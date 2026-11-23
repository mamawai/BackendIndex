export type CategoryId =
  | "repo"
  | "architecture"
  | "systems"
  | "sql"
  | "performance"
  | "security";

export type SourceType =
  | "benchmark_run"
  | "independent_run"
  | "lab_reported"
  | "third_party";

export interface CategoryBenchmarkParams {
  difficulty: number;
  discrimination: number;
  n_models: number;
}

export interface CategoryMeta {
  name: string;
  name_en: string;
  description: string;
  weight: number;
  irt_benchmarks: Record<string, CategoryBenchmarkParams>;
}

export interface BenchmarkMeta {
  id: string;
  name: string;
  category: CategoryId;
  source_family: string;
  source_url: string;
  freshness: "current" | "aging";
  tier: "S" | "A" | "B";
  base_weight: number;
  description: string;
  scored: boolean;
  core?: boolean;
}

export interface LedgerItem {
  benchmark_id: string;
  benchmark_name: string;
  category: CategoryId;
  score: number | null;
  raw_display: string;
  raw_value?: number | null;
  raw_unit?: string | null;
  source_family: string;
  source_type: SourceType;
  source_url: string;
  harness: string | null;
  effort: string | null;
  date: string | null;
  cost_usd: number | null;
  tokens: number | null;
  margin: number | null;
}

export interface RepBenchmark {
  score: number;
  display: string;
  harness: string | null;
  effort: string | null;
  source_type: SourceType;
  date: string | null;
}

export interface ModelEntry {
  canonical_id: string;
  display_name: string;
  organization: string;
  rank: number;
  overall_score: number;
  overall_se: number;
  ci_90: [number, number];
  category_scores: Record<CategoryId, number | null>;
  category_se: Record<CategoryId, number | null>;
  covered_categories: CategoryId[];
  auxiliary_only_categories?: CategoryId[];
  benchmark_count: number;
  observation_count: number;
  independent_family_count: number;
  core_independent_family_count?: number;
  source_family_count: number;
  evidence_status: "Supported" | "Estimated";
  latest_date: string | null;
  is_open_weight: boolean;
  release_date: string | null;
  context_length: number | null;
  prompt_price_per_1m: number | null;
  completion_price_per_1m: number | null;
  cache_read_price_per_1m: number | null;
  blended_price_per_1m: number | null;
  openrouter_id: string | null;
  harnesses: string[];
  primary_harness: string | null;
  avg_eval_cost_usd: number | null;
  representative_benchmarks: Record<string, RepBenchmark>;
  ledger: LedgerItem[];
}

export interface SnapshotData {
  generated_at: string;
  method: string;
  categories: Record<CategoryId, CategoryMeta>;
  benchmarks: Record<string, BenchmarkMeta>;
  source_health: Record<string, { status: string; observations?: number; [k: string]: unknown }>;
  summary: {
    ranked_models: number;
    supported_models: number;
    estimated_models: number;
    total_observations: number;
    tracked_benchmarks: number;
  };
  models: ModelEntry[];
}
