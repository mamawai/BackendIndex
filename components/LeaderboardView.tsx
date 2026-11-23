"use client";

import { useMemo, useState } from "react";
import NumberFlow from "@number-flow/react";
import { ChevronRight, Search, SlidersHorizontal } from "lucide-react";
import { useLang } from "@/lib/i18n";
import {
  BENCHMARK_SHORT_NAMES,
  describeIncomplete,
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
  const minCov = snapshot.rules.min_coverage;

  const viewTabs = useMemo(
    () =>
      VIEW_IDS.map((id) => ({
        value: id,
        label: id === "overall" ? tx("综合 Overall", "Overall") : catTabLabel(id),
      })),
    [catTabLabel, tx]
  );

  const ranked = useMemo(
    () => recomputeRankings(snapshot.models, weights, view, snapshot.rules.min_coverage),
    [snapshot.models, snapshot.rules.min_coverage, weights, view]
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

  const tableHead = (
    <thead>
      <tr>
        <th
          className="w-12"
          title={tx("名次前带 ≈ 的是数据不全的模型，名次仅供参考", "≈ marks incomplete data: the rank is indicative")}
        >
          #
        </th>
        <th>{tx("模型与主力脚手架", "Model & Primary Harness")}</th>
        <th>
          {view === "overall" ? "BackendIndex" : catLabel(view)} · {tx("不确定度区间", "Uncertainty")}
        </th>
        <th className="hidden lg:table-cell">
          {view === "overall"
            ? tx(
                "六大能力维度（上标 = 独立来源数，* = 仅 1 项基准，≠ = 不可比）",
                "6-Dimension Breakdown (sup = independent sources, * = single benchmark, ≠ = not comparable)"
              )
            : tx("该维度代表基准实测", "Key Measured Benchmarks")}
        </th>
        <th className="hidden text-right sm:table-cell">
          {tx("API 均价 · 上下文", "Blended Price · Ctx")}
        </th>
        <th className="w-20 text-right">{tx("溯源", "Ledger")}</th>
      </tr>
    </thead>
  );

  const renderRow = (m: WeightedModelRow, key: string) => {
    const [ciLow, ciHigh] = m.dynamicCi;
    const keyBms = view !== "overall" ? getKeyBenchmarksForCategory(m, view) : [];
    const catDepth = view === "overall" ? getCategoryEvidenceDepth(m, snapshot.benchmarks) : null;
    const singleBench = new Set(m.single_benchmark_categories ?? []);
    const incomparable = new Set(m.incomparable_categories ?? []);
    const incomplete = view === "overall" && !m.dynamicComplete;
    const incompleteNote = incomplete ? describeIncomplete(m, minCov, catLabel, tx, true) : null;

    return (
      // Anchor table rows by rank slot so scores roll and CI bars glide in place across tabs
      <tr key={key} onClick={(e) => onSelectModel(m, e.currentTarget.getBoundingClientRect().top)}>
        <td
          className="font-mono text-xs text-[var(--color-muted-foreground)] tabular-nums"
          title={incompleteNote ?? undefined}
        >
          {incomplete ? `≈${m.dynamicRank}` : m.dynamicRank}
        </td>

        <td>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-[var(--color-foreground)]">{m.display_name}</span>
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
          {/* 数据不全：写明缺哪几维、真实名次可能在哪个范围 */}
          {incomplete && (
            <div className="mt-1 text-[10.5px] text-[var(--color-warning)]" title={incompleteNote ?? undefined}>
              {describeIncomplete(m, minCov, catLabel, tx)}
            </div>
          )}
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
            {incomplete ? (
              <span className="tag w" title={incompleteNote ?? undefined}>
                <i />
                {tx("数据不全", "Incomplete")}
              </span>
            ) : (
              <span className={`tag ${m.evidence_status === "Supported" ? "g" : "w"}`}>
                <i />
                {m.evidence_status}
              </span>
            )}
          </div>
        </td>

        <td className="hidden lg:table-cell">
          {view === "overall" && catDepth ? (
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] tabular-nums text-[var(--color-muted-foreground)]">
              {OVERALL_CHIPS.map((chip) => {
                const s = m.category_scores[chip.id];
                const d = catDepth[chip.id];
                const tone = d.families > 0 ? getEvidenceDepthTone(d.families) : null;
                const single = singleBench.has(chip.id);
                return (
                  <span
                    key={chip.id}
                    title={
                      s !== null
                        ? tx(
                            `${catLabel(chip.id)} ${s.toFixed(1)} · ${d.benchmarks} 项计分基准 / ${d.families} 个独立来源${single ? " · 仅 1 项基准，参考价值有限" : ""}`,
                            `${catLabel(chip.id)} ${s.toFixed(1)} · ${d.benchmarks} scored bmk / ${d.families} independent src${single ? " · single benchmark" : ""}`
                          )
                        : incomparable.has(chip.id)
                          ? tx(
                              `${catLabel(chip.id)} · 不可比：只有和主榜不连通的旧基准成绩，详见证据台账`,
                              `${catLabel(chip.id)} · Not comparable: only results on boards disconnected from the main set`
                            )
                          : tx(`${catLabel(chip.id)} · 缺测`, `${catLabel(chip.id)} · Untested`)
                    }
                    className={`${chip.wideOnly ? "hidden xl:inline-block" : ""} rounded-md px-1.5 py-0.5 ${tone && s !== null ? tone.chipClass : "bg-[var(--color-fill)]"}`}
                  >
                    {chip.short}{" "}
                    <strong className="font-medium text-[var(--color-foreground)]">
                      {s?.toFixed(0) ?? (incomparable.has(chip.id) ? "≠" : "—")}
                      {s !== null && single ? "*" : ""}
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
              {view !== "overall" && singleBench.has(view) && (
                <span
                  className="tag w"
                  title={tx("这个维度只有 1 项基准，分数参考价值有限", "Only one benchmark in this dimension")}
                >
                  {tx("单基准", "1 bmk")}
                </span>
              )}
            </div>
          )}
        </td>

        <td className="hidden text-right font-mono text-[11.5px] tabular-nums text-[var(--color-muted-foreground)] sm:table-cell">
          <div>{formatPrice(m.blended_price_per_1m)}/M</div>
          <div className="text-[10.5px] text-[var(--color-faint)]">{formatContext(m.context_length)}</div>
        </td>

        <td className="whitespace-nowrap text-right">
          <span className="chev inline-flex items-center gap-0.5 font-mono text-[11.5px]">
            {m.benchmark_count}
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </td>
      </tr>
    );
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
              " 条实测记录），按基准档位、来源与新鲜度加权，分维度 2PL IRT 校准。点击任意行可溯源全部证据与脚手架。",
              " measured runs), weighted by tier, provenance & freshness and calibrated per dimension with 2PL IRT. Click any row for full evidence."
            )}
          </p>
        </div>

        <div
          className="flex shrink-0 items-center gap-2 rounded-full bg-[var(--color-fill)] px-3.5 py-1.5 font-mono text-xs tabular-nums text-[var(--color-muted-foreground)]"
          title={tx(
            `已测维度占默认权重 ≥ ${Math.round(minCov * 100)}% 的算数据完整，其余标"数据不全"`,
            `Complete = measured dimensions cover ≥ ${Math.round(minCov * 100)}% of default weights`
          )}
        >
          <span className="font-medium text-[var(--color-foreground)]">{snapshot.summary.ranked_models}</span>
          <span>Ranked</span>
          <span className="opacity-40">·</span>
          <span className="font-medium text-[var(--color-gain)]">{snapshot.summary.complete_models}</span>
          <span>Complete</span>
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
          {tableHead}
          <tbody>
            {(search.trim() || showAllRows ? filtered : filtered.slice(0, 30)).map((m, idx) =>
              renderRow(m, `row-${idx}`)
            )}
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
          <button type="button" onClick={() => setShowAllRows((v) => !v)} className="btn">
            {showAllRows
              ? tx("收起至 Top 30", "Collapse to Top 30")
              : tx(`展开全部 ${filtered.length} 个模型`, `Show All ${filtered.length}`)}
          </button>
        </div>
      )}
    </div>
  );
}
