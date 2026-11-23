import type { CategoryId, ModelEntry } from "./types";

export const DEFAULT_WEIGHTS: Record<CategoryId, number> = {
  repo: 25,
  architecture: 15,
  systems: 20,
  sql: 15,
  performance: 15,
  security: 10,
};

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  repo: "仓库研发",
  architecture: "架构与构建",
  systems: "运维构建",
  sql: "数据库 SQL",
  performance: "性能与算法",
  security: "后端安全",
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

  // Apply 2-point close-call guard for single-family Estimated models
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
  mcpatlas: "MCP Atlas",
  livesqlbench: "LiveSQL",
  scale_sql_understanding: "SCALE Und",
  scale_sql_optimization: "SCALE Opt",
  scale_sql_dialect: "SCALE Dial",
  spider2_snow: "Spider2 Snow",
  spider2_lite: "Spider2 Lite",
  spider2_dbt: "Spider2 DBT",
  gso: "GSO",
  vals_ioi: "Vals IOI v2",
  algotune: "AlgoTune",
  aa_engineering: "AA Eng",
  bfcl_v4: "BFCL v4",
  vals_cyber: "Vals Cyber",
  cybergym: "CyberGym",
  cybench: "Cybench",
  exploitbench: "ExploitBench",
  aa_cyber: "AA Cyber",
};
