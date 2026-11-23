"use client";

import NumberFlow from "@number-flow/react";
import { ChevronRight, Crown, Medal } from "lucide-react";
import { useLang } from "@/lib/i18n";
import { formatContext, formatPrice, type WeightedModelRow } from "@/lib/scoring";

interface TopLeadersProps {
  leaders: WeightedModelRow[];
  onSelectModel: (model: WeightedModelRow, originTop?: number) => void;
}

const PLACE_META = [
  { Icon: Crown, label: "TOP 01" },
  { Icon: Medal, label: "TOP 02" },
  { Icon: Medal, label: "TOP 03" },
];

export function TopLeaders({ leaders, onSelectModel }: TopLeadersProps) {
  const { tx } = useLang();
  if (leaders.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {leaders.slice(0, 3).map((m, idx) => {
        const [ciLow, ciHigh] = m.dynamicCi;
        const { Icon, label } = PLACE_META[idx] || PLACE_META[2];

        return (
          <div
            key={m.canonical_id}
            role="button"
            tabIndex={0}
            onClick={(e) => onSelectModel(m, e.currentTarget.getBoundingClientRect().top)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectModel(m, e.currentTarget.getBoundingClientRect().top);
              }
            }}
            className={`pod ${idx === 0 ? "first" : ""}`}
          >
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="pod-rank inline-flex items-center gap-1.5 font-mono text-[12px] font-medium text-[var(--color-muted-foreground)]">
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </span>
                <span className={`tag ${m.evidence_status === "Supported" ? "g" : "w"}`}>
                  <i />
                  {m.evidence_status}
                </span>
              </div>

              <h3 className="mt-3 truncate text-[17px] font-semibold tracking-[-0.015em] text-[var(--color-foreground)]">
                {m.display_name}
              </h3>
              <p className="mt-0.5 truncate text-xs text-[var(--color-muted-foreground)]">
                {m.organization}
                {m.primary_harness ? ` · ${m.primary_harness}` : ""}
              </p>
            </div>

            <div className="mt-4">
              <div className="flex items-baseline justify-between gap-2">
                <div className="font-mono text-[34px] leading-none font-light tracking-[-0.04em] tabular-nums text-[var(--color-foreground)]">
                  <NumberFlow
                    value={m.dynamicScore}
                    format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
                  />
                </div>
                <span
                  className="font-mono text-[11px] tabular-nums text-[var(--color-faint)]"
                  title={tx(
                    "90% 置信区间：基于实测样本量与缺测维度计算的估计稳健范围",
                    "90% Confidence Interval from Fisher Information & missing-dimension penalty"
                  )}
                >
                  90% CI {ciLow.toFixed(0)}–{ciHigh.toFixed(0)}
                </span>
              </div>

              <div className="relative mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-fill2)]">
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

              <div className="mt-3.5 flex items-center justify-between gap-2 text-[11.5px] text-[var(--color-muted-foreground)]">
                <span className="font-mono tabular-nums">
                  {m.benchmark_count} {tx("基准", "evals")} · {formatContext(m.context_length)} ·{" "}
                  {formatPrice(m.blended_price_per_1m)}/M
                </span>

                <span className="pod-chev inline-flex items-center gap-0.5 text-[var(--color-muted-foreground)]">
                  {tx("账本", "Ledger")} <ChevronRight className="h-3.5 w-3.5" />
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
