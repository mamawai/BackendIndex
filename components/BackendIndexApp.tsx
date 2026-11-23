"use client";

import { useEffect, useMemo, useState } from "react";
import { LangProvider } from "@/lib/i18n";
import { buildComparePreset, computeMedianBaseline } from "@/lib/presets";
import {
  DEFAULT_WEIGHTS,
  recomputeRankings,
  type WeightedModelRow,
} from "@/lib/scoring";
import type { CategoryId, SnapshotData } from "@/lib/types";
import { CompareView } from "./CompareView";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { Header, type NavTab } from "./Header";
import { LeaderboardView } from "./LeaderboardView";
import { MethodologyView } from "./MethodologyView";
import { ParetoView } from "./ParetoView";

interface BackendIndexAppProps {
  snapshot: SnapshotData;
}

export function BackendIndexApp({ snapshot }: BackendIndexAppProps) {
  const [activeTab, setActiveTab] = useState<NavTab>("leaderboard");
  const [weights, setWeights] = useState<Record<CategoryId, number>>({ ...DEFAULT_WEIGHTS });
  const [selectedEntry, setSelectedEntry] = useState<{
    model: WeightedModelRow;
    originTop: number | null;
  } | null>(null);
  const [isDark, setIsDark] = useState(true);

  const defaultCompareIds = useMemo(() => {
    const ranked = recomputeRankings(snapshot.models, DEFAULT_WEIGHTS, "overall", snapshot.rules.min_coverage);
    return buildComparePreset(ranked, "top4", 4);
  }, [snapshot.models, snapshot.rules.min_coverage]);

  const [compareIds, setCompareIds] = useState<string[]>(defaultCompareIds);

  const baselineScores = useMemo(
    () =>
      computeMedianBaseline(
        snapshot.models,
        Object.keys(DEFAULT_WEIGHTS) as CategoryId[]
      ),
    [snapshot.models]
  );

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) root.classList.add("dark");
    else root.classList.remove("dark");
  }, [isDark]);

  const handleSelectModel = (model: WeightedModelRow, originTop?: number) => {
    setSelectedEntry({ model, originTop: originTop ?? null });
  };

  return (
    <LangProvider>
      <div className="min-h-screen bg-[var(--color-background)] text-[var(--color-foreground)]">
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        generatedAt={snapshot.generated_at}
        isDark={isDark}
        onToggleTheme={() => setIsDark((d) => !d)}
      />

      <main className="page-shell py-6 sm:py-8">
        <div key={activeTab} className="animate-tab-in">
          {activeTab === "leaderboard" && (
            <LeaderboardView
              snapshot={snapshot}
              weights={weights}
              onWeightsChange={setWeights}
              onSelectModel={handleSelectModel}
            />
          )}

          {activeTab === "compare" && (
            <CompareView
              snapshot={snapshot}
              weights={weights}
              compareIds={compareIds}
              onCompareIdsChange={setCompareIds}
              onSelectModel={handleSelectModel}
            />
          )}

          {activeTab === "pareto" && (
            <ParetoView
              snapshot={snapshot}
              weights={weights}
              onSelectModel={handleSelectModel}
            />
          )}

          {activeTab === "methodology" && <MethodologyView snapshot={snapshot} />}
        </div>
      </main>

      <EvidenceDrawer
        model={selectedEntry?.model ?? null}
        originTop={selectedEntry?.originTop ?? null}
        benchmarks={snapshot.benchmarks}
        baselineScores={baselineScores}
        minCoverage={snapshot.rules.min_coverage}
        onClose={() => setSelectedEntry(null)}
      />
      </div>
    </LangProvider>
  );
}
