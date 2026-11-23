# Backend.Index — 独立后端工程代码大模型排行榜

**Backend.Index** 是一个面向真实软件工程与后端开发场景的独立大模型评测索引与证据溯源平台。项目通过 Python 数据管道聚合全球 **22** 个公开上游源、**45** 项后端与系统工程基准测试（其中 41 项参与 2PL IRT 校准、4 项为外部/原始倍数对照参考，涵盖仓库级研发、系统重建与演进、运维与工具协议、Text-to-SQL、性能与算法及后端安全），并结合 `90% CI` 不确定性区间与可追溯 Evidence Ledger 提供直观评测看板与多模型对比分析。

> 当前数据快照（`BackendIndex-2PL-IRT-v2.1`，生成时间 `2026-11-23T05:21:56Z`）：共收录 **143** 个入榜模型（`106 Supported` / `37 Estimated`）、**45** 项追踪基准与 **2,403** 条原始评测观测记录。

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
| `repo` | 仓库研发 | Repo Engineering | **25%** | 已有代码库理解（SWE-Atlas QnA）、缺陷定位修复、单测补全（Test Writing）与多文件补丁交付（SWE-rebench、FrontierSWE Implementation、Bug Hunt Bench 等） |
| `systems` | 运维构建与 SRE | Systems, DevOps & SRE | **20%** | 容器终端排错、K8s 生产 SRE 根因定位、复杂构建工具链与 OpenTelemetry 可观测性（Terminal-Bench、ITBench-AA、CompileBench、OTelBench、MCP Atlas、BFCL v4 等） |
| `architecture` | 系统重建与演进 | Architecture & Evolution | **15%** | 跨文件架构重构（Refactoring）、跨语言迁移（Code Migration）与无源码系统重建（ProgramBench、MirrorCode、NL2Repo） |
| `sql` | 数据库 SQL | Database & SQL | **15%** | 企业宽表 Text-to-SQL、ClickHouse 分析查询正确性、SQL 优化与 DBT 建模（Spider 2.0、LiveSQLBench、SCALE SQL、Tinybird LLM SQL 等） |
| `performance` | 性能与算法 | Performance & Algorithms | **15%** | 真实仓库软件运行时性能优化与竞赛级算法求解（GSO Opt@1、FrontierSWE Performance、Vals IOI v2；AlgoTune / InferenceBench 原始加速倍数对照） |
| `security` | 后端安全 | Backend Security | **10%** | 历史漏洞 PoC 复现修复、无引导 CTF、漏洞利用及安全后端服务构建（CyberGym Level-1、Cybench、Vals Cyber、ExploitBench、AutoBaxBench Hard 等） |

---

## 评分方法与防污染机制

1. **Category-First 2PL IRT 校准**（[irt_scorer.py](pipeline/irt_scorer.py)）
   - 先在同一模型与基准的多次提交中优先保留独立评测运行（`benchmark_run` / `independent_run`），再分两轮按维度以纯 NumPy 拟合两参数 IRT 模型并通过共有模型锚点统一对齐到 `repo` 标尺，输出 `0–100` 校准刻度。
2. **90% 置信区间与缺测惩罚（`90% CI`）**
   - 每个固定分数旁标注的区间（如 `82–100`）并非单次最好/最差成绩，而是统计意义上的 **90% 置信区间**（`overall ± 1.645 × overall_se`，截断至 `[0, 100]`），其中 `overall_se = sqrt(base_se² + (missing_weight × 6.5)²)`。未实测维度越多或基准覆盖越少，置信区间越宽。
3. **来源折算、同题拆权与家族封顶**（[config.py](pipeline/config.py)）
   - 实验室自报或第三方转引权重为 `0.72`，独立基准/维护方实测为 `1.00`；较早期历史榜单（`aging`）时效系数为 `0.55`；共有同底层题集的子榜（如 Spider 2.0 Snow/Lite）按同题族折权；在多家族场景下通过迭代归一化严格将单一评测家族占比限制在 **40%–45%** 以内。
4. **核心工程门槛（`Supported` / `Estimated`）与 2 分近距护栏**
   - 仅当模型在**核心工程基准（`core=True`）**上满足「≥ 2 个独立家族 + ≥ 2 个维度（且必含 `repo` 核心工程）+ ≥ 4 项不同核心基准」时方可标记 `Supported`，辅助项目（Exercism 练习、纯工具调用、算法竞赛）不单独授予核心资格；单家族支撑的 `Estimated` 模型落后 2 分护栏继续生效。

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
│   ├── MethodologyView.tsx      # 计分原则、45 项基准清单与数据源健康状态
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
│   ├── config.py                # 6 维权重、来源系数与 45 项基准注册表
│   ├── fetchers.py              # 22 个上游抓取来源与定价 API 解析器
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
