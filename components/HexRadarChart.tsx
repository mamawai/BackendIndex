"use client";

import { useEffect, useRef, useState } from "react";
import { useLang } from "@/lib/i18n";
import type { CategoryId } from "@/lib/types";

export const RADAR_AXES: { id: CategoryId; shortLabel: string }[] = [
  { id: "repo", shortLabel: "仓库研发" },
  { id: "architecture", shortLabel: "架构与构建" },
  { id: "systems", shortLabel: "运维构建" },
  { id: "sql", shortLabel: "数据库 SQL" },
  { id: "performance", shortLabel: "性能与算法" },
  { id: "security", shortLabel: "后端安全" },
];

/** High-contrast 4-model palette led by wiib-web signature orange. */
export const RADAR_PALETTE = [
  "#f97316", // Signature Orange
  "#3b82f6", // Crisp Cobalt Blue
  "#10b981", // Emerald Gain
  "#a855f7", // Vivid Violet
];

export interface RadarSeries {
  id: string;
  name: string;
  scores: Record<CategoryId, number | null>;
  color: string;
  isBaseline?: boolean;
  /** 只有不连通基准成绩的维度，显示"不可比"而不是"缺测" */
  incomparable?: CategoryId[];
}

interface HexRadarChartProps {
  series: RadarSeries[];
  highlightedId?: string | null;
  onHighlightChange?: (id: string | null) => void;
  showAxisScores?: boolean;
  animateMorph?: boolean;
  className?: string;
}

const VW = 396;
const VH = 320;
const CX = VW / 2;
const CY = VH / 2 + 2;
const R = 98;
const RINGS = [100, 75, 50, 25];

function axisAngle(idx: number): number {
  return -Math.PI / 2 + (idx * Math.PI) / 3;
}

function polarToXY(idx: number, val: number): [number, number] {
  const ratio = Math.max(0, Math.min(100, val)) / 100;
  const ang = axisAngle(idx);
  return [CX + Math.cos(ang) * R * ratio, CY + Math.sin(ang) * R * ratio];
}

function labelPlacement(idx: number): {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
} {
  const ang = axisAngle(idx);
  const labelR = R + 19;
  const x = CX + Math.cos(ang) * labelR;
  const y = CY + Math.sin(ang) * labelR;

  if (idx === 0) return { x, y: y - 4, anchor: "middle" };
  if (idx === 3) return { x, y: y + 10, anchor: "middle" };
  if (idx === 1 || idx === 2) return { x: x + 6, y: y + 3, anchor: "start" };
  return { x: x - 6, y: y + 3, anchor: "end" };
}

function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/**
 * Reusable 6-axis hexagonal radar SVG chart matching wiib-web alternating concentric rings,
 * hollow vertices, smooth morph transitions, and dashed bridging across missing dimensions.
 */
export function HexRadarChart({
  series,
  highlightedId = null,
  onHighlightChange,
  showAxisScores = false,
  animateMorph = true,
  className = "",
}: HexRadarChartProps) {
  const { catLabel, tx } = useLang();
  const [hoveredAxis, setHoveredAxis] = useState<CategoryId | null>(null);
  const [animatedScores, setAnimatedScores] = useState<Record<CategoryId, number | null> | null>(
    null
  );
  const prevPrimaryRef = useRef<Record<CategoryId, number | null> | null>(null);

  const primarySeries = series.find((s) => !s.isBaseline);
  const nonBaselineCount = series.filter((s) => !s.isBaseline).length;

  useEffect(() => {
    if (!animateMorph || nonBaselineCount !== 1 || !primarySeries) {
      setAnimatedScores(null);
      prevPrimaryRef.current = primarySeries ? primarySeries.scores : null;
      return;
    }

    const from = prevPrimaryRef.current;
    const to = primarySeries.scores;
    if (!from) {
      prevPrimaryRef.current = to;
      setAnimatedScores(to);
      return;
    }

    let frameId = 0;
    const start = performance.now();
    const duration = 280;

    const tick = (now: number) => {
      const p = easeOutExpo(Math.min(1, (now - start) / duration));
      const next = {} as Record<CategoryId, number | null>;
      for (const axis of RADAR_AXES) {
        const tv = to[axis.id];
        if (tv === null || tv === undefined) {
          next[axis.id] = null;
        } else {
          const fv = from[axis.id] ?? tv;
          next[axis.id] = fv + (tv - fv) * p;
        }
      }
      setAnimatedScores(next);
      if (p < 1) {
        frameId = requestAnimationFrame(tick);
      } else {
        prevPrimaryRef.current = to;
      }
    };

    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
      prevPrimaryRef.current = to;
    };
  }, [animateMorph, nonBaselineCount, primarySeries?.id, primarySeries?.scores]);

  const effectiveSeries =
    nonBaselineCount === 1 && animatedScores && primarySeries
      ? series.map((s) => (s.id === primarySeries.id ? { ...s, scores: animatedScores } : s))
      : series;

  const activePrimary = effectiveSeries.find((s) => !s.isBaseline);

  return (
    <div className={`relative select-none ${className}`}>
      <svg viewBox={`0 0 ${VW} ${VH}`} className="h-auto w-full overflow-visible">
        {/* Alternating crisp concentric rings outside-in */}
        {RINGS.map((ringVal, idx) => {
          const pts = RADAR_AXES.map((_, aIdx) => polarToXY(aIdx, ringVal))
            .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
            .join(" ");
          return (
            <polygon
              key={ringVal}
              points={pts}
              className={idx % 2 === 1 ? "rad-ring alt" : "rad-ring"}
            />
          );
        })}

        {/* Radial spokes */}
        {RADAR_AXES.map((axis, idx) => {
          const [ox, oy] = polarToXY(idx, 100);
          const isPrimaryMissing =
            showAxisScores && primarySeries && primarySeries.scores[axis.id] === null;
          const isAxisHovered = hoveredAxis === axis.id;
          return (
            <line
              key={axis.id}
              x1={CX}
              y1={CY}
              x2={ox}
              y2={oy}
              stroke={
                isAxisHovered
                  ? "var(--color-primary)"
                  : isPrimaryMissing
                    ? "var(--color-line2)"
                    : "var(--color-border)"
              }
              strokeWidth={isAxisHovered ? 1.5 : 1}
              strokeDasharray={isPrimaryMissing ? "3 3" : undefined}
              className="transition-colors duration-150"
            />
          );
        })}

        {/* Subtle ring scale markers */}
        {[50, 75, 100].map((val) => (
          <text
            key={val}
            x={CX + 5}
            y={CY - (R * val) / 100 + 3}
            fill="var(--color-faint)"
            className="font-mono text-[9px]"
          >
            {val}
          </text>
        ))}

        {/* Data polygons (baselines first, then active models) */}
        {[...effectiveSeries]
          .sort((a, b) => Number(!!b.isBaseline) - Number(!!a.isBaseline))
          .map((s) => {
            const ptsWithMeta = RADAR_AXES.map((axis, idx) => {
              const val = s.scores[axis.id];
              return {
                idx,
                axisId: axis.id,
                val,
                xy: val !== null && val !== undefined ? polarToXY(idx, val) : null,
              };
            });
            const measured = ptsWithMeta.filter(
              (p): p is { idx: number; axisId: CategoryId; val: number; xy: [number, number] } =>
                p.xy !== null && p.val !== null
            );

            if (measured.length === 0) return null;

            const isDimmed =
              highlightedId !== null && highlightedId !== s.id && !s.isBaseline;
            const isActive = highlightedId === s.id;
            const polyPoints = measured
              .map((p) => `${p.xy[0].toFixed(1)},${p.xy[1].toFixed(1)}`)
              .join(" ");

            return (
              <g
                key={s.id}
                opacity={isDimmed ? 0.16 : 1}
                className="transition-opacity duration-200 ease-out"
                onMouseEnter={() => !s.isBaseline && onHighlightChange?.(s.id)}
                onMouseLeave={() => !s.isBaseline && onHighlightChange?.(null)}
              >
                {measured.length >= 3 && (
                  <polygon
                    points={polyPoints}
                    fill={s.color}
                    fillOpacity={s.isBaseline ? 0.04 : isActive ? 0.22 : 0.14}
                    stroke="none"
                  />
                )}

                {measured.length >= 2 &&
                  measured.map((curr, mIdx) => {
                    const next = measured[(mIdx + 1) % measured.length];
                    const step = (next.idx - curr.idx + 6) % 6;
                    const spansMissing = step > 1;
                    return (
                      <line
                        key={`${s.id}-edge-${curr.idx}-${next.idx}`}
                        x1={curr.xy[0]}
                        y1={curr.xy[1]}
                        x2={next.xy[0]}
                        y2={next.xy[1]}
                        stroke={s.color}
                        strokeWidth={s.isBaseline ? 1.25 : isActive ? 2.5 : 1.85}
                        strokeLinecap="round"
                        strokeDasharray={
                          s.isBaseline ? "3 3" : spansMissing ? "4 4" : undefined
                        }
                        strokeOpacity={s.isBaseline ? 0.65 : spansMissing ? 0.72 : 0.96}
                      />
                    );
                  })}

                {/* Clean hollow crisp dot vertices matching wiib-web .pt */}
                {!s.isBaseline &&
                  measured.map((p) => {
                    const isVertexHot = isActive || hoveredAxis === p.axisId;
                    return (
                      <g key={`${s.id}-pt-${p.idx}`}>
                        {isVertexHot && (
                          <circle
                            cx={p.xy[0]}
                            cy={p.xy[1]}
                            r={9}
                            fill={s.color}
                            fillOpacity={0.2}
                          />
                        )}
                        <circle
                          cx={p.xy[0]}
                          cy={p.xy[1]}
                          r={isVertexHot ? 4.3 : 3.5}
                          fill="var(--color-background)"
                          stroke={s.color}
                          strokeWidth={1.85}
                        />
                      </g>
                    );
                  })}
              </g>
            );
          })}

        {/* Axis labels (interactive hover targets) */}
        {RADAR_AXES.map((axis, idx) => {
          const pos = labelPlacement(idx);
          const displayVal = primarySeries?.scores[axis.id];
          const isHot = hoveredAxis === axis.id;
          return (
            <g
              key={`label-${axis.id}`}
              className="cursor-pointer"
              onMouseEnter={() => setHoveredAxis(axis.id)}
              onMouseLeave={() => setHoveredAxis(null)}
            >
              <text
                x={pos.x}
                y={pos.y}
                textAnchor={pos.anchor}
                fill={isHot ? "var(--color-primary)" : "var(--color-muted-foreground)"}
                className="text-[11.5px] font-medium transition-colors duration-150"
              >
                {catLabel(axis.id)}
              </text>
              {showAxisScores && activePrimary && (
                <text
                  x={pos.x}
                  y={pos.y + 13}
                  textAnchor={pos.anchor}
                  fill={
                    displayVal !== null && displayVal !== undefined
                      ? "var(--color-foreground)"
                      : "var(--color-faint)"
                  }
                  className="font-mono text-[10.5px] font-medium tabular-nums"
                >
                  {displayVal !== null && displayVal !== undefined
                    ? displayVal.toFixed(1)
                    : primarySeries?.incomparable?.includes(axis.id)
                      ? tx("不可比", "N/C")
                      : tx("缺测", "N/A")}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Axis hover floating readout footer */}
      {hoveredAxis && (
        <div className="animate-dlg-in mt-1.5 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1 rounded-xl bg-[var(--color-raise)] px-3 py-1.5 text-[11px] shadow-[var(--sh-pop)]">
          <span className="font-semibold text-[var(--color-foreground)]">
            {catLabel(hoveredAxis)}
          </span>
          {series
            .filter((s) => !s.isBaseline)
            .map((s) => {
              const v = s.scores[hoveredAxis];
              return (
                <span key={s.id} className="inline-flex items-center gap-1.5 font-mono tabular-nums">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="text-[var(--color-muted-foreground)]">
                    {s.name}{" "}
                    <strong className="font-semibold text-[var(--color-foreground)]">
                      {v !== null
                        ? v.toFixed(1)
                        : s.incomparable?.includes(hoveredAxis)
                          ? tx("不可比", "N/C")
                          : tx("缺测", "N/A")}
                    </strong>
                  </span>
                </span>
              );
            })}
        </div>
      )}
    </div>
  );
}
