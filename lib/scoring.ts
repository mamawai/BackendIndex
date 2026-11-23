import type { BenchmarkMeta, CategoryId, ModelEntry } from "./types";

export const DEFAULT_WEIGHTS: Record<CategoryId, number> = {
  repo: 25,
  architecture: 15,
  systems: 20,
  sql: 15,
  performance: 15,
  security: 10,
};

export interface WeightedModelRow extends ModelEntry {
  dynamicScore: number;
  dynamicCi: [number, number];
  dynamicRank: number;
}

/**
 * Recompute overall score and 90% CI in real time when the user adjusts category weights.
 * Enforces the same 2-point close-call guard for single-family Estimated entries.
 */
export function recomputeRankings(
  models: ModelEntry[],
  weights: Record<CategoryId, number>,
  activeCategory: CategoryId | "overall"
): WeightedModelRow[] {
  const categories = Object.keys(weights) as CategoryId[];
  const totalWeight = categories.reduce((acc, c) => acc + Math.max(0, weights[c]), 0);

  const scored: WeightedModelRow[] = [];

  for (const m of models) {
    if (activeCategory !== "overall") {
      const catScore = m.category_scores[activeCategory];
      if (catScore === null || catScore === undefined) continue;
      const se = m.category_se[activeCategory] ?? 6.0;
      scored.push({
        ...m,
        dynamicScore: catScore,
        dynamicCi: [
          Math.max(0, Number((catScore - 1.645 * se).toFixed(1))),
          Math.min(100, Number((catScore + 1.645 * se).toFixed(1))),
        ],
        dynamicRank: 0,
      });
      continue;
    }

    // Use pre-computed overall score when weights match default
    const isDefault = categories.every(
      (c) => Math.abs(weights[c] - DEFAULT_WEIGHTS[c]) < 0.01
    );
    if (isDefault || totalWeight <= 0) {
      scored.push({
        ...m,
        dynamicScore: m.overall_score,
        dynamicCi: m.ci_90,
        dynamicRank: m.rank,
      });
      continue;
    }

    let wSum = 0;
    let availableW = 0;
    let varSum = 0;
    for (const c of categories) {
      const s = m.category_scores[c];
      const w = Math.max(0, weights[c]) / totalWeight;
      if (s !== null && s !== undefined && w > 0) {
        wSum += w * s;
        availableW += w;
        const se = m.category_se[c] ?? 6.0;
        varSum += (w * se) ** 2;
      }
    }
    if (availableW <= 0) continue;

    const dynamicScore = Number((wSum / availableW).toFixed(2));
    const missingW = Math.max(0, 1 - availableW);
    const baseSe = Math.sqrt(varSum) / availableW;
    const se = Math.sqrt(baseSe ** 2 + (missingW * 6.5) ** 2);

    scored.push({
      ...m,
      dynamicScore,
      dynamicCi: [
        Math.max(0, Number((dynamicScore - 1.645 * se).toFixed(1))),
        Math.min(100, Number((dynamicScore + 1.645 * se).toFixed(1))),
      ],
      dynamicRank: 0,
    });
  }

  scored.sort((a, b) => b.dynamicScore - a.dynamicScore);

  // Apply 2-point close-call guard only on overall rankings (preserve pure category ordering on sub-views)
  if (activeCategory === "overall") {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < scored.length - 1; i++) {
        const curr = scored[i];
        const next = scored[i + 1];
        const currSingleEst =
          curr.evidence_status === "Estimated" && curr.independent_family_count < 2;
        const nextSingleEst =
          next.evidence_status === "Estimated" && next.independent_family_count < 2;
        if (
          currSingleEst &&
          !nextSingleEst &&
          curr.dynamicScore - next.dynamicScore <= 2.0
        ) {
          scored[i] = next;
          scored[i + 1] = curr;
          changed = true;
        }
      }
    }
  }

  return scored.map((item, idx) => ({ ...item, dynamicRank: idx + 1 }));
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

export interface CategoryEvidenceDepth {
  benchmarks: number;
  families: number;
}

/**
 * Count distinct IRT-scored benchmarks and independent source families supporting each category.
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
    if (item.source_family) {
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
  vals_cyber: "Vals Cyber",
  cybergym: "CyberGym",
  cybench: "Cybench",
  exploitbench: "ExploitBench",
  autobaxbench_hard: "AutoBax Hard",
  aa_cyber: "AA Cyber",
};
