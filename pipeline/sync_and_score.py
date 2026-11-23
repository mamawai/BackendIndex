"""Orchestrator: fetch all live backend benchmarks, calibrate via 2PL IRT, emit snapshot.json."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from config import BENCHMARK_REGISTRY, CATEGORY_META, CATEGORY_WEIGHTS
from fetchers import (
    fetch_aider_polyglot,
    fetch_benchlm_supplements,
    fetch_bughunt,
    fetch_compilebench,
    fetch_epoch_archive,
    fetch_livesqlbench,
    fetch_multiswebench,
    fetch_openrouter_and_aa,
    fetch_otelbench,
    fetch_scale_sql,
    fetch_spider2,
    fetch_swe_rebench,
    fetch_tbench,
    fetch_vals,
)
from irt_scorer import deduplicate_observations, score_all_models
from models import ModelMetadata, Observation
from normalizer import ModelNormalizer

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


def run_pipeline(refresh: bool = False) -> Path:
    norm = ModelNormalizer()
    meta_map: dict[str, ModelMetadata] = {}
    all_obs: list[Observation] = []
    source_stats: dict[str, dict[str, int | str]] = {}

    def ingest(name: str, fn) -> None:
        try:
            res = fn()
            if isinstance(res, tuple) and len(res) == 2 and isinstance(res[1], list):
                added = res[1]
                all_obs.extend(added)
                source_stats[name] = {"status": "ok", "observations": len(added)}
            else:
                all_obs.extend(res)
                source_stats[name] = {"status": "ok", "observations": len(res)}
        except Exception as exc:  # noqa: BLE001
            source_stats[name] = {"status": "error", "error": str(exc)}

    print("1/11 Fetching OpenRouter pricing, context & AA indices...")
    meta_map, or_obs = fetch_openrouter_and_aa(norm, refresh=refresh)
    all_obs.extend(or_obs)
    source_stats["openrouter_aa"] = {"status": "ok", "observations": len(or_obs), "models_meta": len(meta_map)}

    print("2/11 Fetching Epoch AI benchmark_data.zip...")
    ingest("epoch_archive", lambda: fetch_epoch_archive(norm, meta_map, refresh=refresh))

    print("3/11 Fetching Terminal-Bench 4.1 (tbench.ai)...")
    ingest("terminal_bench_41", lambda: fetch_tbench(norm, refresh=refresh))

    print("4/11 Fetching Bug Hunt Bench (benchmark.json)...")
    ingest("bug_hunt_bench", lambda: fetch_bughunt(norm, refresh=refresh))

    print("5/11 Fetching SWE-rebench...")
    ingest("swe_rebench", lambda: fetch_swe_rebench(norm, refresh=refresh))

    print("6/11 Fetching Vals AI (SWE-bench, ProgramBench, Migration, IOI, Cyber, Terminal-Bench)...")
    ingest("vals_ai", lambda: fetch_vals(norm, refresh=refresh))

    print("7/11 Fetching ActionTech SCALE SQL & LiveSQLBench...")
    ingest("scale_sql", lambda: fetch_scale_sql(norm, refresh=refresh))
    ingest("livesqlbench", lambda: fetch_livesqlbench(norm, refresh=refresh))

    print("8/11 Fetching Spider 2.0 (Snow / DBT / Lite)...")
    ingest("spider2", lambda: fetch_spider2(norm, refresh=refresh))

    print("9/11 Fetching Quesma OTelBench...")
    ingest("otelbench", lambda: fetch_otelbench(norm, refresh=refresh))

    print("10/11 Fetching Quesma CompileBench, Multi-SWE-bench & Aider Polyglot...")
    ingest("compilebench", lambda: fetch_compilebench(norm, refresh=refresh))
    ingest("multi_swe_bench", lambda: fetch_multiswebench(norm, refresh=refresh))
    ingest("aider_polyglot", lambda: fetch_aider_polyglot(norm, refresh=refresh))

    print("11/11 Fetching BenchLM Nov 2026 supplementary tracks & Scale SWE-Atlas...")
    ingest("benchlm_supplements", lambda: fetch_benchlm_supplements(norm, refresh=refresh))

    print(f"\nTotal raw observations collected: {len(all_obs)}")
    print("Running Category-First 2PL IRT Calibration...")
    scored_models, calibrations = score_all_models(all_obs)

    # Group ledger observations & harnesses per canonical model
    obs_by_model: dict[str, list[Observation]] = {}
    for obs in all_obs:
        if not obs.is_agent_product:
            obs_by_model.setdefault(obs.canonical_model_id, []).append(obs)

    # Also build best representative benchmark matrix per model for category tabs
    rep_scores_by_model: dict[str, dict[str, dict]] = {}
    for cat in CATEGORY_WEIGHTS:
        best_pairs = deduplicate_observations(all_obs, cat)
        for (mid, bid), obs in best_pairs.items():
            rep_scores_by_model.setdefault(mid, {})[bid] = {
                "score": round(obs.raw_score * 100.0, 2),
                "display": obs.raw_display,
                "harness": obs.harness,
                "effort": obs.effort,
                "source_type": obs.source_type,
                "date": obs.date,
            }

    models_payload = []
    for mid, score_info in scored_models.items():
        if not score_info["eligible_overall"]:
            continue
        m_obs = obs_by_model.get(mid, [])
        meta = meta_map.get(mid)

        # Pick cleanest display name & organization
        display_name = meta.display_name if meta else m_obs[0].display_name
        org = meta.organization if meta else m_obs[0].organization

        # Infer dominant harness & harness variants
        harnesses = sorted({o.harness for o in m_obs if o.harness})
        primary_harness = harnesses[0] if harnesses else None

        # Average measured eval cost if available
        eval_costs = [o.cost_usd for o in m_obs if o.cost_usd is not None and o.cost_usd > 0]

        ledger = [
            {
                "benchmark_id": o.benchmark_id,
                "benchmark_name": o.benchmark_name,
                "category": o.category,
                "score": round(o.raw_score * 100.0, 2),
                "raw_display": o.raw_display,
                "source_family": o.source_family,
                "source_type": o.source_type,
                "source_url": o.source_url,
                "harness": o.harness,
                "effort": o.effort,
                "date": o.date,
                "cost_usd": o.cost_usd,
                "tokens": o.tokens,
                "margin": round(o.margin * 100.0, 2) if o.margin is not None else None,
            }
            for o in sorted(
                m_obs,
                key=lambda x: (x.category, x.benchmark_id, -(x.raw_score)),
            )
        ]

        models_payload.append(
            {
                **score_info,
                "display_name": display_name,
                "organization": org,
                "is_open_weight": meta.is_open_weight if meta else False,
                "release_date": meta.release_date if meta else None,
                "context_length": meta.context_length if meta else None,
                "prompt_price_per_1m": meta.prompt_price_per_1m if meta else None,
                "completion_price_per_1m": meta.completion_price_per_1m if meta else None,
                "cache_read_price_per_1m": meta.cache_read_price_per_1m if meta else None,
                "blended_price_per_1m": meta.blended_price_per_1m if meta else None,
                "openrouter_id": meta.openrouter_id if meta else None,
                "harnesses": harnesses,
                "primary_harness": primary_harness,
                "avg_eval_cost_usd": round(sum(eval_costs) / len(eval_costs), 2) if eval_costs else None,
                "representative_benchmarks": rep_scores_by_model.get(mid, {}),
                "ledger": ledger,
            }
        )

    models_payload.sort(key=lambda x: x["rank"])

    snapshot = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method": "BackendIndex-2PL-IRT-v2.0",
        "categories": {
            cid: {
                **CATEGORY_META[cid],
                "weight": CATEGORY_WEIGHTS[cid],
                "irt_benchmarks": calibrations[cid].benchmark_params,
            }
            for cid in CATEGORY_WEIGHTS
        },
        "benchmarks": {
            bid: {
                "id": spec.id,
                "name": spec.name,
                "category": spec.category,
                "source_family": spec.source_family,
                "source_url": spec.source_url,
                "freshness": spec.freshness,
                "tier": spec.tier,
                "base_weight": spec.base_weight,
                "description": spec.description,
                "scored": spec.scored,
            }
            for bid, spec in BENCHMARK_REGISTRY.items()
        },
        "source_health": source_stats,
        "summary": {
            "ranked_models": len(models_payload),
            "supported_models": sum(1 for m in models_payload if m["evidence_status"] == "Supported"),
            "estimated_models": sum(1 for m in models_payload if m["evidence_status"] == "Estimated"),
            "total_observations": len(all_obs),
            "tracked_benchmarks": len(BENCHMARK_REGISTRY),
        },
        "models": models_payload,
    }

    out_path = DATA_DIR / "snapshot.json"
    out_path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nSaved snapshot to {out_path}")
    print("Source health:", json.dumps(source_stats, indent=2, ensure_ascii=False))
    print(
        f"\nRanked models: {snapshot['summary']['ranked_models']} "
        f"(Supported: {snapshot['summary']['supported_models']}, "
        f"Estimated: {snapshot['summary']['estimated_models']})"
    )
    print("\n=== Top 25 BackendIndex Leaderboard (6D) ===")
    print(f"{'Rank':<4} {'Model':<26} {'Org':<12} {'Score':>6} {'90% CI':<15} {'Status':<10} {'Repo':>5} {'Arch':>5} {'Sys':>5} {'SQL':>5} {'Perf':>5} {'Sec':>5} {'Bmks':>4}")
    print("-" * 122)
    for m in models_payload[:25]:
        cs = m["category_scores"]
        fmt = lambda v: f"{v:5.1f}" if v is not None else "   --"
        ci = f"[{m['ci_90'][0]:.1f}, {m['ci_90'][1]:.1f}]"
        print(
            f"{m['rank']:<4} {m['display_name'][:25]:<26} {m['organization'][:11]:<12} "
            f"{m['overall_score']:6.2f} {ci:<15} {m['evidence_status']:<10} "
            f"{fmt(cs['repo'])} {fmt(cs['architecture'])} {fmt(cs['systems'])} {fmt(cs['sql'])} {fmt(cs['performance'])} {fmt(cs['security'])} {m['benchmark_count']:>4}"
        )
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync backend benchmarks & compute 2PL IRT scores.")
    parser.add_argument("--refresh", action="store_true", help="Ignore local HTTP cache and fetch fresh data.")
    args = parser.parse_args()
    run_pipeline(refresh=args.refresh)


if __name__ == "__main__":
    main()
