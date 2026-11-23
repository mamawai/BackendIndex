"""Per-dimension 2PL IRT via marginal maximum likelihood (EM), cross-dimension linking, missing-dimension adjustment and ranking."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, NamedTuple

import numpy as np

from config import BENCHMARK_REGISTRY, CATEGORY_WEIGHTS, SOURCE_TYPE_WEIGHTS, CategoryId
from models import Observation

# 0-100 展示刻度：分数 = sigmoid(ALPHA·θ + BETA)，θ 已对齐到 repo 维度的刻度
ALPHA = 0.88
BETA = 0.35
# 数据完整的门槛：已测维度至少占当前维度权重的 70%；不到的照常排名，但标"数据不全"、名次仅供参考
MIN_COVERAGE = 0.70
# θ 积分网格：每个维度的模型总体按 N(0,1) 定刻度
GRID = np.linspace(-6.0, 6.0, 481)
LOG_PRIOR = -0.5 * GRID**2
INDEPENDENT_TYPES = ("benchmark_run", "independent_run")
# 离散度向全体合并值靠拢的强度（相当于 30 个自由度的"先验"），自由度小的维度更多借用全体值
DISPERSION_POOL_DF = 30
# 同一维度里两个基准至少有这么多共同模型，才算连通、能放在同一把尺子上；不连通时只有主组计分
MIN_SHARED_MODELS = 3


def sigmoid(x: np.ndarray | float) -> np.ndarray | float:
    x_clip = np.clip(x, -30.0, 30.0)
    return 1.0 / (1.0 + np.exp(-x_clip))


@dataclass
class CategoryCalibration:
    """Calibrated abilities (aligned to the repo scale), item parameters and fitted pairs for one category."""

    category: CategoryId
    model_scores: dict[str, float] = field(default_factory=dict)  # 0-100
    model_se: dict[str, float] = field(default_factory=dict)  # 0-100
    model_theta: dict[str, float] = field(default_factory=dict)
    model_theta_se: dict[str, float] = field(default_factory=dict)
    model_obs_count: dict[str, int] = field(default_factory=dict)  # 该维度拟合进来的基准数
    benchmark_params: dict[str, dict[str, float]] = field(default_factory=dict)  # difficulty, discrimination, n_models
    fitted_pairs: dict[tuple[str, str], Observation] = field(default_factory=dict)
    # 每条入模成绩在拟合里实际用的权重（档位×来源×新鲜度，再经同题拆分、单一来源封顶）
    pair_weights: dict[tuple[str, str], float] = field(default_factory=dict)
    dispersion: float = 1.0


def deduplicate_observations(
    observations: list[Observation],
    category: CategoryId,
) -> dict[tuple[str, str], Observation]:
    """Select best verified run per (model_id, benchmark_id) for a scored category."""
    by_pair: dict[tuple[str, str], list[Observation]] = {}
    for obs in observations:
        if obs.is_agent_product or obs.category != category:
            continue
        spec = BENCHMARK_REGISTRY.get(obs.benchmark_id)
        if not spec or not spec.scored:
            continue
        by_pair.setdefault((obs.canonical_model_id, obs.benchmark_id), []).append(obs)

    best_by_pair: dict[tuple[str, str], Observation] = {}
    for pair, runs in by_pair.items():
        # 同一模型同一基准有多次成绩时：先挑维护方/独立实测，再取最高分（即"最佳配置"成绩），再取最新
        best = max(
            runs,
            key=lambda r: (
                1 if r.source_type in INDEPENDENT_TYPES else 0,
                round(r.raw_score, 4),
                r.date or "",
            ),
        )
        best_by_pair[pair] = best

    return best_by_pair


def compute_effective_weights(
    best_by_pair: dict[tuple[str, str], Observation],
    freshness: dict[str, float] | None = None,
) -> dict[tuple[str, str], float]:
    """Tier × provenance × freshness weights, split shared-question overlaps, and cap family shares per dimension."""
    fresh = freshness or {}
    raw_weights: dict[tuple[str, str], float] = {}
    per_model_overlap: dict[tuple[str, str], int] = {}

    for (mid, bid), obs in best_by_pair.items():
        spec = BENCHMARK_REGISTRY[bid]
        w = spec.base_weight * SOURCE_TYPE_WEIGHTS[obs.source_type] * fresh.get(bid, 1.0)
        raw_weights[(mid, bid)] = w
        if spec.overlap_group:
            key = (mid, spec.overlap_group)
            per_model_overlap[key] = per_model_overlap.get(key, 0) + 1

    # Split weights across benchmarks sharing an identical underlying question set (e.g. Spider2 Snow/Lite)
    overlap_adjusted: dict[tuple[str, str], float] = {}
    per_model_pairs: dict[str, list[tuple[str, str]]] = {}
    for pair in raw_weights:
        mid, bid = pair
        spec = BENCHMARK_REGISTRY[bid]
        w = raw_weights[pair]
        if spec.overlap_group:
            cnt = per_model_overlap[(mid, spec.overlap_group)]
            if cnt > 1:
                w = w / cnt
        overlap_adjusted[pair] = w
        per_model_pairs.setdefault(mid, []).append(pair)

    # Iteratively project family weights to guarantee max share <= cap (<=40% for >=4 families, <=45% for 3 families)
    capped_weights = dict(overlap_adjusted)
    for _mid, pairs in per_model_pairs.items():
        fam_totals: dict[str, float] = {}
        for pair in pairs:
            fam = best_by_pair[pair].source_family
            fam_totals[fam] = fam_totals.get(fam, 0.0) + capped_weights[pair]

        n_fams = len(fam_totals)
        if n_fams < 3:
            continue
        cap = 0.40 if n_fams >= 4 else 0.45

        for _ in range(120):
            total_w = sum(fam_totals.values())
            if total_w <= 0:
                break
            max_share = max(fam_totals.values()) / total_w
            if max_share <= cap + 1e-8:
                break
            for fam, fam_w in list(fam_totals.items()):
                other_w = total_w - fam_w
                if other_w > 0 and (fam_w / total_w) > cap + 1e-8:
                    target_fam_w = (cap / (1.0 - cap)) * other_w
                    scale = target_fam_w / fam_w
                    fam_totals[fam] = fam_w * scale
                    for pair in pairs:
                        if best_by_pair[pair].source_family == fam:
                            capped_weights[pair] *= scale

    return capped_weights


@dataclass
class _CategoryData:
    """Model × benchmark matrices for one category (Y = pass rate, W = effective weight, 0 = missing)."""

    models: list[str]
    benchmarks: list[str]
    Y: np.ndarray
    W: np.ndarray
    fitted_pairs: dict[tuple[str, str], Observation]


def _prepare_category(
    observations: list[Observation],
    category: CategoryId,
    freshness: dict[str, float],
) -> _CategoryData | None:
    best_by_pair = deduplicate_observations(observations, category)
    bench_counts: dict[str, int] = {}
    for _, bid in best_by_pair:
        bench_counts[bid] = bench_counts.get(bid, 0) + 1
    # 至少 3 个模型做过的基准才拿来估题目参数
    benchmarks = sorted(bid for bid, cnt in bench_counts.items() if cnt >= 3)
    fitted_pairs = {pair: obs for pair, obs in best_by_pair.items() if pair[1] in benchmarks}
    models = sorted({mid for (mid, _bid) in fitted_pairs})
    if not benchmarks or not models:
        return None

    eff = compute_effective_weights(fitted_pairs, freshness)
    m_idx = {mid: i for i, mid in enumerate(models)}
    b_idx = {bid: j for j, bid in enumerate(benchmarks)}
    Y = np.zeros((len(models), len(benchmarks)), dtype=np.float64)
    W = np.zeros_like(Y)
    for (mid, bid), obs in fitted_pairs.items():
        i, j = m_idx[mid], b_idx[bid]
        Y[i, j] = np.clip(obs.raw_score, 0.01, 0.99)
        W[i, j] = eff[(mid, bid)]
    return _CategoryData(models, benchmarks, Y, W, fitted_pairs)


def _fit_mml(
    data: _CategoryData,
    phi: float,
    start: tuple[np.ndarray, np.ndarray] | None = None,
    iterations: int = 60,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """2PL marginal maximum likelihood by EM on a θ grid; returns (a, d, posterior mean, posterior sd)."""
    Y, W = data.Y, data.W
    M = W > 0
    n_b = Y.shape[1]
    if start is None:
        a = np.ones(n_b)
        d = np.zeros(n_b)
        for j in range(n_b):
            mean_y = float(np.average(Y[M[:, j], j], weights=W[M[:, j], j]))
            d[j] = -math.log(mean_y / (1.0 - mean_y))
    else:
        a, d = start[0].copy(), start[1].copy()

    lam_log_a, lam_d = 1.2, 0.08
    # 少于 4 个模型的基准不估区分度，固定为 1
    can_a = M.sum(0) >= 4
    WY = W * Y / phi
    WN = W * (1.0 - Y) / phi
    post = np.zeros((Y.shape[0], GRID.size))
    for _ in range(iterations):
        # E 步：每个模型在 θ 网格上的后验（似然按 1/φ 放大，即准二项）
        Z = a[:, None] * (GRID[None, :] - d[:, None])
        loglik = WY @ (-np.logaddexp(0.0, -Z)) + WN @ (-np.logaddexp(0.0, Z)) + LOG_PRIOR[None, :]
        loglik -= loglik.max(axis=1, keepdims=True)
        post = np.exp(loglik)
        post /= post.sum(axis=1, keepdims=True)

        # M 步：每个基准在网格点上的期望权重 / 期望通过量，做加权 logistic 回归
        n_g = W.T @ post
        r_g = (W * Y).T @ post
        for _step in range(3):
            Z = a[:, None] * (GRID[None, :] - d[:, None])
            P = sigmoid(Z)
            resid = r_g - n_g * P
            info = n_g * P * (1.0 - P)
            u = a[:, None] * (GRID[None, :] - d[:, None])  # dZ / d(log a)
            v = -a[:, None]  # dZ / dd
            log_a = np.log(a)
            g1 = (resid * u).sum(axis=1) / phi - lam_log_a * log_a
            g2 = (resid * v).sum(axis=1) / phi - lam_d * d
            h11 = (info * u * u).sum(axis=1) / phi + lam_log_a
            h22 = (info * v * v).sum(axis=1) / phi + lam_d
            h12 = (info * u * v).sum(axis=1) / phi
            det = np.maximum(h11 * h22 - h12**2, 1e-12)
            step_log_a = np.where(can_a, np.clip((h22 * g1 - h12 * g2) / det, -0.25, 0.25), 0.0)
            step_d = np.where(can_a, (h11 * g2 - h12 * g1) / det, g2 / h22)
            a = np.exp(np.clip(log_a + step_log_a, math.log(0.25), math.log(4.0)))
            d = np.clip(d + np.clip(step_d, -0.5, 0.5), -6.0, 6.0)

    eap = post @ GRID
    psd = np.sqrt(np.maximum(post @ GRID**2 - eap**2, 1e-12))
    return a, d, eap, psd


def _dispersion_stats(data: _CategoryData, a: np.ndarray, d: np.ndarray, eap: np.ndarray) -> tuple[float, int]:
    """Pearson residual sum and degrees of freedom over cells of multi-benchmark models."""
    M = data.W > 0
    multi = M.sum(axis=1) >= 2
    cells = M & multi[:, None]
    n_cells = int(cells.sum())
    if n_cells == 0:
        return 0.0, 0
    P = np.clip(sigmoid(a[None, :] * (eap[:, None] - d[None, :])), 1e-4, 1.0 - 1e-4)
    rss = float((data.W * (data.Y - P) ** 2 / (P * (1.0 - P)) * cells).sum())
    # 每个多基准模型占 1 个自由度，每个基准占 2 个（难度、区分度）
    df = n_cells - int(multi.sum()) - 2 * len(data.benchmarks)
    return rss, df


def _split_components(data: _CategoryData) -> list[_CategoryData]:
    """Split a category into benchmark groups connected through >= MIN_SHARED_MODELS common models."""
    M = (data.W > 0).astype(np.int64)
    shared = M.T @ M
    n_b = len(data.benchmarks)
    seen = [False] * n_b
    groups: list[list[int]] = []
    for start in range(n_b):
        if seen[start]:
            continue
        seen[start] = True
        stack, members = [start], []
        while stack:
            j = stack.pop()
            members.append(j)
            for k in range(n_b):
                if not seen[k] and shared[j, k] >= MIN_SHARED_MODELS:
                    seen[k] = True
                    stack.append(k)
        groups.append(sorted(members))
    if len(groups) == 1:
        return [data]

    parts: list[_CategoryData] = []
    for cols in groups:
        sub_w = data.W[:, cols]
        rows = np.where((sub_w > 0).any(axis=1))[0]
        bench = [data.benchmarks[j] for j in cols]
        bench_set = set(bench)
        parts.append(
            _CategoryData(
                models=[data.models[i] for i in rows],
                benchmarks=bench,
                Y=data.Y[np.ix_(rows, cols)],
                W=sub_w[rows],
                fitted_pairs={p: o for p, o in data.fitted_pairs.items() if p[1] in bench_set},
            )
        )
    return parts


@dataclass
class _GroupFit:
    """One connected benchmark group of a category: item parameters and model posteriors."""

    category: CategoryId
    data: _CategoryData
    a: np.ndarray
    d: np.ndarray
    theta: np.ndarray
    theta_se: np.ndarray

    def obs_count(self) -> dict[str, int]:
        return dict(zip(self.data.models, (self.data.W > 0).sum(axis=1).tolist()))


def fit_all_categories(
    observations: list[Observation],
    categories: list[CategoryId],
    freshness: dict[str, float] | None = None,
) -> tuple[dict[CategoryId, list[_GroupFit]], dict[CategoryId, float]]:
    """Fit every connected benchmark group of every category (no cross-category borrowing), iterating dispersion."""
    fresh = freshness or {}
    parts: dict[CategoryId, list[_CategoryData]] = {}
    for c in categories:
        dt = _prepare_category(observations, c, fresh)
        if dt is not None:
            parts[c] = _split_components(dt)
    phis = {c: 1.0 for c in parts}
    starts: dict[tuple[CategoryId, int], tuple[np.ndarray, np.ndarray]] = {}
    fits: dict[tuple[CategoryId, int], tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = {}

    # 离散度 φ = 基准成绩围绕预测值的实际波动 / 二项方差；按维度估，再向全体合并值部分靠拢，迭代到稳定
    for _round in range(15):
        stats: dict[CategoryId, tuple[float, int]] = {}
        for c, groups in parts.items():
            rss_c, df_c = 0.0, 0
            for k, grp in enumerate(groups):
                fit = _fit_mml(grp, phis[c], starts.get((c, k)))
                fits[(c, k)] = fit
                starts[(c, k)] = (fit[0], fit[1])
                rss, df = _dispersion_stats(grp, fit[0], fit[1], fit[2])
                if df > 0:
                    rss_c += rss
                    df_c += df
            stats[c] = (rss_c, df_c)
        total_df = sum(df for _, df in stats.values())
        pooled = sum(rss for rss, _ in stats.values()) / total_df if total_df > 0 else 1.0
        new_phis: dict[CategoryId, float] = {}
        for c, (rss, df) in stats.items():
            raw = rss / df if df > 0 else pooled
            mixed = (df * raw + DISPERSION_POOL_DF * pooled) / (df + DISPERSION_POOL_DF)
            new_phis[c] = float(min(max(mixed, 0.005), 1.0))
        converged = all(abs(new_phis[c] - phis[c]) <= 0.01 * phis[c] for c in parts)
        phis = new_phis
        if converged:
            break

    group_fits = {
        c: [_GroupFit(c, grp, *fits[(c, k)]) for k, grp in enumerate(groups)] for c, groups in parts.items()
    }
    return group_fits, phis


def _place_main_groups(
    group_fits: dict[CategoryId, list[_GroupFit]],
) -> tuple[list[_GroupFit], dict[CategoryId, list[_GroupFit]]]:
    """Keep each category's main benchmark group and link it onto the repo scale; other groups are not compared."""
    # 主组 = 有效权重合计最大的那组（权重已含档位、来源、新鲜度）。其余组和主组没有足够共同模型，
    # 数据定不了两组差多少（还原实验里各种对齐法都会放错 4–8 分），所以不放在一起比
    mains = {c: max(gs, key=lambda g: float(g.data.W.sum())) for c, gs in group_fits.items() if gs}
    dropped: dict[CategoryId, list[_GroupFit]] = {c: [g for g in gs if g is not mains[c]] for c, gs in group_fits.items()}
    anchor = mains.get("repo")
    if anchor is None:
        return list(mains.values()), dropped
    a_theta = dict(zip(anchor.data.models, anchor.theta.tolist()))
    a_cnt = anchor.obs_count()

    placed = [anchor]
    for c, g in mains.items():
        if g is anchor:
            continue
        cnt = g.obs_count()
        idx = {m: i for i, m in enumerate(g.data.models)}
        common = [m for m in g.data.models if m in a_theta]
        # 优先用两边都有 ≥2 个基准的模型来对齐，估计更稳
        reliable = [m for m in common if cnt[m] >= 2 and a_cnt[m] >= 2]
        use = reliable if len(reliable) >= 6 else common
        if len(use) < 4:
            # 和仓库研发几乎没有共同模型，放不到统一刻度上：这个维度不计分
            dropped[c].append(g)
            continue
        a_vals = np.array([a_theta[m] for m in use])
        g_vals = np.array([g.theta[idx[m]] for m in use])
        mu_a, sd_a = float(np.mean(a_vals)), float(np.std(a_vals))
        mu_g, sd_g = float(np.mean(g_vals)), float(np.std(g_vals))
        ratio = float(np.clip(sd_a / max(sd_g, 0.2), 0.7, 1.45)) if sd_g > 0.1 else 1.0
        g.theta = (g.theta - mu_g) * ratio + mu_a
        g.theta_se = g.theta_se * ratio
        # a·(θ − d) 在新刻度下保持不变
        g.d = (g.d - mu_g) * ratio + mu_a
        g.a = g.a / ratio
        placed.append(g)
    return placed, dropped


def _build_calibrations(
    placed: list[_GroupFit],
    categories: list[CategoryId],
    phis: dict[CategoryId, float],
) -> dict[CategoryId, CategoryCalibration]:
    """One calibration per category, taken from its placed main group."""
    cals = {c: CategoryCalibration(category=c, dispersion=round(phis.get(c, 1.0), 4)) for c in categories}
    for g in placed:
        cal = cals[g.category]
        cnt = g.obs_count()
        M = g.data.W > 0
        for i, mid in enumerate(g.data.models):
            cal.model_theta[mid] = float(g.theta[i])
            cal.model_theta_se[mid] = float(g.theta_se[i])
            cal.model_obs_count[mid] = cnt[mid]
            for j, bid in enumerate(g.data.benchmarks):
                if g.data.W[i, j] > 0:
                    cal.pair_weights[(mid, bid)] = float(g.data.W[i, j])
        for j, bid in enumerate(g.data.benchmarks):
            cal.benchmark_params[bid] = {
                "difficulty": float(g.d[j]),
                "discrimination": float(g.a[j]),
                "n_models": int(M[:, j].sum()),
            }
        cal.fitted_pairs = dict(g.data.fitted_pairs)
    return cals


def _attach_scores(calibrations: dict[CategoryId, CategoryCalibration]) -> None:
    """Map aligned θ to the 0-100 display scale (delta-method SE) and round stored parameters."""
    for cal in calibrations.values():
        for mid, theta in cal.model_theta.items():
            s = float(sigmoid(ALPHA * theta + BETA))
            cal.model_scores[mid] = round(s * 100.0, 2)
            cal.model_se[mid] = max(round(100.0 * ALPHA * s * (1.0 - s) * cal.model_theta_se[mid], 2), 0.5)
            cal.model_theta[mid] = round(theta, 4)
            cal.model_theta_se[mid] = round(cal.model_theta_se[mid], 4)
        for bp in cal.benchmark_params.values():
            bp["difficulty"] = round(bp["difficulty"], 3)
            bp["discrimination"] = round(bp["discrimination"], 3)


class MissingLine(NamedTuple):
    """缺测修正用的直线：六维分 ≈ intercept + slope × 只用已测这几维算的加权平均（在六维都有分的模型上拟合）。"""

    intercept: float
    slope: float
    resid_sd: float
    n: int
    mean_x: float
    sxx: float

    def predict(self, x: float, x_se: float) -> tuple[float, float]:
        """估计的综合分和标准误：已测部分的测量误差按斜率折算，再加上这条线本身的预测误差。"""
        pred_sd = self.resid_sd * math.sqrt(1.0 + 1.0 / self.n + (x - self.mean_x) ** 2 / self.sxx)
        return self.intercept + self.slope * x, math.sqrt((self.slope * x_se) ** 2 + pred_sd**2)


def _fit_missing_line(
    reference: list[dict[CategoryId, float]],
    covered: tuple[CategoryId, ...],
    norm_w: dict[CategoryId, float],
) -> MissingLine:
    """Regress the full weighted score on the covered-only weighted mean across fully measured models."""
    cov = sum(norm_w[c] for c in covered)
    xs = np.array([sum(norm_w[c] * s[c] for c in covered) / cov for s in reference])
    ys = np.array([sum(w * s[c] for c, w in norm_w.items()) for s in reference])
    mean_x = float(xs.mean())
    sxx = float(((xs - mean_x) ** 2).sum())
    slope = float(((xs - mean_x) * (ys - ys.mean())).sum() / sxx)
    intercept = float(ys.mean()) - slope * mean_x
    resid_sd = float(np.sqrt(((ys - intercept - slope * xs) ** 2).sum() / (len(xs) - 2)))
    return MissingLine(intercept, slope, resid_sd, len(xs), mean_x, sxx)


def score_all_models(
    observations: list[Observation],
    freshness: dict[str, float] | None = None,
    weights: dict[CategoryId, float] | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[CategoryId, CategoryCalibration], dict[str, Any]]:
    """Fit each category, link to the repo scale, combine (adjusting for missing dimensions) and rank."""
    cat_weights = weights or CATEGORY_WEIGHTS
    categories: list[CategoryId] = list(cat_weights.keys())
    total_w = sum(cat_weights.values())
    norm_w = {c: cat_weights[c] / total_w for c in categories}
    clean_obs = [o for o in observations if not o.is_agent_product]

    group_fits, phis = fit_all_categories(clean_obs, categories, freshness)
    placed, dropped = _place_main_groups(group_fits)
    calibrations = _build_calibrations(placed, categories, phis)
    _attach_scores(calibrations)

    # 只在不连通组里有成绩的维度记为"不可比"，和"没测"区分开；这些成绩照样留在台账里
    excluded_benchmarks = {c: sorted(b for g in gs for b in g.data.benchmarks) for c, gs in dropped.items()}
    incomparable: dict[str, set[CategoryId]] = {}
    for c, groups in dropped.items():
        for g in groups:
            for mid in g.data.models:
                if mid not in calibrations[c].model_scores:
                    incomparable.setdefault(mid, set()).add(c)

    fitted_obs_by_model: dict[str, list[Observation]] = {}
    for cal in calibrations.values():
        for (mid, _bid), obs in cal.fitted_pairs.items():
            fitted_obs_by_model.setdefault(mid, []).append(obs)

    all_obs_by_model: dict[str, list[Observation]] = {}
    for o in clean_obs:
        all_obs_by_model.setdefault(o.canonical_model_id, []).append(o)

    # 先算每个模型的证据门槛，缺测修正只用够格（收录）的模型来拟合
    evidence: dict[str, dict[str, Any]] = {}
    for mid in sorted(fitted_obs_by_model.keys()):
        fitted_obs = fitted_obs_by_model[mid]
        covered_cats = [c for c in categories if mid in calibrations[c].model_scores]
        if not covered_cats:
            continue
        core_fitted = [o for o in fitted_obs if BENCHMARK_REGISTRY[o.benchmark_id].core]
        distinct_benchmarks = {o.benchmark_id for o in fitted_obs}
        core_benchmarks = {o.benchmark_id for o in core_fitted}
        core_cats = {o.category for o in core_fitted if o.category in covered_cats}
        core_indep_families = {o.source_family for o in core_fitted if o.source_type in INDEPENDENT_TYPES}
        evidence[mid] = {
            "covered": covered_cats,
            "distinct_benchmarks": distinct_benchmarks,
            "core_cats": core_cats,
            "core_indep_families": core_indep_families,
            "indep_families": {o.source_family for o in fitted_obs if o.source_type in INDEPENDENT_TYPES},
            "all_families": {o.source_family for o in fitted_obs},
            "is_supported": (
                len(core_indep_families) >= 2
                and len(core_cats) >= 2
                and "repo" in core_cats
                and len(core_benchmarks) >= 4
            ),
            # 能进快照（在各维度榜和对比页出现）的最低门槛
            "is_listed": len(distinct_benchmarks) >= 3 and len(covered_cats) >= 2 and "repo" in core_cats,
        }

    # 缺测修正的参照：六个维度都有分的收录模型
    reference = [
        {c: calibrations[c].model_scores[mid] for c in categories}
        for mid, ev in evidence.items()
        if ev["is_listed"] and len(ev["covered"]) == len(categories)
    ]
    missing_lines: dict[tuple[CategoryId, ...], MissingLine] = {}

    results: dict[str, dict[str, Any]] = {}
    sort_key: dict[str, tuple[float, float]] = {}
    for mid, ev in evidence.items():
        covered = ev["covered"]
        cat_scores: dict[str, float | None] = {c: calibrations[c].model_scores.get(mid) for c in categories}
        cat_se: dict[str, float | None] = {c: calibrations[c].model_se.get(mid) for c in categories}
        coverage = sum(norm_w[c] for c in covered)
        measured = sum(norm_w[c] * cat_scores[c] for c in covered) / coverage
        measured_se = math.sqrt(sum((norm_w[c] * cat_se[c]) ** 2 for c in covered)) / coverage

        if len(covered) == len(categories):
            overall, overall_se = measured, measured_se
        else:
            # 缺的维度不能默认"和已测的一样好"：同一模型的 SQL、安全普遍比其它维低，高分模型尤甚。
            # 用六维齐全的模型拟合"只用这几维算的分 → 六维分"的直线来估，还原实验里高分、低分两头都不偏
            key = tuple(covered)
            if key not in missing_lines:
                missing_lines[key] = _fit_missing_line(reference, key, norm_w)
            overall, overall_se = missing_lines[key].predict(measured, measured_se)
        # 排名用未取整的分数；完全同分时区间窄（证据更确定）的在前
        sort_key[mid] = (-overall, overall_se)

        raw_obs_all = all_obs_by_model.get(mid, [])
        latest_date = max((o.date or "" for o in raw_obs_all if o.date), default="") or None
        core_cats = ev["core_cats"]
        results[mid] = {
            "canonical_id": mid,
            "overall_score": round(overall, 2),
            # 已测维度的加权平均，和缺测修正（= 综合分 - 已测平均，六维齐全时为 0）
            "measured_score": round(measured, 2),
            "missing_adjustment": round(round(overall, 2) - round(measured, 2), 2),
            "overall_se": round(overall_se, 2),
            "ci_90": [round(max(0.0, overall - 1.645 * overall_se), 2), round(min(100.0, overall + 1.645 * overall_se), 2)],
            "coverage": round(coverage, 4),
            "category_scores": cat_scores,
            "category_se": cat_se,
            "covered_categories": covered,
            "auxiliary_only_categories": sorted(c for c in covered if c not in core_cats),
            "single_benchmark_categories": [c for c in covered if calibrations[c].model_obs_count.get(mid, 0) == 1],
            "incomparable_categories": [c for c in categories if c in incomparable.get(mid, set())],
            "benchmark_count": len(ev["distinct_benchmarks"]),
            "observation_count": len(raw_obs_all),
            "core_independent_family_count": len(ev["core_indep_families"]),
            "independent_family_count": len(ev["indep_families"]),
            "source_family_count": len(ev["all_families"]),
            "evidence_status": "Supported" if ev["is_supported"] else "Estimated",
            "eligible_overall": ev["is_listed"],
            "latest_date": latest_date,
        }

    # 收录的模型都在同一张榜上排名；已测维度不到门槛的标为"数据不全"
    for r in results.values():
        r["complete"] = r["coverage"] >= MIN_COVERAGE - 1e-9
    ranked_pool = [r for r in results.values() if r["eligible_overall"]]
    ranked_pool.sort(key=lambda r: sort_key[r["canonical_id"]])

    # 单一来源的 Estimated 模型，不允许排在 2 分以内的多方实测模型前面
    changed = True
    while changed:
        changed = False
        for idx in range(len(ranked_pool) - 1):
            curr = ranked_pool[idx]
            nxt = ranked_pool[idx + 1]
            if (
                curr["evidence_status"] == "Estimated"
                and curr["independent_family_count"] < 2
                and (curr["overall_score"] - nxt["overall_score"]) <= 2.0
                and not (nxt["evidence_status"] == "Estimated" and nxt["independent_family_count"] < 2)
            ):
                ranked_pool[idx], ranked_pool[idx + 1] = nxt, curr
                changed = True

    for entry in results.values():
        entry["rank"] = None
    for rank_idx, entry in enumerate(ranked_pool, start=1):
        entry["rank"] = rank_idx

    stats = {
        "dispersion": {c: cal.dispersion for c, cal in calibrations.items()},
        "excluded_benchmarks": excluded_benchmarks,
    }
    return results, calibrations, stats
