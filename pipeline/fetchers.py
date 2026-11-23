"""Live data fetchers and parsers for all verified backend benchmark sources."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import time
import zipfile
from pathlib import Path
from typing import Any

import requests
import yaml
from bs4 import BeautifulSoup

from config import BENCHMARK_REGISTRY, SourceType
from models import ModelMetadata, Observation
from normalizer import ModelNormalizer, infer_organization

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

HEADERS = {"User-Agent": "BackendIndex-ETL/1.0"}
DEFAULT_TTL_SEC = 12 * 3600


def cached_get(url: str, refresh: bool = False, binary: bool = False) -> bytes:
    """Fetch URL with local disk cache to avoid hammering upstream servers."""
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    ext = ".bin" if binary else ".txt"
    cache_path = CACHE_DIR / f"{digest}{ext}"
    if not refresh and cache_path.exists():
        age = time.time() - cache_path.stat().st_mtime
        if age < DEFAULT_TTL_SEC:
            return cache_path.read_bytes()
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    cache_path.write_bytes(resp.content)
    return resp.content


def cached_text(url: str, refresh: bool = False) -> str:
    return cached_get(url, refresh=refresh, binary=False).decode("utf-8", errors="ignore")


def parse_pct(text: str) -> tuple[float | None, float | None]:
    """Parse percentage/rate strings like '71.2% ± 2.9%' or '0.699' into [0,1]."""
    if not text:
        return None, None
    clean = text.replace(",", "").strip()
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*%?(?:\s*±\s*(\d+(?:\.\d+)?)\s*%?)?", clean)
    if not m:
        return None, None
    val = float(m.group(1))
    margin = float(m.group(2)) if m.group(2) else None
    if "%" in clean or val > 1.0:
        val = val / 100.0
        if margin is not None:
            margin = margin / 100.0
    return max(0.0, min(1.0, val)), margin


def parse_cost(text: str) -> float | None:
    if not text:
        return None
    clean = text.replace(",", "").strip().lower()
    m = re.search(r"\$?\s*(\d+(?:\.\d+)?)\s*(k)?", clean)
    if not m:
        return None
    val = float(m.group(1))
    if m.group(2) == "k":
        val *= 1000.0
    return val


def parse_tokens(text: str) -> float | None:
    if not text:
        return None
    clean = text.replace(",", "").strip().lower()
    m = re.search(r"(\d+(?:\.\d+)?)\s*([kmb])?", clean)
    if not m:
        return None
    val = float(m.group(1))
    mult = {"k": 1e3, "m": 1e6, "b": 1e9}.get(m.group(2) or "", 1.0)
    return val * mult


def make_obs(
    norm: ModelNormalizer,
    benchmark_id: str,
    raw_model: str,
    raw_score: float,
    raw_display: str,
    *,
    org_hint: str | None = None,
    harness: str | None = None,
    effort: str | None = None,
    source_type: SourceType | None = None,
    date: str | None = None,
    cost_usd: float | None = None,
    tokens: float | None = None,
    duration_sec: float | None = None,
    margin: float | None = None,
    extra: dict[str, Any] | None = None,
) -> Observation:
    spec = BENCHMARK_REGISTRY[benchmark_id]
    cid, disp, org, parsed_eff, parsed_harness, is_agent = norm.normalize(
        raw_model, org_hint=org_hint, harness_hint=harness
    )
    return Observation(
        raw_model_name=raw_model,
        canonical_model_id=cid,
        display_name=disp,
        organization=org,
        benchmark_id=benchmark_id,
        benchmark_name=spec.name,
        category=spec.category,
        raw_score=max(0.0, min(1.0, raw_score)),
        raw_display=raw_display,
        source_family=spec.source_family,
        source_type=source_type or spec.default_source_type,
        source_url=spec.source_url,
        harness=parsed_harness or harness,
        effort=effort or parsed_eff,
        date=date,
        cost_usd=cost_usd,
        tokens=tokens,
        duration_sec=duration_sec,
        margin=margin,
        is_agent_product=is_agent,
        extra=extra or {},
    )


def fetch_openrouter_and_aa(
    norm: ModelNormalizer, refresh: bool = False
) -> tuple[dict[str, ModelMetadata], list[Observation]]:
    """Fetch OpenRouter live pricing/context/open-weight metadata & embedded AA scores."""
    raw = json.loads(cached_text("https://openrouter.ai/api/v1/models", refresh=refresh))
    models = raw.get("data", [])
    norm.register_openrouter_models(models)

    meta_map: dict[str, ModelMetadata] = {}
    obs_list: list[Observation] = []

    for m in models:
        mid = m.get("id", "")
        if any(tag in mid for tag in (":batch", ":free", ":extended")):
            continue
        raw_name = m.get("name", mid)
        org_part, model_part = (
            [p.strip() for p in raw_name.split(":", 1)] if ":" in raw_name else ("", raw_name)
        )
        cid, disp, org, _, _, _ = norm.normalize(model_part, org_hint=org_part)
        pricing = m.get("pricing") or {}
        try:
            prompt_1m = float(pricing["prompt"]) * 1_000_000 if pricing.get("prompt") else None
            comp_1m = float(pricing["completion"]) * 1_000_000 if pricing.get("completion") else None
            cache_1m = (
                float(pricing["input_cache_read"]) * 1_000_000
                if pricing.get("input_cache_read")
                else None
            )
        except (ValueError, TypeError):
            prompt_1m = comp_1m = cache_1m = None

        blended = (
            round((prompt_1m + comp_1m) / 2.0, 4)
            if prompt_1m is not None and comp_1m is not None
            else None
        )
        hf_id = m.get("hugging_face_id")
        is_open = bool(hf_id)

        # Keep base variant if cid already exists (prefer non-suffixed OpenRouter entry)
        if cid not in meta_map or (":" not in mid and meta_map[cid].openrouter_id and ":" in meta_map[cid].openrouter_id):
            meta_map[cid] = ModelMetadata(
                canonical_id=cid,
                display_name=disp,
                organization=org,
                is_open_weight=is_open,
                context_length=m.get("context_length"),
                prompt_price_per_1m=round(prompt_1m, 4) if prompt_1m is not None else None,
                completion_price_per_1m=round(comp_1m, 4) if comp_1m is not None else None,
                cache_read_price_per_1m=round(cache_1m, 4) if cache_1m is not None else None,
                blended_price_per_1m=blended,
                openrouter_id=mid,
                huggingface_id=hf_id,
            )

        aa = (m.get("benchmarks") or {}).get("artificial_analysis") or {}
        if aa.get("engineering_index") is not None:
            val = float(aa["engineering_index"]) / 100.0
            obs_list.append(
                make_obs(
                    norm,
                    "aa_engineering",
                    model_part,
                    val,
                    f"{aa['engineering_index']:.1f}",
                    org_hint=org_part,
                    date="2026-11-20",
                )
            )
        if aa.get("cyber_index") is not None:
            val = float(aa["cyber_index"]) / 100.0
            obs_list.append(
                make_obs(
                    norm,
                    "aa_cyber",
                    model_part,
                    val,
                    f"{aa['cyber_index']:.1f}",
                    org_hint=org_part,
                    date="2026-11-20",
                )
            )

    return meta_map, obs_list


def fetch_epoch_archive(
    norm: ModelNormalizer, meta_map: dict[str, ModelMetadata], refresh: bool = False
) -> list[Observation]:
    """Ingest Epoch AI benchmark_data.zip CSVs covering backend coding/systems/security."""
    zip_bytes = cached_get("https://epoch.ai/data/benchmark_data.zip", refresh=refresh, binary=True)
    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))

    # 1. Register model_metadata.csv first so normalization is exact
    mm_rows = [
        r
        for r in csv.DictReader(io.TextIOWrapper(zf.open("model_metadata.csv"), encoding="utf-8"))
        if r.get("display_name")
    ]
    norm.register_epoch_metadata(mm_rows)

    for r in mm_rows:
        grp = (r.get("model_group") or "").strip()
        if not grp:
            continue
        cid, disp, org, _, _, _ = norm.normalize(grp, org_hint=r.get("organization"))
        acc = (r.get("accessibility") or "").lower()
        is_open = "open" in acc
        rel_date = (r.get("date") or "").strip() or None
        if cid not in meta_map:
            meta_map[cid] = ModelMetadata(
                canonical_id=cid,
                display_name=disp,
                organization=org,
                release_date=rel_date,
                is_open_weight=is_open,
            )
        else:
            if rel_date and (not meta_map[cid].release_date or rel_date > meta_map[cid].release_date):
                meta_map[cid].release_date = rel_date
            if is_open:
                meta_map[cid].is_open_weight = True

    specs_map: list[tuple[str, str, str, str | None, str | None]] = [
        ("mirrorcode.csv", "mirrorcode", "mean_score", None, None),
        ("frontierswe_external.csv", "frontierswe", "Score", "Harness", None),
        ("frontiercode_external.csv", "frontiercode", "Main score", "Harness", "Reasoning effort"),
        ("deepswe_external.csv", "deepswe", "Pass@1", "Harness", "Reasoning effort"),
        ("cursorbench_external.csv", "cursorbench", "Score", None, "Reasoning level"),
        ("gso_external.csv", "gso", "Score OPT@1", "Scaffold", None),
        ("algotune_external.csv", "algotune", "Score", None, None),
        ("cybench_external.csv", "cybench", "Unguided % Solved", None, None),
        ("exploitbench_external.csv", "exploitbench", "Mean capability", None, None),
    ]

    obs_list: list[Observation] = []
    for filename, bench_id, score_col, harness_col, effort_col in specs_map:
        if filename not in zf.namelist():
            continue
        rows = list(csv.DictReader(io.TextIOWrapper(zf.open(filename), encoding="utf-8")))
        for r in rows:
            raw_ver = (r.get("Model version") or "").strip()
            raw_val_str = (r.get(score_col) or "").strip()
            if not raw_ver or not raw_val_str:
                continue
            try:
                val = float(raw_val_str)
            except ValueError:
                continue
            if val > 1.0:
                val = val / 100.0
            harness = (r.get(harness_col) or "").strip() or None if harness_col else None
            effort = (r.get(effort_col) or "").strip() or None if effort_col else None
            cost_val = None
            if r.get("Cost per task"):
                try:
                    cost_val = float(r["Cost per task"])
                except ValueError:
                    pass
            tok_val = None
            if r.get("Tokens per task"):
                try:
                    tok_val = float(r["Tokens per task"])
                except ValueError:
                    pass
            obs_list.append(
                make_obs(
                    norm,
                    bench_id,
                    raw_ver,
                    val,
                    f"{val * 100:.1f}%",
                    org_hint=r.get("Organization"),
                    harness=harness,
                    effort=effort,
                    date=(r.get("Release date") or "").strip() or None,
                    cost_usd=cost_val,
                    tokens=tok_val,
                )
            )
    return obs_list


def fetch_tbench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse Terminal-Bench 4.1 SSR table from https://www.tbench.ai/."""
    html = cached_text("https://www.tbench.ai/", refresh=refresh)
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    obs_list: list[Observation] = []
    # Table 1 holds the 54+ Terminal-Bench 4.1 model rows
    for tbl in tables:
        trs = tbl.find_all("tr")
        if len(trs) < 15:
            continue
        for tr in trs[1:]:
            cols = [c.get_text(" ", strip=True) for c in tr.find_all("td")]
            if len(cols) < 4:
                continue
            model_name = cols[1]
            agent = cols[2] if len(cols) > 2 else None
            rate, margin = parse_pct(cols[3])
            if rate is None:
                continue
            date = cols[4] if len(cols) > 4 else None
            tokens = parse_tokens(cols[5]) if len(cols) > 5 else None
            cost = parse_cost(cols[6]) if len(cols) > 6 else None
            obs_list.append(
                make_obs(
                    norm,
                    "terminal_bench_41",
                    model_name,
                    rate,
                    cols[3],
                    harness=agent,
                    date=date,
                    cost_usd=cost,
                    tokens=tokens,
                    margin=margin,
                )
            )
    return obs_list


def fetch_bughunt(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse Bug Hunt Bench native JSON (105 planted bugs across 2 production repos)."""
    raw = json.loads(cached_text("https://bughunt.productcompass.pm/data/benchmark.json", refresh=refresh))
    planted = float(raw.get("meta", {}).get("planted_total", 105))
    obs_list: list[Observation] = []
    for r in raw.get("runs", []):
        model = (r.get("model") or "").strip()
        fixed = r.get("fixed")
        if not model or fixed is None:
            continue
        score = float(fixed) / planted
        obs_list.append(
            make_obs(
                norm,
                "bughunt",
                model,
                score,
                f"{float(fixed):.1f} / {int(planted)} ({score * 100:.1f}%)",
                org_hint=r.get("vendor"),
                harness=r.get("harness"),
                effort=r.get("effort"),
                source_type="benchmark_run",
                date=r.get("date"),
                cost_usd=float(r["cost_usd"]) if r.get("cost_usd") is not None else None,
                duration_sec=float(r["wall_min"]) * 60.0 if r.get("wall_min") is not None else None,
            )
        )
    return obs_list


def fetch_swe_rebench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse SWE-rebench SSR leaderboard table."""
    html = cached_text("https://swe-rebench.com/", refresh=refresh)
    soup = BeautifulSoup(html, "html.parser")
    tbl = soup.find("table")
    if not tbl:
        return []
    obs_list: list[Observation] = []
    for tr in tbl.find_all("tr")[1:]:
        cols = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
        if len(cols) < 3:
            continue
        model_raw = cols[1]
        rate, margin = parse_pct(cols[2])
        if rate is None:
            continue
        cost = parse_cost(cols[4]) if len(cols) > 4 else None
        tokens = parse_tokens(cols[5]) if len(cols) > 5 else None
        obs_list.append(
            make_obs(
                norm,
                "swe_rebench",
                model_raw,
                rate,
                cols[2],
                cost_usd=cost,
                tokens=tokens,
                margin=margin,
            )
        )
    return obs_list


def fetch_vals(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse Vals AI SSR HTML tables for SWE-bench, ProgramBench, Code Migration, IOI, Cyber, Terminal-Bench."""
    pages = [
        ("vals_swebench", "https://www.vals.ai/benchmarks/swebench"),
        ("vals_programbench", "https://www.vals.ai/benchmarks/programbench"),
        ("vals_code_migration", "https://www.vals.ai/benchmarks/code-migration-v1-1"),
        ("vals_ioi", "https://www.vals.ai/benchmarks/ioi"),
        ("vals_cyber", "https://www.vals.ai/benchmarks/cyber"),
        ("vals_terminal_bench", "https://www.vals.ai/benchmarks/terminal-bench"),
    ]
    obs_list: list[Observation] = []
    for bench_id, url in pages:
        html = cached_text(url, refresh=refresh)
        soup = BeautifulSoup(html, "html.parser")
        tbl = soup.find("table")
        if not tbl:
            continue
        headers = [th.get_text(" ", strip=True).lower() for th in tbl.find_all("tr")[0].find_all(["th", "td"])]
        for tr in tbl.find_all("tr")[1:]:
            cols = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
            if len(cols) < 3:
                continue
            row_map = dict(zip(headers, cols))
            model_name = row_map.get("model", "")
            score_str = row_map.get("score") or row_map.get("accuracy") or ""
            rate, _ = parse_pct(score_str)
            if not model_name or rate is None:
                continue
            harness = row_map.get("harness")
            cost = parse_cost(row_map.get("cost / test", ""))
            tokens = parse_tokens(row_map.get("tokens / test", ""))
            obs_list.append(
                make_obs(
                    norm,
                    bench_id,
                    model_name,
                    rate,
                    score_str,
                    harness=harness,
                    cost_usd=cost,
                    tokens=tokens,
                )
            )
    return obs_list


def fetch_livesqlbench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse LiveSQLBench-Base-Full SSR table from https://livesqlbench.ai/."""
    html = cached_text("https://livesqlbench.ai/", refresh=refresh)
    soup = BeautifulSoup(html, "html.parser")
    tbl = soup.find("table")
    if not tbl:
        return []
    obs_list: list[Observation] = []
    for tr in tbl.find_all("tr")[1:]:
        cells = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
        if len(cells) < 4:
            continue
        date_m = re.search(r"(\d{4}-\d{2}-\d{2})", cells[0])
        date = date_m.group(1) if date_m else None
        model_raw = re.sub(r"\s*Reported\s+in.*$", "", cells[1], flags=re.I).strip()
        rate, _ = parse_pct(cells[3])
        if not model_raw or rate is None:
            continue
        cost = parse_cost(cells[4]) if len(cells) > 4 else None
        stype: SourceType = "lab_reported" if "reported in" in cells[1].lower() else "benchmark_run"
        obs = make_obs(
            norm,
            "livesqlbench",
            model_raw,
            rate,
            f"{rate * 100:.2f}%",
            org_hint=cells[2] if len(cells) > 2 else None,
            source_type=stype,
            date=date,
            cost_usd=cost,
        )
        if infer_organization(obs.display_name) == "Other":
            obs.is_agent_product = True
        obs_list.append(obs)
    return obs_list


def fetch_scale_sql(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch latest ActionTech SCALE SQL evaluation report from GitHub."""
    # Check 2026-06 (and could inspect directory dynamically; 2026-06 was verified latest)
    url = "https://raw.githubusercontent.com/actiontech/sql-llm-benchmark/main/leaderboard/public/data/eval_reports/models-2026-06.json"
    data = json.loads(cached_text(url, refresh=refresh))
    obs_list: list[Observation] = []
    sub_map = {
        "sql_understanding": "scale_sql_understanding",
        "sql_optimization": "scale_sql_optimization",
        "dialect_conversion": "scale_sql_dialect",
    }
    for m in data.get("models", []):
        name = (m.get("real_model_namne") or m.get("name") or "").strip()
        if not name:
            continue
        mtype = (m.get("type") or "").lower()
        is_app = "application" in mtype
        scores = m.get("scores") or {}
        rel_date = (m.get("releaseDate") or "").replace("/", "-") or None
        for skey, bench_id in sub_map.items():
            sub = scores.get(skey)
            if not sub or sub.get("ability_score") is None:
                continue
            val = float(sub["ability_score"]) / 100.0
            obs = make_obs(
                norm,
                bench_id,
                name,
                val,
                f"{sub['ability_score']:.1f}%",
                org_hint=m.get("organization"),
                date=rel_date,
            )
            if is_app:
                obs.is_agent_product = True
            obs_list.append(obs)
    return obs_list


def fetch_spider2(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse Spider 2.0 Snow / DBT / Lite static HTML tables."""
    html = cached_text("https://spider2-sql.github.io/", refresh=refresh)
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    # Table 1: Snow, Table 2: DBT, Table 3: Lite
    table_map = [(1, "spider2_snow"), (2, "spider2_dbt"), (3, "spider2_lite")]
    obs_list: list[Observation] = []
    for idx, bench_id in table_map:
        if idx >= len(tables):
            continue
        for tr in tables[idx].find_all("tr")[1:]:
            cols = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
            if len(cols) < 3:
                continue
            method_raw = cols[1]
            rate, _ = parse_pct(cols[2])
            if rate is None:
                continue
            # Clean trailing citations/org words when "+ Model" exists
            obs = make_obs(norm, bench_id, method_raw, rate, f"{rate * 100:.2f}%")
            # In Spider2, entries without "+" and without a known LLM keyword are standalone products
            if "+" not in method_raw and infer_organization(obs.display_name) == "Other":
                obs.is_agent_product = True
            obs_list.append(obs)
    return obs_list


def fetch_otelbench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Quesma OTelBench overall microservice observability results."""
    summary_url = "https://raw.githubusercontent.com/QuesmaOrg/otel-bench/main/benchmark-results/otel/summary.json"
    summary = json.loads(cached_text(summary_url, refresh=refresh))

    obs_list: list[Observation] = []
    for m_key, stats in (summary.get("ByModel") or {}).items():
        rate = float(stats.get("PassRate", 0.0)) / 100.0
        obs_list.append(
            make_obs(
                norm,
                "otelbench",
                m_key,
                rate,
                f"{stats.get('PassRate', 0.0):.1f}% ({stats.get('Passed')}/{stats.get('Runs')})",
                cost_usd=stats.get("AvgCost"),
                date="2026-01",
            )
        )
    return obs_list


def fetch_compilebench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Aggregate Quesma CompileBench raw execution rows per model."""
    html = cached_text("https://compilebench.com/", refresh=refresh)
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    if len(tables) < 4:
        return []
    agg: dict[str, dict[str, float]] = {}
    for tr in tables[3].find_all("tr")[1:]:
        cols = [c.get_text(" ", strip=True) for c in tr.find_all("td")]
        if len(cols) < 6:
            continue
        model_raw = cols[0]
        cost = parse_cost(cols[3]) or 0.0
        ok = 1.0 if cols[5].lower() == "success" else 0.0
        st = agg.setdefault(model_raw, {"ok": 0.0, "total": 0.0, "cost": 0.0})
        st["ok"] += ok
        st["total"] += 1.0
        st["cost"] += cost

    obs_list: list[Observation] = []
    for model_raw, st in agg.items():
        if st["total"] < 10:
            continue
        rate = st["ok"] / st["total"]
        obs_list.append(
            make_obs(
                norm,
                "compilebench",
                model_raw,
                rate,
                f"{rate * 100:.1f}% ({int(st['ok'])}/{int(st['total'])})",
                cost_usd=round(st["cost"] / st["total"], 4),
                date="2025-10-15",
            )
        )
    return obs_list


def fetch_multiswebench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Multi-SWE-bench 8-language Verified overall aggregate results."""
    url = "https://raw.githubusercontent.com/multi-swe-bench/experiments/refs/heads/dist/leaderboard.json"
    data = json.loads(cached_text(url, refresh=refresh))

    per_model_lang: dict[str, dict[str, tuple[float, str | None, str | None]]] = {}

    for lang_block in data:
        lang = lang_block.get("name", "")
        for board in lang_block.get("data", []):
            if board.get("name") != "Verified":
                continue
            for r in board.get("results", []):
                raw_name = r.get("name", "")
                rate = r.get("resolvedRate")
                if not raw_name or rate is None:
                    continue
                cid, _, _, _, harness, is_agent = norm.normalize(raw_name)
                if is_agent:
                    continue
                score_pct = float(rate) * 100.0
                date = r.get("date")
                prev = per_model_lang.setdefault(cid, {}).get(lang)
                if prev is None or score_pct > prev[0]:
                    per_model_lang[cid][lang] = (score_pct, harness, date)

    obs_list: list[Observation] = []
    for cid, langs in per_model_lang.items():
        vals = [pct for pct, _, _ in langs.values()]
        latest_date = max((dt or "" for _, _, dt in langs.values()), default="")
        if len(vals) >= 3:
            avg = sum(vals) / len(vals) / 100.0
            obs_list.append(
                make_obs(
                    norm,
                    "multi_swe_bench",
                    cid,
                    avg,
                    f"{avg * 100:.1f}% ({len(vals)} langs)",
                    date=latest_date or None,
                )
            )
    return obs_list


def fetch_aider_polyglot(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Aider Polyglot 6-language benchmark YAML from official GitHub repo."""
    url = "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml"
    rows = yaml.safe_load(cached_text(url, refresh=refresh)) or []
    obs_list: list[Observation] = []
    for r in rows:
        model = (r.get("model") or "").strip()
        rate = r.get("pass_rate_2")
        if not model or rate is None:
            continue
        score = float(rate) / 100.0
        edit_fmt = r.get("edit_format")
        harness = f"Aider ({edit_fmt})" if edit_fmt else "Aider"
        dt = str(r.get("date")) if r.get("date") else None
        cost = float(r["total_cost"]) if r.get("total_cost") is not None else None
        obs_list.append(
            make_obs(
                norm,
                "aider_polyglot",
                model,
                score,
                f"{float(rate):.1f}% (pass@2)",
                harness=harness,
                date=dt,
                cost_usd=cost,
            )
        )
    return obs_list


def fetch_benchlm_supplements(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch recent Nov 2026 tracks referenced on BenchLM (SWE-bench Pro, Scale SWE-Atlas, etc.)."""
    slugs = [
        ("swe_bench_pro", "https://benchlm.ai/benchmarks/swe-bench-pro"),
        ("swe_bench_multilingual", "https://benchlm.ai/benchmarks/swe-bench-multilingual"),
        ("scale_swe_atlas_refactoring", "https://benchlm.ai/benchmarks/scale-swe-atlas-refactoring"),
        ("scale_swe_atlas_testwriting", "https://benchlm.ai/benchmarks/scale-swe-atlas-testwriting"),
        ("scale_swe_atlas_qna", "https://benchlm.ai/benchmarks/scale-swe-atlas-qna"),
        ("nl2repo", "https://benchlm.ai/benchmarks/nl2repo"),
        ("mcpatlas", "https://benchlm.ai/benchmarks/mcpatlas"),
        ("bfcl_v4", "https://benchlm.ai/benchmarks/bfcl-v4"),
        ("cybergym", "https://benchlm.ai/benchmarks/cybergym"),
    ]
    obs_list: list[Observation] = []
    for bench_id, url in slugs:
        html = cached_text(url, refresh=refresh)
        soup = BeautifulSoup(html, "html.parser")
        tbl = soup.find("table")
        if not tbl:
            continue
        headers = [th.get_text(" ", strip=True).lower() for th in tbl.find_all("tr")[0].find_all(["th", "td"])]
        has_who_col = any("who" in h for h in headers)
        for tr in tbl.find_all("tr")[1:]:
            cells = tr.find_all(["th", "td"])
            if len(cells) < 3:
                continue
            # First <a> or <span> contains only the model name without appended provider/provenance spans
            first_node = cells[1].find(["a", "span"])
            model_name = (
                first_node.get_text(" ", strip=True)
                if first_node
                else cells[1].get_text(" ", strip=True)
            )
            score_str = cells[2].get_text(" ", strip=True)
            rate, _ = parse_pct(score_str)
            if not model_name or rate is None:
                continue

            who_text = (
                cells[3].get_text(" ", strip=True)
                if has_who_col and len(cells) > 3
                else cells[1].get_text(" ", strip=True)
            ).lower()
            if "reported by" in who_text and "meta ai (comparison" not in who_text:
                stype: SourceType = "lab_reported"
            elif "third party" in who_text or "comparison table" in who_text or "upstream" in who_text or "carried from" in who_text:
                stype = "third_party"
            elif "run by" in who_text:
                stype = "benchmark_run"
            elif "independent" in who_text:
                stype = "independent_run"
            else:
                stype = BENCHMARK_REGISTRY[bench_id].default_source_type

            obs_list.append(
                make_obs(
                    norm,
                    bench_id,
                    model_name,
                    rate,
                    score_str,
                    source_type=stype,
                    date="2026-11-21",
                )
            )
    return obs_list
