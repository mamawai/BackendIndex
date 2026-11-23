"use client";

import { ExternalLink } from "lucide-react";
import { BENCHMARK_DESC_EN, CATEGORY_I18N, useLang } from "@/lib/i18n";
import type { BenchmarkMeta, CategoryId, SnapshotData } from "@/lib/types";
import { ScoringFlow } from "./ScoringFlow";

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
  const rules = snapshot.rules;
  const benchmarks = Object.values(snapshot.benchmarks).sort((a, b) => {
    const tierOrder = { S: 0, A: 1, B: 2 };
    if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
    if (a.scored !== b.scored) return a.scored ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const categories = Object.keys(snapshot.categories) as CategoryId[];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const tw = rules.tier_weights;
  const sw = rules.source_weights;

  const freshnessCell = (b: BenchmarkMeta) => {
    if (!b.scored) return <span className="text-[var(--color-faint)]">—</span>;
    const factor = `×${b.freshness_factor.toFixed(2)}`;
    const label =
      b.freshness === "current"
        ? tx("现役", "Current")
        : b.freshness === "archived"
          ? tx("已归档", "Archived")
          : b.freshness === "unknown"
            ? tx("无日期", "No date")
            : tx("陈旧", "Stale");
    const cls = b.freshness === "current" ? "tag g" : "tag w";
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className={cls}>
          {label} {factor}
        </span>
        {b.last_activity && (
          <span className="font-mono text-[10px] text-[var(--color-faint)]">
            {b.last_activity}
            {b.age_days !== null ? tx(` · ${b.age_days} 天前`, ` · ${b.age_days}d ago`) : ""}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-8">
      <div className="border-b border-[var(--color-border)] pb-5">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-[var(--color-foreground)] sm:text-[28px]">
          {tx("打分方法与权重体系", "Scoring Methodology & Weights")}
        </h1>
        <p className="mt-1.5 max-w-3xl text-xs text-[var(--color-muted-foreground)] sm:text-sm">
          {tx(
            "BackendIndex 不自己跑私有题库，每条成绩都能溯源到原站，没测过的维度不编分数；在 6 个后端工程维度上分别做 2PL IRT 校准，再汇总成综合分。",
            "BackendIndex runs no private evals, every score links back to its source, and untested dimensions never get a made-up score. Each of the 6 backend dimensions is calibrated separately with 2PL IRT, then combined."
          )}
        </p>
      </div>

      {/* 计分流程总图 + 真实模型示例 */}
      <ScoringFlow snapshot={snapshot} />

      {/* 3 Core Principles */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="blk p-5">
          <div className="font-mono text-xs font-medium text-[var(--color-primary)]">
            01 · {tx("分维度 2PL IRT", "Per-Dimension 2PL IRT")}
          </div>
          <h3 className="mt-2 text-sm font-semibold text-[var(--color-foreground)]">
            {tx("只用本维度的成绩，再统一刻度", "Own Evidence Only, Then One Scale")}
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
            {tx(
              "每个维度单独用边际最大似然拟合两参数 IRT，估出各基准的难度、区分度和模型能力，只用这个维度自己的成绩，不从其它维度借分。同一维度里，两个基准至少有 3 个共同模型才算能放在一起比；不连通时只让证据权重最大的那组计分，其余组的成绩留在台账里、标为“不可比”，不硬排。各维度再用全部共同模型按测量精度加权（并补偿单基准后验收缩）对齐到仓库研发的刻度，映射为 0–100 分。",
              "Each dimension gets its own 2PL IRT fit (marginal maximum likelihood) using only that dimension's scores — no borrowing across dimensions. Two benchmarks are comparable only if at least 3 models took both; when a dimension splits, only the group with the most evidence weight is scored and the rest stay in the ledger as “not comparable”. Dimensions are then linked onto the Repo scale across all shared models weighted by measurement precision (accounting for posterior variance) and mapped to 0–100."
            )}
          </p>
        </div>

        <div className="blk p-5">
          <div className="font-mono text-xs font-medium text-[var(--color-gain)]">
            02 · {tx("权重 = 档位 × 来源 × 新鲜度", "Weight = Tier × Provenance × Freshness")}
          </div>
          <h3 className="mt-2 text-sm font-semibold text-[var(--color-foreground)]">
            {tx("三个因素各管一件事，不重复折算", "Three Factors, No Double Counting")}
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
            {tx(
              `档位只看题目本身：S ×${tw.S} / A ×${tw.A} / B ×${tw.B}。来源：维护方实测、独立复测 ×${sw.benchmark_run}，厂商自报、第三方转引 ×${sw.lab_reported}。新鲜度：${rules.fresh_days} 天内有新评测或新模型上榜记 ×1.0，之后线性降到第 ${rules.stale_days} 天的 ×${rules.stale_factor}；官方已归档的直接 ×${rules.stale_factor}。同题集子榜拆分权重，单个维度内单一来源占比封顶 40%–45%。`,
              `Tier reflects the benchmark itself: S ×${tw.S} / A ×${tw.A} / B ×${tw.B}. Provenance: maintainer or independent runs ×${sw.benchmark_run}, lab-reported or third-party ×${sw.lab_reported}. Freshness: ×1.0 if new runs or new models appeared within ${rules.fresh_days} days, decaying linearly to ×${rules.stale_factor} at ${rules.stale_days} days; archived boards ×${rules.stale_factor}. Shared-question subsets split weight; one source family is capped at 40–45% per dimension.`
            )}
          </p>
        </div>

        <div className="blk p-5">
          <div className="font-mono text-xs font-medium text-[var(--color-warning)]">
            03 · {tx("数据不全标记与不确定度", "Incomplete Flag & Uncertainty")}
          </div>
          <h3 className="mt-2 text-sm font-semibold text-[var(--color-foreground)]">
            {tx("缺测按实测规律修正，数据不全照排但明确标出", "Data-Driven Missing Adjustment; Incomplete Data Flagged")}
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
            {tx(
              `六维都测过的模型，综合分就是加权平均。缺维度的模型，综合分 = 已测维度加权平均 + 缺测修正：在六维都测过的模型上拟合“只用这几维算的分 → 六维分”的直线来估；缺的维度本身不编分数。不直接用已测平均，是因为同一模型的 SQL、安全普遍比其它维低，直接平均会让缺这两维的模型系统性偏高（还原实验里最多偏约 2.4 分），直线修正在高分、低分两头偏差都接近 0。所有模型同榜排名；已测维度不到当前权重 ${pct(rules.min_coverage)} 的标为“数据不全”，名次前加 ≈，并写明缺哪几维、按区间可能落在第几名。区间按模型假设约为 90%，由各基准成绩的实际波动和缺测修正的预测误差算出，不包含脚手架、推理档位的差异。同一模型同一基准有多次成绩时，取实测来源里的最高分，即各基准的最佳配置成绩。`,
              `For models scored on all six dimensions, the overall is the weighted mean. Otherwise overall = weighted mean of measured dimensions + a missing adjustment, read off a line fitted on fully measured models (“score from these dimensions only → six-dimension score”); missing dimensions themselves never get a made-up score. A plain measured mean is biased because a model's SQL and security usually trail its other dimensions — it would systematically flatter models missing them (by up to ~2.4 points in recovery tests), while the fitted line stays unbiased for both strong and weak models. Every model is ranked on one board; those measured on less than ${pct(rules.min_coverage)} of the active weights are flagged “incomplete” with an ≈ rank, the missing dimensions, and the rank range implied by their uncertainty. Ranges are ~90% under the model's assumptions, built from observed benchmark-to-benchmark noise plus the adjustment's prediction error; harness and effort differences are not included. When a model has several runs on one benchmark, the best measured run is used (best-configuration score).`
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
                  {tx(`参与 IRT 校准基准：${bmCount} 项`, `Calibrated benchmarks: ${bmCount}`)}
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
              `全量追踪基准档位与新鲜度（${benchmarks.length} 项，其中 ${snapshot.summary.stale_benchmarks} 项计分基准已降权）`,
              `Tracked Benchmarks, Tiers & Freshness (${benchmarks.length}; ${snapshot.summary.stale_benchmarks} scored benchmarks down-weighted)`
            )}
          </h2>
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {tx(
              "注：IaC-Eval 官方目前仍为 Leaderboard TBD 尚未发布可用公开榜单，暂未收录。",
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
                  <th className="text-right">{tx("档位权重", "Tier Weight")}</th>
                  <th className="text-right">{tx("新鲜度", "Freshness")}</th>
                  <th className="text-right">{tx("IRT 难度 / 区分度", "IRT Diff / Disc")}</th>
                  <th className="text-right">{tx("IRT 校准模型数", "IRT Models")}</th>
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
                          {!b.scored && <span className="tag w">{tx("仅对照参考", "Ref Only")}</span>}
                          {b.scored && b.core === false && <span className="tag">{tx("辅助子项", "Auxiliary")}</span>}
                          {b.scored && b.comparable === false && (
                            <span
                              className="tag w"
                              title={tx(
                                "和本维度主榜共同模型不足，没法放在同一把尺子上比，成绩只留在台账里",
                                "Too few shared models with this dimension's main set; kept in the ledger only"
                              )}
                            >
                              {tx("不连通 · 未计分", "Disconnected · not scored")}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-[var(--color-muted-foreground)]">
                          {lang === "en" ? BENCHMARK_DESC_EN[b.id] ?? b.description : b.description}
                        </div>
                      </td>
                      <td className="text-xs text-[var(--color-muted-foreground)]">{catLabel(b.category)}</td>
                      <td className="text-right font-mono font-medium tabular-nums text-[var(--color-foreground)]">
                        {b.scored ? `×${b.base_weight.toFixed(2)}` : "Ref"}
                      </td>
                      <td className="text-right">{freshnessCell(b)}</td>
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
                          aria-label={tx(`打开 ${b.name} 原站`, `Open ${b.name} source`)}
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
                {info.status !== "ok"
                  ? tx("抓取失败", "fetch failed")
                  : info.observations !== undefined
                    ? `${info.observations} obs`
                    : "ok"}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
