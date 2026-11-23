"use client";

import { useMemo, useState } from "react";
import NumberFlow from "@number-flow/react";
import { ArrowUpRight, Plus, RotateCcw, Search, Trophy, X } from "lucide-react";
import { useLang } from "@/lib/i18n";
import { buildComparePreset, type ComparePresetKey } from "@/lib/presets";
import {
  BENCHMARK_SHORT_NAMES,
  formatContext,
  formatPrice,
  getCategoryEvidenceDepth,
  getEvidenceDepthTone,
  recomputeRankings,
  type WeightedModelRow,
} from "@/lib/scoring";
import type { CategoryId, SnapshotData } from "@/lib/types";
import {
  HexRadarChart,
  RADAR_AXES,
  RADAR_PALETTE,
  type RadarSeries,
} from "./HexRadarChart";
import { SlidingTabs } from "./ui/SlidingControls";

interface CompareViewProps {
  snapshot: SnapshotData;
  weights: Record<CategoryId, number>;
  compareIds: string[];
  onCompareIdsChange: (ids: string[]) => void;
  onSelectModel: (model: WeightedModelRow, originTop?: number) => void;
}

type MatrixTab = "dimensions" | "benchmarks" | "specs";

const KEY_SHARED_BENCHMARKS = [
  "swe_rebench",
  "frontierswe",
  "bughunt",
  "vals_swebench",
  "swe_bench_pro",
  "vals_programbench",
  "mirrorcode",
  "scale_swe_atlas_refactoring",
  "terminal_bench_41",
  "otelbench",
  "itbench_aa",
  "livesqlbench",
  "scale_sql_optimization",
  "tinybird_sql",
  "gso",
  "frontierswe_perf",
  "vals_ioi",
  "vals_cyber",
  "autobaxbench_hard",
];

const PRESET_LIST: { key: ComparePresetKey; zh: string; en: string }[] = [
  { key: "top4", zh: "榜单前四", en: "Top 4 Ranked" },
  { key: "flagship", zh: "四大厂旗舰", en: "Top 4 Labs" },
  { key: "full6d", zh: "六维全满测", en: "Full 6D Tested" },
  { key: "open", zh: "开源四强", en: "Top Open Weights" },
  { key: "value", zh: "高性价比", en: "Best Value" },
];

export function CompareView({
  snapshot,
  weights,
  compareIds,
  onCompareIdsChange,
  onSelectModel,
}: CompareViewProps) {
  const { lang, catLabel, tx } = useLang();
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [matrixTab, setMatrixTab] = useState<MatrixTab>("dimensions");
  const [openSlotIdx, setOpenSlotIdx] = useState<number | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");

  const ranked = useMemo(
    () => recomputeRankings(snapshot.models, weights, "overall", snapshot.rules.min_coverage),
    [snapshot.models, snapshot.rules.min_coverage, weights]
  );

  const modelMap = useMemo(() => {
    const map = new Map<string, WeightedModelRow>();
    for (const m of ranked) map.set(m.canonical_id, m);
    return map;
  }, [ranked]);

  const activeModels = useMemo(
    () =>
      compareIds
        .map((id) => modelMap.get(id))
        .filter((m): m is WeightedModelRow => Boolean(m))
        .slice(0, 4),
    [compareIds, modelMap]
  );

  const depthById = useMemo(() => {
    const out = new Map<string, ReturnType<typeof getCategoryEvidenceDepth>>();
    for (const m of activeModels) {
      out.set(m.canonical_id, getCategoryEvidenceDepth(m, snapshot.benchmarks));
    }
    return out;
  }, [activeModels, snapshot.benchmarks]);

  const radarSeries: RadarSeries[] = useMemo(
    () =>
      activeModels.map((m, idx) => ({
        id: m.canonical_id,
        name: m.display_name,
        scores: m.category_scores,
        color: RADAR_PALETTE[idx % RADAR_PALETTE.length],
        incomparable: m.incomparable_categories,
      })),
    [activeModels]
  );

  const pickerCandidates = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return ranked
      .filter((m) => {
        if (compareIds.includes(m.canonical_id)) return false;
        if (!q) return true;
        return `${m.display_name} ${m.organization} ${m.harnesses.join(" ")}`
          .toLowerCase()
          .includes(q);
      })
      .slice(0, 14);
  }, [ranked, compareIds, pickerQuery]);

  const applyPreset = (key: ComparePresetKey) => {
    onCompareIdsChange(buildComparePreset(ranked, key, 4));
    setOpenSlotIdx(null);
  };

  const replaceOrAddAtSlot = (slotIdx: number, newId: string) => {
    const next = [...compareIds];
    if (slotIdx < next.length) {
      next[slotIdx] = newId;
    } else if (next.length < 4) {
      next.push(newId);
    }
    onCompareIdsChange(next);
    setOpenSlotIdx(null);
    setPickerQuery("");
  };

  const removeAtSlot = (id: string) => {
    onCompareIdsChange(compareIds.filter((x) => x !== id));
    setOpenSlotIdx(null);
  };

  const slots = [0, 1, 2, 3];

  return (
    <div className="space-y-6">
      {/* Header Strip */}
      <section className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-border)] pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-[var(--color-foreground)] sm:text-[28px]">
            {tx("多模型六维同框 PK 对比", "Multi-Model 6D Comparison")}
          </h1>
          <p className="mt-1.5 max-w-2xl text-xs text-[var(--color-muted-foreground)] sm:text-sm">
            {tx(
              "默认载入综合榜前 4 名模型，支持最多 4 个模型在同一张 6 维雷达图上叠图比对，支持维度胜出高亮、真实代表基准逐项 PK 与成本上下文并排对照。",
              "Defaults to Top 4 ranked models. Overlay up to 4 models on a single 6-axis radar chart with benchmark-level head-to-head and pricing specs."
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {PRESET_LIST.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p.key)}
              className="chip"
            >
              {lang === "en" ? p.en : p.zh}
            </button>
          ))}
          <button
            type="button"
            onClick={() => applyPreset("top4")}
            className="btn sm"
            title={tx("重置为综合榜前四模型", "Reset to Top 4 ranked models")}
          >
            <RotateCcw className="h-3 w-3" />
            {tx("重置", "Reset")}
          </button>
        </div>
      </section>

      {/* 4 Dedicated Model Slots */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {slots.map((slotIdx) => {
          const m = activeModels[slotIdx];
          const color = RADAR_PALETTE[slotIdx % RADAR_PALETTE.length];
          const isPickerOpen = openSlotIdx === slotIdx;

          return (
            <div
              key={slotIdx}
              onMouseEnter={() => m && setHighlightedId(m.canonical_id)}
              onMouseLeave={() => m && setHighlightedId(null)}
              className="blk relative flex flex-col justify-between p-4"
            >
              {m ? (
                <>
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                        <span className="font-mono text-[11px] font-medium text-[var(--color-muted-foreground)]">
                          #{m.dynamicComplete ? "" : "≈"}{m.dynamicRank} · {m.organization}
                        </span>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenSlotIdx(isPickerOpen ? null : slotIdx);
                            setPickerQuery("");
                          }}
                          className="btn sm plain"
                        >
                          {tx("换一个", "Swap")}
                        </button>
                        {activeModels.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeAtSlot(m.canonical_id)}
                            aria-label={tx(`移出 ${m.display_name}`, `Remove ${m.display_name}`)}
                            className="ib h-7 w-7"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    <h3 className="mt-2.5 truncate text-[16px] font-semibold text-[var(--color-foreground)]">
                      {m.display_name}
                    </h3>
                  </div>

                  <div className="mt-4 flex items-end justify-between gap-2">
                    <div>
                      <div className="font-mono text-[28px] leading-none font-light tracking-[-0.04em] text-[var(--color-foreground)]">
                        <NumberFlow
                          value={m.dynamicScore}
                          format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
                        />
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-[var(--color-muted-foreground)]">
                        {m.covered_categories.length}/6 {tx("维", "dims")} ·{" "}
                        {formatPrice(m.blended_price_per_1m)}/M
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => onSelectModel(m, e.currentTarget.getBoundingClientRect().top)}
                      className="btn sm"
                    >
                      {tx("账本", "Ledger")}
                      <ArrowUpRight className="h-3 w-3" />
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setOpenSlotIdx(isPickerOpen ? null : slotIdx);
                    setPickerQuery("");
                  }}
                  className="flex min-h-[118px] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--color-line2)] text-xs text-[var(--color-muted-foreground)] transition-colors hover:border-[var(--color-foreground)] hover:text-[var(--color-foreground)]"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-raise)]">
                    <Plus className="h-4 w-4" />
                  </span>
                  <span>
                    {tx(`添加第 ${slotIdx + 1} 个对比模型`, `Add model slot #${slotIdx + 1}`)}
                  </span>
                </button>
              )}

              {isPickerOpen && (
                <div className="animate-dlg-in absolute top-full left-0 z-30 mt-2 w-full min-w-[260px] rounded-2xl bg-[var(--color-pop)] p-3 shadow-[var(--sh-pop)]">
                  <div className="inp mb-2">
                    <Search className="h-3.5 w-3.5 text-[var(--color-faint)]" />
                    <input
                      type="text"
                      value={pickerQuery}
                      onChange={(e) => setPickerQuery(e.target.value)}
                      placeholder={tx("搜索模型名称或厂商...", "Search model or lab...")}
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setOpenSlotIdx(null)}
                      className="text-[var(--color-faint)] hover:text-[var(--color-foreground)]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="max-h-56 space-y-0.5 overflow-y-auto">
                    {pickerCandidates.map((cand) => (
                      <button
                        key={cand.canonical_id}
                        type="button"
                        onClick={() => replaceOrAddAtSlot(slotIdx, cand.canonical_id)}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-[var(--color-pop-h)]"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium text-[var(--color-foreground)]">
                            {cand.display_name}
                          </div>
                          <div className="text-[10.5px] text-[var(--color-muted-foreground)]">
                            {cand.organization} · {cand.covered_categories.length}/6{" "}
                            {tx("维", "dims")}
                          </div>
                        </div>
                        <span className="ml-2 shrink-0 font-mono text-[11px] text-[var(--color-muted-foreground)]">
                          #{cand.dynamicComplete ? "" : "≈"}{cand.dynamicRank} · {cand.dynamicScore.toFixed(1)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* Main 4-Model Radar + Deep Breakdown Matrix */}
      <section className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        <div className="blk lg:col-span-5">
          <div className="pb-2">
            <h2 className="text-sm font-semibold text-[var(--color-foreground)]">
              {tx("四模型六维叠加雷达图", "4-Model 6D Overlaid Radar")}
            </h2>
            <p className="mt-0.5 text-[11.5px] text-[var(--color-muted-foreground)]">
              {tx(
                "悬停图例或顶点可单独高亮某条轮廓；虚线代表跨越缺测维度",
                "Hover legend or vertex to isolate a series; dashed edges bridge untested axes."
              )}
            </p>
          </div>

          <div className="mx-auto mt-2 max-w-[430px]">
            <HexRadarChart
              series={radarSeries}
              highlightedId={highlightedId}
              onHighlightChange={setHighlightedId}
              animateMorph={false}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-2 border-t border-[var(--color-hair)] pt-3.5">
            {activeModels.map((m, idx) => (
              <button
                key={m.canonical_id}
                type="button"
                onMouseEnter={() => setHighlightedId(m.canonical_id)}
                onMouseLeave={() => setHighlightedId(null)}
                onClick={(e) => onSelectModel(m, e.currentTarget.getBoundingClientRect().top)}
                className="chip"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: RADAR_PALETTE[idx % RADAR_PALETTE.length] }}
                />
                <span>{m.display_name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="blk lg:col-span-7">
          <SlidingTabs
            value={matrixTab}
            onChange={setMatrixTab}
            items={[
              { value: "dimensions", label: tx("6 大能力维度", "6 Capabilities") },
              { value: "benchmarks", label: tx("核心代表基准", "Key Benchmarks") },
              { value: "specs", label: tx("定价 · 上下文 · 脚手架", "Pricing & Harnesses") },
            ]}
          />

          <div key={matrixTab} className="animate-tab-in mt-4 overflow-x-auto">
            {matrixTab === "dimensions" && (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{tx("能力维度", "Dimension")}</th>
                    {activeModels.map((m, idx) => (
                      <th key={m.canonical_id} className="text-right">
                        <span className="inline-flex items-center justify-end gap-1.5">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: RADAR_PALETTE[idx % RADAR_PALETTE.length] }}
                          />
                          <span>{m.display_name}</span>
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {RADAR_AXES.map((axis) => {
                    const numeric = activeModels
                      .map((m) => m.category_scores[axis.id])
                      .filter((v): v is number => v !== null);
                    const maxVal = numeric.length >= 2 ? Math.max(...numeric) : null;

                    return (
                      <tr key={axis.id}>
                        <td className="font-medium text-[var(--color-foreground)]">
                          {catLabel(axis.id)}
                        </td>
                        {activeModels.map((m, idx) => {
                          const v = m.category_scores[axis.id];
                          const se = m.category_se[axis.id];
                          const d = depthById.get(m.canonical_id)?.[axis.id];
                          const tone = d && d.families > 0 ? getEvidenceDepthTone(d.families) : null;
                          const isWin = maxVal !== null && v === maxVal;
                          const color = RADAR_PALETTE[idx % RADAR_PALETTE.length];

                          return (
                            <td key={`${axis.id}-${m.canonical_id}`} className="text-right">
                              {v !== null ? (
                                <div className="inline-flex flex-col items-end gap-1">
                                  <div className="inline-flex items-center gap-1 font-mono tabular-nums">
                                    {isWin && (
                                      <Trophy className="h-3 w-3 text-[var(--color-primary)]" />
                                    )}
                                    <span
                                      className={
                                        isWin
                                          ? "font-semibold text-[var(--color-foreground)]"
                                          : "text-[var(--color-muted-foreground)]"
                                      }
                                    >
                                      {v.toFixed(1)}
                                    </span>
                                    {se !== null && (
                                      <span className="text-[10px] text-[var(--color-faint)]">
                                        ±{se.toFixed(1)}
                                      </span>
                                    )}
                                  </div>
                                  <div className="h-1 w-20 overflow-hidden rounded-full bg-[var(--color-fill2)]">
                                    <div
                                      className="h-full rounded-full transition-[width] duration-500 ease-out"
                                      style={{
                                        width: `${Math.min(100, v)}%`,
                                        backgroundColor: color,
                                      }}
                                    />
                                  </div>
                                  {d && d.benchmarks > 0 && tone && (
                                    <div className={tone.badgeClass}>
                                      {tx(
                                        `${d.benchmarks} 项 · ${d.families} 独立来源`,
                                        `${d.benchmarks} bmk · ${d.families} indep. src`
                                      )}
                                    </div>
                                  )}
                                  {m.single_benchmark_categories?.includes(axis.id) && (
                                    <div className="font-mono text-[9px] text-[var(--color-faint)]">
                                      {tx("单基准，仅供参考", "single benchmark")}
                                    </div>
                                  )}
                                </div>
                              ) : m.incomparable_categories?.includes(axis.id) ? (
                                <span
                                  className="text-xs text-[var(--color-warning)]"
                                  title={tx(
                                    "只有和本维度主榜不连通的基准成绩，没法同台比较",
                                    "Only results on boards disconnected from the main set"
                                  )}
                                >
                                  {tx("不可比", "Not comparable")}
                                </span>
                              ) : (
                                <span className="text-xs text-[var(--color-faint)]">
                                  {tx("缺测", "Untested")}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {matrixTab === "benchmarks" && (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{tx("代表性真实基准", "Representative Benchmark")}</th>
                    {activeModels.map((m, idx) => (
                      <th key={m.canonical_id} className="text-right">
                        <span className="inline-flex items-center justify-end gap-1.5">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: RADAR_PALETTE[idx % RADAR_PALETTE.length] }}
                          />
                          <span>{m.display_name}</span>
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {KEY_SHARED_BENCHMARKS.map((bid) => {
                    const meta = snapshot.benchmarks[bid];
                    if (!meta) return null;
                    const rowScores = activeModels.map(
                      (m) => m.representative_benchmarks[bid]?.score ?? null
                    );
                    if (rowScores.every((s) => s === null)) return null;
                    const valid = rowScores.filter((s): s is number => s !== null);
                    const maxScore = valid.length >= 2 ? Math.max(...valid) : null;

                    return (
                      <tr key={bid}>
                        <td>
                          <div className="font-medium text-[var(--color-foreground)]">
                            {BENCHMARK_SHORT_NAMES[bid] || meta.name}
                          </div>
                          <div className="text-[10.5px] text-[var(--color-faint)]">
                            {catLabel(meta.category)} · Tier {meta.tier}
                          </div>
                        </td>
                        {activeModels.map((m) => {
                          const entry = m.representative_benchmarks[bid];
                          const isWin = maxScore !== null && entry?.score === maxScore;
                          return (
                            <td key={`${bid}-${m.canonical_id}`} className="text-right font-mono">
                              {entry ? (
                                <div>
                                  <span
                                    className={
                                      isWin
                                        ? "font-semibold text-[var(--color-primary)]"
                                        : "text-[var(--color-foreground)]"
                                    }
                                  >
                                    {entry.display || `${entry.score.toFixed(1)}%`}
                                  </span>
                                  {entry.harness && (
                                    <div className="text-[10px] text-[var(--color-faint)]">
                                      {entry.harness}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span className="text-[var(--color-faint)]">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {matrixTab === "specs" && (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{tx("工程指标", "Specification")}</th>
                    {activeModels.map((m, idx) => (
                      <th key={m.canonical_id} className="text-right">
                        <span className="inline-flex items-center justify-end gap-1.5">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: RADAR_PALETTE[idx % RADAR_PALETTE.length] }}
                          />
                          <span>{m.display_name}</span>
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="text-[var(--color-muted-foreground)]">
                      {tx("综合得分 · 不确定度区间", "Overall Score · Uncertainty")}
                    </td>
                    {activeModels.map((m) => (
                      <td key={m.canonical_id} className="text-right font-mono font-medium">
                        {m.dynamicScore.toFixed(1)}{" "}
                        <span className="text-[10.5px] text-[var(--color-faint)]">
                          ({m.dynamicCi[0].toFixed(0)}–{m.dynamicCi[1].toFixed(0)})
                        </span>
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="text-[var(--color-muted-foreground)]">
                      {tx("Blended API 均价 / 1M", "Blended Price / 1M")}
                    </td>
                    {activeModels.map((m) => (
                      <td key={m.canonical_id} className="text-right font-mono">
                        {formatPrice(m.blended_price_per_1m)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="text-[var(--color-muted-foreground)]">
                      Input / Output / Cache
                    </td>
                    {activeModels.map((m) => (
                      <td key={m.canonical_id} className="text-right font-mono text-xs">
                        {formatPrice(m.prompt_price_per_1m)} /{" "}
                        {formatPrice(m.completion_price_per_1m)} /{" "}
                        {formatPrice(m.cache_read_price_per_1m)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="text-[var(--color-muted-foreground)]">
                      {tx("上下文窗口", "Context Window")}
                    </td>
                    {activeModels.map((m) => (
                      <td key={m.canonical_id} className="text-right font-mono">
                        {formatContext(m.context_length)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="text-[var(--color-muted-foreground)]">
                      {tx("权重开放与证据等级", "Weights & Evidence")}
                    </td>
                    {activeModels.map((m) => (
                      <td key={m.canonical_id} className="text-right">
                        <span className={`tag ${m.is_open_weight ? "g" : ""}`}>
                          {m.is_open_weight ? tx("开源权重", "Open") : tx("闭源 API", "Closed")} ·{" "}
                          {m.evidence_status}
                        </span>
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="text-[var(--color-muted-foreground)]">
                      {tx("独立来源家族 / 基准数", "Independent Families / Evals")}
                    </td>
                    {activeModels.map((m) => (
                      <td key={m.canonical_id} className="text-right font-mono">
                        {m.independent_family_count} {tx("家族", "fam")} · {m.benchmark_count}{" "}
                        {tx("基准", "evals")}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="text-[var(--color-muted-foreground)]">
                      {tx("主力实测脚手架", "Primary Harnesses")}
                    </td>
                    {activeModels.map((m) => (
                      <td key={m.canonical_id} className="text-right text-xs">
                        {m.harnesses.length > 0 ? m.harnesses.slice(0, 3).join(" · ") : "—"}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
