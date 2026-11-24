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
        `估出每个基准的难度和区分度，不借其它维度的分；和主榜不连通的 ${excludedCount} 项基准不计分；再按精度加权对齐到仓库研发刻度`,
        `Estimates each benchmark's difficulty & discrimination with no cross-dimension borrowing; ${excludedCount} disconnected benchmarks are not scored; precision-weighted linking to the Repo scale`
      ),
    },
    {
      title: tx("加权合成", "Combine"),
      value: tx("按维度信度连续融合", "Reliability-weighted fusion"),
      note: CATS.map((c) => `${catLabel(c)} ${pct(categories[c].weight)}`).join(" · "),
    },
    {
      title: tx("排名", "Rank"),
      value: tx(`${summary.ranked_models} 个模型同榜排名`, `${summary.ranked_models} models on one board`),
      note: tx(
        `已测维度不到权重 ${pct(rules.min_coverage)} 的 ${summary.ranked_models - summary.complete_models} 个标为"数据不全"；各维按统计信度 τ₀²/(τ₀²+SE²) 连续融合实测与 ${summary.complete_models} 个完整模型的跨维度基线（缺测自然退化为 0 信度）`,
        `${summary.ranked_models - summary.complete_models} models measured on < ${pct(rules.min_coverage)} of the weights are flagged incomplete; each dimension blends its measurement with a baseline fitted on ${summary.complete_models} complete models via reliability τ₀²/(τ₀²+SE²)`
      ),
    },
  ];

  // ---- 示例模型：按默认权重把综合分摊开（和管线同一算法，数字与快照一致）----
  const weights = useMemo(
    () => Object.fromEntries(CATS.map((c) => [c, categories[c].weight])) as Record<CategoryId, number>,
    [categories]
  );
  const tau0 = rules.reliability_tau ?? 6.5;
  const estimates = useMemo(
    () => estimateOverall(snapshot.models, weights, rules.min_coverage, tau0),
    [snapshot.models, weights, rules.min_coverage, tau0]
  );
  const est = estimates.get(model.canonical_id)!;
  const missing = CATS.filter((c) => model.category_scores[c] === null);
  const coverage = est.coverage;
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
                              {rep.display?.endsWith("×") ? rep.display : `${rep.score.toFixed(0)}%`}
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

        {/* 第 2 步：维度分按权重与统计信度连续合成 */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-[var(--color-foreground)]">
            {tx(
              `② 综合分 = Σ 维度权重 × [信度 r × 实测分 + (1 − r) × 跨维基线]（已测权重 ${pct(coverage)}，可靠均分 ${est.reliableMean.toFixed(1)}）`,
              `② Overall = Σ weight × [r × measured + (1 − r) × baseline] (${pct(coverage)} measured, reliable mean ${est.reliableMean.toFixed(1)})`
            )}
          </div>
          <div className="space-y-1.5">
            {est.parts.map((part) => {
              const c = part.cat;
              const isIncomp = model.incomparable_categories?.includes(c);
              const formula =
                part.measured !== null
                  ? `${pct(part.weight)} × [${pct(part.reliability)} × ${part.measured.toFixed(1)} + ${pct(1 - part.reliability)} × ${part.baseline.toFixed(1)}] = +${part.contrib.toFixed(2)}`
                  : `${pct(part.weight)} × ${part.baseline.toFixed(1)} (${tx("缺测基线", "missing baseline")}) = +${part.contrib.toFixed(2)}`;
              return (
                <div
                  key={c}
                  className="grid grid-cols-12 items-center gap-2 text-[11px]"
                  title={formula}
                >
                  <span className="col-span-3 truncate text-[var(--color-foreground)]">{catLabel(c)}</span>
                  <span className="col-span-4 truncate font-mono tabular-nums text-[var(--color-muted-foreground)]">
                    {part.measured !== null
                      ? tx(
                          `${pct(part.weight)} × ${part.effective.toFixed(1)} (实测 ${part.measured.toFixed(0)} · r=${pct(part.reliability)})`,
                          `${pct(part.weight)} × ${part.effective.toFixed(1)} (raw ${part.measured.toFixed(0)} · r=${pct(part.reliability)})`
                        )
                      : isIncomp
                        ? tx(`${pct(part.weight)} × ${part.baseline.toFixed(1)} · 不可比`, `${pct(part.weight)} × ${part.baseline.toFixed(1)} · n/c`)
                        : tx(`${pct(part.weight)} × ${part.baseline.toFixed(1)} · 缺测`, `${pct(part.weight)} × ${part.baseline.toFixed(1)} · untested`)}
                  </span>
                  <div className="col-span-3 h-2 overflow-hidden rounded-full bg-[var(--color-fill2)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-primary)]"
                      style={{ width: `${Math.min(100, part.effective)}%`, opacity: 0.35 + 0.65 * part.reliability }}
                    />
                  </div>
                  <span className="col-span-2 text-right font-mono tabular-nums text-[var(--color-foreground)]">
                    +{part.contrib.toFixed(1)}
                  </span>
                </div>
              );
            })}
            {(missing.length > 0 || Math.abs(model.missing_adjustment) >= 0.05) && (
              <>
                <div className="grid grid-cols-12 items-center gap-2 border-t border-[var(--color-hair)] pt-1.5 text-[11px]">
                  <span className="col-span-10 text-[var(--color-muted-foreground)]">
                    {tx("已测维度直接加权平均", "Direct weighted mean of measured dimensions")}
                  </span>
                  <span className="col-span-2 text-right font-mono tabular-nums text-[var(--color-foreground)]">
                    {model.measured_score.toFixed(1)}
                  </span>
                </div>
                <div className="grid grid-cols-12 items-center gap-2 text-[11px]">
                  <span className="col-span-10 text-[var(--color-muted-foreground)]">
                    {missing.length > 0
                      ? tx(
                          `信度与缺测修正（含缺测：${missingLabels.join("、")}）`,
                          `Reliability & missing adjustment (missing: ${missingLabels.join(", ")})`
                        )
                      : tx("低信度单榜噪声平滑修正", "Low-reliability noise shrinkage adjustment")}
                  </span>
                  <span className="col-span-2 text-right font-mono tabular-nums text-[var(--color-foreground)]">
                    {signed(model.missing_adjustment)}
                  </span>
                </div>
              </>
            )}
            <div className="grid grid-cols-12 items-center gap-2 border-t border-[var(--color-hair)] pt-1.5 text-[11px]">
              <span className="col-span-10 text-[var(--color-muted-foreground)]">
                {tx("综合分（悬停各维可看完整融合算式）", "Overall (hover any dimension for exact formula)")}
              </span>
              <span className="col-span-2 text-right font-mono font-semibold tabular-nums text-[var(--color-foreground)]">
                {model.overall_score.toFixed(1)}
              </span>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--color-muted-foreground)]">
            {tx(
              `为什么按信度 r = τ₀² / (τ₀² + SE²)（τ₀ = ${tau0}）连续融合：单维榜单完全保留各维原始分数不变；但在合成综合分时，测了多项核心大榜、误差极小（SE ≈ 2）的维度信度达 90%+，几乎全按实测算；而只测了 1 个极高噪声微基准（如单测 Tinybird SQL，SE ≈ 17，r ≈ 13%）的维度只占它应有的小部分权重，剩余权重与完全缺测（r = 0%）采用同一套跨维度基线直线估算，彻底消除了“多测一个低精度小榜反而比交白卷倒扣 2–4 分”的断崖。`,
              `Why blend by reliability r = τ₀² / (τ₀² + SE²) (τ₀ = ${tau0}): single-dimension boards keep raw dimension scores untouched, while Overall weights each dimension's direct score by its measurement reliability. Well-measured dimensions (SE ≈ 2) get >90% direct weight, whereas noisy single-benchmark dimensions (e.g. Tinybird-only SQL with SE ≈ 17, r ≈ 13%) smoothly fall back toward the same cross-dimension baseline used for untested dimensions (r = 0%), eliminating the cliff where taking a noisy micro-benchmark hurt more than leaving it untested.`
            )}
          </p>
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
              `区间 ${model.ci_90[0].toFixed(1)}–${model.ci_90[1].toFixed(1)} = 综合分 ± 1.645 × √(测量误差² + 基线估计误差²)。其中已测部分的测量标准误为 ${est.measuredSe.toFixed(2)}，低信度与缺测部分由跨维度基线引入的结构预测标准误为 ${est.predSd.toFixed(2)}（合成标准误 ${est.se.toFixed(2)}）。`,
              `Range ${model.ci_90[0].toFixed(1)}–${model.ci_90[1].toFixed(1)} = overall ± 1.645 × √(measurement² + baseline-prediction²), combining direct measurement SE ${est.measuredSe.toFixed(2)} with cross-dimension baseline prediction SE ${est.predSd.toFixed(2)} (total SE ${est.se.toFixed(2)}).`
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
