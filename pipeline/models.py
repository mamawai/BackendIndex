"""Data structures shared across ETL fetchers, normalizer, and IRT calibration."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from config import CategoryId, SourceType


@dataclass
class Observation:
    """A single normalized benchmark measurement for a model (+ optional harness)."""

    raw_model_name: str
    canonical_model_id: str
    display_name: str
    organization: str
    benchmark_id: str
    benchmark_name: str
    category: CategoryId
    raw_score: float  # Normalized to [0, 1] scale for IRT
    raw_display: str  # Original formatted score string (e.g. "71.2%", "63.0 / 105")
    source_family: str
    source_type: SourceType
    source_url: str
    harness: str | None = None
    effort: str | None = None
    date: str | None = None
    cost_usd: float | None = None
    tokens: float | None = None
    duration_sec: float | None = None
    margin: float | None = None
    is_agent_product: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class ModelMetadata:
    """Canonical metadata merged from Epoch AI and OpenRouter."""

    canonical_id: str
    display_name: str
    organization: str
    release_date: str | None = None
    is_open_weight: bool = False
    context_length: int | None = None
    prompt_price_per_1m: float | None = None
    completion_price_per_1m: float | None = None
    cache_read_price_per_1m: float | None = None
    blended_price_per_1m: float | None = None
    openrouter_id: str | None = None
    huggingface_id: str | None = None
