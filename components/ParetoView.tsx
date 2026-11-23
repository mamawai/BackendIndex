"use client";

import { useMemo, useState } from "react";
import NumberFlow from "@number-flow/react";
import { useLang } from "@/lib/i18n";
import {
  computeParetoFrontier,
  formatContext,
  formatPrice,
  recomputeRankings,
  type WeightedModelRow,
} from "@/lib/scoring";
import type { CategoryId, SnapshotData } from "@/lib/types";

interface ParetoViewProps {
  snapshot: SnapshotData;
  weights: Record<CategoryId, number>;
  onSelectModel: (model: WeightedModelRow, originTop?: number) => void;
}

const PRICE_TICKS = [0.1, 0.5, 1, 3, 10, 30, 80];
const SCORE_TICKS = [40, 55, 70, 85, 95];

export function ParetoView({ snapshot, weights, onSelectModel }: ParetoViewProps) {
  const { tx } = useLang();
  const [openOnly, setOpenOnly] = useState(false);
  const [longCtxOnly, setLongCtxOnly] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const ranked = useMemo(
    () => recomputeRankings(snapshot.models, weights, "overall"),
    [snapshot.models, weights]
  );

  const points = useMemo(() => {
    return ranked
      .filter((m) => {
        if (m.blended_price_per_1m === null || m.blended_price_per_1m <= 0) return false;
        if (openOnly && !m.is_open_weight) return false;
        if (longCtxOnly && (m.context_length ?? 0) < 1_000_000) return false;
        return true;
      })
      .map((m) => ({
        model: m,
        id: m.canonical_id,
        price: m.blended_price_per_1m as number,
        score: m.dynamicScore,
      }));
  }, [ranked, openOnly, longCtxOnly]);

  const frontierIds = useMemo(() => computeParetoFrontier(points), [points]);

  const frontierSorted = useMemo(
    () => points.filter((p) => frontierIds.has(p.id)).sort((a, b) => a.price - b.price),
    [points, frontierIds]
  );

  const W = 980;
  const H = 400;
  const PAD_L = 54;
  const PAD_R = 32;
  const PAD_T = 30;
  const PAD_B = 46;

  const minLog = Math.log10(0.05);
  const maxLog = Math.log10(100);
  const minScore = 35;
  const maxScore = 98;

  const xOf = (price: number) => {
    const clamped = Math.max(0.05, Math.min(100, price));
    const ratio = (Math.log10(clamped) - minLog) / (maxLog - minLog);
    return PAD_L + ratio * (W - PAD_L - PAD_R);
  };

  const yOf = (score: number) => {
    const clamped = Math.max(minScore, Math.min(maxScore, score));
    const ratio = (clamped - minScore) / (maxScore - minScore);
    return H - PAD_B - ratio * (H - PAD_T - PAD_B);
  };

  const frontierPath = useMemo(() => {
    if (frontierSorted.length < 2) return "";
    return frontierSorted
      .map((p, idx) => `${idx === 0 ? "M" : "L"} ${xOf(p.price).toFixed(1)} ${yOf(p.score).toFixed(1)}`)
      .join(" ");
  }, [frontierSorted]);

  const frontierLabels = useMemo(() => {
    const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const results = new Map<string, { lx: number; ly: number; anchor: "start" | "end" }>();
    const byScoreDesc = [...frontierSorted].sort((a, b) => b.score - a.score);
    for (const p of byScoreDesc) {
      const cx = xOf(p.price);
      const cy = yOf(p.score);
      const w = Math.max(48, p.model.display_name.length * 6.2);
      const h = 14;
      const candidates: { lx: number; ly: number; anchor: "start" | "end"; bx: number; by: number }[] = [
        { lx: cx + 9, ly: cy + 3, anchor: "start", bx: cx + 9, by: cy - 8 },
        { lx: cx - 9, ly: cy - 6, anchor: "end", bx: cx - 9 - w, by: cy - 17 },
        { lx: cx + 9, ly: cy + 14, anchor: "start", bx: cx + 9, by: cy + 3 },
        { lx: cx - 9, ly: cy + 12, anchor: "end", bx: cx - 9 - w, by: cy + 1 },
        { lx: cx + 9, ly: cy - 10, anchor: "start", bx: cx + 9, by: cy - 21 },
      ];
      let chosen = candidates[0];
      for (const cand of candidates) {
        if (cand.bx < PAD_L || cand.bx + w > W - 4 || cand.by < 8 || cand.by + h > H - PAD_B) {
          continue;
        }
        const overlaps = placed.some(
          (b) => !(cand.bx + w + 4 < b.x1 || cand.bx > b.x2 + 4 || cand.by + h + 2 < b.y1 || cand.by > b.y2 + 2)
        );
        if (!overlaps) {
          chosen = cand;
          break;
        }
      }
      placed.push({ x1: chosen.bx, y1: chosen.by, x2: chosen.bx + w, y2: chosen.by + h });
      results.set(p.id, { lx: chosen.lx, ly: chosen.ly, anchor: chosen.anchor });
    }
    return results;
  }, [frontierSorted]);

  const hovered = points.find((p) => p.id === hoveredId) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-border)] pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-[var(--color-foreground)] sm:text-[28px]">
            {tx("API 性价比帕累托前沿", "API Cost–Performance Pareto Frontier")}
          </h1>
          <p className="mt-1.5 max-w-2xl text-xs text-[var(--color-muted-foreground)] sm:text-sm">
            {tx(
              "横轴为 OpenRouter 实时 Input/Output 均价（$/1M Tokens，对数坐标），纵轴为 BackendIndex 能力分。悬停图表节点或下方前沿卡片可双向高亮联动。",
              "Blended Input/Output API price ($/1M tokens, log scale) vs. BackendIndex score. Hover nodes or cards below for cross-highlighting."
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={openOnly}
            onClick={() => setOpenOnly((v) => !v)}
            className="chip"
          >
            {tx("仅开源权重", "Open Weights")}
          </button>
          <button
            type="button"
            aria-pressed={longCtxOnly}
            onClick={() => setLongCtxOnly((v) => !v)}
            className="chip"
          >
            {tx("1M+ 超长上下文", "1M+ Context")}
          </button>
        </div>
      </div>

      {/* Scatter Surface */}
      <div className="blk relative p-5">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full select-none overflow-visible">
          {SCORE_TICKS.map((sc) => {
            const y = yOf(sc);
            return (
              <g key={`y-${sc}`}>
                <line
                  x1={PAD_L}
                  y1={y}
                  x2={W - PAD_R}
                  y2={y}
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                />
                <text
                  x={PAD_L - 10}
                  y={y + 4}
                  textAnchor="end"
                  fill="var(--color-faint)"
                  className="font-mono text-[10px]"
                >
                  {sc}
                </text>
              </g>
            );
          })}

          {PRICE_TICKS.map((pr) => {
            const x = xOf(pr);
            return (
              <g key={`x-${pr}`}>
                <line
                  x1={x}
                  y1={PAD_T}
                  x2={x}
                  y2={H - PAD_B}
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                />
                <text
                  x={x}
                  y={H - PAD_B + 18}
                  textAnchor="middle"
                  fill="var(--color-faint)"
                  className="font-mono text-[10px]"
                >
                  ${pr}
                </text>
              </g>
            );
          })}

          <text
            x={(PAD_L + W - PAD_R) / 2}
            y={H - 8}
            textAnchor="middle"
            fill="var(--color-muted-foreground)"
            className="text-[11px]"
          >
            {tx("Blended API 价格（$/1M Tokens · 对数坐标）", "Blended API Price ($/1M Tokens · Log Scale)")}
          </text>
          <text
            x={14}
            y={(PAD_T + H - PAD_B) / 2}
            textAnchor="middle"
            transform={`rotate(-90 14 ${(PAD_T + H - PAD_B) / 2})`}
            fill="var(--color-muted-foreground)"
            className="text-[11px]"
          >
            {tx("BackendIndex 分数", "BackendIndex Score")}
          </text>

          {frontierPath && (
            <path
              d={frontierPath}
              fill="none"
              stroke="var(--color-primary)"
              strokeWidth={1.75}
              strokeDasharray="5 4"
              opacity={0.78}
            />
          )}

          {points.map((p) => {
            const cx = xOf(p.price);
            const cy = yOf(p.score);
            const isFrontier = frontierIds.has(p.id);
            const isHovered = hoveredId === p.id;
            const dotColor = isFrontier
              ? "var(--color-primary)"
              : p.model.is_open_weight
                ? "var(--color-gain)"
                : "var(--color-faint)";

            return (
              <g
                key={p.id}
                className="cursor-pointer"
                opacity={hoveredId && !isHovered ? 0.38 : 1}
                onMouseEnter={() => setHoveredId(p.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={(e) => onSelectModel(p.model, e.currentTarget.getBoundingClientRect().top)}
              >
                {isHovered && (
                  <circle cx={cx} cy={cy} r={12} fill={dotColor} fillOpacity={0.22} />
                )}
                <circle
                  cx={cx}
                  cy={cy}
                  r={isHovered ? 7 : isFrontier ? 5.2 : 4}
                  fill={dotColor}
                  stroke="var(--color-fill)"
                  strokeWidth={1.5}
                />
                {isFrontier &&
                  (() => {
                    const pos = frontierLabels.get(p.id) ?? {
                      lx: cx + 9,
                      ly: cy + 3,
                      anchor: "start" as const,
                    };
                    return (
                      <text
                        x={pos.lx}
                        y={pos.ly}
                        textAnchor={pos.anchor}
                        fill="var(--color-foreground)"
                        className="text-[10.5px] font-medium"
                      >
                        {p.model.display_name}
                      </text>
                    );
                  })()}
              </g>
            );
          })}

          {hovered &&
            (() => {
              const cx = xOf(hovered.price);
              const cy = yOf(hovered.score);
              const boxW = 205;
              const boxH = 44;
              const bx = cx + boxW + 16 > W ? cx - boxW - 12 : cx + 12;
              const by = cy - boxH - 8 < 6 ? cy + 12 : cy - boxH - 8;
              return (
                <g pointerEvents="none">
                  <rect
                    x={bx}
                    y={by}
                    width={boxW}
                    height={boxH}
                    rx={10}
                    fill="var(--color-foreground)"
                    opacity={0.96}
                  />
                  <text
                    x={bx + 11}
                    y={by + 17}
                    fill="var(--color-on-ink)"
                    className="text-[11px] font-semibold"
                  >
                    #{hovered.model.dynamicRank} {hovered.model.display_name}
                  </text>
                  <text
                    x={bx + 11}
                    y={by + 33}
                    fill="var(--color-on-ink)"
                    opacity={0.8}
                    className="font-mono text-[10px]"
                  >
                    Score {hovered.score.toFixed(1)} · {formatPrice(hovered.price)}/M ·{" "}
                    {formatContext(hovered.model.context_length)}
                  </text>
                </g>
              );
            })()}
        </svg>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-hair)] pt-3 text-xs">
          <div className="flex flex-wrap items-center gap-4 text-[11.5px] text-[var(--color-muted-foreground)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-primary)]" />
              {tx("帕累托最优前沿", "Pareto Optimal Frontier")} ({frontierSorted.length})
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-gain)]" />
              {tx("开源权重模型", "Open Weights")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-faint)]" />
              {tx("闭源 API 模型", "Proprietary API")}
            </span>
          </div>
          <span className="text-[11px] text-[var(--color-faint)]">
            {tx(
              `共 ${points.length} 个带公开 API 定价模型，点击任意点或卡片打开账本`,
              `${points.length} priced models plotted · click any point to inspect evidence`
            )}
          </span>
        </div>
      </div>

      {/* Frontier Picks Grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {frontierSorted
          .slice()
          .reverse()
          .map((p) => (
            <button
              key={p.id}
              type="button"
              onMouseEnter={() => setHoveredId(p.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={(e) => onSelectModel(p.model, e.currentTarget.getBoundingClientRect().top)}
              className="pod p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-semibold text-[var(--color-foreground)]">
                  {p.model.display_name}
                </span>
                <span className="font-mono text-xl font-light text-[var(--color-primary)] tabular-nums">
                  <NumberFlow
                    value={p.score}
                    format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
                  />
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-[var(--color-muted-foreground)]">
                <span>
                  {formatPrice(p.price)}/1M {tx("均价", "blended")}
                </span>
                <span>{formatContext(p.model.context_length)} ctx</span>
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}
