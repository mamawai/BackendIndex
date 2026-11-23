# Backend.Index — 独立后端工程代码大模型排行榜

**Backend.Index** 是一个面向真实软件工程与后端开发场景的独立大模型评测索引与证据溯源平台。项目通过 Python 数据管道聚合全球 **14** 个公开权威榜单源、**40** 项后端与系统工程基准测试（涵盖仓库级修复、系统构建运维、Text-to-SQL、性能内核优化、架构重构与后端安全等方向），采用 **2PL 题目反应理论（2PL IRT）** 校准能力分与 `90% CI` 不确定性区间，并在 Next.js 前端中提供透明的证据链回溯与多模型对比分析。

> 当前数据快照（`BackendIndex-2PL-IRT-v2.0`，生成时间 `2026-11-22T17:50:43Z`）：共收录 **135** 个入榜模型（`93 Supported` / `42 Estimated`）、**40** 项计分基准与 **1,857** 条评测观测记录。

---

## 核心特性

- **六大工程能力维度排行榜**
  - 支持在「综合总榜」与 6 个单维度榜单间平滑切换，支持搜索模型/厂商、筛选开源权重（Open Weights）、`Supported Only` 过滤与点击打开**自定义权重弹窗**实时重排。
- **行内上弹证据溯源浮窗（Evidence Modal）**
  - 点击榜单任意模型即可从对应行位向上展开详情浮窗，集中展示综合估分、`90% CI` 不确定性、6 维对比分布、主力脚手架（Harness）表现与包含原始来源链接的逐条 **Evidence Ledger**。
- **多模型六维对比（Compare）**
  - 默认载入 Top 4 模型并支持任意替换最多 4 个模型叠加六维雷达图，内置 `Top 4 Ranked`、`Top 4 Labs`、`Full 6D Tested`、`Top Open Weights`、`Best Value` 一键预设，以及 **能力维度 / 关键基准 PK / API 价格与脚手架** 三个对比视图。
- **API 性价比前沿（Pareto Frontier）**
  - 结合 OpenRouter 混合定价（对数坐标）与 BackendIndex 校准分绘制 Pareto 最优前沿，支持开源权重与 `1M+` 长上下文过滤。
- **中英文实时切换与浏览器语言自适应（`中 / EN`）**
  - 右上角支持一键切换中文 / English 与浅色 / 深色主题；首次访问未手动指定时，会自动按浏览器 `navigator.languages` / `navigator.language` 匹配默认语言（中文环境显示中文，其余自动切换英文），手动选择则持久化至 `localStorage`。

---

## 六大能力维度与默认权重

| 维度 ID | 中文名称 | English | 默认权重 | 评测侧重点 |
| :--- | :--- | :--- | :---: | :--- |
| `repo` | 仓库研发 | Repo Engineering | **25%** | 多文件大型仓库 Bug 定位、真实 Issue 修复与端到端补丁合入（SWE-rebench v2、FrontierSWE、Bug Hunt Bench 等） |
| `systems` | 运维构建与 SRE | Systems, DevOps & SRE | **20%** | 容器终端排错、复杂构建工具链、OpenTelemetry 可观测性与工具协议（Terminal-Bench 4.1、CompileBench、OTelBench 等） |
| `architecture` | 架构与构建 | Architecture & Build | **15%** | 跨模块代码库问答、安全重构、单元测试编写、遗产代码迁移与从零系统重建（SWE-Atlas、RefactoringBench 等） |
| `sql` | 数据库 SQL | Database & SQL | **15%** | 企业宽表 Text-to-SQL、执行优化、SQL 方言迁移与查询分析（Spider 2.0、LiveSQLBench、SCALE SQL 等） |
| `performance` | 性能与算法 | Performance & Algorithms | **15%** | 运行时性能优化、算法竞赛内核与综合编码能力（LiveCodeBench、BigCodeBench、AlgoTune 等） |
| `security` | 后端安全 | Backend Security | **10%** | CVE PoC 复现与自动补丁、渗透对抗与系统安全攻防（CyberGym、Cybench、ExploitBench 等） |

---

## 评分方法与防污染机制

1. **Category-First 2PL IRT 校准**（[irt_scorer.py](pipeline/irt_scorer.py)）
   - 先在同一模型与基准的多次提交中优先保留独立评测运行（`benchmark_run` / `independent_run`），再按维度以纯 NumPy 拟合两参数 IRT 模型，联合估算基准区分度 `a`、难度 `b` 及模型潜在能力 `θ`，最终映射至 `0–100` 校准刻度。
2. **90% 置信区间与缺测惩罚（`90% CI`）**
   - 每个固定分数旁标注的区间（如 `86–100`）并非单次最好/最差成绩，而是统计意义上的 **90% 置信区间**（`overall ± 1.645 × overall_se`，截断至 `[0, 100]`），其中 `overall_se = sqrt(base_se² + (missing_weight × 6.5)²)`。未实测维度越多或基准覆盖越少，置信区间越宽。
3. **来源折算与 40% 单机构封顶**（[config.py](pipeline/config.py)）
   - 官方实验室自报或第三方转发权重为 `0.72`，独立基准运行为 `1.00`；较早期榜单（`aging`）时效系数为 `0.55`。当某模型涵盖至少 3 个评测来源家族时，单一家族的贡献上限被限制在 **40%**。
4. **`Supported` / `Estimated` 状态与 2 分近距护栏**
   - 满足「≥ 2 个独立第三方家族 + ≥ 2 个维度（且必含 `repo`）+ ≥ 4 项不同基准」的模型标记为 `Supported`，否则为 `Estimated`；且仅由单个独立家族支撑的 `Estimated` 模型在综合榜上若领先下一名不超过 `2.0` 分，会被动态后移，防止单榜刷分冲榜。

---

## 项目结构

```text
BackendIndex/
├── app/
│   ├── globals.css              # 全局主题变量、无边框卡片与胶囊滑块样式
│   ├── layout.tsx               # App Router 根布局与字体配置
│   └── page.tsx                 # 读取静态快照并渲染前端应用
├── components/
│   ├── BackendIndexApp.tsx      # 顶层状态、视图切换与全局浮窗挂载
│   ├── Header.tsx               # 导航栏、中/EN 语言切换、浅/深色主题切换
│   ├── TopLeaders.tsx           # 榜单 Top 3 卡片
│   ├── LeaderboardView.tsx      # 综合/分维排行榜、过滤芯片与搜索
│   ├── CompareView.tsx          # 最多 4 模型 6 维雷达叠加与多维 PK 页
│   ├── EvidenceDrawer.tsx       # 行内上弹证据溯源与 Ledger 详情浮窗
│   ├── ParetoView.tsx           # API 定价 vs 分数 Pareto 前沿散点图
│   ├── MethodologyView.tsx      # 计分原则、40 项基准清单与数据源健康状态
│   ├── HexRadarChart.tsx        # SVG 六边形多模型对比雷达图
│   ├── WeightPopover.tsx        # 自定义 6 维权重调优浮层
│   └── ui/SlidingControls.tsx   # ResizeObserver 驱动的平滑滑动选择器
├── lib/
│   ├── i18n.tsx                 # LangProvider、中英字典与 <title>/lang 同步
│   ├── lang-detect.ts           # 浏览器语言偏好探测与本地覆盖解析
│   ├── presets.ts               # 对比模型默认组合预设与均值基线计算
│   ├── scoring.ts               # 客户端动态权重重算与 90% CI 更新
│   └── types.ts                 # 前后端共享类型定义
├── pipeline/
│   ├── config.py                # 6 维权重、来源系数与 40 项基准注册表
│   ├── fetchers.py              # 14 个上游榜单与定价 API 抓取器
│   ├── normalizer.py            # 跨榜单模型名归一化与厂商归属映射
│   ├── irt_scorer.py            # 2PL IRT 校准引擎、CI 计算与护栏排序
│   ├── models.py                # 观测记录与模型元数据 dataclass
│   ├── probe_sources.py         # 上游数据源结构探针辅助脚本
│   └── sync_and_score.py        # 数据同步与打分主入口，输出 data/snapshot.json
├── data/
│   └── snapshot.json            # 前端直接消费的校准结果快照
├── package.json
└── tsconfig.json
```

---

## 本地运行指南

### 1. 启动前端 Web 应用

环境需要 **Node.js**（推荐 Node 20+）。

```bash
# 安装依赖
npm install

# 启动开发服务器（默认 http://localhost:3000）
npm run dev

# 类型检查与生产构建
npm run lint
npm run build

# 启动生产服务（可按需指定端口）
npx next start -p 3177
```

### 2. 重新抓取并校准榜单快照（可选）

仓库已自带可直接运行的 [data/snapshot.json](data/snapshot.json)。如需重新拉取上游榜单或调整 [pipeline/config.py](pipeline/config.py) 中的权重重新计算，可运行 Python 管道（建议 Python 3.10+）：

```bash
# 安装 Python 数据管道依赖
pip install numpy requests pyyaml beautifulsoup4

# 使用本地 HTTP 缓存重跑校准并重新生成 data/snapshot.json
python pipeline/sync_and_score.py

# 忽略本地缓存，从上游站点全量刷新数据
python pipeline/sync_and_score.py --refresh
```
