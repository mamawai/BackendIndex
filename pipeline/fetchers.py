"""Live data fetchers and parsers for all verified backend benchmark sources."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests
import yaml
from bs4 import BeautifulSoup

from config import BENCHMARK_REGISTRY, SourceType
from models import ModelMetadata, Observation
from normalizer import ModelNormalizer, infer_organization, normalize_effort, normalize_harness

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


def normalize_iso_date(raw: str | None) -> str | None:
    """Normalize heterogeneous upstream date formats (e.g. 'Oct 28, 2026', '2026/06/01') to ISO."""
    if not raw:
        return None
    clean = re.sub(r"\s+", " ", raw).strip()
    if not clean:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}$", clean):
        return clean
    if re.match(r"^\d{4}-\d{2}$", clean):
        return clean
    slash_m = re.match(r"^(\d{4})/(\d{1,2})/(\d{1,2})$", clean)
    if slash_m:
        y, m, d = int(slash_m.group(1)), int(slash_m.group(2)), int(slash_m.group(3))
        return f"{y:04d}-{m:02d}-{d:02d}"
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%b %d %Y", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(clean, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    iso_m = re.search(r"(\d{4}-\d{2}-\d{2})", clean)
    if iso_m:
        return iso_m.group(1)
    return clean


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


def _valid_http_url(url: str | None) -> str | None:
    if url and url.strip().startswith(("http://", "https://")):
        return url.strip()
    return None


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
    source_family: str | None = None,
    source_type: SourceType | None = None,
    source_url: str | None = None,
    date: str | None = None,
    cost_usd: float | None = None,
    cost_unit: str | None = None,
    tokens: float | None = None,
    duration_sec: float | None = None,
    margin: float | None = None,
    force_agent_product: bool = False,
    extra: dict[str, Any] | None = None,
) -> Observation:
    spec = BENCHMARK_REGISTRY[benchmark_id]
    cid, disp, org, parsed_eff, parsed_harness, is_agent = norm.normalize(
        raw_model, org_hint=org_hint, harness_hint=harness
    )
    resolved_url = _valid_http_url(source_url) or spec.source_url
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
        source_family=source_family or spec.source_family,
        source_type=source_type or spec.default_source_type,
        source_url=resolved_url,
        harness=normalize_harness(parsed_harness or harness),
        effort=normalize_effort(effort or parsed_eff),
        date=normalize_iso_date(date),
        cost_usd=cost_usd,
        cost_unit=cost_unit if cost_usd is not None else None,
        tokens=tokens,
        duration_sec=duration_sec,
        margin=margin,
        is_agent_product=force_agent_product or is_agent,
        extra=extra or {},
    )


def fetch_openrouter_and_aa(
    norm: ModelNormalizer, refresh: bool = False
) -> tuple[dict[str, ModelMetadata], list[Observation]]:
    """Fetch OpenRouter live pricing/context/open-weight metadata & embedded AA reference scores."""
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
        created = m.get("created")
        listed = (
            datetime.fromtimestamp(created, tz=timezone.utc).strftime("%Y-%m-%d")
            if isinstance(created, (int, float)) and created > 0
            else None
        )

        if cid not in meta_map or (":" not in mid and meta_map[cid].openrouter_id and ":" in meta_map[cid].openrouter_id):
            meta_map[cid] = ModelMetadata(
                canonical_id=cid,
                display_name=disp,
                organization=org,
                listed_date=listed,
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
                    extra={"raw_value": round(float(aa["engineering_index"]), 2), "raw_unit": "index_pts"},
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
                    extra={"raw_value": round(float(aa["cyber_index"]), 2), "raw_unit": "index_pts"},
                )
            )

    return meta_map, obs_list


def _classify_epoch_cybench_row(row: dict[str, str], model_org: str) -> tuple[str | None, SourceType]:
    """Resolve Cybench provenance from Epoch's Source and Notes columns."""
    src = (row.get("Source") or "").strip()
    notes = (row.get("Notes") or "").strip()
    combined = f"{src} {notes}".lower()
    if "hal" in combined:
        return "HAL", "independent_run"
    if any(k in combined for k in ("model card", "system card")):
        inferred = infer_organization(src, model_org)
        return (inferred if inferred != "Other" else model_org), "lab_reported"
    return "Cybench", "benchmark_run"


def fetch_epoch_archive(
    norm: ModelNormalizer,
    meta_map: dict[str, ModelMetadata],
    official_pairs: set[tuple[str, str]] | None = None,
    refresh: bool = False,
) -> list[Observation]:
    """Ingest Epoch AI benchmark_data.zip CSVs, yielding cleanly to direct official tracks when present."""
    zip_bytes = cached_get("https://epoch.ai/data/benchmark_data.zip", refresh=refresh, binary=True)
    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))

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
        rel_date = normalize_iso_date((r.get("date") or "").strip() or None)
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
        ("frontierswe_external.csv", "frontierswe", "Implementation", "Harness", None),
        ("frontierswe_external.csv", "frontierswe_perf", "Performance", "Harness", None),
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
            raw_ver = (r.get("Model version") or r.get("Name") or "").strip()
            raw_val_str = (r.get(score_col) or "").strip()
            if not raw_ver or not raw_val_str:
                continue
            try:
                raw_num = float(raw_val_str)
            except ValueError:
                continue

            extra: dict[str, Any] = {}
            if bench_id == "algotune":
                # AlgoTune exports raw speedup multipliers; keep unscaled reference value without entering IRT
                raw_display = f"{raw_num:.2f}×"
                val = 0.0
                extra = {"raw_value": round(raw_num, 4), "raw_unit": "speedup_x"}
            else:
                val = raw_num / 100.0 if raw_num > 1.0 else raw_num
                raw_display = f"{val * 100:.1f}%"

            harness = (r.get(harness_col) or "").strip() or None if harness_col else None
            effort = (r.get(effort_col) or "").strip() or None if effort_col else None
            eval_date = (r.get("Evaluation date") or "").strip() or None
            row_url = _valid_http_url(r.get("Source link")) or _valid_http_url(r.get("Source"))

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

            obs = make_obs(
                norm,
                bench_id,
                raw_ver,
                val,
                raw_display,
                org_hint=r.get("Organization"),
                harness=harness,
                effort=effort,
                source_url=row_url,
                date=eval_date,
                cost_usd=cost_val,
                cost_unit="per_task",
                tokens=tok_val,
                extra=extra,
            )
            if bench_id == "cybench":
                fam, stype = _classify_epoch_cybench_row(r, obs.organization)
                if fam:
                    obs.source_family = fam
                obs.source_type = stype

            # Skip Epoch mirror entries when the authoritative official source already provides that (model, benchmark)
            if official_pairs and (obs.canonical_model_id, bench_id) in official_pairs:
                continue

            obs_list.append(obs)
    return obs_list


def fetch_tbench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse Terminal-Bench 4.1 SSR table from https://www.tbench.ai/."""
    html = cached_text("https://www.tbench.ai/", refresh=refresh)
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    obs_list: list[Observation] = []
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
            # 这一列是"模型发布日期"不是评测日期：不当观测日期用，只留给新鲜度判断
            release = normalize_iso_date(cols[4]) if len(cols) > 4 else None
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
                    cost_usd=cost,
                    cost_unit="per_run",
                    tokens=tokens,
                    margin=margin,
                    extra={"model_release_date": release} if release else None,
                )
            )
    return obs_list


def fetch_bughunt(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse Bug Hunt Bench native JSON (excluding superseded partial runs)."""
    raw = json.loads(cached_text("https://bughunt.productcompass.pm/data/benchmark.json", refresh=refresh))
    planted = float(raw.get("meta", {}).get("planted_total", 105))
    obs_list: list[Observation] = []
    for r in raw.get("runs", []):
        if r.get("superseded"):
            continue
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
                cost_unit="per_run",
                duration_sec=float(r["wall_min"]) * 60.0 if r.get("wall_min") is not None else None,
            )
        )
    return obs_list


def fetch_swe_rebench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse SWE-rebench SSR table, preserving Agent/Model badges before trimming."""
    html = cached_text("https://swe-rebench.com/", refresh=refresh)
    soup = BeautifulSoup(html, "html.parser")
    tbl = soup.find("table")
    if not tbl:
        return []
    obs_list: list[Observation] = []
    for tr in tbl.find_all("tr")[1:]:
        tds = tr.find_all(["th", "td"])
        if len(tds) < 3:
            continue
        cell = BeautifulSoup(str(tds[1]), "html.parser")
        org_title_el = cell.find("svg").find("title") if cell.find("svg") else None
        org_hint = org_title_el.get_text(strip=True) if org_title_el else None
        for svg in cell.find_all("svg"):
            svg.decompose()

        label_el = cell.select_one(".g-label")
        label_txt = label_el.get_text(" ", strip=True).lower() if label_el else ""
        is_agent_badge = label_txt == "agent"
        if label_el:
            label_el.decompose()

        name_el = cell.select_one(".rank-table__model-name")
        model_raw = name_el.get_text(" ", strip=True) if name_el else cell.get_text(" ", strip=True)
        model_raw = re.sub(r"\s+(?:Model|Agent)$", "", model_raw, flags=re.I).strip()

        cols = [c.get_text(" ", strip=True) for c in tds]
        rate, margin = parse_pct(cols[2])
        if not model_raw or rate is None:
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
                org_hint=org_hint,
                cost_usd=cost,
                cost_unit="per_task",
                tokens=tokens,
                margin=margin,
                force_agent_product=is_agent_badge,
            )
        )
    return obs_list


def fetch_vals(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse Vals AI SSR HTML tables for SWE-bench, ProgramBench, Code Migration, IOI, Cyber, SRE Bench, Terminal-Bench."""
    pages: list[tuple[str, str, SourceType]] = [
        ("vals_swebench", "https://www.vals.ai/benchmarks/swebench", "independent_run"),
        ("vals_programbench", "https://www.vals.ai/benchmarks/programbench", "independent_run"),
        ("vals_code_migration", "https://www.vals.ai/benchmarks/code-migration-v1-1", "benchmark_run"),
        ("vals_ioi", "https://www.vals.ai/benchmarks/ioi", "benchmark_run"),
        ("vals_cyber", "https://www.vals.ai/benchmarks/cyber", "benchmark_run"),
        ("vals_srebench", "https://www.vals.ai/benchmarks/srebench", "independent_run"),
        ("vals_terminal_bench", "https://www.vals.ai/benchmarks/terminal-bench", "independent_run"),
        ("terminal_bench_40", "https://www.vals.ai/benchmarks/terminal-bench-4", "independent_run"),
    ]
    obs_list: list[Observation] = []
    for bench_id, url, stype in pages:
        html = cached_text(url, refresh=refresh)
        soup = BeautifulSoup(html, "html.parser")
        tbl = soup.find("table")
        if not tbl:
            continue
        # Vals 页面上明确写了"已归档、不再测新模型"的基准，新鲜度直接按陈旧算
        archived = "Archived Benchmark" in html
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
                    # 显式标明 Vals AI 来源家族与链接，避免双源基准（如 TB 4.0）串成默认家族名
                    source_family="Vals AI",
                    source_type=stype,
                    source_url=url,
                    cost_usd=cost,
                    cost_unit="per_task",
                    tokens=tokens,
                    extra={"archived": True} if archived else None,
                )
            )
    return obs_list


def fetch_livesqlbench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse LiveSQLBench-Base-Full v1 table, capturing per-row links and reported badges."""
    html = cached_text("https://livesqlbench.ai/", refresh=refresh)
    soup = BeautifulSoup(html, "html.parser")
    tbl = soup.find("table")
    if not tbl:
        return []
    obs_list: list[Observation] = []
    for tr in tbl.find_all("tr")[1:]:
        tds = tr.find_all(["th", "td"])
        if len(tds) < 4:
            continue
        cells = [c.get_text(" ", strip=True) for c in tds]
        date_m = re.search(r"(\d{4}-\d{2}-\d{2})", cells[0])
        date = date_m.group(1) if date_m else None

        badge_titles = " ".join(el.get("title", "") for el in tds[1].find_all(attrs={"title": True})).lower()
        row_text_low = cells[1].lower()
        model_raw = re.sub(r"\s*Reported\b.*$", "", cells[1], flags=re.I).strip()
        rate, _ = parse_pct(cells[3])
        if not model_raw or rate is None:
            continue

        # LiveSQLBench puts external submission links in later columns (tds[-1] / tds[2])
        row_links = [
            _valid_http_url(a["href"])
            for td in (tds[-1], *tds[1:-1])
            for a in td.find_all("a", href=True)
        ]
        row_url = next((u for u in row_links if u), None)
        cost = parse_cost(cells[4]) if len(cells) > 4 else None
        submitter_org = cells[2] if len(cells) > 2 else None

        if "officially reported" in badge_titles or "reported i" in row_text_low or "reported in" in row_text_low:
            stype: SourceType = "lab_reported"
            obs_family: str | None = infer_organization(model_raw, submitter_org)
        elif "verified by the bird team" in badge_titles:
            stype = "benchmark_run"
            obs_family = "HKU BIRD / LiveSQLBench"
        else:
            stype = "third_party"
            obs_family = submitter_org or "LiveSQLBench Submitters"

        obs = make_obs(
            norm,
            "livesqlbench",
            model_raw,
            rate,
            f"{rate * 100:.2f}%",
            org_hint=submitter_org,
            source_family=obs_family if obs_family != "Other" else None,
            source_type=stype,
            source_url=row_url,
            date=date,
            cost_usd=cost,
            cost_unit="per_task",
        )
        if infer_organization(obs.display_name) == "Other":
            obs.is_agent_product = True
        obs_list.append(obs)
    return obs_list


def fetch_scale_sql(norm: ModelNormalizer, refresh: bool = False) -> tuple[dict[str, Any], list[Observation]]:
    """Discover and fetch the latest ActionTech SCALE SQL evaluation report from GitHub."""
    fallback_file = "models-2026-06.json"
    latest_file = fallback_file
    fallback_used = False
    try:
        dir_url = "https://api.github.com/repos/actiontech/sql-llm-benchmark/contents/leaderboard/public/data/eval_reports"
        entries = json.loads(cached_text(dir_url, refresh=refresh))
        candidates = sorted(
            e["name"]
            for e in entries
            if isinstance(e, dict) and re.match(r"^models-\d{4}-\d{2}\.json$", e.get("name", ""))
        )
        if candidates:
            latest_file = candidates[-1]
        else:
            fallback_used = True
    except Exception:
        fallback_used = True

    month_m = re.search(r"(\d{4}-\d{2})", latest_file)
    report_month = month_m.group(1) if month_m else "2026-06"
    url = f"https://raw.githubusercontent.com/actiontech/sql-llm-benchmark/main/leaderboard/public/data/eval_reports/{latest_file}"
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
                source_url=url,
                date=report_month,
            )
            if is_app:
                obs.is_agent_product = True
            obs_list.append(obs)
    return {"report": latest_file, "fallback_used": fallback_used}, obs_list


def fetch_spider2(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Parse Spider 2.0 tables, removing .affiliation and paperlink citations before entity resolution."""
    html = cached_text("https://spider2-sql.github.io/", refresh=refresh)
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    table_map = [(1, "spider2_snow"), (2, "spider2_dbt"), (3, "spider2_lite")]
    obs_list: list[Observation] = []
    for idx, bench_id in table_map:
        if idx >= len(tables):
            continue
        for tr in tables[idx].find_all("tr")[1:]:
            tds = tr.find_all(["th", "td"])
            if len(tds) < 3:
                continue
            cell = BeautifulSoup(str(tds[1]), "html.parser")
            aff_el = cell.select_one(".affiliation")
            aff_text = aff_el.get_text(" ", strip=True) if aff_el else None
            aff_link_el = aff_el.find("a", href=True) if aff_el else None
            aff_url = _valid_http_url(aff_link_el["href"]) if aff_link_el else None
            if aff_el:
                aff_el.decompose()

            paper_links = [
                _valid_http_url(a["href"])
                for a in cell.find_all("a", class_="paperlink", href=True)
            ]
            for pl in cell.find_all("a", class_="paperlink"):
                pl.decompose()

            method_raw = re.sub(r"\s+", " ", cell.get_text(" ", strip=True)).strip()
            score_text = tds[2].get_text(" ", strip=True)
            rate, _ = parse_pct(score_text)
            if not method_raw or rate is None:
                continue

            stype: SourceType = "benchmark_run" if not aff_text or "xlang" in aff_text.lower() else "third_party"
            fam = aff_text if aff_text and "xlang" not in aff_text.lower() else None
            obs = make_obs(
                norm,
                bench_id,
                method_raw,
                rate,
                f"{rate * 100:.2f}%",
                source_family=fam,
                source_type=stype,
                source_url=aff_url or next((u for u in paper_links if u), None),
            )
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
                # AvgCost = 总花费 / 运行次数，每次运行是一道题
                cost_usd=stats.get("AvgCost"),
                cost_unit="per_task",
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
                cost_unit="per_task",
            )
        )
    return obs_list


def fetch_multiswebench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Multi-SWE-bench 8-language Verified aggregate results."""
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
                date = normalize_iso_date(r.get("date"))
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
                    f"{avg * 100:.1f}% ({len(vals)} langs · multi-harness)",
                    harness="Multi-harness best",
                    source_url=url,
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
                cost_unit="per_run",
            )
        )
    return obs_list


def fetch_gso(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch official GSO Opt@1 results unconditionally scaled as percentages."""
    url = "https://gso-bench.github.io/assets/leaderboard.json"
    data = json.loads(cached_text(url, refresh=refresh))
    obs_list: list[Observation] = []
    for r in data.get("models", []):
        if (r.get("setting") or "Opt@1").lower() != "opt@1":
            continue
        name = (r.get("name") or "").strip()
        raw_score = r.get("score")
        if not name or raw_score is None:
            continue
        val = float(raw_score) / 100.0
        sub_org = (r.get("submission_org_name") or "GSO").strip()
        sub_url = _valid_http_url(r.get("submission_org_url"))
        obs = make_obs(
            norm,
            "gso",
            name,
            val,
            f"{val * 100:.1f}%",
            org_hint=r.get("model_org"),
            harness=r.get("scaffold"),
            effort=r.get("reasoning_effort"),
            source_family=sub_org,
            source_url=sub_url or url,
            date=r.get("date"),
        )
        if sub_org.lower() == "gso":
            obs.source_type = "benchmark_run"
        else:
            sub_vendor = infer_organization(sub_org)
            obs.source_type = "lab_reported" if sub_vendor == obs.organization else "independent_run"
        obs_list.append(obs)
    return obs_list


def _match_footnote_url(links: list[str], model_slug: str) -> str | None:
    if not links:
        return None
    if len(links) == 1:
        return links[0]
    tokens = [t for t in model_slug.split("-") if t not in ("thinking", "preview")]
    best_url = links[0]
    best_hits = -1
    # Prefer longest prefix/token overlap (e.g. 'grok-4-1' -> 'grok-4-1-model-card.pdf')
    for u in links:
        ulow = u.lower()
        joined = "-".join(tokens)
        if joined and joined in ulow:
            return u
        hits = sum(1 for t in tokens if f"-{t}-" in ulow or ulow.endswith(f"-{t}.pdf"))
        if hits > best_hits:
            best_hits = hits
            best_url = u
    return best_url


def fetch_cybench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch official Cybench CSV and resolve superscript + dagger footnotes from cybench.github.io."""
    sup_to_num = str.maketrans("¹²³⁴⁵⁶⁷⁸⁹⁰", "1234567890")
    html = cached_text("https://cybench.github.io/", refresh=refresh)
    soup = BeautifulSoup(html, "html.parser")
    footnote_map: dict[str, tuple[str | None, SourceType, list[str]]] = {}
    for el in soup.find_all(["p", "li", "div"]):
        txt = el.get_text(" ", strip=True)
        if not txt or len(txt) > 320:
            continue
        m = re.match(r"^([¹²³⁴⁵⁶⁷⁸⁹⁰]+)\s*(.+)$", txt)
        if not m:
            continue
        fnum = m.group(1).translate(sup_to_num)
        desc = m.group(2).lower()
        links = [
            u
            for a in el.find_all("a", href=True)
            if (u := _valid_http_url(a["href"]))
        ]
        if "hal" in desc:
            footnote_map[fnum] = ("HAL", "independent_run", links)
        elif any(k in desc for k in ("claude", "opus", "sonnet", "mythos", "anthropic")):
            footnote_map[fnum] = ("Anthropic", "lab_reported", links)
        elif "grok" in desc or "xai" in desc:
            footnote_map[fnum] = ("xAI", "lab_reported", links)
        elif "muse" in desc or "meta" in desc:
            footnote_map[fnum] = ("Meta", "lab_reported", links)

    csv_url = "https://cybench.github.io/data/leaderboard.csv"
    csv_text = cached_text(csv_url, refresh=refresh)
    obs_list: list[Observation] = []
    for row in csv.DictReader(io.StringIO(csv_text)):
        raw_model = (row.get("Model") or "").strip()
        rate, _ = parse_pct(row.get("End-to-End % Solved") or "")
        if not raw_model or rate is None:
            continue
        # Handle multi-markers such as 'OpenAI o3-mini ¹†' cleanly
        tail_m = re.search(r"([\s¹²³⁴⁵⁶⁷⁸⁹⁰†‡*]+)$", raw_model)
        clean_model = raw_model[: tail_m.start()].strip() if tail_m else raw_model
        fnums = [ch.translate(sup_to_num) for ch in (tail_m.group(1) if tail_m else "") if ch in "¹²³⁴⁵⁶⁷⁸⁹⁰"]
        fnum = fnums[0] if fnums else None
        fam, stype, flinks = footnote_map.get(fnum, ("Cybench", "benchmark_run", []))
        slug_hint = re.sub(r"[^a-z0-9]+", "-", clean_model.lower()).strip("-")
        obs_list.append(
            make_obs(
                norm,
                "cybench",
                clean_model,
                rate,
                f"{rate * 100:.1f}%",
                source_family=fam,
                source_type=stype,
                source_url=_match_footnote_url(flinks, slug_hint) or csv_url,
            )
        )
    return obs_list


def fetch_cybergym(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch official CyberGym Level-1 (strict trials=1, focus=model) JSON with vendor provenance."""
    url = "https://www.cybergym.io/assets/data/cybergym.json"
    data = json.loads(cached_text(url, refresh=refresh))
    obs_list: list[Observation] = []
    for r in data.get("level1", []):
        if r.get("focus") != "model" or r.get("trials") != 1:
            continue
        raw_model = (r.get("model") or "").strip()
        score = r.get("score_10")
        if not raw_model or score is None:
            continue

        extra: dict[str, Any] = {}
        ft_m = re.search(r"\(\s*finetuned from\s+([^)]+)\s*\)\s*$", raw_model, flags=re.I)
        clean_model = raw_model[: ft_m.start()].strip() if ft_m else raw_model
        if ft_m:
            extra["finetuned_from"] = ft_m.group(1).strip()

        val = float(score)
        src_raw = (r.get("source") or "CyberGym Team").strip()
        obs = make_obs(
            norm,
            "cybergym",
            clean_model,
            val,
            f"{val * 100:.1f}%",
            harness=r.get("agent"),
            source_url=_valid_http_url(r.get("source_url")) or url,
            date=r.get("date"),
            extra=extra,
        )
        if src_raw.lower() == "cybergym team":
            obs.source_family = "CyberGym Team"
            obs.source_type = "benchmark_run"
        else:
            src_org = infer_organization(src_raw)
            src_family = src_org if src_org != "Other" else src_raw
            obs.source_family = src_family
            obs.source_type = "lab_reported" if src_family == obs.organization else "third_party"
        obs_list.append(obs)
    return obs_list


def fetch_bfcl(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch official Berkeley BFCL overall CSV from gorilla.cs.berkeley.edu/data_overall.csv."""
    url = "https://gorilla.cs.berkeley.edu/data_overall.csv"
    text = cached_text(url, refresh=refresh)
    obs_list: list[Observation] = []
    for row in csv.DictReader(io.StringIO(text)):
        raw_model = (row.get("Model") or "").strip()
        rate, _ = parse_pct(row.get("Overall Acc") or "")
        if not raw_model or rate is None:
            continue
        mode_m = re.search(r"\s*\(((?:FC|Prompt)[^)]*)\)\s*$", raw_model, re.I)
        mode_tag = mode_m.group(1).strip() if mode_m else None
        clean_model = raw_model[: mode_m.start()].strip() if mode_m else raw_model
        cost = parse_cost(row.get("Total Cost ($)") or "")
        obs_list.append(
            make_obs(
                norm,
                "bfcl_v4",
                clean_model,
                rate,
                f"{rate * 100:.2f}%",
                org_hint=row.get("Organization"),
                harness=f"BFCL ({mode_tag})" if mode_tag else "BFCL",
                source_url=_valid_http_url(row.get("Model Link")) or url,
                cost_usd=cost,
                cost_unit="per_run",
            )
        )
    return obs_list


def _parse_benchlm_provenance(
    who_text: str, default_family: str, default_type: SourceType
) -> tuple[str, SourceType]:
    """Resolve true evaluator family and provenance type from BenchLM's Who column."""
    low = who_text.lower()
    if any(k in low for k in ("third party", "reported by a third party", "comparison table", "upstream", "carried from")):
        return default_family, "third_party"
    if "reported by" in low:
        after = re.split(r"reported by\s+", who_text, flags=re.I)[-1].strip()
        vendor = re.split(r"[,(;·]", after)[0].strip()
        org = infer_organization(vendor)
        return (org if org != "Other" else (vendor or default_family)), "lab_reported"
    if "run by" in low:
        return default_family, "benchmark_run"
    if "independent" in low:
        return default_family, "independent_run"
    return default_family, default_type


def fetch_benchlm_supplements(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Scale SWE-Atlas, SWE-bench Pro, SWE-bench Multilingual, NL2Repo, MCP Atlas via BenchLM."""
    slugs = [
        ("swe_bench_pro", "https://benchlm.ai/benchmarks/swe-bench-pro"),
        ("swe_bench_multilingual", "https://benchlm.ai/benchmarks/swe-bench-multilingual"),
        ("scale_swe_atlas_refactoring", "https://benchlm.ai/benchmarks/scale-swe-atlas-refactoring"),
        ("scale_swe_atlas_testwriting", "https://benchlm.ai/benchmarks/scale-swe-atlas-testwriting"),
        ("scale_swe_atlas_qna", "https://benchlm.ai/benchmarks/scale-swe-atlas-qna"),
        ("nl2repo", "https://benchlm.ai/benchmarks/nl2repo"),
        ("mcpatlas", "https://benchlm.ai/benchmarks/mcpatlas"),
    ]
    obs_list: list[Observation] = []
    for bench_id, url in slugs:
        spec = BENCHMARK_REGISTRY[bench_id]
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
            )
            fam, stype = _parse_benchlm_provenance(who_text, spec.source_family, spec.default_source_type)

            obs_list.append(
                make_obs(
                    norm,
                    bench_id,
                    model_name,
                    rate,
                    score_str,
                    source_family=fam,
                    source_type=stype,
                    source_url=url,
                    date=None,
                )
            )
    return obs_list


def fetch_autobaxbench_hard(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch ETH SRI AutoBaxBench Hard sec_pass@1 JSON, excluding author-contaminated models (*)."""
    url = "https://raw.githubusercontent.com/eth-sri/baxbench-website/main/static/data/leaderboard_data_abb_hard.json"
    rows = json.loads(cached_text(url, refresh=refresh))
    obs_list: list[Observation] = []
    # Official page notes Opus 5.5 & Fable 5.2 hit context limits at highest reasoning on certain tasks and ran 'high'
    context_downgraded = {"claude-opus-5-5", "claude-fable-5-2"}

    for row in rows:
        raw_model = (row.get("model") or "").strip()
        sec_pass = row.get("sec_pass_1")
        if not raw_model or sec_pass is None:
            continue
        # '*' designates models used to generate AutoBaxBench tasks (potential contamination)
        if "*" in raw_model:
            continue

        val = max(0.0, min(1.0, float(sec_pass)))
        extra: dict[str, Any] = {}
        if row.get("pass_1") is not None:
            extra["pass_1"] = round(float(row["pass_1"]), 4)
        if row.get("insec_pass") is not None:
            extra["insec_pass"] = round(float(row["insec_pass"]), 4)

        obs = make_obs(
            norm,
            "autobaxbench_hard",
            raw_model,
            val,
            f"{val * 100:.1f}%",
            source_url="https://baxbench.com/autobaxbuilder/",
            extra=extra,
        )
        if obs.canonical_model_id in context_downgraded:
            obs.effort = "max (partial high)"
            obs.extra["effort_note"] = "Partial tasks downgraded from max to high due to context limit"
        obs_list.append(obs)
    return obs_list


def fetch_tinybird_sql(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Tinybird LLM SQL Exactness scores from SSR payload, excluding routers, aliases & latency penalty."""
    url = "https://llm-benchmark.tinybird.live/"
    html = cached_text(url, refresh=refresh)
    unesc = html.replace('\\"', '"').replace("\\\\", "\\")
    blocks = re.findall(r'\{[^{}]{0,1500}"exactnessScore"\s*:\s*[0-9.]+[^{}]{0,1500}\}', unesc)

    # Rank tie-breakers deterministically: canonical base slug > non-preview/dated/exacto > higher success > higher exactness
    best_by_key: dict[tuple[str, str | None], tuple[tuple[int, int, int, float], Observation]] = {}
    for blk in blocks:
        try:
            d = json.loads(blk)
        except json.JSONDecodeError:
            continue

        provider = (d.get("provider") or "").strip()
        model = (d.get("model") or "").strip()
        exactness = d.get("exactnessScore")
        total_q = d.get("totalQueries") or 0
        succ_q = d.get("successfulQueries") or 0
        if not provider or not model or exactness is None:
            continue
        prov_low = provider.lower()
        mod_low = model.lower()
        if (
            provider.startswith("~")
            or "openrouter" in prov_low
            or "router" in prov_low
            or prov_low in ("human", "unbiased", "stealth")
            or mod_low == "human"
            or "router" in mod_low
            or "switchyard" in mod_low
            or "pareto" in mod_low
            or "-latest" in mod_low
            or mod_low.endswith((":free", ":beta", ":extended"))
            or total_q <= 0
            or succ_q <= 0
            # eval.ts defaults exactnessScore=0 when validationMap lacks a record despite successful queries
            or float(exactness) <= 0.0
        ):
            continue

        clean_model = model
        effort: str | None = None
        tag_m = re.search(r":(thinking|exacto)$", clean_model, flags=re.I)
        is_exacto = False
        if tag_m:
            tag_val = tag_m.group(1).lower()
            clean_model = clean_model[: tag_m.start()].strip()
            if tag_val == "thinking":
                effort = "thinking"
            elif tag_val == "exacto":
                is_exacto = True

        rate = max(0.0, min(1.0, float(exactness) / 100.0))
        model_url = f"https://llm-benchmark.tinybird.live/models/{quote(model, safe='.-_')}"
        obs = make_obs(
            norm,
            "tinybird_sql",
            clean_model,
            rate,
            f"{float(exactness):.2f}/100",
            org_hint=provider,
            effort=effort,
            source_url=model_url,
            extra={
                "raw_value": round(float(exactness), 2),
                "raw_unit": "pts_100",
                "total_queries": int(total_q),
                "successful_queries": int(succ_q),
            },
        )
        # Disambiguate same-(model, effort) collisions (e.g. -0731 / -preview / reversed claude-4.5-sonnet)
        norm_clean_slug = re.sub(r"[^a-z0-9]+", "-", clean_model.lower().replace(".", "-")).strip("-")
        is_dated_or_preview = bool(re.search(r"(?:-preview|-\d{4}|-\d{8})$", clean_model.lower()))
        prio = (
            1 if (is_exacto or is_dated_or_preview) else 0,
            0 if norm_clean_slug == obs.canonical_model_id else 1,
            -int(succ_q),
            -float(exactness),
        )
        key = (obs.canonical_model_id, obs.effort)
        if key not in best_by_key or prio < best_by_key[key][0]:
            best_by_key[key] = (prio, obs)

    return [pair[1] for pair in best_by_key.values()]


def _fetch_aa_evaluation(
    norm: ModelNormalizer,
    benchmark_id: str,
    url: str,
    score_key: str,
    *,
    refresh: bool = False,
    harness: str | None = None,
    refusal_key: str | None = None,
    extra_keys: dict[str, str] | None = None,
) -> list[Observation]:
    """Generic SSR JSON parser for Artificial Analysis independent evaluation pages."""
    html = cached_text(url, refresh=refresh)
    unesc = html.replace('\\"', '"').replace("\\\\", "\\")

    dec = json.JSONDecoder()
    best_by_key: dict[tuple[str, str | None], Observation] = {}
    for m in re.finditer(r'\{"id":"[0-9a-f-]{36}","slug":"', unesc):
        try:
            obj, _ = dec.raw_decode(unesc, m.start())
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        raw_val = obj.get(score_key)
        if not isinstance(raw_val, (int, float)):
            continue

        raw_name = (obj.get("shortName") or obj.get("name") or obj.get("slug") or "").strip()
        if not raw_name:
            continue
        creator_name = (obj.get("creator") or {}).get("name")
        raw_effort = obj.get("effort")
        if isinstance(raw_effort, dict):
            aa_effort = (raw_effort.get("slug") or raw_effort.get("label") or "").strip().lower() or None
        else:
            aa_effort = str(raw_effort).strip().lower() if raw_effort is not None else None
        if aa_effort in ("none", "default", "unknown"):
            aa_effort = None

        rate = max(0.0, min(1.0, float(raw_val)))
        extra: dict[str, Any] = {}
        # 顺手带上 AA 里记录的模型发布日期，方便新鲜度自动判定
        rel_date = normalize_iso_date(obj.get("releaseDate") if isinstance(obj.get("releaseDate"), str) else None)
        if rel_date:
            extra["model_release_date"] = rel_date
        if refusal_key and isinstance(obj.get(refusal_key), (int, float)):
            extra["refusal_rate"] = round(float(obj[refusal_key]), 4)
        if extra_keys:
            for src_k, dst_k in extra_keys.items():
                if isinstance(obj.get(src_k), (int, float)):
                    extra[dst_k] = round(float(obj[src_k]), 2)

        obs = make_obs(
            norm,
            benchmark_id,
            raw_name,
            rate,
            f"{rate * 100:.1f}%",
            org_hint=creator_name,
            harness=harness,
            effort=aa_effort,
            source_family="Artificial Analysis",
            source_type="independent_run",
            source_url=url,
            extra=extra,
        )
        key = (obs.canonical_model_id, obs.effort)
        if key not in best_by_key or obs.raw_score > best_by_key[key].raw_score:
            best_by_key[key] = obs

    return list(best_by_key.values())


def fetch_itbench_aa(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Artificial Analysis ITBench-AA (59 Kubernetes SRE root-cause localization snapshots)."""
    return _fetch_aa_evaluation(
        norm,
        "itbench_aa",
        "https://artificialanalysis.ai/evaluations/itbench-aa",
        "itbenchSre",
        refresh=refresh,
        extra_keys={"itbenchAvgTurnsPerTask": "avg_turns"},
    )


def fetch_cwe_bench_aa(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Artificial Analysis CWE-Bench-AA (120 OWASP Top 10 multi-language repo audit & patch tasks)."""
    return _fetch_aa_evaluation(
        norm,
        "cwe_bench_aa",
        "https://artificialanalysis.ai/evaluations/cwe-bench-aa",
        "cweBench",
        refresh=refresh,
        harness="Stirrup",
        refusal_key="cweBenchRefusalRate",
    )


def fetch_deepsecbench_aa(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Artificial Analysis DeepsecBench-AA (Vercel real web-app security static audit, median F2)."""
    return _fetch_aa_evaluation(
        norm,
        "deepsecbench_aa",
        "https://artificialanalysis.ai/evaluations/deepsecbench-aa",
        "deepsecBench",
        refresh=refresh,
        harness="Stirrup",
        refusal_key="deepsecBenchRefusalRate",
    )


def fetch_frontiercode_2_aa(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Artificial Analysis independent run of Cognition FrontierCode 2.0 (132 private repo tasks)."""
    return _fetch_aa_evaluation(
        norm,
        "frontiercode_2_aa",
        "https://artificialanalysis.ai/evaluations/frontiercode-2-0",
        "frontierCode20",
        refresh=refresh,
    )


def fetch_terminal_bench_40_aa(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch Artificial Analysis independent run of Terminal-Bench 4.0 (66 container terminal tasks)."""
    return _fetch_aa_evaluation(
        norm,
        "terminal_bench_40",
        "https://artificialanalysis.ai/evaluations/terminalbench-4-0",
        "terminalBench40",
        refresh=refresh,
    )


_FRONTIERSWE_VENDORS: dict[str, str] = {
    "anthropic": "Anthropic",
    "openai": "OpenAI",
    "google": "Google",
    "deepseek": "DeepSeek",
    "zai": "Z.ai",
    "xai": "xAI",
    "moonshot": "Moonshot AI",
    "meta": "Meta",
    "qwen": "Alibaba",
    "thinkingmachines": "Thinking Machines",
}


def fetch_frontierswe(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch official FrontierSWE V2 Implementation & Performance tracks directly from frontierswe.com."""
    base_url = "https://www.frontierswe.com/"
    html = cached_text(base_url, refresh=refresh)
    unesc = html.replace('\\"', '"').replace("\\\\", "\\")
    m = re.search(r'"entries":\{', unesc)
    if not m:
        return []
    entries, _ = json.JSONDecoder().raw_decode(unesc, m.end() - 1)
    # 官网 entries.abs.mean 里的 implementation / performance 与 Epoch 归档口径完全一致
    rows = ((entries.get("abs") or {}).get("mean")) or []

    obs_list: list[Observation] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        raw_model = (r.get("model") or "").strip()
        if not raw_model:
            continue
        vendor_key = str(r.get("vendor") or "").strip().lower()
        org_hint = _FRONTIERSWE_VENDORS.get(vendor_key) or (vendor_key or None)
        harness = (r.get("harness") or "").strip() or None
        cost_usd = float(r["avgCostUsd"]) if isinstance(r.get("avgCostUsd"), (int, float)) else None
        dur_sec = float(r["avgDurationSeconds"]) if isinstance(r.get("avgDurationSeconds"), (int, float)) else None
        trace_href = (r.get("traceHref") or "").strip()
        row_url = f"https://www.frontierswe.com{trace_href}" if trace_href.startswith("/") else base_url

        for col, bench_id in (("implementation", "frontierswe"), ("performance", "frontierswe_perf")):
            val = r.get(col)
            if not isinstance(val, (int, float)):
                continue
            rate = float(val) / 100.0 if float(val) > 1.0 else float(val)
            obs_list.append(
                make_obs(
                    norm,
                    bench_id,
                    raw_model,
                    rate,
                    f"{rate * 100:.1f}%",
                    org_hint=org_hint,
                    harness=harness,
                    source_type="benchmark_run",
                    source_url=row_url,
                    cost_usd=cost_usd,
                    cost_unit="per_task",
                    duration_sec=dur_sec,
                )
            )
    return obs_list


def _extract_js_object_array(js_text: str, marker_regex: str) -> list[str]:
    """Extract balanced object literals from a JS array literal containing marker_regex."""
    marker = re.search(marker_regex, js_text)
    if not marker:
        return []
    start = js_text.rfind("[", 0, marker.start())
    if start == -1:
        return []
    depth, in_s, esc, quote_ch, end = 0, False, False, "", start
    for idx in range(start, len(js_text)):
        ch = js_text[idx]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if in_s:
            if ch == quote_ch:
                in_s = False
            continue
        if ch in ('"', "'"):
            in_s = True
            quote_ch = ch
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = idx + 1
                break
    return re.findall(r"\{[^{}]+\}", js_text[start:end])


def fetch_inferencebench(norm: ModelNormalizer, refresh: bool = False) -> list[Observation]:
    """Fetch InferenceBench aggregate speedup multipliers (scored=False reference alongside AlgoTune)."""
    index_url = "https://inferencebench.ai/"
    html = cached_text(index_url, refresh=refresh)
    script_m = re.search(r'src=["\'](script\.js[^"\']*)["\']', html)
    script_path = script_m.group(1) if script_m else "script.js"
    js_url = f"https://inferencebench.ai/{script_path.lstrip('/')}"
    js_text = cached_text(js_url, refresh=refresh)

    # Prefer prompt v1.0.1 (†) runs when both old (v1.0) and new prompt versions exist for a model+effort
    best_by_key: dict[tuple[str, str | None], tuple[tuple[int, float], Observation]] = {}
    for blk in _extract_js_object_array(js_text, r"\{\s*rank:\s*1\b"):
        r_type = re.search(r'\btype:\s*"([^"]+)"', blk)
        r_model = re.search(r'\bmodel:\s*"([^"]+)"', blk)
        r_scaffold = re.search(r'\bscaffold:\s*"([^"]+)"', blk)
        r_val = re.search(r"\bvalue:\s*([0-9.]+)", blk)
        r_sem = re.search(r"\bsem:\s*([0-9.]+)", blk)
        if not (r_type and r_model and r_scaffold and r_val and r_sem):
            continue
        if r_type.group(1) != "agent":
            continue

        raw_model = r_model.group(1)
        scaffold = r_scaffold.group(1)
        val = float(r_val.group(1))
        sem = float(r_sem.group(1))
        r_mark = re.search(r'\bmark:\s*"([^"]*)"', blk)
        mark = r_mark.group(1) if r_mark else ""
        is_v101 = ("†" in mark) or ("prompt v1.0.1" in scaffold.lower())
        harness_clean = re.sub(r"\s*·\s*prompt\s+v[\d.]+", "", scaffold, flags=re.I).strip() or None

        obs = make_obs(
            norm,
            "inferencebench",
            raw_model,
            0.0,
            f"{val:.2f}×",
            harness=harness_clean,
            source_url=index_url,
            extra={
                "raw_value": round(val, 4),
                "raw_unit": "speedup_x",
                "sem": round(sem, 3),
                "prompt_version": "v1.0.1" if is_v101 else "v1.0",
            },
        )
        prio = (0 if is_v101 else 1, -val)
        key = (obs.canonical_model_id, obs.effort)
        if key not in best_by_key or prio < best_by_key[key][0]:
            best_by_key[key] = (prio, obs)

    return [pair[1] for pair in best_by_key.values()]
