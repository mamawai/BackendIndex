"""Pure-NumPy category-first 2PL IRT calibration and evidence gating engine."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from config import (
    BENCHMARK_REGISTRY,
    CATEGORY_WEIGHTS,
    FRESHNESS_MULTIPLIER,
    SOURCE_TYPE_WEIGHTS,
    CategoryId,
)
from models import Observation


def sigmoid(x: np.ndarray | float) -> np.ndarray | float:
    x_clip = np.clip(x, -25.0, 25.0)
    return 1.0 / (1.0 + np.exp(-x_clip))


@dataclass
class CategoryCalibration:
    """Calibrated 2PL IRT latent abilities, parameters, and fitted pairs for one category."""

    category: CategoryId
    model_scores: dict[str, float]  # 0-100 scale
    model_se: dict[str, float]  # 0-100 scale SE
    model_theta: dict[str, float]  # Standardized latent ability (aligned to repo scale after pass 2)
    model_obs_count: dict[str, int]
    benchmark_params: dict[str, dict[str, float]]  # difficulty, discrimination, n_models
    fitted_pairs: dict[tuple[str, str], Observation]


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
        # Prefer independent/benchmark-run over lab-reported when choosing representative run,
        # then highest raw score, then latest verified evaluation date.
        best = max(
            runs,
            key=lambda r: (
                1 if r.source_type in ("benchmark_run", "independent_run") else 0,
                round(r.raw_score, 4),
                r.date or "",
            ),
        )
        best_by_pair[pair] = best

    return best_by_pair


def compute_effective_weights(
    best_by_pair: dict[tuple[str, str], Observation],
) -> dict[tuple[str, str], float]:
    """Compute provenance + freshness weights, split shared-question overlaps, and strictly cap family shares."""
    raw_weights: dict[tuple[str, str], float] = {}
    per_model_overlap: dict[tuple[str, str], int] = {}

    for (mid, bid), obs in best_by_pair.items():
        spec = BENCHMARK_REGISTRY[bid]
        w = spec.base_weight * SOURCE_TYPE_WEIGHTS[obs.source_type] * FRESHNESS_MULTIPLIER[spec.freshness]
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


def fit_category_irt(
    observations: list[Observation],
    category: CategoryId,
    general_theta_prior: dict[str, float] | None = None,
) -> CategoryCalibration:
    """Fit a regularized 2-parameter logistic (2PL) IRT model per category on >=3-model benchmarks."""
    best_by_pair = deduplicate_observations(observations, category)
    if not best_by_pair:
        return CategoryCalibration(category, {}, {}, {}, {}, {}, {})

    # Filter benchmarks with >= 3 models first so overlap/family caps only reflect actually fitted items
    bench_counts: dict[str, int] = {}
    for _, bid in best_by_pair:
        bench_counts[bid] = bench_counts.get(bid, 0) + 1
    valid_benchmarks = sorted(bid for bid, cnt in bench_counts.items() if cnt >= 3)
    fitted_pairs = {pair: obs for pair, obs in best_by_pair.items() if pair[1] in valid_benchmarks}
    valid_models = sorted({mid for (mid, _bid) in fitted_pairs})

    if not valid_benchmarks or not valid_models:
        return CategoryCalibration(category, {}, {}, {}, {}, {}, {})

    eff_weights = compute_effective_weights(fitted_pairs)

    m_idx = {mid: i for i, mid in enumerate(valid_models)}
    b_idx = {bid: j for j, bid in enumerate(valid_benchmarks)}
    n_m, n_b = len(valid_models), len(valid_benchmarks)

    Y = np.zeros((n_m, n_b), dtype=np.float64)
    W = np.zeros((n_m, n_b), dtype=np.float64)
    obs_counts = {mid: 0 for mid in valid_models}

    for (mid, bid), _obs in fitted_pairs.items():
        i, j = m_idx[mid], b_idx[bid]
        Y[i, j] = np.clip(_obs.raw_score, 0.01, 0.99)
        W[i, j] = eff_weights[(mid, bid)]
        obs_counts[mid] += 1

    theta = np.zeros(n_m, dtype=np.float64)
    prior_mu = np.array(
        [general_theta_prior.get(mid, 0.0) if general_theta_prior else 0.0 for mid in valid_models],
        dtype=np.float64,
    )
    a = np.ones(n_b, dtype=np.float64)
    d = np.zeros(n_b, dtype=np.float64)
    for j in range(n_b):
        mask = W[:, j] > 0
        if np.any(mask):
            mean_y = np.average(Y[mask, j], weights=W[:, j][mask])
            d[j] = -math.log(mean_y / (1.0 - mean_y))

    lam_theta = 0.14
    lam_d = 0.08
    lam_log_a = 1.2

    # Continuous multi-benchmark reference weighting prevents discontinuous jumps when overlap counts sit near 4
    ref_weights = np.array(
        [1.0 if obs_counts[mid] >= 2 else 0.15 for mid in valid_models],
        dtype=np.float64,
    )

    for _ in range(45):
        for i in range(n_m):
            mask = W[i] > 0
            if not np.any(mask):
                continue
            for _step in range(3):
                p = sigmoid(a[mask] * (theta[i] - d[mask]))
                grad = np.sum(W[i, mask] * a[mask] * (Y[i, mask] - p)) - lam_theta * (theta[i] - prior_mu[i])
                hess = np.sum(W[i, mask] * (a[mask] ** 2) * p * (1.0 - p)) + lam_theta
                theta[i] = float(np.clip(theta[i] + np.clip(grad / max(hess, 1e-6), -0.5, 0.5), -4.5, 4.5))

        for j in range(n_b):
            mask = W[:, j] > 0
            if not np.any(mask):
                continue
            for _step in range(3):
                p = sigmoid(a[j] * (theta[mask] - d[j]))
                grad = np.sum(W[mask, j] * (-a[j]) * (Y[mask, j] - p)) - lam_d * d[j]
                hess = np.sum(W[mask, j] * (a[j] ** 2) * p * (1.0 - p)) + lam_d
                d[j] = float(np.clip(d[j] + np.clip(grad / max(hess, 1e-6), -0.5, 0.5), -4.5, 4.5))

        for j in range(n_b):
            mask = W[:, j] > 0
            if np.sum(mask) < 4:
                continue
            log_a = math.log(a[j])
            diff = theta[mask] - d[j]
            p = sigmoid(a[j] * diff)
            grad = np.sum(W[mask, j] * a[j] * diff * (Y[mask, j] - p)) - lam_log_a * log_a
            hess = np.sum(W[mask, j] * (a[j] ** 2) * (diff ** 2) * p * (1.0 - p)) + lam_log_a
            log_a = float(np.clip(log_a + np.clip(grad / max(hess, 1e-6), -0.25, 0.25), math.log(0.45), math.log(2.6)))
            a[j] = math.exp(log_a)

        mu_ref = float(np.average(theta, weights=ref_weights))
        theta = theta - mu_ref
        d = d - mu_ref

    mu_ref = float(np.average(theta, weights=ref_weights))
    var_ref = float(np.average((theta - mu_ref) ** 2, weights=ref_weights))
    sd_ref = max(math.sqrt(var_ref), 0.35)
    theta_std = (theta - mu_ref) / sd_ref
    d_std = (d - mu_ref) / sd_ref
    a_std = a * sd_ref

    ALPHA = 0.88
    BETA = 0.35

    model_scores: dict[str, float] = {}
    model_se: dict[str, float] = {}
    model_theta: dict[str, float] = {}

    for i, mid in enumerate(valid_models):
        mask = W[i] > 0
        p = sigmoid(a[mask] * (theta[i] - d[mask]))
        info = lam_theta + float(np.sum(W[i, mask] * (a[mask] ** 2) * p * (1.0 - p)))
        se_theta = (1.0 / math.sqrt(max(info, 0.1))) / sd_ref
        s = float(sigmoid(ALPHA * theta_std[i] + BETA))
        score_100 = round(s * 100.0, 2)
        se_100 = round(100.0 * ALPHA * s * (1.0 - s) * se_theta, 2)

        model_scores[mid] = score_100
        model_se[mid] = max(se_100, 1.5)
        model_theta[mid] = round(float(theta_std[i]), 3)

    bparams: dict[str, dict[str, float]] = {}
    for j, bid in enumerate(valid_benchmarks):
        bparams[bid] = {
            "difficulty": round(float(d_std[j]), 3),
            "discrimination": round(float(a_std[j]), 3),
            "n_models": int(np.sum(W[:, j] > 0)),
        }

    return CategoryCalibration(
        category=category,
        model_scores=model_scores,
        model_se=model_se,
        model_theta=model_theta,
        model_obs_count=obs_counts,
        benchmark_params=bparams,
        fitted_pairs=fitted_pairs,
    )


def score_all_models(
    observations: list[Observation],
    weights: dict[CategoryId, float] | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[CategoryId, CategoryCalibration]]:
    """Run two-pass category 2PL IRT, align scales to repo anchor, and enforce fitted-only core gating."""
    cat_weights = weights or CATEGORY_WEIGHTS
    categories: list[CategoryId] = list(cat_weights.keys())
    clean_obs = [o for o in observations if not o.is_agent_product]

    # Pass 1: independent per-category IRT for general ability prior
    pass1 = {c: fit_category_irt(clean_obs, c) for c in categories}
    general_prior: dict[str, float] = {}
    all_p1_mids = {mid for cal in pass1.values() for mid in cal.model_theta}
    for mid in all_p1_mids:
        vals = [pass1[c].model_theta[mid] for c in categories if mid in pass1[c].model_theta]
        if vals:
            general_prior[mid] = float(np.mean(vals))

    # Pass 2: category-first 2PL IRT shrunk gently toward general ability
    calibrations: dict[CategoryId, CategoryCalibration] = {
        cat: fit_category_irt(clean_obs, cat, general_theta_prior=general_prior)
        for cat in categories
    }

    # Cross-category shared-anchor alignment onto "repo" scale, transforming both model thetas and item params
    ALPHA = 0.88
    BETA = 0.35
    anchor_cal = calibrations.get("repo")
    if anchor_cal and anchor_cal.model_theta:
        for c in categories:
            if c == "repo":
                continue
            cal = calibrations[c]
            common = [m for m in cal.model_theta if m in anchor_cal.model_theta]
            if len(common) >= 4:
                a_vals = np.array([anchor_cal.model_theta[m] for m in common], dtype=np.float64)
                c_vals = np.array([cal.model_theta[m] for m in common], dtype=np.float64)
                mu_a, sd_a = float(np.mean(a_vals)), float(np.std(a_vals))
                mu_c, sd_c = float(np.mean(c_vals)), float(np.std(c_vals))
                ratio = float(np.clip(sd_a / max(sd_c, 0.2), 0.7, 1.45)) if sd_c > 0.1 else 1.0

                for mid in list(cal.model_theta.keys()):
                    aligned_theta = (cal.model_theta[mid] - mu_c) * ratio + mu_a
                    cal.model_theta[mid] = round(aligned_theta, 4)
                    s_old = cal.model_scores[mid] / 100.0
                    denom = max(100.0 * ALPHA * s_old * (1.0 - s_old), 1e-3)
                    se_theta = (cal.model_se[mid] / denom) * ratio
                    s_new = float(sigmoid(ALPHA * aligned_theta + BETA))
                    cal.model_scores[mid] = round(s_new * 100.0, 2)
                    cal.model_se[mid] = max(round(100.0 * ALPHA * s_new * (1.0 - s_new) * se_theta, 2), 1.5)

                # Transform item parameters consistently so a * (theta - d) remains invariant on the unified repo scale
                for bid, bp in cal.benchmark_params.items():
                    bp["difficulty"] = round((bp["difficulty"] - mu_c) * ratio + mu_a, 3)
                    bp["discrimination"] = round(bp["discrimination"] / ratio, 3)

    fitted_obs_by_model: dict[str, list[Observation]] = {}
    for cal in calibrations.values():
        for (mid, _bid), obs in cal.fitted_pairs.items():
            fitted_obs_by_model.setdefault(mid, []).append(obs)

    all_obs_by_model: dict[str, list[Observation]] = {}
    for o in clean_obs:
        all_obs_by_model.setdefault(o.canonical_model_id, []).append(o)

    results: dict[str, dict[str, Any]] = {}
    for mid in sorted(fitted_obs_by_model.keys()):
        fitted_obs = fitted_obs_by_model[mid]
        raw_obs_all = all_obs_by_model.get(mid, fitted_obs)

        cat_scores: dict[str, float | None] = {}
        cat_se: dict[str, float | None] = {}
        covered_cats: list[str] = []

        weighted_sum = 0.0
        weight_sum = 0.0
        var_sum = 0.0

        for cat, w in cat_weights.items():
            cal = calibrations[cat]
            sc = cal.model_scores.get(mid)
            se = cal.model_se.get(mid)
            cat_scores[cat] = sc
            cat_se[cat] = se
            if sc is not None and se is not None:
                covered_cats.append(cat)
                weighted_sum += w * sc
                weight_sum += w
                var_sum += (w * se) ** 2

        if weight_sum <= 0:
            continue

        overall = weighted_sum / weight_sum
        missing_weight = max(0.0, 1.0 - weight_sum)
        base_se = math.sqrt(var_sum) / weight_sum
        overall_se = math.sqrt(base_se ** 2 + (missing_weight * 6.5) ** 2)
        ci_low = round(max(0.0, overall - 1.645 * overall_se), 2)
        ci_high = round(min(100.0, overall + 1.645 * overall_se), 2)

        # Gate strictly using observations that actually entered fitted IRT weight matrices
        core_fitted = [o for o in fitted_obs if BENCHMARK_REGISTRY[o.benchmark_id].core]
        distinct_benchmarks = {o.benchmark_id for o in fitted_obs}
        core_benchmarks = {o.benchmark_id for o in core_fitted}
        core_cats = {o.category for o in core_fitted if o.category in covered_cats}
        auxiliary_only_cats = sorted(c for c in covered_cats if c not in core_cats)

        indep_families = {
            o.source_family
            for o in fitted_obs
            if o.source_type in ("benchmark_run", "independent_run")
        }
        core_indep_families = {
            o.source_family
            for o in core_fitted
            if o.source_type in ("benchmark_run", "independent_run")
        }
        all_families = {o.source_family for o in fitted_obs}

        is_supported = (
            len(core_indep_families) >= 2
            and len(core_cats) >= 2
            and "repo" in core_cats
            and len(core_benchmarks) >= 4
        )
        is_eligible_overall = (
            len(distinct_benchmarks) >= 3
            and len(covered_cats) >= 2
            and "repo" in core_cats
        )

        # All Observation.date strings are normalized ISO prefixes ('YYYY-MM-DD' or 'YYYY-MM')
        latest_date = max((o.date or "" for o in raw_obs_all if o.date), default="") or None

        results[mid] = {
            "canonical_id": mid,
            "overall_score": round(overall, 2),
            "overall_se": round(overall_se, 2),
            "ci_90": [ci_low, ci_high],
            "category_scores": cat_scores,
            "category_se": cat_se,
            "covered_categories": covered_cats,
            "auxiliary_only_categories": auxiliary_only_cats,
            "benchmark_count": len(distinct_benchmarks),
            "observation_count": len(raw_obs_all),
            "core_independent_family_count": len(core_indep_families),
            "independent_family_count": len(indep_families),
            "source_family_count": len(all_families),
            "evidence_status": "Supported" if is_supported else "Estimated",
            "eligible_overall": is_eligible_overall,
            "latest_date": latest_date,
        }

    ranked_pool = [r for r in results.values() if r["eligible_overall"]]
    ranked_pool.sort(key=lambda r: r["overall_score"], reverse=True)

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
                and not (
                    nxt["evidence_status"] == "Estimated"
                    and nxt["independent_family_count"] < 2
                )
            ):
                ranked_pool[idx], ranked_pool[idx + 1] = nxt, curr
                changed = True

    for rank_idx, entry in enumerate(ranked_pool, start=1):
        entry["rank"] = rank_idx
    for entry in results.values():
        if not entry["eligible_overall"]:
            entry["rank"] = None

    return results, calibrations
