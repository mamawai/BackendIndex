import type { BenchmarkMeta, CategoryId, ModelEntry } from "./types";

export const DEFAULT_WEIGHTS: Record<CategoryId, number> = {
  repo: 25,
  architecture: 15,
  systems: 20,
  sql: 15,
  performance: 15,
  security: 10,
};

const INDEPENDENT_TYPES = new Set(["benchmark_run", "independent_run"]);

export interface WeightedModelRow extends ModelEntry {
  dynamicScore: number;
  dynamicCi: [number, number];
  dynamicRank: number;
  /** 已测维度占当前权重的比例 */
  dynamicCoverage: number;
  /** false = 已测维度不到门槛（数据不全）：照常排名，但名次仅供参考 */
  dynamicComplete: boolean;
  /** 只给数据不全的模型：按它的区间，在当前榜单里可能落在的名次范围 [最好, 最差] */
  dynamicRankRange: [number, number] | null;
}

interface WorkRow extends WeightedModelRow {
  se: number;
}

const toInterval = (score: number, se: number): [number, number] => [
  Math.max(0, Number((score - 1.645 * se).toFixed(1))),
  Math.min(100, Number((score + 1.645 * se).toFixed(1))),
];

/** 给数据不全的行算名次范围：分数高于它区间上限的有几个 → 最好名次；高于区间下限的有几个 → 最差名次 */
function attachRankRanges(rows: WeightedModelRow[]): void {
  for (const r of rows) {
    if (r.dynamicComplete) continue;
    const others = rows.filter((o) => o !== r).map((o) => o.dynamicScore);
    const best = 1 + others.filter((s) => s > r.dynamicCi[1]).length;
    const worst = 1 + others.filter((s) => s > r.dynamicCi[0]).length;
    r.dynamicRankRange = [best, Math.max(best, worst)];
  }
}

/** 单一来源的 Estimated 模型，不允许排在 2 分以内的多方实测模型前面（和管线同一规则） */
function applyCloseCallGuard(rows: WorkRow[]): void {
  const single = (r: WorkRow) => r.evidence_status === "Estimated" && r.independent_family_count < 2;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < rows.length - 1; i++) {
      const curr = rows[i];
      const next = rows[i + 1];
      if (single(curr) && !single(next) && curr.dynamicScore - next.dynamicScore <= 2.0) {
        rows[i] = next;
        rows[i + 1] = curr;
        changed = true;
      }
    }
  }
}

/** 缺测修正用的直线：全维度分 ≈ intercept + slope × 只用已测这几维算的加权平均（在各维都有分的模型上拟合） */
export interface MissingLine {
  intercept: number;
  slope: number;
  residSd: number;
  /** 参照模型数：当前权重下各维都有分的模型 */
  n: number;
  meanX: number;
  sxx: number;
}

export interface OverallEstimate {
  /** 已测维度的加权平均 */
  measured: number;
  /** 综合分：维度齐全时 = 已测平均，缺测时 = 直线估计值 */
  score: number;
  se: number;
  /** 已测部分的测量误差（缺测时已按直线斜率折算） */
  measuredSe: number;
  /** 缺测部分的估计误差：直线在参照模型上的预测误差，维度齐全时为 0 */
  predSd: number;
  coverage: number;
  /** 维度齐全时为 null */
  line: MissingLine | null;
}

/**
 * 和管线同一算法：维度齐全时综合分就是加权平均；缺测时，在各维都有分的模型上拟合
 * "只用已测这几维算的分 → 全维度分"的直线，按它估综合分，这条线的预测误差计入区间。
 */
export function estimateOverall(
  models: ModelEntry[],
  weights: Record<CategoryId, number>
): Map<string, OverallEstimate> {
  const cats = (Object.keys(weights) as CategoryId[]).filter((c) => weights[c] > 0);
  const total = cats.reduce((acc, c) => acc + weights[c], 0);
  const w = (c: CategoryId) => weights[c] / total;
  const scoredCats = (m: ModelEntry) => cats.filter((c) => m.category_scores[c] !== null && m.category_scores[c] !== undefined);
  const avgOver = (m: ModelEntry, S: CategoryId[]) =>
    S.reduce((acc, c) => acc + w(c) * (m.category_scores[c] as number), 0) / S.reduce((acc, c) => acc + w(c), 0);

  const reference = models.filter((m) => scoredCats(m).length === cats.length);
  const lines = new Map<string, MissingLine>();
  const lineFor = (S: CategoryId[]): MissingLine => {
    const key = S.join("+");
    const cached = lines.get(key);
    if (cached) return cached;
    const xs = reference.map((m) => avgOver(m, S));
    const ys = reference.map((m) => avgOver(m, cats));
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    xs.forEach((x, i) => {
      sxy += (x - meanX) * (ys[i] - meanY);
      sxx += (x - meanX) ** 2;
    });
    const slope = sxy / sxx;
    const intercept = meanY - slope * meanX;
    const rss = xs.reduce((acc, x, i) => acc + (ys[i] - intercept - slope * x) ** 2, 0);
    const line = { intercept, slope, residSd: Math.sqrt(rss / (xs.length - 2)), n: xs.length, meanX, sxx };
    lines.set(key, line);
    return line;
  };

  const out = new Map<string, OverallEstimate>();
  for (const m of models) {
    const S = scoredCats(m);
    if (!S.length) continue;
    const coverage = S.reduce((acc, c) => acc + w(c), 0);
    const measured = avgOver(m, S);
    const rawSe = Math.sqrt(S.reduce((acc, c) => acc + (w(c) * (m.category_se[c] ?? 0)) ** 2, 0)) / coverage;
    if (S.length === cats.length) {
      out.set(m.canonical_id, { measured, score: measured, se: rawSe, measuredSe: rawSe, predSd: 0, coverage, line: null });
      continue;
    }
    const line = lineFor(S);
    // 离参照模型的平均水平越远，这条线估得越不准
    const predSd = line.residSd * Math.sqrt(1 + 1 / line.n + (measured - line.meanX) ** 2 / line.sxx);
    const measuredSe = line.slope * rawSe;
    out.set(m.canonical_id, {
      measured,
      score: line.intercept + line.slope * measured,
      se: Math.sqrt(measuredSe ** 2 + predSd ** 2),
      measuredSe,
      predSd,
      coverage,
      line,
    });
  }
  return out;
}

/**
 * Recompute the overall score and uncertainty interval when the user adjusts category weights,
 * with the same rules as the pipeline (see estimateOverall). Every model is ranked on one board; those
 * whose measured dimensions cover less than `minCoverage` of the active weights are flagged as incomplete.
 */
export function recomputeRankings(
  models: ModelEntry[],
  weights: Record<CategoryId, number>,
  activeCategory: CategoryId | "overall",
  minCoverage: number
): WeightedModelRow[] {
  // 单维度视图：有这个维度分数的模型都按维度分排名
  if (activeCategory !== "overall") {
    const rows: WorkRow[] = [];
    for (const m of models) {
      const s = m.category_scores[activeCategory];
      if (s === null || s === undefined) continue;
      const se = m.category_se[activeCategory] ?? 0;
      rows.push({
        ...m,
        dynamicScore: s,
        dynamicCi: toInterval(s, se),
        dynamicRank: 0,
        dynamicCoverage: m.coverage,
        // 单维度榜只看这一维，不存在"数据不全"
        dynamicComplete: true,
        dynamicRankRange: null,
        se,
      });
    }
    rows.sort((a, b) => b.dynamicScore - a.dynamicScore || a.se - b.se);
    return rows.map(({ se: _se, ...r }, idx) => ({ ...r, dynamicRank: idx + 1 }));
  }

  const categories = Object.keys(weights) as CategoryId[];
  const totalWeight = categories.reduce((acc, c) => acc + Math.max(0, weights[c]), 0);
  const isDefault = categories.every((c) => Math.abs(weights[c] - DEFAULT_WEIGHTS[c]) < 0.01);

  // 默认权重直接用管线算好的分数和名次，保证两边完全一致
  if (isDefault || totalWeight <= 0) {
    const rows: WeightedModelRow[] = models.map((m) => ({
      ...m,
      dynamicScore: m.overall_score,
      dynamicCi: m.ci_90,
      dynamicRank: m.rank,
      dynamicCoverage: m.coverage,
      dynamicComplete: m.complete,
      dynamicRankRange: null,
    }));
    rows.sort((a, b) => a.dynamicRank - b.dynamicRank);
    attachRankRanges(rows);
    return rows;
  }

  const estimates = estimateOverall(models, weights);
  const work: WorkRow[] = [];
  for (const m of models) {
    const e = estimates.get(m.canonical_id);
    if (!e) continue;
    work.push({
      ...m,
      dynamicScore: Number(e.score.toFixed(2)),
      dynamicCi: toInterval(e.score, e.se),
      dynamicRank: 0,
      dynamicCoverage: e.coverage,
      dynamicComplete: e.coverage >= minCoverage - 1e-9,
      dynamicRankRange: null,
      se: e.se,
    });
  }

  work.sort((a, b) => b.dynamicScore - a.dynamicScore || a.se - b.se);
  applyCloseCallGuard(work);
  const rows: WeightedModelRow[] = work.map(({ se: _se, ...r }, idx) => ({ ...r, dynamicRank: idx + 1 }));
  attachRankRanges(rows);
  return rows;
}

/**
 * 数据不全模型的说明：覆盖差多少、缺哪几维（缺测 = 收录的数据源都没测过；不可比 = 只有不连通的旧榜成绩），
 * 以及按它的区间在当前榜单里可能落在的名次。数据完整的返回 null。
 */
export function describeIncomplete(
  m: WeightedModelRow,
  minCoverage: number,
  catLabel: (c: CategoryId) => string,
  tx: (zh: string, en: string) => string,
  detailed = false
): string | null {
  if (m.dynamicComplete) return null;
  const coverage = m.dynamicCoverage;
  const range = m.dynamicRankRange;
  const inc = new Set(m.incomparable_categories ?? []);
  const missing = (Object.keys(m.category_scores) as CategoryId[]).filter((c) => m.category_scores[c] === null);
  const untested = missing.filter((c) => !inc.has(c)).map(catLabel);
  const incomparable = missing.filter((c) => inc.has(c)).map(catLabel);
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const parts: string[] = [];
  if (detailed) {
    parts.push(
      tx(
        `数据不全：已测维度只占 ${pct(coverage)}（不到 ${pct(minCoverage)}），综合分里缺的部分是按各维都测过的模型估的，名次仅供参考`,
        `incomplete data: measured dimensions cover ${pct(coverage)} (< ${pct(minCoverage)}); the missing part of the overall is estimated from fully measured models, so the rank is indicative`
      )
    );
  }
  if (untested.length) {
    parts.push(
      detailed
        ? tx(
            `缺 ${untested.join("、")}：收录的数据源里还没有它在这些维度的成绩`,
            `missing ${untested.join(", ")}: no tracked source has tested it there yet`
          )
        : tx(`缺 ${untested.join(" · ")}`, `missing ${untested.join(" · ")}`)
    );
  }
  if (incomparable.length) {
    parts.push(
      detailed
        ? tx(
            `${incomparable.join("、")}不可比：只有和主榜不连通的旧榜成绩`,
            `${incomparable.join(", ")} not comparable: only results on disconnected older boards`
          )
        : tx(`${incomparable.join(" · ")} 不可比`, `${incomparable.join(" · ")} not comparable`)
    );
  }
  if (range) {
    const r = range[0] === range[1] ? `${range[0]}` : `${range[0]}–${range[1]}`;
    parts.push(
      detailed
        ? tx(`按它的区间，真实名次可能在第 ${r} 名之间`, `by its range, the true rank could be anywhere in #${r}`)
        : tx(`名次可能在第 ${r} 名`, `rank could be #${r}`)
    );
  }
  return parts.join(detailed ? tx("；", "; ") : "，");
}

/** Compute Pareto frontier (non-dominated models: lowest price for given or higher score). */
export function computeParetoFrontier(
  points: { id: string; price: number; score: number }[]
): Set<string> {
  const sorted = [...points].sort((a, b) => a.price - b.price || b.score - a.score);
  const frontier = new Set<string>();
  let maxScore = -Infinity;
  for (const p of sorted) {
    if (p.score > maxScore) {
      frontier.add(p.id);
      maxScore = p.score;
    }
  }
  return frontier;
}

export function formatContext(ctx: number | null): string {
  if (!ctx) return "—";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(ctx % 1_000_000 === 0 ? 0 : 2)}M`;
  return `${Math.round(ctx / 1000)}K`;
}

export function formatPrice(price: number | null): string {
  if (price === null || price === undefined) return "—";
  if (price === 0) return "$0";
  if (price < 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(price >= 10 ? 0 : 1)}`;
}

export function formatTokens(tokens: number | null): string {
  if (!tokens) return "—";
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(1)}B`;
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}K`;
  return `${Math.round(tokens)}`;
}

/** Cost with its unit: per task vs. one full run of the benchmark (never mixed). */
export function formatCost(
  cost: number | null,
  unit: "per_task" | "per_run" | null | undefined,
  lang: "zh" | "en"
): string {
  if (!cost) return "—";
  const amount = cost >= 100 ? `$${Math.round(cost).toLocaleString("en-US")}` : `$${cost.toFixed(2)}`;
  if (unit === "per_task") return `${amount}${lang === "en" ? "/task" : "/题"}`;
  if (unit === "per_run") return `${amount}${lang === "en" ? "/run" : "/整轮"}`;
  return amount;
}

export interface CategoryEvidenceDepth {
  benchmarks: number;
  families: number;
}

/**
 * Count distinct IRT-scored benchmarks and independent source families (maintainer or independent
 * runs only — lab-reported and third-party transcriptions are not counted) supporting each category.
 */
export function getCategoryEvidenceDepth(
  model: ModelEntry,
  benchmarks: Record<string, BenchmarkMeta>
): Record<CategoryId, CategoryEvidenceDepth> {
  const bms: Record<CategoryId, Set<string>> = {
    repo: new Set(),
    architecture: new Set(),
    systems: new Set(),
    sql: new Set(),
    performance: new Set(),
    security: new Set(),
  };
  const fams: Record<CategoryId, Set<string>> = {
    repo: new Set(),
    architecture: new Set(),
    systems: new Set(),
    sql: new Set(),
    performance: new Set(),
    security: new Set(),
  };

  for (const item of model.ledger) {
    if (benchmarks[item.benchmark_id]?.scored === false) continue;
    bms[item.category].add(item.benchmark_id);
    // 只数维护方实测 / 独立复测的来源，自报和转引不算"独立来源"
    if (item.source_family && INDEPENDENT_TYPES.has(item.source_type)) {
      fams[item.category].add(item.source_family);
    }
  }

  return {
    repo: { benchmarks: bms.repo.size, families: fams.repo.size },
    architecture: { benchmarks: bms.architecture.size, families: fams.architecture.size },
    systems: { benchmarks: bms.systems.size, families: fams.systems.size },
    sql: { benchmarks: bms.sql.size, families: fams.sql.size },
    performance: { benchmarks: bms.performance.size, families: fams.performance.size },
    security: { benchmarks: bms.security.size, families: fams.security.size },
  };
}

/**
 * Progressive visual hierarchy by independent source depth:
 * more independent sources carry stronger positive emphasis, while single-source entries stay gently noted.
 */
export function getEvidenceDepthTone(families: number): {
  badgeClass: string;
  supClass: string;
  chipClass: string;
} {
  if (families >= 4) {
    return {
      badgeClass:
        "rounded border border-[color-mix(in_srgb,var(--color-gain)_35%,transparent)] bg-[var(--color-gain-soft)] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-[var(--color-gain)]",
      supClass: "ml-0.5 text-[9px] font-semibold text-[var(--color-gain)]",
      chipClass:
        "border border-[color-mix(in_srgb,var(--color-gain)_24%,transparent)] bg-[color-mix(in_srgb,var(--color-gain-soft)_55%,var(--color-fill))]",
    };
  }
  if (families >= 2) {
    return {
      badgeClass:
        "rounded border border-[color-mix(in_srgb,var(--color-info)_28%,transparent)] bg-[var(--color-info-soft)] px-1.5 py-0.5 font-mono text-[9.5px] font-medium text-[var(--color-info)]",
      supClass: "ml-0.5 text-[9px] font-medium text-[var(--color-info)]",
      chipClass:
        "border border-[color-mix(in_srgb,var(--color-info)_18%,transparent)] bg-[var(--color-fill)]",
    };
  }
  return {
    badgeClass:
      "rounded border border-dashed border-[color-mix(in_srgb,var(--color-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_6%,transparent)] px-1.5 py-0.5 font-mono text-[9.5px] font-normal text-[color-mix(in_srgb,var(--color-warning)_82%,var(--color-muted-foreground))]",
    supClass:
      "ml-0.5 text-[9px] font-normal text-[color-mix(in_srgb,var(--color-warning)_78%,var(--color-faint))]",
    chipClass: "border border-transparent bg-[var(--color-fill)]",
  };
}

export const BENCHMARK_SHORT_NAMES: Record<string, string> = {
  swe_rebench: "SWE-rebench",
  frontierswe: "FrontierSWE",
  frontiercode: "FrontierCode",
  frontiercode_2_aa: "FC 2.0 (AA)",
  bughunt: "BugHunt",
  deepswe: "DeepSWE",
  cursorbench: "CursorBench",
  vals_swebench: "Vals SWE",
  vals_code_migration: "Migration",
  vals_programbench: "ProgramBench",
  scale_swe_atlas_refactoring: "Atlas Refactor",
  scale_swe_atlas_testwriting: "Atlas Tests",
  scale_swe_atlas_qna: "Atlas QnA",
  swe_bench_pro: "SWE-Pro",
  swe_bench_multilingual: "SWE-ML",
  nl2repo: "NL2Repo",
  multi_swe_bench: "Multi-SWE",
  aider_polyglot: "Aider",
  terminal_bench_41: "TB-4.1",
  terminal_bench_40: "TB-4.0",
  vals_terminal_bench: "Vals TB 1.0",
  mirrorcode: "MirrorCode",
  otelbench: "OTelBench",
  compilebench: "CompileBench",
  itbench_aa: "ITBench-AA",
  mcpatlas: "MCP Atlas",
  livesqlbench: "LiveSQL",
  scale_sql_understanding: "SCALE Und",
  scale_sql_optimization: "SCALE Opt",
  scale_sql_dialect: "SCALE Dial",
  spider2_snow: "Spider2 Snow",
  spider2_lite: "Spider2 Lite",
  spider2_dbt: "Spider2 DBT",
  tinybird_sql: "Tinybird SQL",
  gso: "GSO",
  frontierswe_perf: "FSWE Perf",
  vals_ioi: "Vals IOI v2",
  algotune: "AlgoTune",
  inferencebench: "InferenceBench",
  aa_engineering: "AA Eng",
  bfcl_v4: "BFCL v4",
  cwe_bench_aa: "CWE-Bench",
  deepsecbench_aa: "DeepsecBench",
  vals_srebench: "Vals RevEng",
  vals_cyber: "Vals Cyber",
  cybergym: "CyberGym",
  cybench: "Cybench",
  exploitbench: "ExploitBench",
  autobaxbench_hard: "AutoBax Hard",
  aa_cyber: "AA Cyber",
};
