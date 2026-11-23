"use client";

import { ExternalLink } from "lucide-react";
import { BENCHMARK_DESC_EN, CATEGORY_I18N, useLang } from "@/lib/i18n";
import type { CategoryId, SnapshotData } from "@/lib/types";

interface MethodologyViewProps {
  snapshot: SnapshotData;
}

const TIER_BADGE: Record<string, string> = {
  S: "tag o",
  A: "tag",
  B: "tag",
};

export function MethodologyView({ snapshot }: MethodologyViewProps) {
  const { lang, catLabel, tx } = useLang();
  const benchmarks = Object.values(snapshot.benchmarks).sort((a, b) => {
    const tierOrder = { S: 0, A: 1, B: 2 };
    if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
    return b.base_weight - a.base_weight;
  });

  const categories = Object.keys(snapshot.categories) as CategoryId[];

  return (
    <div className="space-y-8">
      <div className="border-b border-[var(--color-border)] pb-5">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-[var(--color-foreground)] sm:text-[28px]">
          {tx("打分方法论与权威权重体系", "Scoring Methodology & Authority Tiers")}
        </h1>
        <p className="mt-1.5 max-w-3xl text-xs text-[var(--color-muted-foreground)] sm:text-sm">
          {tx(
            "BackendIndex 遵循“不自己跑私有题库、不伪造缺失分数、所有数据源可溯源”的原则，借鉴 BenchLM 的证据防线与 Epoch 的 IRT 统计框架，在 6 大后端工程维度上完成跨站校准。",
            "BackendIndex runs zero proprietary private evals and never imputes missing scores as zero. Built on BenchLM's evidence guardrails and Epoch's 2PL IRT calibration across 6 backend engineering dimensions."
          )}
        </p>
      </div>

      {/* 3 Core Principles */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="blk p-5">
          <div className="font-mono text-xs font-medium text-[var(--color-primary)]">
            01 · 2PL IRT + {tx("跨类目锚定", "Cross-Category Anchor")}
          </div>
          <h3 className="mt-2 text-sm font-semibold text-[var(--color-foreground)]">
            {tx("先去难度偏置，再跨维度对齐", "De-Bias Difficulty, Then Align Scales")}
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
            {tx(
              "按 6 大类别分别拟合两参数项目反应理论（2PL IRT），估算各榜单难度与区分度后，再通过共享模型锚点统一对齐到仓库研发（Repo）能力标尺并映射为 0–100 分。",
              "A regularized two-parameter logistic IRT model fits latent ability, item difficulty, and discrimination per category, aligning all 6 scales onto the Repo reference cohort (0–100)."
            )}
          </p>
        </div>

        <div className="blk p-5">
          <div className="font-mono text-xs font-medium text-[var(--color-gain)]">
            02 · {tx("有效权重公式与上限", "Provenance Weight & Cap")}
          </div>
          <h3 className="mt-2 text-sm font-semibold text-[var(--color-foreground)]">
            {tx("三档权威权重 × 来源可信度", "Tier Authority × Source Provenance")}
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
            {tx(
              "观测权重 = Tier 权重（S: 1.25–1.60 / A: 0.90–1.15 / B: 0.60–0.80）× 来源权重（独立/维护方 1.0，厂商自报/转引 0.72）× 新鲜度（现役 1.0，陈旧 0.55）；同题集子榜按比例拆权，单一评测家族上限 40%–45%。",
              "Effective Weight = Tier (S: 1.25–1.60, A: 0.90–1.15, B: 0.60–0.80) × Provenance (Independent/Maintainer 1.0, Self-reported/3rd-party 0.72) × Freshness (1.0 vs 0.55), with shared-question overlap splits and a 40%–45% family cap."
            )}
          </p>
        </div>

        <div className="blk p-5">
          <div className="font-mono text-xs font-medium text-[var(--color-warning)]">
            03 · {tx("缺测不补 0 & 防插队", "Missing != Zero & Close-Call Guard")}
          </div>
          <h3 className="mt-2 text-sm font-semibold text-[var(--color-foreground)]">
            {tx("90% 置信区间 + 2 分近距离保护", "90% CI + 2-Point Evidence Guardrail")}
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
            {tx(
              "90% 置信区间表示真实能力落点范围（非单题最佳/最差极值）；缺失维度越多区间越宽。仅凭单一来源进入 Estimated 的模型，不允许排在 2 分以内的多方实测模型之前。",
              "90% CI reflects estimation uncertainty from sample depth and missing dimensions (not single-task min/max). Single-family Estimated models cannot outrank others within 2.0 points."
            )}
          </p>
        </div>
      </div>

      {/* Category Weights */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-foreground)]">
          {tx("六大后端维度默认权重", "Default 6-Dimension Weights")}
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((cid) => {
            const cat = snapshot.categories[cid];
            const bmCount = Object.keys(cat.irt_benchmarks || {}).length;
            return (
              <div key={cid} className="blk p-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] font-semibold text-[var(--color-foreground)]">
                    {catLabel(cid)}
                  </span>
                  <span className="font-mono text-lg font-medium text-[var(--color-primary)]">
                    {Math.round(cat.weight * 100)}%
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
                  {lang === "en" ? CATEGORY_I18N[cid]?.descEn ?? cat.description : cat.description}
                </p>
                <div className="mt-2.5 font-mono text-[10.5px] text-[var(--color-faint)]">
                  {tx(`参与 IRT 校准基准：${bmCount} 项`, `Calibrated IRT benchmarks: ${bmCount}`)}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Benchmark Tier & IRT Registry */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-foreground)]">
            {tx(
              `全量追踪基准权威分级表（${benchmarks.length} 项）`,
              `Tracked Benchmarks & Authority Tiers (${benchmarks.length})`
            )}
          </h2>
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {tx(
              "注：IaC-Eval 官方目前仍为 Leaderboard TBD 尚未发布可用公开榜单，暂未强行收录。",
              "Note: IaC-Eval remains Leaderboard TBD upstream and is excluded until public scores ship."
            )}
          </span>
        </div>

        <div className="blk p-3">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{tx("级别", "Tier")}</th>
                  <th>{tx("基准名称与说明", "Benchmark & Scope")}</th>
                  <th>{tx("所属维度", "Dimension")}</th>
                  <th className="text-right">{tx("基准权重", "Base Weight")}</th>
                  <th className="text-right">{tx("IRT 难度 / 区分度", "IRT Diff / Disc")}</th>
                  <th className="text-right">{tx("入榜模型数", "Models")}</th>
                  <th className="text-right">{tx("原站", "Source")}</th>
                </tr>
              </thead>
              <tbody>
                {benchmarks.map((b) => {
                  const params = snapshot.categories[b.category]?.irt_benchmarks?.[b.id];
                  return (
                    <tr key={b.id}>
                      <td>
                        <span className={TIER_BADGE[b.tier]}>Tier {b.tier}</span>
                      </td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1.5 font-medium text-[var(--color-foreground)]">
                          <span>{b.name}</span>
                          {!b.scored && (
                            <span className="tag w">
                              {tx("仅对照参考", "Ref Only")}
                            </span>
                          )}
                          {b.scored && b.core === false && (
                            <span className="tag">
                              {tx("辅助子项", "Auxiliary")}
                            </span>
                          )}
                          {b.freshness === "aging" && (
                            <span className="tag w">
                              {tx("历史降权 ×0.55", "Aging ×0.55")}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-[var(--color-muted-foreground)]">
                          {lang === "en" ? BENCHMARK_DESC_EN[b.id] ?? b.description : b.description}
                        </div>
                      </td>
                      <td className="text-xs text-[var(--color-muted-foreground)]">
                        {catLabel(b.category)}
                      </td>
                      <td className="text-right font-mono font-medium tabular-nums text-[var(--color-foreground)]">
                        {b.scored ? `×${b.base_weight.toFixed(2)}` : "Ref"}
                      </td>
                      <td className="text-right font-mono text-[11px] tabular-nums text-[var(--color-muted-foreground)]">
                        {params
                          ? `${params.difficulty >= 0 ? "+" : ""}${params.difficulty.toFixed(2)} / ${params.discrimination.toFixed(2)}`
                          : "—"}
                      </td>
                      <td className="text-right font-mono tabular-nums text-[var(--color-muted-foreground)]">
                        {params ? params.n_models : "—"}
                      </td>
                      <td className="text-right">
                        <a
                          href={b.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="ib inline-flex"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Source Health */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-foreground)]">
          {tx(`ETL 数据管道健康状态（${snapshot.method}）`, `ETL Pipeline Health (${snapshot.method})`)}
        </h2>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          {Object.entries(snapshot.source_health).map(([src, info]) => (
            <div key={src} className="blk p-3.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="truncate font-mono text-[11px] font-medium text-[var(--color-foreground)]"
                  title={src}
                >
                  {src}
                </span>
                {info.status === "ok" ? (
                  <span className="lamp-dot shrink-0" />
                ) : (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-loss)]" />
                )}
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-[var(--color-muted-foreground)]">
                {info.observations !== undefined ? `${info.observations} obs` : "ok"}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
