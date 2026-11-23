import type { WeightedModelRow } from "./scoring";
import type { CategoryId } from "./types";

export type ComparePresetKey = "top4" | "flagship" | "full6d" | "open" | "value";

/** Pick up to `maxCount` curated models dynamically from current ranked entries. */
export function buildComparePreset(
  models: WeightedModelRow[],
  preset: ComparePresetKey,
  maxCount = 4
): string[] {
  if (models.length === 0) return [];

  if (preset === "top4") {
    return models.slice(0, maxCount).map((m) => m.canonical_id);
  }

  if (preset === "full6d") {
    const picked = models
      .filter((m) => m.covered_categories.length === 6)
      .slice(0, maxCount)
      .map((m) => m.canonical_id);
    return picked.length > 0 ? picked : models.slice(0, maxCount).map((m) => m.canonical_id);
  }

  if (preset === "open") {
    const picked = models
      .filter((m) => m.is_open_weight && m.covered_categories.length >= 4)
      .slice(0, maxCount)
      .map((m) => m.canonical_id);
    return picked.length > 0
      ? picked
      : models
          .filter((m) => m.is_open_weight)
          .slice(0, maxCount)
          .map((m) => m.canonical_id);
  }

  if (preset === "value") {
    const picked = models
      .filter(
        (m) =>
          m.blended_price_per_1m !== null &&
          m.blended_price_per_1m > 0 &&
          m.blended_price_per_1m <= 5 &&
          m.covered_categories.length >= 4
      )
      .slice(0, maxCount)
      .map((m) => m.canonical_id);
    return picked.length > 0 ? picked : models.slice(0, maxCount).map((m) => m.canonical_id);
  }

  // Flagship: top representative from distinct labs with >= 4 dimensions covered
  const seenOrgs = new Set<string>();
  const picked: string[] = [];
  for (const m of models) {
    if (m.covered_categories.length < 4) continue;
    if (seenOrgs.has(m.organization)) continue;
    seenOrgs.add(m.organization);
    picked.push(m.canonical_id);
    if (picked.length >= maxCount) break;
  }
  return picked.length > 0 ? picked : models.slice(0, maxCount).map((m) => m.canonical_id);
}

/** Compute per-category median score across all ranked models for dashed radar baseline. */
export function computeMedianBaseline(
  models: { category_scores: Record<CategoryId, number | null> }[],
  categories: CategoryId[]
): Record<CategoryId, number | null> {
  const res = {} as Record<CategoryId, number | null>;
  for (const c of categories) {
    const vals = models
      .map((m) => m.category_scores[c])
      .filter((v): v is number => v !== null && v !== undefined)
      .sort((a, b) => a - b);
    if (vals.length === 0) {
      res[c] = null;
    } else {
      const mid = Math.floor(vals.length / 2);
      res[c] =
        vals.length % 2 === 1
          ? vals[mid]
          : Number(((vals[mid - 1] + vals[mid]) / 2).toFixed(1));
    }
  }
  return res;
}
