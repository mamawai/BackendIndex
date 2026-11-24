import type { BenchmarkMeta, CategoryId, ModelEntry } from "./types";

export const DEFAULT_WEIGHTS: Record<CategoryId, number> = {
  repo: 25,
  architecture: 15,
  systems: 20,
  sql: 15,
  performance: 15,
  security: 10,
};

/** 跨维度固有标准差尺度 τ₀（与管线 RELIABILITY_TAU = 6.5 一致） */
export const RELIABILITY_TAU = 6.5;

export function dimReliability(se: number | null | undefined, tau = RELIABILITY_TAU): number {
  if (se === null || se === undefined) return 0;
  const tau2 = tau * tau;
  return tau2 / (tau2 + se * se);
}

const INDEPENDENT_TYPES = new Set(["benchmark_run", "independent_run"]);

export interface WeightedModelRow extends ModelEntry {
  dynamicScore: number;
  dynamicCi: [number, number];
  dynamicRank: number;
  /** 已测维度占当前权重的比例 */
  dynamicCoverage: number;
  /** false = 已测维度不到门槛（数据不全）：照常排名，但名次仅供参考 */
  dynamicComplete: boolean;
  /** true = 因单一来源或单基准 2 分保护规则被排在 2 分以内的更充分实测模型之后 */
  dynamicGuarded: boolean;
  dynamicGuardReason?: "single_source" | "single_benchmark" | null;
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

/** 证据偏薄的模型（综合榜单一来源 Estimated / 单维榜仅 1 项基准），不允许排在 2 分以内的多源或多基准实测模型前面 */
function applyTwoPointGuard(
  rows: WorkRow[],
  isThin: (r: WorkRow) => boolean,
  reason: "single_source" | "single_benchmark"
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < rows.length - 1; i++) {
      const curr = rows[i];
      const next = rows[i + 1];
      if (isThin(curr) && !isThin(next) && curr.dynamicScore - next.dynamicScore <= 2.0) {
        curr.dynamicGuarded = true;
        curr.dynamicGuardReason = reason;
        rows[i] = next;
        rows[i + 1] = curr;
        changed = true;
      }
    }
  }
}

/** 单维度跨维度基线回归线：E[S_c | X_rel] ≈ intercept + slope × X_rel */
export interface CategoryBaselineLine {
  intercept: number;
  slope: number;
  structSd: number;
  n: number;
  meanX: number;
  sxx: number;
}

export interface CategoryContribution {
  cat: CategoryId;
  weight: number;
  measured: number | null;
  se: number | null;
  reliability: number;
  baseline: number;
  effective: number;
  contrib: number;
}

export interface OverallEstimate {
  /** 已测维度的直接加权平均 */
  measured: number;
  /** 按测量信度 r = τ₀²/(τ₀²+SE²) 加权的可靠已测均值 X_rel */
  reliableMean: number;
  /** 综合分：各维度按信度融合实测与跨维度基线后的加权和 */
  score: number;
  se: number;
  measuredSe: number;
  predSd: number;
  coverage: number;
  parts: CategoryContribution[];
  lines: Record<CategoryId, CategoryBaselineLine>;
}

/**
 * 和管线同一算法：每个维度的实测话语权按信度 r = τ₀² / (τ₀² + SE²) 连续折算；
 * 测得多且准的维度接近 100% 实测，极高噪声单基准（如单测 Tinybird）与缺测维度（r = 0）平滑向跨维度基线靠拢。
 */
export function estimateOverall(
  models: ModelEntry[],
  weights: Record<CategoryId, number>,
  minCoverage = 0.7,
  reliabilityTau = RELIABILITY_TAU
): Map<string, OverallEstimate> {
  const allCats: CategoryId[] = ["repo", "architecture", "systems", "sql", "performance", "security"];
  const cats = allCats.filter((c) => (weights[c] ?? 0) > 0);
  const out = new Map<string, OverallEstimate>();
  if (!cats.length) return out;

  const total = cats.reduce((acc, c) => acc + weights[c], 0);
  const w = (c: CategoryId) => weights[c] / total;
  const rel = (m: ModelEntry, c: CategoryId) =>
    m.category_scores[c] !== null && m.category_scores[c] !== undefined
      ? dimReliability(m.category_se[c], reliabilityTau)
      : 0;

  const xRel = new Map<string, number>();
  const wRel = new Map<string, number>();
  const covMap = new Map<string, number>();
  for (const m of models) {
    let num = 0;
    let den = 0;
    let cov = 0;
    for (const c of cats) {
      const sc = m.category_scores[c];
      if (sc !== null && sc !== undefined) {
        cov += w(c);
        const r = rel(m, c);
        const wr = w(c) * r;
        num += wr * sc;
        den += wr;
      }
    }
    covMap.set(m.canonical_id, cov);
    wRel.set(m.canonical_id, den);
    xRel.set(m.canonical_id, den > 0 ? num / den : 0);
  }

  const completeModels = models.filter((m) => (covMap.get(m.canonical_id) ?? 0) >= minCoverage - 1e-9);
  const lines = {} as Record<CategoryId, CategoryBaselineLine>;
  for (const c of allCats) {
    lines[c] = { intercept: 0, slope: 1, structSd: 0, n: 0, meanX: 0, sxx: 1 };
  }

  for (const c of cats) {
    let pool = completeModels.filter((m) => m.category_scores[c] !== null && m.category_scores[c] !== undefined);
    if (pool.length < 3) {
      pool = models.filter((m) => m.category_scores[c] !== null && m.category_scores[c] !== undefined);
    }
    if (!pool.length) continue;

    const xs = pool.map((m) => xRel.get(m.canonical_id) ?? 0);
    const ys = pool.map((m) => m.category_scores[c] as number);
    const ses = pool.map((m) => m.category_se[c] ?? 0);
    const rawWs = ses.map((se) => dimReliability(se, reliabilityTau));
    const wSum = rawWs.reduce((a, b) => a + b, 0) || 1;
    const ws = rawWs.map((v) => v / wSum);

    const mx = xs.reduce((acc, x, i) => acc + ws[i] * x, 0);
    const my = ys.reduce((acc, y, i) => acc + ws[i] * y, 0);
    const sxxW = xs.reduce((acc, x, i) => acc + ws[i] * (x - mx) ** 2, 0);

    let slope = 1;
    let intercept = 0;
    let structSd = 0;
    if (cats.length > 1 && sxxW > 1e-6) {
      const sxyW = xs.reduce((acc, x, i) => acc + ws[i] * (x - mx) * (ys[i] - my), 0);
      slope = sxyW / sxxW;
      intercept = my - slope * mx;
      const rawRv =
        xs.reduce((acc, x, i) => acc + ws[i] * (ys[i] - (intercept + slope * x)) ** 2, 0) *
        (pool.length / Math.max(pool.length - 2, 1));
      const measV = ses.reduce((acc, se, i) => acc + ws[i] * se ** 2, 0);
      structSd = Math.sqrt(Math.max(rawRv - 0.5 * measV, 9.0));
    }
    const sxxUnw = Math.max(
      xs.reduce((acc, x) => acc + (x - mx) ** 2, 0),
      1.0
    );
    lines[c] = { intercept, slope, structSd, n: pool.length, meanX: mx, sxx: sxxUnw };
  }

  for (const m of models) {
    const S = cats.filter((c) => m.category_scores[c] !== null && m.category_scores[c] !== undefined);
    if (!S.length) continue;
    const coverage = covMap.get(m.canonical_id) ?? 0;
    const measured = S.reduce((acc, c) => acc + w(c) * (m.category_scores[c] as number), 0) / coverage;
    const xm = xRel.get(m.canonical_id) ?? 0;
    const wrel = wRel.get(m.canonical_id) ?? 0;
    const bRem = cats.reduce((acc, c) => acc + w(c) * (1 - rel(m, c)) * lines[c].slope, 0);

    let score = 0;
    let measVar = 0;
    let predVar = 0;
    const parts: CategoryContribution[] = [];

    for (const c of cats) {
      const sc = m.category_scores[c];
      const se = m.category_se[c];
      const r = rel(m, c);
      const ln = lines[c];
      const baseline = ln.intercept + ln.slope * xm;
      const effective = r * (sc ?? 0) + (1 - r) * baseline;
      const contrib = w(c) * effective;
      score += contrib;

      if (sc !== null && sc !== undefined && se !== null && se !== undefined) {
        const coef = w(c) * r * (1 + (wrel > 0 ? bRem / wrel : 0));
        measVar += (coef * se) ** 2;
      }
      const predSdC = ln.n > 0 ? ln.structSd * Math.sqrt(1 + 1 / ln.n + (xm - ln.meanX) ** 2 / ln.sxx) : 0;
      predVar += (w(c) * (1 - r) * predSdC) ** 2;

      parts.push({
        cat: c,
        weight: w(c),
        measured: sc ?? null,
        se: se ?? null,
        reliability: r,
        baseline,
        effective,
        contrib,
      });
    }

    const measuredSe = Math.sqrt(measVar);
    const predSd = Math.sqrt(predVar);
    out.set(m.canonical_id, {
      measured,
      reliableMean: xm,
      score,
      se: Math.sqrt(measVar + predVar),
      measuredSe,
      predSd,
      coverage,
      parts,
      lines,
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
  // 单维度视图：有这个维度分数的模型都按维度分排名，并对仅测 1 项基准的模型施加 2 分邻近保护
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
        dynamicGuarded: false,
        dynamicGuardReason: null,
        dynamicRankRange: null,
        se,
      });
    }
    rows.sort((a, b) => b.dynamicScore - a.dynamicScore || a.se - b.se);
    applyTwoPointGuard(
      rows,
      (r) => Boolean(r.single_benchmark_categories?.includes(activeCategory)),
      "single_benchmark"
    );
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
      dynamicGuarded: Boolean(m.rank_guarded),
      dynamicGuardReason: m.rank_guarded ? "single_source" : null,
      dynamicRankRange: null,
    }));
    rows.sort((a, b) => a.dynamicRank - b.dynamicRank);
    attachRankRanges(rows);
    return rows;
  }

  const estimates = estimateOverall(models, weights, minCoverage);
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
      dynamicGuarded: false,
      dynamicGuardReason: null,
      dynamicRankRange: null,
      se: e.se,
    });
  }

  work.sort((a, b) => b.dynamicScore - a.dynamicScore || a.se - b.se);
  applyTwoPointGuard(
    work,
    (r) => r.evidence_status === "Estimated" && r.independent_family_count < 2,
    "single_source"
  );
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

  // 直接按实际入模计分的 representative_benchmarks 统计，排除不连通旧榜与同基准多源重复计数
  for (const [bid, rep] of Object.entries(model.representative_benchmarks)) {
    const meta = benchmarks[bid];
    if (!meta || meta.scored === false || meta.comparable === false) continue;
    bms[meta.category].add(bid);
    const fam = rep.source_family ?? meta.source_family;
    if (fam && INDEPENDENT_TYPES.has(rep.source_type)) {
      fams[meta.category].add(fam);
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
