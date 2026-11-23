"use client";

import { useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useLang } from "@/lib/i18n";
import { BENCHMARK_SHORT_NAMES, estimateOverall } from "@/lib/scoring";
import type { CategoryId, SnapshotData } from "@/lib/types";

const CATS: CategoryId[] = ["repo", "architecture", "systems", "sql", "performance", "security"];

interface ScoringFlowProps {
  snapshot: SnapshotData;
}

/**
 * 方法论页顶部：先给出从数据源到名次的 6 步流程，再拿一个真实模型把每一步的数字摊开算一遍。
 * 所有数字都直接读快照，和管线算出来的结果一致。
 */
export function ScoringFlow({ snapshot }: ScoringFlowProps) {
  const { catLabel, tx } = useLang();
  const { rules, summary, categories, benchmarks } = snapshot;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const tw = rules.tier_weights;
  const sw = rules.source_weights;

  const completeModels = useMemo(() => snapshot.models.filter((m) => m.complete), [snapshot.models]);
  const incompleteModels = useMemo(() => snapshot.models.filter((m) => !m.complete), [snapshot.models]);
  const [modelId, setModelId] = useState(snapshot.models[0]?.canonical_id ?? "");
  const model = snapshot.models.find((m) => m.canonical_id === modelId) ?? snapshot.models[0];

  const excludedCount = CATS.reduce((acc, c) => acc + (categories[c]?.excluded_benchmarks?.length ?? 0), 0);
  // 缺测修正的参照：六个维度都有分的模型
  const refCount = snapshot.models.filter((m) => CATS.every((c) => m.category_scores[c] !== null)).length;
  const steps = [
    {
      title: tx("抓取", "Collect"),
      value: tx(`${Object.keys(snapshot.source_health).length} 个数据源`, `${Object.keys(snapshot.source_health).length} sources`),
      note: tx(
        `${summary.tracked_benchmarks} 项基准，共 ${summary.total_observations} 条原始成绩，每条都留原站链接`,
        `${summary.tracked_benchmarks} benchmarks, ${summary.total_observations} raw results, each linked to its source`
      ),
    },
    {
      title: tx("清洗", "Clean"),
      value: tx("统一模型身份", "Unify model identity"),
      note: tx(
        "合并同一模型的不同写法，剔除 Agent 产品；同一基准多次成绩取实测来源里的最佳配置",
        "Merge name variants, drop agent products; several runs on one benchmark keep the best measured run"
      ),
    },
    {
      title: tx("加权", "Weight"),
      value: `S ×${tw.S} · A ×${tw.A} · B ×${tw.B}`,
      note: tx(
        `× 来源（实测 ×${sw.benchmark_run}，自报/转引 ×${sw.lab_reported}）× 新鲜度（${summary.stale_benchmarks}/${summary.scored_benchmarks} 项超过 ${rules.fresh_days} 天被降权）`,
        `× provenance (measured ×${sw.benchmark_run}, self-reported ×${sw.lab_reported}) × freshness (${summary.stale_benchmarks}/${summary.scored_benchmarks} older than ${rules.fresh_days} days down-weighted)`
      ),
    },
    {
      title: tx("分维度 IRT", "Per-Dimension IRT"),
      value: tx("6 个维度各自拟合", "6 separate fits"),
      note: tx(
        `估出每个基准的难度和区分度，不借其它维度的分；和主榜不连通的 ${excludedCount} 项基准不计分；再对齐到仓库研发刻度`,
        `Estimates each benchmark's difficulty & discrimination with no cross-dimension borrowing; ${excludedCount} disconnected benchmarks are not scored; linked to the Repo scale`
      ),
    },
    {
      title: tx("加权合成", "Combine"),
      value: tx("已测加权平均 + 缺测修正", "Measured mean + missing adj."),
      note: CATS.map((c) => `${catLabel(c)} ${pct(categories[c].weight)}`).join(" · "),
    },
    {
      title: tx("排名", "Rank"),
      value: tx(`${summary.ranked_models} 个模型同榜排名`, `${summary.ranked_models} models on one board`),
      note: tx(
        `已测维度不到权重 ${pct(rules.min_coverage)} 的 ${summary.ranked_models - summary.complete_models} 个标为"数据不全"，名次仅供参考并给出可能范围；缺的维度不编分，综合分按 ${refCount} 个六维都测过的模型的实际关系修正，估计误差计入区间`,
        `${summary.ranked_models - summary.complete_models} models measured on < ${pct(rules.min_coverage)} of the weights are flagged incomplete, with an indicative rank range; missing dimensions get no made-up score — the overall is adjusted using ${refCount} fully measured models, and the estimate error widens the range`
      ),
    },
  ];

  // ---- 示例模型：按默认权重把综合分摊开（和管线同一算法，数字与快照一致）----
  const weights = useMemo(
    () => Object.fromEntries(CATS.map((c) => [c, categories[c].weight])) as Record<CategoryId, number>,
    [categories]
  );
  const estimates = useMemo(() => estimateOverall(snapshot.models, weights), [snapshot.models, weights]);
  const est = estimates.get(model.canonical_id)!;
  const covered = CATS.filter((c) => model.category_scores[c] !== null);
  const missing = CATS.filter((c) => model.category_scores[c] === null);
  const coverage = covered.reduce((acc, c) => acc + weights[c], 0);
  const parts = covered.map((c) => {
    const score = model.category_scores[c] as number;
    return { cat: c, w: weights[c], score, contrib: (weights[c] * score) / coverage };
  });
  const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;
  const maxWeight = Math.max(tw.S, tw.A, tw.B);
  // 没进综合分的维度：区分"没测"和"测了但不可比"
  const missingLabels = missing.map(
    (c) => `${catLabel(c)}${model.incomparable_categories?.includes(c) ? tx("（不可比）", " (not comparable)") : ""}`
  );
  const sourceLabel = (t: string) =>
    t === "benchmark_run"
      ? tx("维护方实测", "maintainer run")
      : t === "independent_run"
        ? tx("独立复测", "independent")
        : t === "lab_reported"
          ? tx("厂商自报", "lab-reported")
          : tx("第三方转引", "third-party");

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-foreground)]">
          {tx("一个分数是怎么算出来的", "How a Score Is Computed")}
        </h2>
        <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
          {tx(
            "从数据源到名次一共 6 步，下面的数字都来自当前快照；再往下用一个真实模型把每一步摊开。",
            "Six steps from sources to rank, all numbers from the current snapshot; below, one real model walks through each step."
          )}
        </p>
      </div>

      {/* 6 步流程 */}
      <ol className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {steps.map((s, idx) => (
          <li key={s.title} className="blk flex flex-col gap-1.5 p-3.5">
            <div className="flex items-center justify-between font-mono text-[11px] text-[var(--color-primary)]">
              <span>
                {String(idx + 1).padStart(2, "0")} · {s.title}
              </span>
              {idx < steps.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-[var(--color-faint)]" aria-hidden="true" />}
            </div>
            <div className="text-[13px] font-semibold text-[var(--color-foreground)]">{s.value}</div>
            <p className="text-[11px] leading-relaxed text-[var(--color-muted-foreground)]">{s.note}</p>
          </li>
        ))}
      </ol>

      {/* 真实模型示例 */}
      <div className="blk space-y-5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-[var(--color-foreground)]">
            {tx("拿一个模型算一遍", "Walk Through One Model")}
          </h3>
          <label className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
            {tx("选择模型", "Model")}
            <select
              value={model.canonical_id}
              onChange={(e) => setModelId(e.target.value)}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-fill)] px-2.5 py-1.5 text-xs text-[var(--color-foreground)] outline-none"
            >
              <optgroup label={tx("数据完整", "Complete data")}>
                {completeModels.map((m) => (
                  <option key={m.canonical_id} value={m.canonical_id}>
                    #{m.rank} {m.display_name}
                  </option>
                ))}
              </optgroup>
              {incompleteModels.length > 0 && (
                <optgroup label={tx("数据不全", "Incomplete data")}>
                  {incompleteModels.map((m) => (
                    <option key={m.canonical_id} value={m.canonical_id}>
                      #≈{m.rank} {m.display_name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        </div>

        {/* 第 1 步：每条成绩的权重 */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-[var(--color-foreground)]">
            {tx(
              "① 每条成绩的权重 = 档位 × 来源 × 新鲜度（同题集子榜再拆分、单一来源占比再封顶）",
              "① Each result's weight = tier × provenance × freshness (then shared-question split and per-source cap)"
            )}
          </div>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {CATS.map((c) => {
              const reps = Object.entries(model.representative_benchmarks)
                .filter(([bid]) => benchmarks[bid]?.category === c)
                .sort((a, b) => (b[1].weight ?? 0) - (a[1].weight ?? 0));
              const score = model.category_scores[c];
              const incomparable = model.incomparable_categories?.includes(c);
              return (
                <div key={c} className="rounded-xl bg-[var(--color-fill)] p-3">
                  <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-medium text-[var(--color-foreground)]">{catLabel(c)}</span>
                    <span className="font-mono text-[11px] text-[var(--color-muted-foreground)]">
                      {score !== null
                        ? tx(`维度分 ${score.toFixed(1)} ±${(model.category_se[c] ?? 0).toFixed(1)}`, `score ${score.toFixed(1)} ±${(model.category_se[c] ?? 0).toFixed(1)}`)
                        : incomparable
                          ? tx("不可比，不计分", "not comparable")
                          : tx("缺测", "untested")}
                    </span>
                  </div>
                  {reps.length === 0 ? (
                    <div className="text-[11px] text-[var(--color-faint)]">
                      {incomparable
                        ? tx("只有和主榜不连通的基准成绩，见详情台账", "Only disconnected results; see ledger")
                        : tx("没有入模成绩", "No scored results")}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {reps.map(([bid, rep]) => {
                        const meta = benchmarks[bid];
                        const product = meta.base_weight * (sw[rep.source_type] ?? 1) * meta.freshness_factor;
                        const w = rep.weight ?? product;
                        const adjusted = Math.abs(w - product) > 0.005;
                        const formula = `${meta.tier} ×${meta.base_weight.toFixed(2)} × ${sourceLabel(rep.source_type)} ×${(sw[rep.source_type] ?? 1).toFixed(2)} × ${tx("新鲜度", "freshness")} ×${meta.freshness_factor.toFixed(2)} = ${product.toFixed(2)}${adjusted ? tx(` → 拆分/封顶后 ${w.toFixed(2)}`, ` → after split/cap ${w.toFixed(2)}`) : ""}`;
                        return (
                          <div key={bid} className="grid grid-cols-12 items-center gap-2 text-[11px]" title={formula}>
                            <span className="col-span-5 truncate text-[var(--color-foreground)]">
                              {BENCHMARK_SHORT_NAMES[bid] || meta.name}
                            </span>
                            <span className="col-span-2 text-right font-mono tabular-nums text-[var(--color-muted-foreground)]">
                              {rep.score.toFixed(0)}%
                            </span>
                            <div className="col-span-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-fill2)]">
                              <div
                                className="h-full rounded-full bg-[var(--color-primary)]"
                                style={{ width: `${Math.min(100, (w / maxWeight) * 100)}%` }}
                              />
                            </div>
                            <span className="col-span-2 text-right font-mono tabular-nums text-[var(--color-foreground)]">
                              ×{w.toFixed(2)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[10.5px] text-[var(--color-faint)]">
            {tx(
              "悬停任意一行可看完整算式。权重只决定这条成绩在拟合里的分量，分数高低由 IRT 按基准难度换算。",
              "Hover a row for the full formula. Weight sets how much a result counts in the fit; IRT converts the score using each benchmark's difficulty."
            )}
          </p>
        </div>

        {/* 第 2 步：维度分按权重合成 */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-[var(--color-foreground)]">
            {missing.length
              ? tx(
                  `② 综合分 = 已测维度加权平均（这里已测 ${pct(coverage)}）+ 缺测修正`,
                  `② Overall = weighted mean of measured dimensions (here ${pct(coverage)}) + missing adjustment`
                )
              : tx(
                  "② 综合分 = Σ(维度权重 × 维度分)，六个维度都有成绩",
                  "② Overall = Σ(dimension weight × dimension score); all six dimensions are scored"
                )}
          </div>
          <div className="space-y-1.5">
            {CATS.map((c) => {
              const part = parts.find((p) => p.cat === c);
              return (
                <div
                  key={c}
                  className="grid grid-cols-12 items-center gap-2 text-[11px]"
                  title={
                    part
                      ? `${pct(part.w)} × ${part.score.toFixed(1)} ÷ ${pct(coverage)} = ${part.contrib.toFixed(2)}`
                      : undefined
                  }
                >
                  <span className="col-span-3 truncate text-[var(--color-foreground)]">{catLabel(c)}</span>
                  <span className="col-span-3 font-mono tabular-nums text-[var(--color-muted-foreground)]">
                    {part
                      ? `${pct(part.w)} × ${part.score.toFixed(1)}`
                      : model.incomparable_categories?.includes(c)
                        ? tx(`${pct(weights[c])} · 不可比`, `${pct(weights[c])} · n/c`)
                        : tx(`${pct(weights[c])} · 缺测`, `${pct(weights[c])} · untested`)}
                  </span>
                  <div className="col-span-4 h-2 overflow-hidden rounded-full bg-[var(--color-fill2)]">
                    {part && (
                      <div
                        className="h-full rounded-full bg-[var(--color-primary)]"
                        style={{ width: `${Math.min(100, part.contrib)}%` }}
                      />
                    )}
                  </div>
                  <span className="col-span-2 text-right font-mono tabular-nums text-[var(--color-foreground)]">
                    {part ? `+${part.contrib.toFixed(1)}` : "—"}
                  </span>
                </div>
              );
            })}
            {est.line && (
              <>
                <div className="grid grid-cols-12 items-center gap-2 border-t border-[var(--color-hair)] pt-1.5 text-[11px]">
                  <span className="col-span-10 text-[var(--color-muted-foreground)]">
                    {tx("已测维度加权平均（条长 = 贡献，满格 100 分）", "Measured mean (bar = contribution, full width = 100)")}
                  </span>
                  <span className="col-span-2 text-right font-mono tabular-nums text-[var(--color-foreground)]">
                    {model.measured_score.toFixed(1)}
                  </span>
                </div>
                <div className="grid grid-cols-12 items-center gap-2 text-[11px]">
                  <span className="col-span-10 text-[var(--color-muted-foreground)]">
                    {tx(`缺测修正（${missingLabels.join("、")}）`, `Missing adjustment (${missingLabels.join(", ")})`)}
                  </span>
                  <span className="col-span-2 text-right font-mono tabular-nums text-[var(--color-foreground)]">
                    {signed(model.missing_adjustment)}
                  </span>
                </div>
              </>
            )}
            <div className="grid grid-cols-12 items-center gap-2 border-t border-[var(--color-hair)] pt-1.5 text-[11px]">
              <span className="col-span-10 text-[var(--color-muted-foreground)]">
                {est.line
                  ? tx("综合分", "Overall")
                  : tx("综合分（条长 = 对综合分的贡献，满格 100 分）", "Overall (bar = contribution, full width = 100)")}
              </span>
              <span className="col-span-2 text-right font-mono font-semibold tabular-nums text-[var(--color-foreground)]">
                {model.overall_score.toFixed(1)}
              </span>
            </div>
          </div>
          {est.line && (
            <p className="text-[11px] leading-relaxed text-[var(--color-muted-foreground)]">
              {tx(
                `缺测修正怎么来：在 ${est.line.n} 个六维都测过的模型上，拟合“只用${covered.map(catLabel).join("、")}算的分”和“六维全算的分”的关系，得到 六维分 ≈ ${est.line.slope.toFixed(3)} × 已测分 ${est.line.intercept >= 0 ? "+" : "−"} ${Math.abs(est.line.intercept).toFixed(1)}；它的已测分 ${model.measured_score.toFixed(1)} 代进去 ≈ ${model.overall_score.toFixed(1)}。缺的维度本身不编分数。不直接用已测平均，是因为同一模型的 SQL、安全普遍比其它维低（高分模型尤甚），直接平均会让缺这两维的模型偏高、缺架构/运维/性能的偏低。`,
                `How the adjustment works: across ${est.line.n} models scored on all six dimensions, the score from ${covered.map(catLabel).join(", ")} alone predicts the six-dimension score as 6D ≈ ${est.line.slope.toFixed(3)} × measured ${est.line.intercept >= 0 ? "+" : "−"} ${Math.abs(est.line.intercept).toFixed(1)}; plugging in its measured ${model.measured_score.toFixed(1)} gives ≈ ${model.overall_score.toFixed(1)}. Missing dimensions never get a made-up score. A plain average of measured dimensions would flatter models missing SQL or security (usually a model's weakest, especially at the top) and understate those missing architecture, systems or performance.`
              )}
            </p>
          )}
        </div>

        {/* 第 3 步：区间与名次 */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-[var(--color-foreground)]">
            {tx("③ 不确定度区间与名次", "③ Uncertainty range & rank")}
          </div>
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-[var(--color-fill2)]">
            <div
              className="absolute top-0 h-full rounded-full"
              style={{
                left: `${model.ci_90[0]}%`,
                width: `${Math.max(1, model.ci_90[1] - model.ci_90[0])}%`,
                backgroundColor: "color-mix(in srgb, var(--color-primary) 30%, transparent)",
              }}
            />
            <div
              className="absolute top-0 h-full w-1.5 rounded-full bg-[var(--color-primary)]"
              style={{ left: `calc(${Math.min(98.5, model.overall_score)}% - 3px)` }}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--color-muted-foreground)]">
            {tx(
              `区间 ${model.ci_90[0].toFixed(1)}–${model.ci_90[1].toFixed(1)} = 综合分 ± 1.645 × √(测量误差² + 缺测估计误差²)。测量误差 ±${est.measuredSe.toFixed(1)} 来自已测维度分的标准误${est.line ? `（按直线斜率 ${est.line.slope.toFixed(3)} 折算）` : ""}；${est.line ? `缺测估计误差 ±${est.predSd.toFixed(1)} 是那条直线在 ${est.line.n} 个参照模型上的实际预测误差，已测分离它们的平均水平越远越大` : "缺测估计误差为 0，六个维度都有成绩"}。`,
              `Range ${model.ci_90[0].toFixed(1)}–${model.ci_90[1].toFixed(1)} = overall ± 1.645 × √(measurement² + missing-estimate²). Measurement ±${est.measuredSe.toFixed(1)} from the measured dimensions' standard errors${est.line ? ` (scaled by the line's slope ${est.line.slope.toFixed(3)})` : ""}; ${est.line ? `missing-estimate ±${est.predSd.toFixed(1)} is that line's actual prediction error over ${est.line.n} reference models, growing the further the measured score sits from their average` : "missing-estimate is 0 — all six dimensions are scored"}.`
            )}{" "}
            {model.complete
              ? tx(
                  `已测维度占 ${pct(model.coverage)}，数据完整，综合排名第 ${model.rank}。`,
                  `Measured dimensions cover ${pct(model.coverage)} (complete), ranked #${model.rank}.`
                )
              : tx(
                  `已测维度只占 ${pct(model.coverage)}（不到 ${pct(rules.min_coverage)}），标为数据不全：照常排在第 ≈${model.rank} 名，但名次仅供参考。`,
                  `Measured dimensions cover only ${pct(model.coverage)} (< ${pct(rules.min_coverage)}), flagged incomplete: ranked ≈#${model.rank}, indicative only.`
                )}
          </p>
          <p className="text-[10.5px] text-[var(--color-faint)]">
            {tx(
              "区间按模型假设约为 90%，不包含脚手架、推理档位差异。",
              "~90% under the model's assumptions; harness and effort differences are not included."
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
