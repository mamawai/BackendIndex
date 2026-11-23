"""Configuration, category taxonomy, and benchmark registry for BackendIndex."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

CategoryId = Literal["repo", "architecture", "systems", "sql", "performance", "security"]
SourceType = Literal["benchmark_run", "independent_run", "lab_reported", "third_party"]
Tier = Literal["S", "A", "B"]

# Default BackendIndex overall capability weights (sum to 1.0)
CATEGORY_WEIGHTS: dict[CategoryId, float] = {
    "repo": 0.25,
    "architecture": 0.15,
    "systems": 0.20,
    "sql": 0.15,
    "performance": 0.15,
    "security": 0.10,
}

CATEGORY_META: dict[CategoryId, dict[str, str]] = {
    "repo": {
        "name": "仓库级研发",
        "name_en": "Repo Engineering",
        "description": "已有代码库理解、缺陷定位修复、单测补全与多文件补丁交付能力",
    },
    "architecture": {
        "name": "系统重建与演进",
        "name_en": "Architecture & Evolution",
        "description": "跨文件架构重构、跨语言系统迁移与无源码参考的完整系统重建能力",
    },
    "systems": {
        "name": "运维构建与 SRE",
        "name_en": "Systems, DevOps & SRE",
        "description": "容器终端排错、复杂构建系统、分布式可观测性改造与工具协议调用",
    },
    "sql": {
        "name": "数据库与 SQL",
        "name_en": "Database & SQL",
        "description": "超宽企业表 Text-to-SQL、SQL 优化能力分评估、执行计划分析与方言迁移",
    },
    "performance": {
        "name": "性能与算法工程",
        "name_en": "Performance & Algorithms",
        "description": "软件运行时性能优化、复杂算法内核与竞赛级算法复杂度求解",
    },
    "security": {
        "name": "后端安全",
        "name_en": "Backend Security",
        "description": "历史漏洞 PoC 复现与修复、无引导渗透 CTF 与漏洞阶段利用能力",
    },
}

# 基准档位权重，只看题目本身：
#   S：核心真实工程基准（仓库级/生产级任务，覆盖面足）
#   A：真实工程任务，但题量小、范围窄，或是重建/迁移这类半合成任务
#   B：辅助参考（练习题、竞赛题、纯工具调用、跨脚手架聚合分）
# 谁跑的分（来源）和数据新不新（新鲜度）另外折算，这里不重复扣
TIER_WEIGHTS: dict[Tier, float] = {"S": 1.4, "A": 1.1, "B": 0.7}

# 来源可信度：维护方实测 / 独立复测算满分，厂商自报 / 第三方转引打折
SOURCE_TYPE_WEIGHTS: dict[SourceType, float] = {
    "benchmark_run": 1.00,
    "independent_run": 1.00,
    "lab_reported": 0.72,
    "third_party": 0.72,
}

# 新鲜度：基准最近一次"有新动静"（新评测日期或新模型上榜）距快照的天数
FRESH_DAYS = 30  # 30 天内算新，不打折
STALE_DAYS = 90  # 超过 30 天开始线性降，到 90 天降到底
STALE_FACTOR = 0.55  # 降到底的系数；官方已归档、查不到任何日期的也按它算


def freshness_factor(age_days: int | None, archived: bool = False) -> float:
    """Freshness multiplier: 1.0 within FRESH_DAYS, linear decay to STALE_FACTOR at STALE_DAYS."""
    if archived or age_days is None or age_days >= STALE_DAYS:
        return STALE_FACTOR
    if age_days <= FRESH_DAYS:
        return 1.0
    span = STALE_DAYS - FRESH_DAYS
    return round(1.0 - (age_days - FRESH_DAYS) / span * (1.0 - STALE_FACTOR), 4)


@dataclass(frozen=True)
class BenchmarkSpec:
    """Metadata describing an ingested backend benchmark track."""

    id: str
    name: str
    category: CategoryId
    source_family: str
    source_url: str
    default_source_type: SourceType
    description: str
    tier: Tier = "A"
    scored: bool = True
    # False for auxiliary tracks (e.g. Exercism drills, pure tool calling, contest algo)
    # that should contribute carefully without standalone-granting core engineering Supported status.
    core: bool = True
    # Benchmarks sharing an identical underlying question set share capacity in IRT weighting.
    overlap_group: str | None = None

    @property
    def base_weight(self) -> float:
        return TIER_WEIGHTS[self.tier]


BENCHMARK_REGISTRY: dict[str, BenchmarkSpec] = {
    # --- Repo Engineering ---
    # S：真实 GitHub Issue，按期滚动换新题防污染，维护方统一跑
    "swe_rebench": BenchmarkSpec(
        id="swe_rebench",
        name="SWE-rebench",
        category="repo",
        source_family="SWE-rebench (Nebius)",
        source_url="https://swe-rebench.com/",
        default_source_type="benchmark_run",
        description="按期滚动抓取最新 GitHub Issue 的防污染仓库级软件工程榜单",
        tier="S",
    ),
    # S：真实软件仓库的功能实现，维护方统一跑
    "frontierswe": BenchmarkSpec(
        id="frontierswe",
        name="FrontierSWE · Implementation",
        category="repo",
        source_family="Proximal",
        source_url="https://www.frontierswe.com/",
        default_source_type="benchmark_run",
        description="真实软件工程仓库功能实现子项（剔除研究/性能混合分，取 Implementation 分列）",
        tier="S",
    ),
    # S：真实仓库编码，按维护者合并标准评判
    "frontiercode": BenchmarkSpec(
        id="frontiercode",
        name="FrontierCode 1.1",
        category="repo",
        source_family="Cognition",
        source_url="https://cognition.com/blog/frontier-code-1.1",
        default_source_type="benchmark_run",
        description="聚焦代码质量与仓库维护者合并标准的工程编码测试（1.1 Main）",
        tier="S",
    ),
    # S：132 道私有真实仓库工程任务，AA 统一独立复测
    "frontiercode_2_aa": BenchmarkSpec(
        id="frontiercode_2_aa",
        name="FrontierCode 2.0 (AA)",
        category="repo",
        source_family="Artificial Analysis",
        source_url="https://artificialanalysis.ai/evaluations/frontiercode-2-0",
        default_source_type="independent_run",
        description="Artificial Analysis 独立复测的 Cognition FrontierCode 2.0（132 道私有真实仓库工程任务）",
        tier="S",
    ),
    # A（原 S）：真实生产仓库盲测，但只有 2 个仓库、105 个 bug、仅 TypeScript，作者个人维护
    "bughunt": BenchmarkSpec(
        id="bughunt",
        name="Bug Hunt Bench",
        category="repo",
        source_family="Bug Hunt Bench",
        source_url="https://bughunt.productcompass.pm/data/benchmark.json",
        default_source_type="benchmark_run",
        description="生产级 TypeScript 双仓库 105 个预埋缺陷盲测调试（已过滤废止旧记录）",
        tier="A",
    ),
    # S：长程多文件真实工程任务
    "deepswe": BenchmarkSpec(
        id="deepswe",
        name="DeepSWE",
        category="repo",
        source_family="Datacurve",
        source_url="https://deepswe.datacurve.ai/",
        default_source_type="benchmark_run",
        description="长程受约束多文件软件工程实现与修复交付基准",
        tier="S",
    ),
    # A：真实 IDE 编辑任务，范围限于 Cursor 场景
    "cursorbench": BenchmarkSpec(
        id="cursorbench",
        name="CursorBench 4.0",
        category="repo",
        source_family="Cursor",
        source_url="https://cursor.com/cursorbench",
        default_source_type="benchmark_run",
        description="真实 IDE 多文件编辑、调试与修改基准（4.0 归档版）",
        tier="A",
    ),
    # S：真实 GitHub Issue，Vals 统一复测；官方已归档，靠新鲜度降权
    "vals_swebench": BenchmarkSpec(
        id="vals_swebench",
        name="SWE-bench Verified (Vals)",
        category="repo",
        source_family="Vals AI",
        source_url="https://www.vals.ai/benchmarks/swebench",
        default_source_type="independent_run",
        description="Vals AI 统一沙盒与成本测量的 SWE-bench Verified 独立复测",
        tier="S",
    ),
    # A：真实仓库写测试，任务类型单一；经 BenchLM 转抓
    "scale_swe_atlas_testwriting": BenchmarkSpec(
        id="scale_swe_atlas_testwriting",
        name="SWE Atlas · Test Writing",
        category="repo",
        source_family="Scale Labs",
        source_url="https://labs.scale.com/leaderboard/swe-atlas",
        default_source_type="third_party",
        description="面向已有代码库提交测试补丁与回归捕获的仓库单元测试基准",
        tier="A",
    ),
    # A：真实仓库理解问答，不产出补丁；经 BenchLM 转抓
    "scale_swe_atlas_qna": BenchmarkSpec(
        id="scale_swe_atlas_qna",
        name="SWE Atlas · Codebase QnA",
        category="repo",
        source_family="Scale Labs",
        source_url="https://labs.scale.com/leaderboard/swe-atlas",
        default_source_type="third_party",
        description="仓库理解：跨文件运行分析与代码库实现机制全局问答",
        tier="A",
    ),
    # A：真实企业仓库修复；经 BenchLM 转抓，成绩基本是厂商自报（来源另行折扣）
    "swe_bench_pro": BenchmarkSpec(
        id="swe_bench_pro",
        name="SWE-bench Pro",
        category="repo",
        source_family="Scale Labs",
        source_url="https://labs.scale.com/leaderboard/swe_bench_pro",
        default_source_type="third_party",
        description="长周期、跨文件防污染企业级仓库工程修复基准",
        tier="A",
    ),
    # A：多语言真实 Issue 修复；经 BenchLM 转抓，成绩基本是厂商自报（来源另行折扣）
    "swe_bench_multilingual": BenchmarkSpec(
        id="swe_bench_multilingual",
        name="SWE-bench Multilingual",
        category="repo",
        source_family="SWE-bench",
        source_url="https://github.com/SWE-bench/experiments/tree/main/evaluation/multilingual",
        default_source_type="third_party",
        description="多语言真实开源仓库软件工程 Issue 修复基准",
        tier="A",
    ),
    # B：多语言仓库修复，但成绩是跨脚手架取优后的聚合分
    "multi_swe_bench": BenchmarkSpec(
        id="multi_swe_bench",
        name="Multi-SWE-bench (8 Langs)",
        category="repo",
        source_family="Multi-SWE-bench",
        source_url="https://multi-swe-bench.github.io/",
        default_source_type="benchmark_run",
        description="覆盖 Java / Go / Rust / C / C++ / TS / JS / Python 的多语言仓库修复（跨脚手架取优聚合）",
        tier="B",
    ),
    # B：Exercism 练习题，辅助参考
    "aider_polyglot": BenchmarkSpec(
        id="aider_polyglot",
        name="Aider Polyglot (225)",
        category="repo",
        source_family="Aider AI",
        source_url="https://github.com/Aider-AI/aider/blob/main/aider/website/_data/polyglot_leaderboard.yml",
        default_source_type="benchmark_run",
        description="225 道 Exercism 六语言基础代码编辑练习（辅助编辑参考，不单授仓库核心资格）",
        tier="B",
        core=False,
    ),
    # --- Architecture & Systems Evolution ---
    # S：无源码按行为重建系统程序，Vals 统一跑
    "vals_programbench": BenchmarkSpec(
        id="vals_programbench",
        name="ProgramBench",
        category="architecture",
        source_family="Vals AI",
        source_url="https://www.vals.ai/benchmarks/programbench",
        default_source_type="independent_run",
        description="行为重建：依据行为说明与已编译 CLI 在无源码参考下从零交付兼容系统程序",
        tier="S",
    ),
    # S：只凭可观测行为端到端重实现完整命令行工具
    "mirrorcode": BenchmarkSpec(
        id="mirrorcode",
        name="MirrorCode",
        category="architecture",
        source_family="Epoch / METR",
        source_url="https://epoch.ai/MirrorCode",
        default_source_type="benchmark_run",
        description="长程系统重建：仅凭可观测行为端到端重实现完整命令行系统工具",
        tier="S",
    ),
    # A：跨语言迁移，范围限于 CLI、COBOL→Java 等场景
    "vals_code_migration": BenchmarkSpec(
        id="vals_code_migration",
        name="Code Migration v1.1",
        category="architecture",
        source_family="Vals AI",
        source_url="https://www.vals.ai/benchmarks/code-migration-v1-1",
        default_source_type="benchmark_run",
        description="跨语言工程迁移基准（CLI 及 COBOL→Java 等端到端行为验收）",
        tier="A",
    ),
    # A：真实大型工程重构，任务类型单一；经 BenchLM 转抓
    "scale_swe_atlas_refactoring": BenchmarkSpec(
        id="scale_swe_atlas_refactoring",
        name="SWE Atlas · Refactoring",
        category="architecture",
        source_family="Scale Labs",
        source_url="https://labs.scale.com/leaderboard/swe-atlas",
        default_source_type="third_party",
        description="真实大型工程跨文件组件与依赖重构演进（兼顾结构整理与行为稳定）",
        tier="A",
    ),
    # B：按需求文档从零生成仓库，仅 Python；经 BenchLM 转抓
    "nl2repo": BenchmarkSpec(
        id="nl2repo",
        name="NL2Repo",
        category="architecture",
        source_family="NL2Repo",
        source_url="https://proceedings.mlr.press/v306/ding26j.html",
        default_source_type="third_party",
        description="从自然语言需求文档与空工作区从零设计与构建可安装仓库",
        tier="B",
    ),
    # --- Systems, DevOps & SRE ---
    # S：真实容器终端排错与运维任务，维护方统一跑（与 4.0 同系拆权）
    "terminal_bench_41": BenchmarkSpec(
        id="terminal_bench_41",
        name="Terminal-Bench 4.1",
        category="systems",
        source_family="Harbor / TBench",
        source_url="https://www.tbench.ai/",
        default_source_type="benchmark_run",
        description="Terminal-Bench 4.1：通用容器终端操作、环境排错与命令行工程任务（与 4.0 同系拆权）",
        tier="S",
        overlap_group="tbench_4x",
    ),
    # S：66 道容器终端运维工程任务，AA 与 Vals 双独立复测（与 4.1 同系拆权）
    "terminal_bench_40": BenchmarkSpec(
        id="terminal_bench_40",
        name="Terminal-Bench 4.0 (AA / Vals)",
        category="systems",
        source_family="AA / Vals AI",
        source_url="https://www.vals.ai/benchmarks/terminal-bench-4",
        default_source_type="independent_run",
        description="Terminal-Bench 4.0：66 道复杂容器终端与系统排错任务，聚合 AA 与 Vals 独立复测（与 4.1 同系拆权）",
        tier="S",
        overlap_group="tbench_4x",
    ),
    # S：11 种后端语言微服务的 OpenTelemetry 插桩改造
    "otelbench": BenchmarkSpec(
        id="otelbench",
        name="OTelBench",
        category="systems",
        source_family="Quesma",
        source_url="https://raw.githubusercontent.com/QuesmaOrg/otel-bench/main/benchmark-results/otel/summary.json",
        default_source_type="benchmark_run",
        description="跨 11 种后端语言的微服务 OpenTelemetry 插桩与分布式可观测性改造",
        tier="S",
    ),
    # A：Terminal-Bench 1.0 旧版（80 题），Vals 复测
    "vals_terminal_bench": BenchmarkSpec(
        id="vals_terminal_bench",
        name="Terminal-Bench 1.0 (Vals)",
        category="systems",
        source_family="Vals AI",
        source_url="https://www.vals.ai/benchmarks/terminal-bench",
        default_source_type="independent_run",
        description="Vals AI 在 Terminus 2 下对 Terminal-Bench 1.0 (80 题历史版) 的独立复测",
        tier="A",
    ),
    # A：旧工具链与交叉编译，任务范围窄
    "compilebench": BenchmarkSpec(
        id="compilebench",
        name="CompileBench",
        category="systems",
        source_family="Quesma",
        source_url="https://compilebench.com/",
        default_source_type="benchmark_run",
        description="老旧工具链、依赖修复与交叉编译输出可执行二进制文件",
        tier="A",
    ),
    # A：59 个 K8s 故障快照的根因定位，题量小
    "itbench_aa": BenchmarkSpec(
        id="itbench_aa",
        name="ITBench-AA (SRE)",
        category="systems",
        source_family="Artificial Analysis",
        source_url="https://artificialanalysis.ai/evaluations/itbench-aa",
        default_source_type="independent_run",
        description="Artificial Analysis 独立执行的 59 个 Kubernetes 真实生产快照 SRE 故障根因定位基准",
        tier="A",
    ),
    # B：纯 MCP 工具调用编排，辅助参考；经 BenchLM 转抓
    "mcpatlas": BenchmarkSpec(
        id="mcpatlas",
        name="MCP Atlas",
        category="systems",
        source_family="Scale Labs",
        source_url="https://labs.scale.com/leaderboard/mcp_atlas",
        default_source_type="third_party",
        description="多 MCP 工具工作流编排调用（辅助协议参考，不单授系统核心资格）",
        tier="B",
        core=False,
    ),
    # B：函数调用，辅助参考
    "bfcl_v4": BenchmarkSpec(
        id="bfcl_v4",
        name="BFCL v4",
        category="systems",
        source_family="Berkeley BFCL",
        source_url="https://gorilla.cs.berkeley.edu/data_overall.csv",
        default_source_type="benchmark_run",
        description="Berkeley 函数调用与多轮结构化工具交互基准（辅助工具参考，不单授系统核心资格）",
        tier="B",
        core=False,
    ),
    # --- Database & SQL ---
    # S：600 道抗污染企业级 SQL，维护方核验
    "livesqlbench": BenchmarkSpec(
        id="livesqlbench",
        name="LiveSQLBench-Base-Full v1",
        category="sql",
        source_family="HKU BIRD / LiveSQLBench",
        source_url="https://livesqlbench.ai/",
        default_source_type="benchmark_run",
        description="Base-Full v1：600 道融合外部知识的抗污染企业级复杂 SQL 任务（按官方/自报徽标区分来源）",
        tier="S",
    ),
    # A：SQL 理解与执行计划分析
    "scale_sql_understanding": BenchmarkSpec(
        id="scale_sql_understanding",
        name="SCALE SQL Understanding",
        category="sql",
        source_family="ActionTech SCALE SQL",
        source_url="https://sql-llm-leaderboard.com/",
        default_source_type="benchmark_run",
        description="SQL 理解、执行准确率与 Explain 执行计划分析",
        tier="A",
    ),
    # S：慢查询改写与等价性校验，直接对应后端 SQL 调优
    "scale_sql_optimization": BenchmarkSpec(
        id="scale_sql_optimization",
        name="SCALE SQL Optimization",
        category="sql",
        source_family="ActionTech SCALE SQL",
        source_url="https://sql-llm-leaderboard.com/",
        default_source_type="benchmark_run",
        description="按官方协议汇总的慢查询改写与逻辑等价性 SQL 优化能力分（ability_score）",
        tier="S",
    ),
    # A：多数据库方言迁移，范围窄
    "scale_sql_dialect": BenchmarkSpec(
        id="scale_sql_dialect",
        name="SCALE SQL Dialect Migration",
        category="sql",
        source_family="ActionTech SCALE SQL",
        source_url="https://sql-llm-leaderboard.com/",
        default_source_type="benchmark_run",
        description="复杂 SQL 语句与多数据库方言语义兼容迁移基准",
        tier="A",
    ),
    # S：Snowflake 超宽企业表 Text-to-SQL（与 Lite 同题集，拆权）
    "spider2_snow": BenchmarkSpec(
        id="spider2_snow",
        name="Spider 2.0-Snow",
        category="sql",
        source_family="XLANG Spider 2.0",
        source_url="https://spider2-sql.github.io/",
        default_source_type="third_party",
        description="Snowflake 超宽企业表 Text-to-SQL（与 Lite 共用 547 题，同题族防重复折权）",
        tier="S",
        overlap_group="spider2_sql_547",
    ),
    # S：多数据库复杂查询（与 Snow 同题集，拆权）
    "spider2_lite": BenchmarkSpec(
        id="spider2_lite",
        name="Spider 2.0-Lite",
        category="sql",
        source_family="XLANG Spider 2.0",
        source_url="https://spider2-sql.github.io/",
        default_source_type="third_party",
        description="BigQuery / Snowflake / SQLite 多库复杂查询（与 Snow 共用 547 题，同题族防重复折权）",
        tier="S",
        overlap_group="spider2_sql_547",
    ),
    # A：DBT 数据建模工作流，题量小
    "spider2_dbt": BenchmarkSpec(
        id="spider2_dbt",
        name="Spider 2.0-DBT",
        category="sql",
        source_family="XLANG Spider 2.0",
        source_url="https://spider2-sql.github.io/",
        default_source_type="third_party",
        description="DuckDB + DBT 真实数据工程转换建模工作流",
        tier="A",
    ),
    # A：50 道 ClickHouse 分析查询，单一数据集
    "tinybird_sql": BenchmarkSpec(
        id="tinybird_sql",
        name="Tinybird LLM SQL",
        category="sql",
        source_family="Tinybird",
        source_url="https://llm-benchmark.tinybird.live/",
        default_source_type="benchmark_run",
        description="2 亿行 GitHub 事件 ClickHouse 上的 50 道分析型 SQL Exactness 正确性分（不含效率惩罚分）",
        tier="A",
    ),
    # --- Performance & Algorithms ---
    # S：真实开源仓库性能优化（Opt@1）
    "gso": BenchmarkSpec(
        id="gso",
        name="GSO Software Optimization",
        category="performance",
        source_family="GSO",
        source_url="https://gso-bench.github.io/assets/leaderboard.json",
        default_source_type="benchmark_run",
        description="真实开源软件仓库的性能剖析与相对专家级加速优化（Opt@1）",
        tier="S",
    ),
    # A：FrontierSWE 的性能子集，题量小
    "frontierswe_perf": BenchmarkSpec(
        id="frontierswe_perf",
        name="FrontierSWE · Performance",
        category="performance",
        source_family="Proximal",
        source_url="https://www.frontierswe.com/",
        default_source_type="benchmark_run",
        description="FrontierSWE 真实工程性能剖析与算法优化子集（与 Implementation 子集相互独立）",
        tier="A",
    ),
    # B：竞赛算法题，辅助参考
    "vals_ioi": BenchmarkSpec(
        id="vals_ioi",
        name="IOI v2 (Vals)",
        category="performance",
        source_family="Vals AI",
        source_url="https://www.vals.ai/benchmarks/ioi",
        default_source_type="benchmark_run",
        description="IOI 竞赛级算法设计与复杂度优化求解（算法子项，不单授核心工程资格）",
        tier="B",
        core=False,
    ),
    # 只展示：原始加速倍数，不进主分
    "algotune": BenchmarkSpec(
        id="algotune",
        name="AlgoTune",
        category="performance",
        source_family="AlgoTune",
        source_url="https://algotune.io/",
        default_source_type="benchmark_run",
        description="核心数值与算法内核运行加速倍数（原始倍数如 2.05×，暂只展示不进 IRT 概率主分）",
        tier="A",
        scored=False,
        core=False,
    ),
    # 只展示：原始加速倍数，不进主分
    "inferencebench": BenchmarkSpec(
        id="inferencebench",
        name="InferenceBench",
        category="performance",
        source_family="InferenceBench",
        source_url="https://inferencebench.ai/",
        default_source_type="benchmark_run",
        description="LLM 推理服务端综合优化加速倍数（原始倍数如 10.27×，含异构 Prompt 暂只展示对照不进 IRT 主分）",
        tier="A",
        scored=False,
        core=False,
    ),
    # 只作对照：复合指数，含非代码维度，不进主分
    "aa_engineering": BenchmarkSpec(
        id="aa_engineering",
        name="AA Engineering Index",
        category="performance",
        source_family="Artificial Analysis",
        source_url="https://artificialanalysis.ai/methodology/capability-indexes",
        default_source_type="independent_run",
        description="AA 工程复合指数（含非代码维度且与 TBench/FrontierCode 交叉，外部对照不计入主分）",
        tier="B",
        scored=False,
        core=False,
    ),
    # --- Backend Security ---
    # S：120 道六语言 OWASP Top 10 真实仓库审计与补丁修复，确定性 pass@1，AA 独立实测
    "cwe_bench_aa": BenchmarkSpec(
        id="cwe_bench_aa",
        name="CWE-Bench-AA",
        category="security",
        source_family="Artificial Analysis",
        source_url="https://artificialanalysis.ai/evaluations/cwe-bench-aa",
        default_source_type="independent_run",
        description="Artificial Analysis 独立执行的 120 道六语言 OWASP Top 10 真实仓库安全审计与漏洞补丁基准（pass@1）",
        tier="S",
    ),
    # A：Vercel 真实 Web 应用安全静态审计（中位 F2），含裁判打分故定 A 档
    "deepsecbench_aa": BenchmarkSpec(
        id="deepsecbench_aa",
        name="DeepsecBench-AA",
        category="security",
        source_family="Artificial Analysis",
        source_url="https://artificialanalysis.ai/evaluations/deepsecbench-aa",
        default_source_type="independent_run",
        description="Artificial Analysis 独立执行的 Vercel 真实 Web 应用代码安全审计基准（中位 F2 分）",
        tier="A",
    ),
    # A：64 道无源码二进制逆向分析任务，偏专精故定 A 档
    "vals_srebench": BenchmarkSpec(
        id="vals_srebench",
        name="SRE Bench · RevEng (Vals)",
        category="security",
        source_family="Vals AI",
        source_url="https://www.vals.ai/benchmarks/srebench",
        default_source_type="independent_run",
        description="Vals AI 独立执行的 64 道无源码软件逆向工程与二进制安全分析基准",
        tier="A",
    ),
    # S：真实开源软件漏洞复现与修复，Vals 统一跑
    "vals_cyber": BenchmarkSpec(
        id="vals_cyber",
        name="CyberBench (Vals)",
        category="security",
        source_family="Vals AI",
        source_url="https://www.vals.ai/benchmarks/cyber",
        default_source_type="benchmark_run",
        description="Vals CyberBench：开源原生软件缺陷复现与安全修复",
        tier="S",
    ),
    # A：真实历史漏洞 PoC 复现，偏攻击侧
    "cybergym": BenchmarkSpec(
        id="cybergym",
        name="CyberGym Level-1",
        category="security",
        source_family="CyberGym Team",
        source_url="https://www.cybergym.io/assets/data/cybergym.json",
        default_source_type="benchmark_run",
        description="CyberGym Level-1（trials=1）：真实历史漏洞 PoC 复现（按原表区分自报与官方运行）",
        tier="A",
    ),
    # A：CTF 解题，偏攻击侧
    "cybench": BenchmarkSpec(
        id="cybench",
        name="Cybench",
        category="security",
        source_family="Cybench",
        source_url="https://cybench.github.io/data/leaderboard.csv",
        default_source_type="benchmark_run",
        description="无引导 CTF 与后端服务渗透解题率（按官方脚注与模型卡还原自报与 HAL 复测）",
        tier="A",
    ),
    # A：漏洞分阶段利用，偏攻击侧，入榜模型少
    "exploitbench": BenchmarkSpec(
        id="exploitbench",
        name="ExploitBench v0.1",
        category="security",
        source_family="ExploitBench",
        source_url="https://exploitbench.ai/",
        default_source_type="benchmark_run",
        description="自动化漏洞分阶段利用达成度（Mean Capability）",
        tier="A",
    ),
    # A：从零写出同时过功能和安全测试的后端服务，入榜模型少
    "autobaxbench_hard": BenchmarkSpec(
        id="autobaxbench_hard",
        name="AutoBaxBench Hard",
        category="security",
        source_family="ETH SRI",
        source_url="https://baxbench.com/autobaxbuilder/",
        default_source_type="benchmark_run",
        description="AutoBaxBench Hard（sec_pass@1）：从零生成 5 端点后端服务并同时通过功能与安全测试（已剔除出题关联模型）",
        tier="A",
    ),
    # 只作对照：复合指数，不进主分
    "aa_cyber": BenchmarkSpec(
        id="aa_cyber",
        name="AA Cyber Index",
        category="security",
        source_family="Artificial Analysis",
        source_url="https://artificialanalysis.ai/methodology/cyber-index",
        default_source_type="independent_run",
        description="AA 网络安全复合指数（含 CyberGym-E2E-AA 等组成，外部对照不计入主分）",
        tier="B",
        scored=False,
        core=False,
    ),
}
