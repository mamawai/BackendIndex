"""Orchestrator: fetch all live backend benchmarks, calibrate via 2PL IRT, emit snapshot.json."""

from __future__ import annotations

import argparse
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from config import (
    BENCHMARK_REGISTRY,
    CATEGORY_META,
    CATEGORY_WEIGHTS,
    FRESH_DAYS,
    SOURCE_TYPE_WEIGHTS,
    STALE_DAYS,
    STALE_FACTOR,
    TIER_WEIGHTS,
    freshness_factor,
)
from fetchers import (
    fetch_aider_polyglot,
    fetch_autobaxbench_hard,
    fetch_benchlm_supplements,
    fetch_bfcl,
    fetch_bughunt,
    fetch_compilebench,
    fetch_cybench,
    fetch_cybergym,
    fetch_epoch_archive,
    fetch_gso,
    fetch_inferencebench,
    fetch_itbench_aa,
    fetch_livesqlbench,
    fetch_multiswebench,
    fetch_openrouter_and_aa,
    fetch_otelbench,
    fetch_scale_sql,
    fetch_spider2,
    fetch_swe_rebench,
    fetch_tbench,
    fetch_tinybird_sql,
    fetch_vals,
)
from irt_scorer import MIN_COVERAGE, score_all_models
from models import ModelMetadata, Observation
from normalizer import ModelNormalizer, harness_family

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

_DATE_RE = re.compile(r"^(\d{4})-(\d{2})(?:-(\d{2}))?")


def _parse_day(value: str | None) -> date | None:
    """ISO 'YYYY-MM-DD' / 'YYYY-MM' to date; month-only values count as the month's last day."""
    if not value:
        return None
    m = _DATE_RE.match(value.strip())
    if not m:
        return None
    year, month = int(m.group(1)), int(m.group(2))
    try:
        if m.group(3):
            return date(year, month, int(m.group(3)))
        return date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)
    except ValueError:
        return None


def compute_freshness(
    all_obs: list[Observation],
    meta_map: dict[str, ModelMetadata],
    as_of: date,
) -> dict[str, dict]:
    """Per-benchmark freshness from data: latest evaluation date or latest release of a model on that board."""
    latest: dict[str, date] = {}
    archived: set[str] = set()
    for o in all_obs:
        if o.is_agent_product:
            continue
        if o.extra.get("archived"):
            archived.add(o.benchmark_id)
        meta = meta_map.get(o.canonical_model_id)
        release = (meta.release_date or meta.listed_date) if meta else None
        # 榜上最近的评测日期，或者榜上最新模型的发布日期，取较新的那个当"最近一次有新动静"
        for day in (_parse_day(o.date), _parse_day(release), _parse_day(o.extra.get("model_release_date"))):
            if day and day <= as_of and (o.benchmark_id not in latest or day > latest[o.benchmark_id]):
                latest[o.benchmark_id] = day

    out: dict[str, dict] = {}
    for bid in BENCHMARK_REGISTRY:
        last = latest.get(bid)
        age = (as_of - last).days if last else None
        is_archived = bid in archived
        if is_archived:
            status = "archived"
        elif last is None:
            status = "unknown"
        elif age is not None and age <= FRESH_DAYS:
            status = "current"
        else:
            status = "aging"
        out[bid] = {
            "last_activity": last.isoformat() if last else None,
            "age_days": age,
            "factor": freshness_factor(age, is_archived),
            "status": status,
        }
    return out


def _primary_harness(model_obs: list[Observation]) -> str | None:
    """Harness used on the most distinct benchmarks (ties: more runs, then name)."""
    benches: dict[str, set[str]] = {}
    runs: dict[str, int] = {}
    for o in model_obs:
        fam = harness_family(o.harness)
        if not fam:
            continue
        benches.setdefault(fam, set()).add(o.benchmark_id)
        runs[fam] = runs.get(fam, 0) + 1
    if not benches:
        return None
    return min(benches, key=lambda f: (-len(benches[f]), -runs[f], f))


def run_pipeline(refresh: bool = False) -> Path:
    norm = ModelNormalizer()
    meta_map: dict[str, ModelMetadata] = {}
    all_obs: list[Observation] = []
    source_stats: dict[str, dict[str, int | str | bool]] = {}

    def ingest(name: str, fn) -> list[Observation]:
        try:
            res = fn()
            if isinstance(res, tuple) and len(res) == 2 and isinstance(res[1], list):
                info_extra, added = res
                all_obs.extend(added)
                stats: dict[str, int | str | bool] = {"status": "ok", "observations": len(added)}
                if isinstance(info_extra, dict):
                    for k, v in info_extra.items():
                        if isinstance(v, (int, str, bool)):
                            stats[k] = v
                source_stats[name] = stats
                return added
            all_obs.extend(res)
            source_stats[name] = {"status": "ok", "observations": len(res)}
            return res
        except Exception as exc:  # noqa: BLE001
            source_stats[name] = {"status": "error", "error": str(exc)}
            return []

    print("1/15 Fetching OpenRouter pricing, context & AA reference indices...")
    meta_map, or_obs = fetch_openrouter_and_aa(norm, refresh=refresh)
    all_obs.extend(or_obs)
    source_stats["openrouter_aa"] = {"status": "ok", "observations": len(or_obs), "models_meta": len(meta_map)}

    print("2/15 Fetching authoritative direct tracks (GSO, Cybench, CyberGym, BFCL)...")
    official_gso = ingest("gso_official", lambda: fetch_gso(norm, refresh=refresh))
    official_cybench = ingest("cybench_official", lambda: fetch_cybench(norm, refresh=refresh))
    ingest("cybergym_official", lambda: fetch_cybergym(norm, refresh=refresh))
    ingest("berkeley_bfcl", lambda: fetch_bfcl(norm, refresh=refresh))

    # Prevent Epoch archive copies from colliding with official GSO/Cybench canonical pairs
    official_pairs = {
        (o.canonical_model_id, o.benchmark_id)
        for o in (*official_gso, *official_cybench)
    }

    print("3/15 Fetching Epoch AI benchmark_data.zip (gap-filling historical rows cleanly)...")
    ingest("epoch_archive", lambda: fetch_epoch_archive(norm, meta_map, official_pairs=official_pairs, refresh=refresh))

    print("4/15 Fetching Terminal-Bench 4.1 & Bug Hunt Bench...")
    ingest("terminal_bench_41", lambda: fetch_tbench(norm, refresh=refresh))
    ingest("bug_hunt_bench", lambda: fetch_bughunt(norm, refresh=refresh))

    print("5/15 Fetching SWE-rebench & Vals AI benchmarks...")
    ingest("swe_rebench", lambda: fetch_swe_rebench(norm, refresh=refresh))
    ingest("vals_ai", lambda: fetch_vals(norm, refresh=refresh))

    print("6/15 Fetching SCALE SQL, LiveSQLBench & Spider 2.0...")
    ingest("scale_sql", lambda: fetch_scale_sql(norm, refresh=refresh))
    ingest("livesqlbench", lambda: fetch_livesqlbench(norm, refresh=refresh))
    ingest("spider2", lambda: fetch_spider2(norm, refresh=refresh))

    print("7/15 Fetching OTelBench, CompileBench, Multi-SWE-bench & Aider Polyglot...")
    ingest("otelbench", lambda: fetch_otelbench(norm, refresh=refresh))
    ingest("compilebench", lambda: fetch_compilebench(norm, refresh=refresh))
    ingest("multi_swe_bench", lambda: fetch_multiswebench(norm, refresh=refresh))
    ingest("aider_polyglot", lambda: fetch_aider_polyglot(norm, refresh=refresh))

    print("8/15 Fetching Scale SWE-Atlas / SWE-bench Pro / Multilingual / NL2Repo / MCP Atlas...")
    ingest("benchlm_supplements", lambda: fetch_benchlm_supplements(norm, refresh=refresh))

    print("9/15 Fetching AutoBaxBench Hard, Tinybird SQL, ITBench-AA & InferenceBench...")
    ingest("autobaxbench_hard", lambda: fetch_autobaxbench_hard(norm, refresh=refresh))
    ingest("tinybird_sql", lambda: fetch_tinybird_sql(norm, refresh=refresh))
    ingest("itbench_aa", lambda: fetch_itbench_aa(norm, refresh=refresh))
    ingest("inferencebench", lambda: fetch_inferencebench(norm, refresh=refresh))

    generated = datetime.now(timezone.utc)
    print(f"\nTotal raw observations collected: {len(all_obs)}")
    print("Computing data-driven benchmark freshness...")
    freshness = compute_freshness(all_obs, meta_map, generated.date())
    print("Running per-dimension 2PL IRT calibration (marginal ML)...")
    scored_models, calibrations, cal_stats = score_all_models(
        all_obs, freshness={bid: f["factor"] for bid, f in freshness.items()}
    )

    obs_by_model: dict[str, list[Observation]] = {}
    for obs in all_obs:
        if not obs.is_agent_product:
            obs_by_model.setdefault(obs.canonical_model_id, []).append(obs)

    # Representative scores come directly from IRT-fitted pairs so un-fitted items never appear as rep scores
    rep_scores_by_model: dict[str, dict[str, dict]] = {}
    for cal in calibrations.values():
        for (mid, bid), obs in cal.fitted_pairs.items():
            rep_scores_by_model.setdefault(mid, {})[bid] = {
                "score": round(obs.raw_score * 100.0, 2),
                "display": obs.raw_display,
                "harness": obs.harness,
                "effort": obs.effort,
                "source_type": obs.source_type,
                "date": obs.date,
                # 这条成绩在拟合里实际用的权重，方法论页的计分示例直接展示它
                "weight": round(cal.pair_weights.get((mid, bid), 0.0), 3),
            }

    models_payload = []
    for mid, score_info in scored_models.items():
        if not score_info["eligible_overall"]:
            continue
        m_obs = obs_by_model.get(mid, [])
        meta = meta_map.get(mid)

        display_name = meta.display_name if meta else m_obs[0].display_name
        org = meta.organization if meta else m_obs[0].organization

        harnesses = sorted({o.harness for o in m_obs if o.harness})

        # Deduplicate ledger deterministically using normalized numeric score (never formatted string)
        seen_ledger: set[tuple[str, float, str, str, str]] = set()
        deduped_obs: list[Observation] = []
        for o in sorted(
            m_obs,
            key=lambda x: (
                x.category,
                x.benchmark_id,
                -(x.extra.get("raw_value", x.raw_score)),
                0 if x.source_type in ("benchmark_run", "independent_run") else 1,
                0 if x.date else 1,
            ),
        ):
            metric_key = round(float(o.extra.get("raw_value", o.raw_score)), 3)
            sig = (o.benchmark_id, metric_key, o.source_family, o.harness or "", o.effort or "")
            if sig in seen_ledger:
                continue
            seen_ledger.add(sig)
            deduped_obs.append(o)

        ledger = []
        for o in deduped_obs:
            spec = BENCHMARK_REGISTRY[o.benchmark_id]
            entry: dict[str, object] = {
                "benchmark_id": o.benchmark_id,
                "benchmark_name": o.benchmark_name,
                "category": o.category,
                "score": round(o.raw_score * 100.0, 2) if spec.scored else None,
                "raw_display": o.raw_display,
                "source_family": o.source_family,
                "source_type": o.source_type,
                "source_url": o.source_url,
                "harness": o.harness,
                "effort": o.effort,
                "date": o.date,
                "cost_usd": o.cost_usd,
                "cost_unit": o.cost_unit,
                "tokens": o.tokens,
                "margin": round(o.margin * 100.0, 2) if o.margin is not None else None,
            }
            if "raw_value" in o.extra:
                entry["raw_value"] = o.extra["raw_value"]
                entry["raw_unit"] = o.extra.get("raw_unit")
            if "effort_note" in o.extra:
                entry["effort_note"] = o.extra["effort_note"]
            ledger.append(entry)

        # Keep observation_count strictly consistent with the deduplicated ledger length
        score_info_synced = {**score_info, "observation_count": len(ledger)}

        models_payload.append(
            {
                **score_info_synced,
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
                "primary_harness": _primary_harness(m_obs),
                "representative_benchmarks": rep_scores_by_model.get(mid, {}),
                "ledger": ledger,
            }
        )

    models_payload.sort(key=lambda x: x["rank"])
    ranked = models_payload
    # 和本维度主组不连通、因此没参与计分的基准
    excluded = {b for bs in cal_stats["excluded_benchmarks"].values() for b in bs}

    snapshot = {
        "generated_at": generated.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method": "BackendIndex-2PL-IRT-v3",
        "rules": {
            "min_coverage": MIN_COVERAGE,
            "fresh_days": FRESH_DAYS,
            "stale_days": STALE_DAYS,
            "stale_factor": STALE_FACTOR,
            "tier_weights": TIER_WEIGHTS,
            "source_weights": SOURCE_TYPE_WEIGHTS,
        },
        "categories": {
            cid: {
                **CATEGORY_META[cid],
                "weight": CATEGORY_WEIGHTS[cid],
                "irt_benchmarks": calibrations[cid].benchmark_params,
                "dispersion": cal_stats["dispersion"][cid],
                "excluded_benchmarks": cal_stats["excluded_benchmarks"].get(cid, []),
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
                "tier": spec.tier,
                "base_weight": spec.base_weight,
                "description": spec.description,
                "scored": spec.scored,
                "core": spec.core,
                "comparable": bid not in excluded,
                "freshness": freshness[bid]["status"],
                "last_activity": freshness[bid]["last_activity"],
                "age_days": freshness[bid]["age_days"],
                "freshness_factor": freshness[bid]["factor"],
            }
            for bid, spec in BENCHMARK_REGISTRY.items()
        },
        "source_health": source_stats,
        "summary": {
            "listed_models": len(models_payload),
            "ranked_models": len(ranked),
            "complete_models": sum(1 for m in ranked if m["complete"]),
            "supported_models": sum(1 for m in ranked if m["evidence_status"] == "Supported"),
            "estimated_models": sum(1 for m in ranked if m["evidence_status"] == "Estimated"),
            "total_observations": len(all_obs),
            "tracked_benchmarks": len(BENCHMARK_REGISTRY),
            "scored_benchmarks": sum(1 for s in BENCHMARK_REGISTRY.values() if s.scored),
            "stale_benchmarks": sum(
                1 for bid, s in BENCHMARK_REGISTRY.items() if s.scored and freshness[bid]["factor"] < 1.0
            ),
        },
        "models": models_payload,
    }

    out_path = DATA_DIR / "snapshot.json"
    out_path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nSaved snapshot to {out_path}")
    print("Source health:", json.dumps(source_stats, indent=2, ensure_ascii=False))
    print(
        f"\nRanked models: {snapshot['summary']['ranked_models']} | Complete data: {snapshot['summary']['complete_models']} "
        f"(Supported: {snapshot['summary']['supported_models']}, Estimated: {snapshot['summary']['estimated_models']}) | "
        f"Stale scored benchmarks: {snapshot['summary']['stale_benchmarks']}/{snapshot['summary']['scored_benchmarks']}"
    )
    print("\n=== Top 25 BackendIndex Leaderboard (6D) ===")
    print(f"{'Rank':<4} {'Model':<26} {'Org':<12} {'Score':>6} {'Interval':<15} {'Cov':>4} {'Status':<10} {'Repo':>5} {'Arch':>5} {'Sys':>5} {'SQL':>5} {'Perf':>5} {'Sec':>5} {'Bmks':>4}")
    print("-" * 128)
    for m in ranked[:25]:
        cs = m["category_scores"]
        fmt = lambda v: f"{v:5.1f}" if v is not None else "   --"
        ci = f"[{m['ci_90'][0]:.1f}, {m['ci_90'][1]:.1f}]"
        print(
            f"{m['rank']:<4} {m['display_name'][:25]:<26} {m['organization'][:11]:<12} "
            f"{m['overall_score']:6.2f} {ci:<15} {m['coverage']:4.2f} {m['evidence_status']:<10} "
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
