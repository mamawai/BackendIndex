# Backend.Index — 独立后端工程代码大模型排行榜

**Backend.Index** 是一个面向真实软件工程与后端开发场景的独立大模型评测索引与证据溯源平台。项目通过 Python 数据管道聚合全球 **27** 个公开上游数据源、**50** 项后端与系统工程基准测试（其中 45 项参与 2PL IRT 校准、5 项为外部/协议/原始倍数对照参考，涵盖仓库级研发、系统重建与演进、运维构建与 SRE、Text-to-SQL、性能与算法及后端安全），按维度分别校准后通过统计信度连续加权汇总成综合分，并给出不确定度区间与可追溯的 Evidence Ledger。

> 当前数据快照（`BackendIndex-2PL-IRT-v3`，生成时间 `2026-11-24T05:58:30Z`）：共 **131** 个模型同榜排名，其中 **76** 个数据完整、**55** 个标为"数据不全"（名次仅供参考）；**50** 项追踪基准中有 **21** 项计分基准因超过 30 天没有新动静被降权；共 **2,612** 条原始评测观测记录。

---

## 核心特性

- **六大工程能力维度排行榜**
  - 支持在「综合总榜」与 6 个单维度榜单间平滑切换，支持搜索模型/厂商、筛选开源权重（Open Weights）、`Supported Only`、`仅数据完整`（隐藏数据不全行但保留原名次）过滤与自定义维度权重实时重排。
  - 缺维度的模型按六维齐全模型的实际关系修正综合分（缺的维度本身不编分数）；已测维度不到当前权重 70% 的照常排名，但标为"数据不全"，并给出缺测维度和可能的名次范围。
- **行内上弹证据溯源浮窗（Evidence Modal）**
  - 点击榜单任意模型即可展开详情浮窗，集中展示综合估分与不确定度区间、6 维分布（严格按入模基准统计独立来源数与"单基准"维度）、脚手架（Harness）与推理档位、按"每题 / 整轮"标明口径的评测成本，以及包含原始来源链接的逐条 **Evidence Ledger**。
- **多模型六维对比（Compare）**
  - 默认载入综合榜前 4 名并支持任意替换最多 4 个模型叠加六维雷达图，内置 `Top 4 Ranked`、`Top 4 Labs`、`Full 6D Tested`、`Top Open Weights`、`Best Value` 一键预设，以及 **能力维度 / 关键基准 PK / API 价格与脚手架** 三个对比视图。
- **API 性价比前沿（Pareto Frontier）**
  - 结合 OpenRouter `3:1` 输入/输出加权均价（对数坐标）与参与排名模型的综合分绘制 Pareto 最优前沿（数据不全模型以空心圆展示、不计入前沿线），支持开源权重与 `1M+` 长上下文过滤。
- **中英文实时切换与浏览器语言自适应（`中 / EN`）**
  - 右上角支持一键切换中文 / English 与浅色 / 深色主题；首次访问未手动指定时，会自动按浏览器 `navigator.languages` / `navigator.language` 匹配默认语言（中文环境显示中文，其余自动切换英文），手动选择则持久化至 `localStorage`。

---

## 六大能力维度与默认权重

| 维度 ID | 中文名称 | English | 默认权重 | 评测侧重点 |
| :--- | :--- | :--- | :---: | :--- |
| `repo` | 仓库研发 | Repo Engineering | **25%** | 已有代码库理解（SWE-Atlas QnA）、缺陷定位修复、单测补全（Test Writing）与多文件补丁交付（SWE-rebench、FrontierSWE Implementation、FrontierCode 1.1 / 2.0、Bug Hunt Bench 等） |
| `systems` | 运维构建与 SRE | Systems, DevOps & SRE | **20%** | 容器终端排错、K8s 生产 SRE 根因定位、复杂构建工具链与 OpenTelemetry 可观测性（Terminal-Bench 4.1 / 4.0、ITBench-AA、CompileBench、OTelBench；MCP Atlas / BFCL v4 协议参考对照） |
| `architecture` | 系统重建与演进 | Architecture & Evolution | **15%** | 跨文件架构重构（Refactoring）、跨语言迁移（Code Migration）与无源码系统重建（ProgramBench、MirrorCode、NL2Repo） |
| `sql` | 数据库 SQL | Database & SQL | **15%** | 企业宽表 Text-to-SQL、ClickHouse 分析查询正确性、SQL 优化与 DBT 建模（Spider 2.0、LiveSQLBench、SCALE SQL、Tinybird LLM SQL 等） |
| `performance` | 性能与算法 | Performance & Algorithms | **15%** | 真实仓库软件运行时性能优化、LLM 推理服务内核优化与竞赛级算法求解（GSO Opt@1、InferenceBench 对数加速比校准、FrontierSWE Performance、Vals IOI v2；AlgoTune 原始倍数对照） |
| `security` | 后端安全 | Backend Security | **10%** | OWASP 真实仓库审计补丁、Web 静态安全审计、二进制逆向、漏洞 PoC 复现修复与无引导 CTF（CWE-Bench-AA、DeepsecBench-AA、Vals SRE Bench 逆向、Vals Cyber、CyberGym Level-1、Cybench、ExploitBench、AutoBaxBench Hard 等） |

---

## 评分方法

1. **分维度 2PL IRT 校准**（[irt_scorer.py](pipeline/irt_scorer.py)）
   - 每个维度单独用边际最大似然（EM，θ 在网格上积分）拟合两参数 IRT，区分度限制在 `[0.25, 1.45]`（防止稀疏维度里单个小基准通过 `a²` 垄断 Fisher 信息量），只用这个维度自己的成绩，**不从其它维度借分**；只有一项基准的维度，分数会向该维度全体模型的平均水平收缩，页面上标为"单基准"。
   - 同一维度里，两个基准至少有 3 个共同模型才算能放在一起比。不连通时（例如只有老模型的 Terminal-Bench 1.0 / OTelBench / CompileBench 和只有新模型的 Terminal-Bench 4.1），**只让有效权重（档位×来源×新鲜度）合计最大的那组计分**，其余组的成绩保留在台账里、该维度标为"不可比"，不硬排。
     - 依据：把连通维度人为切成新旧两组做还原实验（架构、性能、SQL 共 42 种切法），"整组对齐""回归对齐"等办法平均会把被切开那组放错 4–8 分、最坏 10–30 分，而头部相邻名次只差约 1 分，所以不连通的两组不做比较。
   - 各维度再用全部共同模型按两边后验方差的反方差加权对齐到 `repo` 刻度（并用全方差公式补偿单基准模型的后验收缩，不设人为截断上限），映射为 `0–100` 分；和仓库研发共同模型不足 4 个的维度不计分。
2. **观测权重 = 档位 × 来源 × 新鲜度 × 抽样方差衰减**（[config.py](pipeline/config.py) / [irt_scorer.py](pipeline/irt_scorer.py)）
   - **档位**只看题目本身：`S ×1.4`（核心真实工程基准）/ `A ×1.1`（题量小、范围窄或半合成）/ `B ×0.7`（练习、竞赛等辅助参考），每项基准的定档理由写在注册表注释里。
   - **来源与卫生清洗**：维护方实测 / 独立复测 `×1.0`，厂商自报 / 第三方转引 `×0.72`；开放提交 SQL 榜上的定制多智能体刷榜系统（如 QUVI、AntQL、Tianqiong、Prism Swarm 等）及异常中断运行（Tinybird 完成率 < 50%）直接隔离剔除，仅收录基座模型与标准通用脚手架。
   - **小样本标准误衰减**：附带抽样标准误 `stderr` 的观测（如仅约 9 题、标准误达 ±10% 的 MirrorCode）按异方差测量误差公式自动衰减有效精度权重，防止小样本噪声倒挂大题量核心基准。
   - **新鲜度**由数据自动判定：取该基准"最近评测日期"和"榜上最新模型的发布日期"里较新的一个，30 天内 `×1.0`，之后线性降到第 90 天的 `×0.55`；官方已标归档（如 Vals 的 SWE-bench Verified、Terminal-Bench 1.0）直接 `×0.55`。
   - 共用同一题集或同系迭代的子榜（如 Spider 2.0 Snow/Lite、Terminal-Bench 4.0/4.1）拆分权重；同一维度有 3 个及以上来源时，单一评测来源占比封顶 40%–45%。
   - 同一模型同一基准有多次成绩时，取实测来源里的最高分，即**各基准的最佳配置成绩**（推理档位、脚手架不同的成绩不分开计分，台账里逐条保留）。
3. **综合分信度连续融合、缺测修正与邻近保护**
   - 单维度榜单完全保留该维度自身的 IRT 分数，缺的维度本身**绝不编分数**（页面仍标"缺测"）。
   - 汇总综合总榜时，每个维度的实测话语权按统计信度 `r = τ₀² / (τ₀² + SE²)`（`τ₀ = 6.5`）连续折算，剩余 `(1 − r)` 权重由完整模型按信度加权拟合的跨维度基线直线估算：
     - 多基准高精度维度（`SE ≈ 2`）信度达 `90%+`，几乎完全由实测成绩决定；
     - 仅测 1 项极高噪声微基准的维度（如单测 Tinybird SQL，`SE ≈ 17`，`r ≈ 13%`）自动降权，与完全缺测（`SE = ∞`，`r = 0%`）无缝平滑衔接，彻底消除"多测一项高噪声微基准反而比完全缺测倒扣 2–4 分"的断崖，使前 25 名模型的同场 PK 胜负一致率提升至 **90.9%**。
   - 所有收录模型同榜排名；已测维度不到当前权重 **70%** 的标为"数据不全"：名次前加 `≈`，写明缺哪几维（区分"缺测"和"不可比"），并按它的区间给出可能落在的名次范围。自定义权重时按新权重重新拟合、重新判断。
   - **2 分邻近保护**：`Supported` 需满足核心基准上 ≥ 2 个独立来源家族 + ≥ 2 个维度（必含 `repo`）+ ≥ 4 项不同核心基准；综合榜上单一来源的 `Estimated` 模型不排在 2 分以内的多方实测模型之前，单维度榜上仅测 1 项基准的模型同样不排在 2 分以内的多基准实测模型之前（页面标出 `↓` 与 `2pt` 说明）。
4. **不确定度区间**
   - 每个维度的标准误来自 IRT 后验，其中各基准成绩围绕预测值的实际波动用准二项离散度估计；缺测模型再加上缺测修正那条直线在参照模型上的实际预测误差（已测分离参照模型的平均水平越远越大）。
   - 区间按模型假设约为 90%（还原实验里缺测部分的实际覆盖为 91%–96%）：缺测越多越宽，证据越多越窄；**不包含**脚手架、推理档位差异和"选哪些基准"带来的影响。

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
│   ├── LeaderboardView.tsx      # 综合/分维排行榜、数据不全标记、过滤芯片与搜索
│   ├── CompareView.tsx          # 最多 4 模型 6 维雷达叠加与多维 PK 页
│   ├── EvidenceDrawer.tsx       # 行内上弹证据溯源与 Ledger 详情浮窗
│   ├── ParetoView.tsx           # API 定价 vs 分数 Pareto 前沿散点图
│   ├── MethodologyView.tsx      # 计分方法、50 项基准档位与新鲜度、数据源健康状态
│   ├── HexRadarChart.tsx        # SVG 六边形多模型对比雷达图
│   ├── WeightPopover.tsx        # 自定义 6 维权重调优浮层
│   └── ui/SlidingControls.tsx   # ResizeObserver 驱动的平滑滑动选择器
├── lib/
│   ├── i18n.tsx                 # LangProvider、中英字典与 <title>/lang 同步
│   ├── lang-detect.ts           # 浏览器语言偏好探测与本地覆盖解析
│   ├── presets.ts               # 对比模型默认组合预设与中位线计算
│   ├── scoring.ts               # 客户端动态权重重算（含缺测修正）、覆盖门槛与不确定度区间
│   └── types.ts                 # 前后端共享类型定义
├── pipeline/
│   ├── config.py                # 6 维权重、档位/来源/新鲜度规则与 50 项基准注册表
│   ├── fetchers.py              # 27 个上游抓取来源与定价 API 解析器
│   ├── normalizer.py            # 跨榜单模型名归一化、脚手架与推理档位写法统一
│   ├── irt_scorer.py            # 分维度 2PL IRT（边际最大似然）、跨维度对齐、缺测修正与排名
│   ├── models.py                # 观测记录与模型元数据 dataclass
│   ├── probe_sources.py         # 上游数据源结构探针辅助脚本
│   └── sync_and_score.py        # 数据同步、新鲜度判定与打分主入口，输出 data/snapshot.json
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

仓库已自带可直接运行的 [data/snapshot.json](data/snapshot.json)。如需重新拉取上游榜单或调整 [pipeline/config.py](pipeline/config.py) 中的规则重新计算，可运行 Python 管道（建议 Python 3.10+）：

```bash
# 安装 Python 数据管道依赖
pip install numpy requests pyyaml beautifulsoup4

# 使用本地 HTTP 缓存（12 小时内有效；离线时可加 --offline 直接用现有缓存）重跑校准并重新生成 data/snapshot.json
python -X utf8 pipeline/sync_and_score.py
python -X utf8 pipeline/sync_and_score.py --offline

# 忽略本地缓存，从上游站点全量刷新数据
python -X utf8 pipeline/sync_and_score.py --refresh
```

> Windows 终端默认编码不是 UTF-8，加 `-X utf8` 可避免打印模型名时报编码错误。新鲜度按运行当天计算，同一份数据隔几天重跑，降权的基准可能会变多。
