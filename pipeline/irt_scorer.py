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
    """Calibrated 2PL IRT latent abilities and benchmark parameters for one category."""

    category: CategoryId
    model_scores: dict[str, float]  # 0-100 scale
    model_se: dict[str, float]  # 0-100 scale SE
    model_theta: dict[str, float]  # Standardized latent ability
    model_obs_count: dict[str, int]
    benchmark_params: dict[str, dict[str, float]]  # difficulty, discrimination, n_models


def deduplicate_observations(
    observations: list[Observation],
    category: CategoryId,
) -> dict[tuple[str, str], Observation]:
    """Select best verified run per (model_id, benchmark_id) and enforce 40% family cap."""
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
        # then highest raw score (or most recent date).
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
    """Compute provenance + freshness weights with a 40% single-evaluator family cap."""
    raw_weights: dict[tuple[str, str], float] = {}
    per_model_family: dict[str, dict[str, float]] = {}

    for (mid, bid), obs in best_by_pair.items():
        spec = BENCHMARK_REGISTRY[bid]
        w = spec.base_weight * SOURCE_TYPE_WEIGHTS[obs.source_type] * FRESHNESS_MULTIPLIER[spec.freshness]
        raw_weights[(mid, bid)] = w
        fam_map = per_model_family.setdefault(mid, {})
        fam_map[obs.source_family] = fam_map.get(obs.source_family, 0.0) + w

    # Cap any single source_family at <= 40% of a model's total weight when >= 3 families exist
    capped_weights: dict[tuple[str, str], float] = {}
    for (mid, bid), w in raw_weights.items():
        obs = best_by_pair[(mid, bid)]
        fam_map = per_model_family[mid]
        if len(fam_map) >= 3:
            total_w = sum(fam_map.values())
            fam_w = fam_map[obs.source_family]
            other_w = total_w - fam_w
            if other_w > 0 and fam_w / total_w > 0.40:
                max_fam_w = (0.40 / 0.60) * other_w
                scale = max_fam_w / fam_w
                w = w * scale
        capped_weights[(mid, bid)] = w

    return capped_weights


def fit_category_irt(
    observations: list[Observation],
    category: CategoryId,
    general_theta_prior: dict[str, float] | None = None,
) -> CategoryCalibration:
    """Fit a regularized 2-parameter logistic (2PL) IRT model per category."""
    best_by_pair = deduplicate_observations(observations, category)
    if not best_by_pair:
        return CategoryCalibration(category, {}, {}, {}, {}, {})

    eff_weights = compute_effective_weights(best_by_pair)

    # Filter benchmarks with >= 3 models so item parameters are identifiable
    bench_counts: dict[str, int] = {}
    for _, bid in best_by_pair:
        bench_counts[bid] = bench_counts.get(bid, 0) + 1
    valid_benchmarks = sorted(bid for bid, cnt in bench_counts.items() if cnt >= 3)
    valid_models = sorted({mid for (mid, bid) in best_by_pair if bid in valid_benchmarks})

    if not valid_benchmarks or not valid_models:
        return CategoryCalibration(category, {}, {}, {}, {}, {})

    m_idx = {mid: i for i, mid in enumerate(valid_models)}
    b_idx = {bid: j for j, bid in enumerate(valid_benchmarks)}
    n_m, n_b = len(valid_models), len(valid_benchmarks)

    Y = np.zeros((n_m, n_b), dtype=np.float64)
    W = np.zeros((n_m, n_b), dtype=np.float64)
    obs_counts = {mid: 0 for mid in valid_models}

    for (mid, bid), obs in best_by_pair.items():
        if bid not in b_idx:
            continue
        i, j = m_idx[mid], b_idx[bid]
        Y[i, j] = np.clip(obs.raw_score, 0.01, 0.99)
        W[i, j] = eff_weights[(mid, bid)]
        obs_counts[mid] += 1

    # Initialize theta from average logit centered across models; difficulty from negative logit mean
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
            mean_y = np.average(Y[mask, j], weights=W[mask, j])
            d[j] = -math.log(mean_y / (1.0 - mean_y))

    lam_theta = 0.14
    lam_d = 0.08
    lam_log_a = 1.2

    # Alternating Newton-Raphson updates for theta, d, and log(a)
    # Only subtract mu_ref inside the loop (exact shift invariance); scale once after convergence.
    ref_mask = np.array([obs_counts[mid] >= 2 for mid in valid_models])
    if np.sum(ref_mask) < 4:
        ref_mask = np.ones(n_m, dtype=bool)

    for _ in range(45):
        # 1. Update theta_i
        for i in range(n_m):
            mask = W[i] > 0
            if not np.any(mask):
                continue
            for _step in range(3):
                p = sigmoid(a[mask] * (theta[i] - d[mask]))
                grad = np.sum(W[i, mask] * a[mask] * (Y[i, mask] - p)) - lam_theta * (theta[i] - prior_mu[i])
                hess = np.sum(W[i, mask] * (a[mask] ** 2) * p * (1.0 - p)) + lam_theta
                theta[i] = float(np.clip(theta[i] + np.clip(grad / max(hess, 1e-6), -0.5, 0.5), -4.5, 4.5))

        # 2. Update difficulty d_j
        for j in range(n_b):
            mask = W[:, j] > 0
            if not np.any(mask):
                continue
            for _step in range(3):
                p = sigmoid(a[j] * (theta[mask] - d[j]))
                grad = np.sum(W[mask, j] * (-a[j]) * (Y[mask, j] - p)) - lam_d * d[j]
                hess = np.sum(W[mask, j] * (a[j] ** 2) * p * (1.0 - p)) + lam_d
                d[j] = float(np.clip(d[j] + np.clip(grad / max(hess, 1e-6), -0.5, 0.5), -4.5, 4.5))

        # 3. Update log(a_j) (discrimination bounded in [0.45, 2.6])
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

        # Shift-center only so a*(theta - d) remains strictly invariant
        mu_ref = float(np.mean(theta[ref_mask]))
        theta = theta - mu_ref
        d = d - mu_ref

    # Standardize onto reference cohort after convergence
    mu_ref = float(np.mean(theta[ref_mask]))
    sd_ref = max(float(np.std(theta[ref_mask])), 0.35)
    theta_std = (theta - mu_ref) / sd_ref
    d_std = (d - mu_ref) / sd_ref
    a_std = a * sd_ref

    # Compute Fisher information & map to intuitive 0-100 calibrated scale
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
        model_se[mid] = se_100
        model_theta[mid] = round(float(theta_std[i]), 4)

    bench_params = {
        bid: {
            "difficulty": round(float(d_std[b_idx[bid]]), 3),
            "discrimination": round(float(a_std[b_idx[bid]]), 3),
            "n_models": int(np.sum(W[:, b_idx[bid]] > 0)),
        }
        for bid in valid_benchmarks
    }

    return CategoryCalibration(
        category=category,
        model_scores=model_scores,
        model_se=model_se,
        model_theta=model_theta,
        model_obs_count=obs_counts,
        benchmark_params=bench_params,
    )


def score_all_models(
    observations: list[Observation],
    category_weights: dict[CategoryId, float] | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[CategoryId, CategoryCalibration]]:
    """Run two-pass category 2PL IRT (pass 1 -> general prior -> pass 2) and combine Overall."""
    weights = category_weights or CATEGORY_WEIGHTS
    categories: list[CategoryId] = list(weights.keys())

    # Pass 1: independent per-category IRT to obtain rough general ability prior
    pass1 = {c: fit_category_irt(observations, c) for c in categories}
    general_prior: dict[str, float] = {}
    all_mids = {mid for cal in pass1.values() for mid in cal.model_theta}
    for mid in all_mids:
        vals = [pass1[c].model_theta[mid] for c in categories if mid in pass1[c].model_theta]
        if vals:
            general_prior[mid] = float(np.mean(vals))

    # Pass 2: category-first 2PL IRT shrunk gently toward general ability when observations are sparse
    calibrations = {c: fit_category_irt(observations, c, general_theta_prior=general_prior) for c in categories}

    # Cross-category shared-anchor alignment onto the deepest category ("repo") scale
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
                    # Recover se_theta from previous SE, scale by ratio, and remap score
                    denom = max(100.0 * ALPHA * s_old * (1.0 - s_old), 1e-3)
                    se_theta = (cal.model_se[mid] / denom) * ratio
                    s_new = float(sigmoid(ALPHA * aligned_theta + BETA))
                    cal.model_scores[mid] = round(s_new * 100.0, 2)
                    cal.model_se[mid] = round(100.0 * ALPHA * s_new * (1.0 - s_new) * se_theta, 2)

    # Aggregate evidence provenance per model across all scored observations
    model_obs: dict[str, list[Observation]] = {}
    for obs in observations:
        if obs.is_agent_product:
            continue
        spec = BENCHMARK_REGISTRY.get(obs.benchmark_id)
        if spec and spec.scored:
            model_obs.setdefault(obs.canonical_model_id, []).append(obs)

    results: dict[str, dict[str, Any]] = {}
    for mid, obs_list in model_obs.items():
        cat_scores: dict[str, float | None] = {}
        cat_se: dict[str, float | None] = {}
        covered_cats: list[CategoryId] = []
        weighted_sum = 0.0
        weight_sum = 0.0
        var_sum = 0.0

        for c in categories:
            cal = calibrations[c]
            if mid in cal.model_scores:
                sc = cal.model_scores[mid]
                se = cal.model_se[mid]
                cat_scores[c] = sc
                cat_se[c] = se
                covered_cats.append(c)
                w = weights[c]
                weighted_sum += w * sc
                weight_sum += w
                var_sum += (w * se) ** 2
            else:
                cat_scores[c] = None
                cat_se[c] = None

        if weight_sum <= 0:
            continue

        overall = weighted_sum / weight_sum
        # Widen uncertainty smoothly when categories are missing (missingness penalty)
        missing_weight = max(0.0, 1.0 - weight_sum)
        base_se = math.sqrt(var_sum) / weight_sum
        overall_se = math.sqrt(base_se ** 2 + (missing_weight * 6.5) ** 2)
        ci_low = round(max(0.0, overall - 1.645 * overall_se), 2)
        ci_high = round(min(100.0, overall + 1.645 * overall_se), 2)

        distinct_benchmarks = {o.benchmark_id for o in obs_list}
        indep_families = {
            o.source_family
            for o in obs_list
            if o.source_type in ("benchmark_run", "independent_run")
        }
        all_families = {o.source_family for o in obs_list}

        # Minimum catalog visibility threshold: >= 2 benchmarks, OR >= 3 observations
        # Supported requires >= 2 independent families, >= 2 categories, and >= 4 distinct benchmarks
        is_supported = (
            len(indep_families) >= 2
            and len(covered_cats) >= 2
            and "repo" in covered_cats
            and len(distinct_benchmarks) >= 4
        )
        is_eligible_overall = (
            len(distinct_benchmarks) >= 3
            and len(covered_cats) >= 2
            and "repo" in covered_cats
        )

        latest_date = max((o.date or "" for o in obs_list), default="") or None

        results[mid] = {
            "canonical_id": mid,
            "overall_score": round(overall, 2),
            "overall_se": round(overall_se, 2),
            "ci_90": [ci_low, ci_high],
            "category_scores": cat_scores,
            "category_se": cat_se,
            "covered_categories": covered_cats,
            "benchmark_count": len(distinct_benchmarks),
            "observation_count": len(obs_list),
            "independent_family_count": len(indep_families),
            "source_family_count": len(all_families),
            "evidence_status": "Supported" if is_supported else "Estimated",
            "eligible_overall": is_eligible_overall,
            "latest_date": latest_date,
        }

    # Enforce 2-point close-call guard for single-family Estimated entries
    ranked_pool = [r for r in results.values() if r["eligible_overall"]]
    ranked_pool.sort(key=lambda r: r["overall_score"], reverse=True)

    # Bubble-adjust single-source Estimated entries downward if within 2 points above another entry
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
