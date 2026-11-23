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

export type FreshnessStatus = "current" | "aging" | "archived" | "unknown";

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
  dispersion: number;
  /** 和本维度主组不连通、因此不参与计分的基准 */
  excluded_benchmarks?: string[];
}

export interface BenchmarkMeta {
  id: string;
  name: string;
  category: CategoryId;
  source_family: string;
  source_url: string;
  tier: "S" | "A" | "B";
  base_weight: number;
  description: string;
  scored: boolean;
  core?: boolean;
  /** false = 和本维度主组没有足够共同模型，成绩只留在台账里、不计分 */
  comparable?: boolean;
  freshness: FreshnessStatus;
  last_activity: string | null;
  age_days: number | null;
  freshness_factor: number;
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
  effort_note?: string | null;
  date: string | null;
  cost_usd: number | null;
  /** per_task = 每题成本，per_run = 整轮跑完的总成本 */
  cost_unit?: "per_task" | "per_run" | null;
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
  /** 这条成绩在拟合里实际用的权重（档位×来源×新鲜度，再经同题拆分、单一来源封顶） */
  weight?: number;
}

export interface ModelEntry {
  canonical_id: string;
  display_name: string;
  organization: string;
  rank: number;
  /** false = 已测维度不到权重门槛（数据不全）：照常排名，但名次仅供参考 */
  complete: boolean;
  overall_score: number;
  /** 已测维度的加权平均 */
  measured_score: number;
  /** 缺测修正 = 综合分 - 已测平均（六维齐全时为 0），按六维齐全模型的实际关系估出 */
  missing_adjustment: number;
  overall_se: number;
  ci_90: [number, number];
  /** 已测维度占默认维度权重的比例 */
  coverage: number;
  category_scores: Record<CategoryId, number | null>;
  category_se: Record<CategoryId, number | null>;
  covered_categories: CategoryId[];
  auxiliary_only_categories?: CategoryId[];
  single_benchmark_categories?: CategoryId[];
  /** 只有和主组不连通的基准成绩、没法同台比较的维度（区别于"缺测"） */
  incomparable_categories?: CategoryId[];
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
  representative_benchmarks: Record<string, RepBenchmark>;
  ledger: LedgerItem[];
}

export interface SnapshotRules {
  min_coverage: number;
  fresh_days: number;
  stale_days: number;
  stale_factor: number;
  tier_weights: Record<"S" | "A" | "B", number>;
  source_weights: Record<SourceType, number>;
}

export interface SnapshotData {
  generated_at: string;
  method: string;
  rules: SnapshotRules;
  categories: Record<CategoryId, CategoryMeta>;
  benchmarks: Record<string, BenchmarkMeta>;
  source_health: Record<string, { status: string; observations?: number; [k: string]: unknown }>;
  summary: {
    listed_models: number;
    ranked_models: number;
    complete_models: number;
    supported_models: number;
    estimated_models: number;
    total_observations: number;
    tracked_benchmarks: number;
    scored_benchmarks: number;
    stale_benchmarks: number;
  };
  models: ModelEntry[];
}
