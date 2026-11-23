"use client";

import { useMemo, useState } from "react";
import NumberFlow from "@number-flow/react";
import { ChevronRight, Search, SlidersHorizontal } from "lucide-react";
import { useLang } from "@/lib/i18n";
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
import { TopLeaders } from "./TopLeaders";
import { Collapsible, Seg } from "./ui/SlidingControls";
import { WeightPopover } from "./WeightPopover";

type BoardView = CategoryId | "overall";

interface LeaderboardViewProps {
  snapshot: SnapshotData;
  weights: Record<CategoryId, number>;
  onWeightsChange: (w: Record<CategoryId, number>) => void;
  onSelectModel: (model: WeightedModelRow, originTop?: number) => void;
}

const VIEW_IDS: BoardView[] = [
  "overall",
  "repo",
  "architecture",
  "systems",
  "sql",
  "performance",
  "security",
];

const OVERALL_CHIPS: { id: CategoryId; short: string; wideOnly?: boolean }[] = [
  { id: "repo", short: "Repo" },
  { id: "architecture", short: "Arch" },
  { id: "systems", short: "Sys" },
  { id: "sql", short: "SQL" },
  { id: "performance", short: "Perf", wideOnly: true },
  { id: "security", short: "Sec", wideOnly: true },
];

export function LeaderboardView({
  snapshot,
  weights,
  onWeightsChange,
  onSelectModel,
}: LeaderboardViewProps) {
  const { catLabel, catTabLabel, tx } = useLang();
  const [view, setView] = useState<BoardView>("overall");
  const [search, setSearch] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  const [supportedOnly, setSupportedOnly] = useState(false);
  const [showWeights, setShowWeights] = useState(false);
  const [showAllRows, setShowAllRows] = useState(false);

  const viewTabs = useMemo(
    () =>
      VIEW_IDS.map((id) => ({
        value: id,
        label: id === "overall" ? tx("综合 Overall", "Overall") : catTabLabel(id),
      })),
    [catTabLabel, tx]
  );

  const ranked = useMemo(
    () => recomputeRankings(snapshot.models, weights, view),
    [snapshot.models, weights, view]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ranked.filter((m) => {
      if (openOnly && !m.is_open_weight) return false;
      if (supportedOnly && m.evidence_status !== "Supported") return false;
      if (q) {
        const hay = `${m.display_name} ${m.organization} ${m.harnesses.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [ranked, openOnly, supportedOnly, search]);

  const getKeyBenchmarksForCategory = (m: WeightedModelRow, cat: CategoryId) => {
    return Object.entries(m.representative_benchmarks)
      .filter(([bid]) => snapshot.benchmarks[bid]?.category === cat)
      .sort(
        (a, b) =>
          (snapshot.benchmarks[b[0]]?.base_weight ?? 1) -
          (snapshot.benchmarks[a[0]]?.base_weight ?? 1)
      )
      .slice(0, 3);
  };

  return (
    <div className="space-y-7">
      {/* Compact Hero */}
      <section className="flex flex-col justify-between gap-4 border-b border-[var(--color-border)] pb-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-[var(--color-foreground)] sm:text-[28px]">
            Backend Engineering Index
          </h1>
          <p className="mt-1.5 max-w-2xl text-xs text-[var(--color-muted-foreground)] sm:text-sm">
            {tx("汇总 ", "Aggregating ")}
            <span className="font-mono font-medium text-[var(--color-foreground)]">
              {snapshot.summary.tracked_benchmarks}
            </span>
            {tx(" 个真实后端与系统工程基准（", " real-world backend & systems benchmarks (")}
            <span className="font-mono font-medium text-[var(--color-foreground)]">
              {snapshot.summary.total_observations}
            </span>
            {tx(
              " 条实测记录），经三档权威权重与 2PL IRT 校准。点击任意行可溯源全部证据与脚手架。",
              " measured runs), calibrated via tiered authority weights & 2PL IRT. Click any row for full evidence."
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2 rounded-full bg-[var(--color-fill)] px-3.5 py-1.5 font-mono text-xs tabular-nums text-[var(--color-muted-foreground)]">
          <span className="font-medium text-[var(--color-foreground)]">
            {snapshot.summary.ranked_models}
          </span>
          <span>Ranked</span>
          <span className="opacity-40">·</span>
          <span className="font-medium text-[var(--color-gain)]">
            {snapshot.summary.supported_models}
          </span>
          <span>Supported</span>
        </div>
      </section>

      {/* Top 3 Podium Cards */}
      <TopLeaders leaders={filtered} onSelectModel={onSelectModel} />

      {/* Category Segmented Bar + Filter Chips + Weights Accordion */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Seg
            value={view}
            onChange={setView}
            options={viewTabs}
            label={tx("后端能力维度切换", "Backend capability filter")}
          />

          <div className="flex flex-wrap items-center gap-2">
            <div className="inp w-44 sm:w-52">
              <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-faint)]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tx("搜索模型 / 厂商...", "Search model / lab...")}
              />
            </div>

            <button
              type="button"
              aria-pressed={openOnly}
              onClick={() => setOpenOnly((v) => !v)}
              className="chip"
            >
              {tx("仅开源", "Open Weights")}
            </button>

            <button
              type="button"
              aria-pressed={supportedOnly}
              onClick={() => setSupportedOnly((v) => !v)}
              className="chip"
            >
              {tx("仅 Supported", "Supported Only")}
            </button>

            {view === "overall" && (
              <button
                type="button"
                aria-pressed={showWeights}
                onClick={() => setShowWeights((v) => !v)}
                className="chip"
              >
                <SlidersHorizontal className="h-3 w-3" />
                {tx("权重调优", "Weights")}
              </button>
            )}
          </div>
        </div>

        <Collapsible open={showWeights && view === "overall"}>
          <div className="pt-0.5">
            <WeightPopover weights={weights} onChange={onWeightsChange} />
          </div>
        </Collapsible>
      </div>

      {/* Borderless Clean Leaderboard Table */}
      <div className="tw">
        <table className="tbl hov">
          <thead>
            <tr>
              <th className="w-12">#</th>
              <th>{tx("模型与主力脚手架", "Model & Primary Harness")}</th>
              <th>
                {view === "overall" ? "BackendIndex" : catLabel(view)} · 90% CI
              </th>
              <th className="hidden lg:table-cell">
                {view === "overall"
                  ? tx("六大能力维度（上标 = 来源数）", "6-Dimension Breakdown (sup = sources)")
                  : tx("该维度代表基准实测", "Key Measured Benchmarks")}
              </th>
              <th className="hidden text-right sm:table-cell">
                {tx("API 均价 · 上下文", "Blended Price · Ctx")}
              </th>
              <th className="w-20 text-right">{tx("溯源", "Ledger")}</th>
            </tr>
          </thead>
          <tbody>
            {(search.trim() || showAllRows ? filtered : filtered.slice(0, 30)).map((m, idx) => {
              const [ciLow, ciHigh] = m.dynamicCi;
              const keyBms = view !== "overall" ? getKeyBenchmarksForCategory(m, view) : [];
              const catDepth = view === "overall" ? getCategoryEvidenceDepth(m, snapshot.benchmarks) : null;

              return (
                // Anchor table rows by rank slot so scores roll and CI bars glide in place across tabs
                <tr
                  key={`row-${idx}`}
                  onClick={(e) => onSelectModel(m, e.currentTarget.getBoundingClientRect().top)}
                >
                  <td className="font-mono text-xs text-[var(--color-muted-foreground)] tabular-nums">
                    {m.dynamicRank}
                  </td>

                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-[var(--color-foreground)]">
                        {m.display_name}
                      </span>
                      {m.is_open_weight && <span className="tag g">Open</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--color-muted-foreground)]">
                      <span>{m.organization}</span>
                      {m.primary_harness && (
                        <span className="rounded-md bg-[var(--color-fill)] px-1.5 py-0.5 text-[10.5px]">
                          {m.primary_harness}
                        </span>
                      )}
                    </div>
                  </td>

                  <td>
                    <div className="flex items-center gap-3">
                      <span className="inline-flex w-12 shrink-0 items-center font-mono text-sm font-semibold tabular-nums text-[var(--color-foreground)]">
                        <NumberFlow
                          value={m.dynamicScore}
                          format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
                        />
                      </span>
                      <div className="hidden w-24 sm:block">
                        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-fill2)]">
                          <div
                            className="absolute top-0 h-full rounded-full transition-all duration-500 ease-out"
                            style={{
                              left: `${ciLow}%`,
                              width: `${Math.max(2, ciHigh - ciLow)}%`,
                              backgroundColor: "color-mix(in srgb, var(--color-primary) 26%, transparent)",
                            }}
                          />
                          <div
                            className="absolute top-0 h-full w-1.5 rounded-full bg-[var(--color-primary)] transition-all duration-500 ease-out"
                            style={{ left: `calc(${Math.min(98.5, m.dynamicScore)}% - 3px)` }}
                          />
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] tabular-nums text-[var(--color-faint)]">
                          {ciLow.toFixed(0)}–{ciHigh.toFixed(0)}
                        </div>
                      </div>
                      <span className={`tag ${m.evidence_status === "Supported" ? "g" : "w"}`}>
                        <i />
                        {m.evidence_status}
                      </span>
                    </div>
                  </td>

                  <td className="hidden lg:table-cell">
                    {view === "overall" && catDepth ? (
                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] tabular-nums text-[var(--color-muted-foreground)]">
                        {OVERALL_CHIPS.map((chip) => {
                          const s = m.category_scores[chip.id];
                          const d = catDepth[chip.id];
                          const tone = d.families > 0 ? getEvidenceDepthTone(d.families) : null;
                          return (
                            <span
                              key={chip.id}
                              title={
                                s !== null
                                  ? tx(
                                      `${catLabel(chip.id)} ${s.toFixed(1)} · ${d.benchmarks} 项计分基准 / ${d.families} 个独立来源`,
                                      `${catLabel(chip.id)} ${s.toFixed(1)} · ${d.benchmarks} scored bmk / ${d.families} src`
                                    )
                                  : tx(`${catLabel(chip.id)} · 缺测`, `${catLabel(chip.id)} · Untested`)
                              }
                              className={`${chip.wideOnly ? "hidden xl:inline-block" : ""} rounded-md px-1.5 py-0.5 ${tone && s !== null ? tone.chipClass : "bg-[var(--color-fill)]"}`}
                            >
                              {chip.short}{" "}
                              <strong className="font-medium text-[var(--color-foreground)]">
                                {s?.toFixed(0) ?? "—"}
                              </strong>
                              {s !== null && d.families > 0 && tone && (
                                <sup className={tone.supClass}>{d.families}</sup>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] tabular-nums">
                        {keyBms.map(([bid, val]) => (
                          <span
                            key={bid}
                            className="rounded-md bg-[var(--color-fill)] px-1.5 py-0.5 text-[var(--color-foreground)]"
                          >
                            {BENCHMARK_SHORT_NAMES[bid] || snapshot.benchmarks[bid]?.name}{" "}
                            <span className="text-[var(--color-muted-foreground)]">
                              {val.display || `${val.score.toFixed(0)}%`}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>

                  <td className="hidden text-right font-mono text-[11.5px] tabular-nums text-[var(--color-muted-foreground)] sm:table-cell">
                    <div>{formatPrice(m.blended_price_per_1m)}/M</div>
                    <div className="text-[10.5px] text-[var(--color-faint)]">
                      {formatContext(m.context_length)}
                    </div>
                  </td>

                  <td className="whitespace-nowrap text-right">
                    <span className="chev inline-flex items-center gap-0.5 font-mono text-[11.5px]">
                      {m.benchmark_count}
                      <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="blk py-12 text-center text-xs text-[var(--color-muted-foreground)]">
          {tx("当前筛选条件下暂无匹配模型，请放宽搜索或筛选条件。", "No models match the active filters.")}
        </div>
      )}

      {!search.trim() && filtered.length > 30 && (
        <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-4 text-xs">
          <span className="text-[var(--color-muted-foreground)]">
            {showAllRows
              ? tx(`当前展示全部 ${filtered.length} 个模型`, `Showing all ${filtered.length} models`)
              : tx(`当前展示前 30 个模型（共 ${filtered.length} 个）`, `Showing top 30 of ${filtered.length} models`)}
          </span>
          <button
            type="button"
            onClick={() => setShowAllRows((v) => !v)}
            className="btn"
          >
            {showAllRows
              ? tx("收起至 Top 30", "Collapse to Top 30")
              : tx(`展开全部 ${filtered.length} 个模型`, `Show All ${filtered.length}`)}
          </button>
        </div>
      )}
    </div>
  );
}
