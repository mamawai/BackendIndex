"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import NumberFlow from "@number-flow/react";
import {
  ExternalLink,
  Layers,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { useLang } from "@/lib/i18n";
import {
  formatContext,
  formatPrice,
  formatTokens,
  getCategoryEvidenceDepth,
  getEvidenceDepthTone,
  type WeightedModelRow,
} from "@/lib/scoring";
import type { BenchmarkMeta, CategoryId } from "@/lib/types";
import { HexRadarChart, type RadarSeries } from "./HexRadarChart";

interface EvidenceDrawerProps {
  model: WeightedModelRow | null;
  originTop?: number | null;
  benchmarks: Record<string, BenchmarkMeta>;
  baselineScores?: Record<CategoryId, number | null>;
  onClose: () => void;
}

const SOURCE_BADGE: Record<string, { zh: string; en: string; cls: string }> = {
  benchmark_run: { zh: "维护方亲测", en: "Maintainer Run", cls: "tag g" },
  independent_run: { zh: "独立第三方", en: "Independent", cls: "tag b" },
  lab_reported: { zh: "厂商自报 (×0.72)", en: "Lab Reported (×0.72)", cls: "tag w" },
  third_party: { zh: "第三方转引 (×0.72)", en: "Third-Party (×0.72)", cls: "tag" },
};

const TIER_CLS: Record<string, string> = {
  S: "tag o",
  A: "tag",
  B: "tag",
};

export function EvidenceDrawer({
  model,
  originTop = null,
  benchmarks,
  baselineScores,
  onClose,
}: EvidenceDrawerProps) {
  const { lang, catLabel, tx } = useLang();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const activeId = model?.canonical_id ?? null;

  useEffect(() => {
    if (!activeId) return;
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.({ preventScroll: true });
    };
  }, [activeId]);

  if (!model) return null;

  const fromOffset =
    typeof window !== "undefined" && originTop !== null
      ? Math.max(24, Math.min(220, Math.round(originTop - window.innerHeight * 0.35 + 48)))
      : 32;

  const categories: CategoryId[] = [
    "repo",
    "architecture",
    "systems",
    "sql",
    "performance",
    "security",
  ];
  const catDepth = getCategoryEvidenceDepth(model, benchmarks);
  const harnessRows = model.ledger.filter((item) => item.harness || item.effort);

  const radarSeries: RadarSeries[] = [
    ...(baselineScores
      ? [
          {
            id: "__baseline__",
            name: tx("全榜中位线", "Board Median"),
            scores: baselineScores,
            color: "var(--color-faint)",
            isBaseline: true,
          },
        ]
      : []),
    {
      id: model.canonical_id,
      name: model.display_name,
      scores: model.category_scores,
      color: "var(--color-primary)",
    },
  ];

  return (
    <div
      className="dlg-wrap fixed inset-0 z-50 grid place-items-center p-4 sm:p-6"
      role="presentation"
    >
      <div
        className="animate-fade-in fixed inset-0 bg-[var(--color-scrim)] backdrop-blur-[4px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={tx(`${model.display_name} 能力画像与证据账本`, `${model.display_name} Profile & Evidence`)}
        tabIndex={-1}
        style={{ "--pop-from-y": `${fromOffset}px` } as CSSProperties}
        className="dlg-card animate-float-up relative z-10 flex max-h-[86vh] w-[min(880px,100%)] flex-col overflow-hidden rounded-[24px] bg-[var(--color-pop)] shadow-[var(--sh-dlg)] outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-medium text-[var(--color-primary)]">
                #{model.rank}
              </span>
              <h2 className="text-lg font-semibold tracking-tight text-[var(--color-foreground)]">
                {model.display_name}
              </h2>
              {model.is_open_weight && <span className="tag g">Open Weights</span>}
              <span className={`tag ${model.evidence_status === "Supported" ? "g" : "w"}`}>
                <i />
                {model.evidence_status} · {model.core_independent_family_count ?? model.independent_family_count}{" "}
                {tx("核心独立来源", "core indep. families")}
              </span>
            </div>
            <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
              {model.organization} · {tx(`覆盖 ${model.benchmark_count} 项基准 / ${model.observation_count} 条实测记录`, `${model.benchmark_count} benchmarks · ${model.observation_count} observations`)}
              {model.latest_date ? ` · ${tx("最新", "Latest")} ${model.latest_date}` : ""}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              aria-label={tx("关闭浮窗 (Esc)", "Close modal (Esc)")}
              className="ib"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* Score & Specs Summary */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div className="blk p-3.5">
              <div className="flex items-center justify-between gap-1 text-[11px] text-[var(--color-muted-foreground)]">
                <span>{tx("综合指数", "Overall Score")}</span>
                {(Math.abs(model.dynamicScore - model.overall_score) >= 0.05 ||
                  model.dynamicRank !== model.rank) && (
                  <span className="font-mono text-[10px] text-[var(--color-primary)]">
                    {tx(
                      `当前视图 #${model.dynamicRank} · ${model.dynamicScore.toFixed(1)}`,
                      `View #${model.dynamicRank} · ${model.dynamicScore.toFixed(1)}`
                    )}
                  </span>
                )}
              </div>
              <div className="mt-1 font-mono text-2xl font-light tracking-[-0.03em] text-[var(--color-foreground)]">
                <NumberFlow
                  value={model.overall_score}
                  format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
                />
              </div>
              <div
                className="whitespace-nowrap font-mono text-[10px] text-[var(--color-faint)]"
                title={tx(
                  "90% 置信区间：反映目前样本量与缺失维度导致的估计稳健范围，非单次最高/最低分",
                  "90% Confidence Interval from Fisher Information & missing-dimension penalty (not min/max)"
                )}
              >
                90% CI {model.ci_90[0].toFixed(1)}–{model.ci_90[1].toFixed(1)}
              </div>
            </div>

            <div className="blk p-3.5">
              <div className="text-[11px] text-[var(--color-muted-foreground)]">
                {tx("API 均价 / 1M", "Blended / 1M")}
              </div>
              <div className="mt-1 font-mono text-lg font-medium text-[var(--color-foreground)]">
                {formatPrice(model.blended_price_per_1m)}
              </div>
              <div className="font-mono text-[10px] text-[var(--color-faint)]">
                {formatPrice(model.prompt_price_per_1m)} {tx("入", "in")} /{" "}
                {formatPrice(model.completion_price_per_1m)} {tx("出", "out")}
              </div>
            </div>

            <div className="blk p-3.5">
              <div className="text-[11px] text-[var(--color-muted-foreground)]">
                {tx("Prompt 缓存价", "Cached Input")}
              </div>
              <div className="mt-1 font-mono text-lg font-medium text-[var(--color-foreground)]">
                {formatPrice(model.cache_read_price_per_1m)}
              </div>
              <div className="text-[10px] text-[var(--color-faint)]">per 1M cached</div>
            </div>

            <div className="blk p-3.5">
              <div className="text-[11px] text-[var(--color-muted-foreground)]">
                {tx("上下文窗口", "Context Window")}
              </div>
              <div className="mt-1 font-mono text-lg font-medium text-[var(--color-foreground)]">
                {formatContext(model.context_length)}
              </div>
              <div className="text-[10px] text-[var(--color-faint)]">
                {model.avg_eval_cost_usd
                  ? `${tx("均耗", "Avg eval")} $${model.avg_eval_cost_usd}`
                  : "tokens"}
              </div>
            </div>
          </div>

          {/* 6-Dimension Radar + Bars */}
          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 text-[var(--color-primary)]" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)]">
                  {tx("6 维能力校准分布（2PL IRT）", "6-Dimension Calibration Profile (2PL IRT)")}
                </h3>
              </div>
              <div className="flex items-center gap-3 text-[10.5px] text-[var(--color-muted-foreground)]">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-3 rounded-full bg-[var(--color-primary)]" />
                  {model.display_name}
                </span>
                {baselineScores && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-0.5 w-3 border-t border-dashed border-[var(--color-faint)]" />
                    {tx("全榜中位线", "Board Median")}
                  </span>
                )}
              </div>
            </div>

            <div className="blk grid grid-cols-1 items-center gap-4 p-4 sm:grid-cols-12">
              <div className="sm:col-span-5">
                <HexRadarChart
                  series={radarSeries}
                  showAxisScores
                  animateMorph
                  className="mx-auto max-w-[260px]"
                />
              </div>

              <div className="space-y-2.5 sm:col-span-7">
                {categories.map((c) => {
                  const val = model.category_scores[c];
                  const se = model.category_se[c];
                  const depth = catDepth[c];
                  const tone = getEvidenceDepthTone(depth.families);
                  const isAuxOnly = model.auxiliary_only_categories?.includes(c);
                  return (
                    <div key={c} className="grid grid-cols-12 items-center gap-2.5 text-xs">
                      <span
                        className="col-span-5 inline-flex flex-wrap items-center gap-1.5 font-medium text-[var(--color-foreground)]"
                        title={
                          isAuxOnly
                            ? tx(
                                "该维度目前仅包含辅助/竞赛/工具类子项实测",
                                "Covered only by auxiliary (contest/tool/drill) tracks"
                              )
                            : undefined
                        }
                      >
                        <span className="truncate">{catLabel(c)}</span>
                        {val !== null && depth.benchmarks > 0 && (
                          <span className={tone.badgeClass}>
                            {tx(
                              `${depth.benchmarks} 项 · ${depth.families} 来源`,
                              `${depth.benchmarks} bmk · ${depth.families} src`
                            )}
                          </span>
                        )}
                        {isAuxOnly && (
                          <span className="rounded bg-[var(--color-fill2)] px-1 py-0.5 font-mono text-[9px] text-[var(--color-faint)]">
                            {tx("辅助", "Aux")}
                          </span>
                        )}
                      </span>
                      <div className="col-span-4">
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-fill2)]">
                          {val !== null && (
                            <div
                              className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-500 ease-out"
                              style={{ width: `${Math.min(100, val)}%` }}
                            />
                          )}
                        </div>
                      </div>
                      <span className="col-span-3 text-right font-mono tabular-nums text-[var(--color-foreground)]">
                        {val !== null ? (
                          <>
                            {val.toFixed(1)}
                            {se !== null && (
                              <span className="ml-1 text-[10px] text-[var(--color-faint)]">
                                ±{se.toFixed(1)}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-[var(--color-faint)]">{tx("缺测", "Untested")}</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* Harness & Effort Breakdown */}
          {harnessRows.length > 0 && (
            <section>
              <div className="mb-2.5 flex items-center gap-2">
                <Wrench className="h-3.5 w-3.5 text-[var(--color-primary)]" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)]">
                  {tx("Agent Harness 脚手架与推理档位拆解", "Agent Harness & Reasoning Effort Breakdown")}
                </h3>
              </div>
              <div className="blk overflow-x-auto p-3">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{tx("基准", "Benchmark")}</th>
                      <th>{tx("Harness / 档位", "Harness / Effort")}</th>
                      <th className="text-right">{tx("实测得分", "Score")}</th>
                      <th className="text-right">{tx("成本 / Token", "Cost / Tokens")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {harnessRows.slice(0, 12).map((row, idx) => (
                      <tr key={`${row.benchmark_id}-${idx}`}>
                        <td className="font-medium text-[var(--color-foreground)]">
                          {row.benchmark_name}
                        </td>
                        <td className="text-xs text-[var(--color-muted-foreground)]">
                          <span className="rounded-md bg-[var(--color-raise)] px-1.5 py-0.5 text-[10.5px]">
                            {row.harness || "Default"}
                          </span>
                          {row.effort && (
                            <span
                              title={row.effort_note || undefined}
                              className="ml-1.5 font-mono text-[10.5px] text-[var(--color-primary)]"
                            >
                              {row.effort}
                            </span>
                          )}
                          {row.effort_note && (
                            <div className="mt-0.5 text-[10px] text-[var(--color-faint)]">
                              {row.effort_note}
                            </div>
                          )}
                        </td>
                        <td className="text-right font-mono tabular-nums text-[var(--color-foreground)]">
                          {row.raw_display}
                        </td>
                        <td className="text-right font-mono text-[11px] tabular-nums text-[var(--color-muted-foreground)]">
                          {row.cost_usd ? `$${row.cost_usd.toFixed(2)}` : "—"}
                          {row.tokens ? ` · ${formatTokens(row.tokens)}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Full Evidence Ledger */}
          <section>
            <div className="mb-2.5 flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 text-[var(--color-gain)]" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)]">
                {tx(
                  `Evidence Ledger · 完整原始证据账本 (${model.ledger.length} 条)`,
                  `Evidence Ledger · Raw Verified Runs (${model.ledger.length})`
                )}
              </h3>
            </div>
            <div className="blk divide-y divide-[var(--color-hair)] p-2">
              {model.ledger.map((item, idx) => {
                const bmeta = benchmarks[item.benchmark_id];
                const badge = SOURCE_BADGE[item.source_type] ?? SOURCE_BADGE.independent_run;
                const tier = bmeta?.tier ?? "A";
                return (
                  <div
                    key={`${item.benchmark_id}-${idx}`}
                    className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-xs transition-colors hover:bg-[var(--color-raise)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={TIER_CLS[tier]}>Tier {tier}</span>
                        <span className="font-medium text-[var(--color-foreground)]">
                          {item.benchmark_name}
                        </span>
                        <span className="text-[10.5px] text-[var(--color-faint)]">
                          · {catLabel(item.category)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted-foreground)]">
                        <span className={badge.cls}>{lang === "en" ? badge.en : badge.zh}</span>
                        <span>{item.source_family}</span>
                        {item.harness && <span>· {item.harness}</span>}
                        {item.effort && (
                          <span title={item.effort_note || undefined} className="font-mono">
                            ({item.effort})
                          </span>
                        )}
                        {item.date && <span className="font-mono text-[10px]">· {item.date}</span>}
                      </div>
                      {item.effort_note && (
                        <div className="mt-0.5 text-[10px] text-[var(--color-faint)]">
                          {item.effort_note}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-right">
                      <div>
                        <div className="font-mono font-semibold tabular-nums text-[var(--color-foreground)]">
                          {item.raw_display}
                        </div>
                        {bmeta && (
                          <div className="font-mono text-[10px] text-[var(--color-faint)]">
                            {!bmeta.scored
                              ? tx("外部对照 (不进主分)", "Ref Only (Non-IRT)")
                              : bmeta.core === false
                                ? tx(`辅助权重 ×${bmeta.base_weight.toFixed(2)}`, `Aux ×${bmeta.base_weight.toFixed(2)}`)
                                : tx(`基准权重 ×${bmeta.base_weight.toFixed(2)}`, `Weight ×${bmeta.base_weight.toFixed(2)}`)}
                          </div>
                        )}
                      </div>
                      <a
                        href={item.source_url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={tx(`查看 ${item.benchmark_name} 原始榜单`, `Open ${item.benchmark_name} source`)}
                        className="ib"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
