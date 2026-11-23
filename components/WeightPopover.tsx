"use client";

import NumberFlow from "@number-flow/react";
import { RotateCcw } from "lucide-react";
import { useLang } from "@/lib/i18n";
import { DEFAULT_WEIGHTS } from "@/lib/scoring";
import type { CategoryId } from "@/lib/types";

interface WeightPopoverProps {
  weights: Record<CategoryId, number>;
  onChange: (next: Record<CategoryId, number>) => void;
}

export function WeightPopover({ weights, onChange }: WeightPopoverProps) {
  const { catLabel, tx } = useLang();
  const categories = Object.keys(DEFAULT_WEIGHTS) as CategoryId[];
  const sum = categories.reduce((acc, c) => acc + weights[c], 0) || 1;

  return (
    <div className="blk p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-[13px] font-semibold text-[var(--color-foreground)]">
            {tx("自定义 6 维权重（实时重算排名）", "Custom 6-Dimension Weights (Live Re-ranking)")}
          </h4>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {tx(
              "根据业务偏好调整比例（例如把数据库 SQL 或架构重构调高），系统自动按比例归一化。",
              "Adjust dimension emphasis to fit your stack; ratios normalize to 100% automatically."
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...DEFAULT_WEIGHTS })}
          className="btn sm"
        >
          <RotateCcw className="h-3 w-3" />
          {tx("恢复默认", "Reset")}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        {categories.map((cat) => {
          const pct = Math.round((weights[cat] / sum) * 100);
          return (
            <div
              key={cat}
              className="rounded-xl bg-[var(--color-raise)] p-3 shadow-[var(--sh-thumb)]"
            >
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium text-[var(--color-foreground)]">
                  {catLabel(cat)}
                </span>
                <span className="font-mono font-semibold text-[var(--color-primary)] tabular-nums">
                  <NumberFlow value={pct} suffix="%" />
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={60}
                step={5}
                value={weights[cat]}
                onChange={(e) =>
                  onChange({
                    ...weights,
                    [cat]: Number(e.target.value),
                  })
                }
                className="weight-slider w-full"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
