"""Probe real-world public backend benchmark endpoints for availability and schema."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import requests
import yaml
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "raw_samples"
RAW_DIR.mkdir(parents=True, exist_ok=True)

HEADERS = {
    "User-Agent": "BackendIndex-DataProbe/0.1 (+https://github.com/local-probe)"
}
TIMEOUT = 18


def fetch(url: str) -> tuple[int, str, str]:
    """Fetch URL and return (status_code, content_type, text_or_error)."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        return resp.status_code, resp.headers.get("content-type", ""), resp.text
    except Exception as exc:  # noqa: BLE001
        return -1, "", f"{type(exc).__name__}: {exc}"


def save_sample(name: str, content: str) -> None:
    (RAW_DIR / name).write_text(content, encoding="utf-8", errors="ignore")


def probe_github_tree(owner_repo: str, branch: str = "main") -> list[str]:
    """List files in a GitHub repo tree to locate data files cleanly."""
    url = f"https://api.github.com/repos/{owner_repo}/git/trees/{branch}?recursive=1"
    status, _, text = fetch(url)
    if status != 200:
        return [f"HTTP {status}: {text[:160]}"]
    data = json.loads(text)
    return [
        item["path"]
        for item in data.get("tree", [])
        if item.get("type") == "blob"
        and any(
            item["path"].endswith(ext)
            for ext in (".json", ".yml", ".yaml", ".csv", ".jsonl")
        )
    ]


def inspect_json_summary(text: str) -> dict[str, Any]:
    data = json.loads(text)
    if isinstance(data, dict):
        summary: dict[str, Any] = {"type": "dict", "top_keys": list(data.keys())[:15]}
        for k, v in data.items():
            if isinstance(v, list):
                summary[f"len({k})"] = len(v)
                if v and isinstance(v[0], dict):
                    summary[f"sample_keys({k})"] = list(v[0].keys())[:15]
        return summary
    if isinstance(data, list):
        return {
            "type": "list",
            "count": len(data),
            "sample_keys": list(data[0].keys())[:15] if data and isinstance(data[0], dict) else None,
        }
    return {"type": type(data).__name__}


def inspect_html_page(url: str, name: str) -> dict[str, Any]:
    status, ctype, text = fetch(url)
    if status != 200:
        return {"url": url, "status": status, "error": text[:200]}
    save_sample(f"{name}.html", text)
    soup = BeautifulSoup(text, "html.parser")
    tables = soup.find_all("table")
    next_data = soup.find("script", id="__NEXT_DATA__")
    script_srcs = [s.get("src", "") for s in soup.find_all("script") if s.get("src")]
    title = soup.title.get_text(strip=True) if soup.title else ""
    visible_lines = [l.strip() for l in soup.get_text("\n").splitlines() if l.strip()]
    json_blobs = re.findall(r"self\.__next_f\.push", text)
    return {
        "url": url,
        "status": status,
        "content_type": ctype,
        "title": title,
        "html_bytes": len(text),
        "table_count": len(tables),
        "table_rows": [len(t.find_all("tr")) for t in tables[:5]],
        "has_next_data": bool(next_data),
        "next_flight_chunks": len(json_blobs),
        "visible_line_count": len(visible_lines),
        "sample_visible_lines": visible_lines[:18],
        "script_hints": script_srcs[:8],
    }


def main() -> None:
    report: dict[str, Any] = {}

    # 1. Direct structured GitHub / API endpoints
    direct_structured = {
        "swebench_leaderboards_json": "https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/main/data/leaderboards.json",
        "aider_polyglot_yml": "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml",
        "aider_edit_yml": "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/edit_leaderboard.yml",
        "all_bench_v2_1_json": "https://raw.githubusercontent.com/final-bench/ALL-Bench-Leaderboard/main/all_bench_leaderboard_v2.1.json",
        "openrouter_models_api": "https://openrouter.ai/api/v1/models",
    }

    report["direct_structured"] = {}
    for key, url in direct_structured.items():
        status, ctype, text = fetch(url)
        entry: dict[str, Any] = {"url": url, "status": status, "content_type": ctype}
        if status == 200:
            ext = "yml" if url.endswith(".yml") else "json"
            save_sample(f"{key}.{ext}", text)
            entry["bytes"] = len(text)
            if ext == "yml":
                parsed = yaml.safe_load(text)
                entry["parsed"] = {
                    "type": type(parsed).__name__,
                    "count": len(parsed) if isinstance(parsed, list) else None,
                    "sample": parsed[0] if isinstance(parsed, list) and parsed else None,
                    "latest_date": max(
                        (str(r.get("date", "")) for r in parsed if isinstance(r, dict)),
                        default="",
                    )
                    if isinstance(parsed, list)
                    else "",
                }
            else:
                entry["parsed"] = inspect_json_summary(text)
                if key == "swebench_leaderboards_json":
                    data = json.loads(text)
                    entry["boards"] = [
                        {
                            "name": b.get("name"),
                            "count": len(b.get("results", [])),
                            "latest_date": max(
                                (str(r.get("date", "")) for r in b.get("results", [])),
                                default="",
                            ),
                            "sample": b.get("results", [None])[0],
                        }
                        for b in data.get("leaderboards", [])
                    ]
        else:
            entry["error"] = text[:200]
        report["direct_structured"][key] = entry

    # 2. Discover data files inside key GitHub leaderboard repos
    repos_to_inspect = [
        ("multi-swe-bench/multi-swe-bench.github.io", "main"),
        ("LiveCodeBench/livecodebench.github.io", "main"),
        ("evalplus/evalplus.github.io", "main"),
        ("xlang-ai/Spider2", "main"),
        ("scaleapi/SWE-bench_Pro-os", "main"),
    ]
    report["github_repo_data_files"] = {}
    for repo, branch in repos_to_inspect:
        files = probe_github_tree(repo, branch)
        report["github_repo_data_files"][repo] = files[:35]

    # 3. Inspect Hugging Face Datasets / Spaces API for SWE-rebench, BigCodeBench, Terminal-Bench
    hf_targets = {
        "swe_rebench_hf_api": "https://huggingface.co/api/datasets/nebius/SWE-rebench-leaderboard",
        "swe_rebench_rows": "https://datasets-server.huggingface.co/rows?dataset=nebius%2FSWE-rebench-leaderboard&config=default&split=test&offset=0&length=5",
        "bigcodebench_space_api": "https://huggingface.co/api/spaces/bigcode/bigcodebench-leaderboard",
        "bigcode_results_dataset": "https://huggingface.co/api/datasets/bigcode/bigcodebench-results",
    }
    report["huggingface"] = {}
    for key, url in hf_targets.items():
        status, _, text = fetch(url)
        entry = {"url": url, "status": status}
        if status == 200:
            save_sample(f"{key}.json", text)
            entry["summary"] = inspect_json_summary(text)
        else:
            entry["error"] = text[:220]
        report["huggingface"][key] = entry

    # 4. Inspect live leaderboard webpages (SSR vs SPA vs blocked)
    web_targets = {
        "spider2_site": "https://spider2-sql.github.io/",
        "scale_sql": "https://sql-llm-leaderboard.com/",
        "tbench_ai": "https://www.tbench.ai/",
        "compilebench": "https://compilebench.com/",
        "swe_rebench_site": "https://swe-rebench.com/",
        "evalplus_site": "https://evalplus.github.io/leaderboard.html",
        "livecodebench_site": "https://livecodebench.github.io/",
        "multi_swe_site": "https://multi-swe-bench.github.io/",
        "quesma_otelbench": "https://quesma.com/",
    }
    report["webpages"] = {
        name: inspect_html_page(url, name) for name, url in web_targets.items()
    }

    out_path = ROOT / "probe_report.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"Probe completed. Saved report to {out_path}")


if __name__ == "__main__":
    main()
