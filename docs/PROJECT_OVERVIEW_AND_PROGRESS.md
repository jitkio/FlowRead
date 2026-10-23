# FlowRead 项目整体与进度分析

更新日期：2026-10-18  
分析对象：当前工作区（分支 `Prepare1`，HEAD `3f62726`）  
分析方式：源码、文档、git 状态只读审阅 + 本轮实际运行 `npm test`、`npm run build`、`cargo test`。  
边界说明：**未修改任何实现代码**（按验证需要重新生成了 `dist/` 与 `src-tauri/target/` 构建产物）。本文结论区分「代码证据」「自动化验证」「文档宣称」「未验证」四类，文档数字不再直接当作结论依据。

---

## 0. 结论摘要

1. **项目已不是"模板阶段"**：从 v1.0 基础架构推进到「v1.1 三栏阅读架构 + 阶段 2A/2B 结构化解析预览 + PDF 云端解析服务」，阅读、选区高亮、伴读卡片、详情追问、记录本、配置工作区、PDF 解析任务等主链路都有真实实现，生产代码中 **0 处 TODO/FIXME**。
2. **自动化层面健康**：本轮实测前端 **12 个套件 / 123 项全部通过**、Rust **82 项全部通过**、生产构建 **exit 0（TypeScript 0 错误）**。与 2026-10-18 文档宣称一致（个别旧文档数字已过期，见 §6）。
3. **全部新工作仍未提交**：工作区为 `16 个已跟踪文件修改（+5751/−228）+ 21 个未跟踪文件`，跨越 10-17 的 2B 与 10-18 的解析服务两个阶段；仓库只有 2 个 commit。
4. **验证进度明显落后于实现**：2A/2B/解析服务只在 JSDOM + mock IPC + 本地 mock HTTP 上验证过；**真实 Tauri 桌面、真实 PDF、真实 MinerU/Datalab Token、真实大文件与百万字场景均未联调/验收**（文档自己也如此标注）。
5. **最大产品缺口**：结构化重排视图目前是"只读"的——重排模式下 Ask 输入框被禁用（`src/App.tsx:2519`），`选区→锚点→卡片` 只在原版文本/PDF 视图成立；预览与重排都无虚拟化，且硬限制 2000 块（`src/utils/parsedDocumentLoader.ts:14`）。第二阶段确认需求还有 2 项未做：记录本移到顶部「当前文档记录」、阅读区底部参数状态栏（全仓无对应文案/代码）。第三阶段基本未开始。
6. **粗略进度判断**（启发式，按已确认需求与代码/验证覆盖加权，不是精确度量）：**功能实现约 75%，可发布完成度约 55–60%**。差距主要来自真实验收、两条二阶段遗留项、第三阶段与性能/安全加固。

---

## 1. 项目概况

### 1.1 产品与定位

FlowRead 是 Windows 桌面阅读与 AI 伴读软件：支持 PDF、TXT、Markdown、EPUB；提供原文选区、高亮、伴读卡片、详情与追问、记录本、工作区与配置管理。2026-10-17/18 新增「PDF 云端解析（MinerU / Datalab Convert）→ 结构化文档 → 流式重排阅读」能力，并引入独立 Python 横向评测工具做服务商选型。

### 1.2 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19.1、TypeScript ~6.0、Vite 8、TanStack Virtual 3（虚拟列表）、PDF.js 6.4、KaTeX + remark/rehype（Markdown/公式渲染） |
| 桌面 | Tauri 2、Rust edition 2024（本机工具链 1.101 nightly） |
| 后端 | rusqlite 0.33（SQLite，WAL）、reqwest(rustls)、tokio、zip、sha2、base64、regex、epub、html2text |
| 凭据 | `keyring` 3（`windows-native`）→ Windows Credential Manager；伴读模型 API Key 仍在 localStorage |
| 发布 | release profile：`lto=true`、`opt-level=3`、`panic="abort"`、`strip=true` |

### 1.3 代码规模（本轮实测，物理行数）

| 区域 | 规模 | 说明 |
| --- | --- | --- |
| 前端 `src/` | **约 3.2 万行**：TS/TSX 56 文件 27,999 行（生产 18,097 / 测试 9,902）+ CSS 4 文件 4,031 行 | App.tsx 2,728 行为最大单文件 |
| Rust `src-tauri/src/` | **13,393 行 / 12 文件** | 含内联测试与 `parse_jobs/tests.rs`（1,689 行） |
| 文档 | 4 篇阶段文档 796 行 + `PROJECT_CONTEXT.md` 165 行 + README 11 行 | 见 §6 |
| 工具 `tools/pdf-parse-eval/` | Python 约 4,400 行 + 23 项离线测试 | MinerU/Datalab 解析质量横向评测，未进入发布包 |
| 自动化测试 | 前端 123 项（12 套件）+ Rust 82 项 + 评测工具 23 项（后者本轮未运行） | 运行结果见 §4 |

最大文件：`App.tsx`(2,728)、`db.rs`(3,377)、`parse_normalize.rs`(2,231)、`parsed_workspace.rs`(2,066)、`parse_jobs.rs`(1,751)、`parse_jobs/tests.rs`(1,689)、`ReaderArea.tsx`(1,403)、`FullAnswerModal.tsx`(1,216)、`RightCompanionPanel.tsx`(1,203)、`PDFReaderArea.tsx`(1,183)。

### 1.4 仓库状态

| 项 | 状态 |
| --- | --- |
| 分支 | `Prepare1`（另存 `workbuddy/prepare1-b12560fa`、`origin/Prepare1`）；`main` 停在 v1.0 |
| commit | 2 个：`8af51c2` v1.0 基础（89 文件 +16,137）；`3f62726` v1.1 + 阶段 2A（74 文件 +27,895/−1,417，10-16） |
| 未提交修改 | 16 个已跟踪文件 +5,751/−228（`docs/PARSED_PREVIEW_NOTES.md`、`Cargo.toml/lock`、`db.rs`、`lib.rs`、`parsed_preview.rs`、`App.tsx`、`ParsedBlock/ControlledContentRenderer`、`recordStorage` 等） |
| 未跟踪 | 21 个：3 篇解析文档、10 个 Rust 解析服务文件/夹具、9 个前端解析 UI/工具/测试文件（含 2B 的 `ParsedReflowReaderArea.tsx`、`parsedReadingPreferences.ts`） |
| 工作树特点 | 2B 与解析服务改动**混在同一批文件**中（`App.tsx`、`db.rs`、`lib.rs`、`docs/PARSED_PREVIEW_NOTES.md` 同时含两阶段内容），无法按文件干净拆分提交 |

---

## 2. 整体架构

### 2.1 分层结构

| 层 | 关键文件 | 职责 |
| --- | --- | --- |
| 应用编排 | `src/App.tsx` | 全局状态与打开文档身份、导航/打开代次、解析任务跟踪与终态处理、预览会话、双视图切换、卡片/高亮/工作区弹窗编排 |
| 阅读与渲染 | `ReaderArea.tsx`、`PDFReaderArea.tsx`、`PDFPage.tsx`、`pdfTransport.ts` | 文本虚拟化滚动/切片/选区/高亮；PDF 范围流分页加载、文本层、跨页选区→PDF 坐标、框选裁图 |
| 结构化解析视图 | `ParsedDocumentPreview.tsx`、`ParsedBlock.tsx`、`ControlledContentRenderer.tsx`、`ParsedReflowReaderArea.tsx`、`parsedDocumentLoader.ts`、`parsedReadingPreferences.ts` | blocks.json 校验/资产加载/受控渲染（Markdown+KaTeX+HTML 过滤）；流式重排阅读、位置记忆、版本隔离 |
| 伴读与 AI | `RightCompanionPanel.tsx`、`CompanionCardItem.tsx`、`FullAnswerModal.tsx`、`ConnectionLinesOverlay.tsx`、`FiveLineClampedView.tsx`、`AIPanel.tsx` | 跟随视图/记录本、五/两行小卡、流式生成、详情与追问、翻译/公式/图表按需功能、锚点卡片连线 |
| 服务与工具 | `parserService.ts`、`aiDispatcher.ts`、`recordStorage.ts`、`translationManager.ts`、`aiConfig.ts`、`promptConfig.ts`、`themeManager.ts`、`workspaceManager.ts`、`textDocumentManager.ts`、`textAnchorIndexer.ts`、`sourceAnchorUtils.ts` | 解析任务 IPC+轮询、AI 2 并发队列与 SSE、SQLite/资产/分页、语言与配置签名、主题/提示词/工作区、文本切片与锚点索引 |
| IPC 边界 | `src-tauri/src/lib.rs` | 注册 **42 个 Tauri 命令**：db 24、parse 10、文件 3、preview 3、workspace 2；**全部为同步命令**（流水线在后台 worker 运行） |
| Rust 数据层 | `db.rs`(3,377) | 13 张表、索引、幂等迁移、24 个 CRUD 命令 |
| Rust 解析管线 | `parse_jobs.rs` + `parse_jobs/tests.rs`、`parse_providers/{mod,mineru,datalab}.rs`、`parse_normalize.rs`、`parse_settings.rs`、`parsed_workspace.rs`、`parsed_preview.rs` | 9 阶段任务状态机、检查点恢复、provider 客户端与错误分类、归一化、工作区版本导入、只读预览会话 |

### 2.2 三条核心闭环

1. **阅读/伴读闭环**：打开文档 → 文本切片与锚点索引（或 PDF 坐标）→ 选区工具条 → 锚点/高亮（复用去重）→ 卡片创建 → `aiDispatcher` 流式主回答 → 小卡片五行/两行 → 详情与追问 → SQLite/本地资产 + 游标分页。
2. **PDF 云端解析闭环**：导入 PDF → `parse_job_start` → 后台 worker（preparing/submitting/uploading/processing/downloading/normalizing/importing）→ 归一化为 blocks.json + 资产 → 版本登记与激活（同一事务）→ 前端轮询到终态 → 打开原版 PDF 并自动切流式重排（受 6 条防抢视图规则约束）。
3. **解析产物手动闭环**：选择 blocks.json/目录 → `parsed_workspace_import_dir`（staging → 原子 rename、安全拷贝、缺图即失败、2000 块/50MB 上限）→ 版本激活 → 只读预览或双视图切换 → 位置记忆（按 document+revision+version 隔离）。

### 2.3 数据模型与持久化

- **SQLite 13 表**：`schema_migrations`、`documents`、`source_anchors`、`cards`、`card_turns`、`card_function_results`、`card_function_versions`、`highlights`、`assets`、`reading_preferences`、`parsed_document_versions`、`app_settings`、`parse_jobs`。
- 关键约束：`PRAGMA WAL` + `busy_timeout=5000` + `foreign_keys=ON`；`documents` 级联删除；单文档单激活版本部分唯一索引；`parse_jobs.version_id` 部分唯一索引。迁移为幂等 DDL + `PRAGMA table_info` 补列（`db.rs:284`、`db.rs:404-411`、`db.rs:490-494`）。
- **localStorage**：模型 Profile（**含明文 API Key**，`aiConfig.ts:69`）、全局阅读偏好、提示词配置、工作区树、解析阅读态 `flowread_parsed_reading_state_v1`、伴读栏宽度。
- **凭据**：解析服务 Token 存 Windows Credential Manager（服务名 `flowread_parse_provider`，写入/清除后回读校验，不落 SQLite、不回传前端）；伴读 AI Key 仍是 localStorage 明文。

---

## 3. 进度评估

### 3.1 开发时间线（据 commit + 文件修改时间）

| 时间 | 阶段 | 产出 |
| --- | --- | --- |
| 10-12 | v1.0 基础架构 | `8af51c2`：89 文件 +16,137 行 |
| 10-13 | 第一阶段修复与交接 | `PROJECT_CONTEXT.md`：第一阶段自动化通过（当时 8 套件 44 项、Rust 12 项） |
| 10-14~16 | 三栏布局 + 阶段 2A 只读预览 | 三栏组件、ReaderMinimap（canvas）、FloatingAskBar、ParsedDocumentPreview、`tools/pdf-parse-eval`；10-16 提交 `3f62726` |
| 10-17 | 阶段 2B 隐式工作区/双视图 | `parsed_workspace.rs`、`ParsedReflowReaderArea.tsx`、位置记忆、db 版本激活约束、`PARSED_PREVIEW_NOTES` 重写（未提交） |
| 10-18 | PDF 云端解析服务 | 后端 parse_jobs/providers/normalize/settings；前端解析设置/导入/任务面板与 tracker；3 篇新文档（全部未提交） |

### 3.2 阶段完成度矩阵

| 阶段/需求块 | 状态 | 证据与说明 |
| --- | --- | --- |
| v1.0 基础（打开/阅读/翻译/卡片/存储/PDF 生命周期） | **已实现（自动化）** | 其余 56 项前端回归用例（123 − 2A/解析 67）+ 相关 Rust 用例通过；真机体验仍待验收 |
| 第一阶段真机验收 | **未验证** | `PROJECT_CONTEXT.md`§2/§8 与所有阶段文档均标"待人工验收" |
| 第二阶段三栏布局/视觉 | **大部分实现（约 70%）** | 左 minimap（canvas，非 DOM 克隆）、中阅读区+底部 Ask、右卡片画布、可拖分栏宽度持久化、详情 16:10、小卡五行/两行规则均已实现；**"记录本移到顶部『当前文档记录』"未实现**（全仓无该文案，右栏仍保留"记录本"页签 `RightCompanionPanel.tsx:840`）；**"参数状态栏"未实现**（全仓无对应文案/代码）；视觉统一需真机确认 |
| 阶段 2A 只读解析预览 | **已实现** | `parsed_preview.rs`、`ParsedDocumentPreview`、受控渲染/资产/公式；`parsedDocumentPreview.test.tsx` 40 项通过 |
| 阶段 2B 隐式工作区/双视图/位置记忆 | **已实现（自动化）** | `parsed_workspace.rs` 19 项 Rust 用例；`parsedReadingPreferences`、版本隔离、位置恢复；`pdfParseFlow.test.tsx` 覆盖自动打开/切书不抢回 |
| PDF 云解析 MinerU/Datalab | **代码完成，联调未开始** | 10 IPC 全注册、前后端 DTO 对齐、82 项 Rust 离线测试；真实 Token/真实云端/真实桌面未验证 |
| 第三阶段（空白导入、恢复上次文档、提示词草稿、卡片自动主回答、统一持久化） | **基本未开始** | 默认介绍页仍在（8 处 `default_reading_intro` 引用）；无草稿键、无恢复上次文档逻辑、无主回答自动生成代码 |

### 3.3 未提交工作树构成（21 个未跟踪文件）

- 文档 3：`PARSE_CONTENT_FIXES.md`、`PARSE_SERVICE_API.md`、`PDF_PARSE_USER_FLOW.md`。
- Rust 解析服务 10：`parse_jobs.rs`、`parse_jobs/tests.rs`、`parse_normalize.rs`、`parse_providers/{mod,mineru,datalab}.rs`、`parse_settings.rs`、`parsed_workspace.rs`、`tests/fixtures/datalab_null_markdown.json`。
- 前端 8：`parserService.ts`、`types/parserService.ts`、`parsedReadingPreferences.ts`、`PdfParseImportModal.tsx`、`ParserSettingsModal.tsx`、`ParseJobsPanel.tsx`、`PdfParseFlow.css`、`pdfParseFlow.test.tsx`；另有 `ParsedReflowReaderArea.tsx`（2B）。
- 已跟踪文件修改 16：App/db/lib/parsed_preview/2A 组件与测试/`recordStorage`/文档/Cargo 依赖。

**提交建议**：由于 `App.tsx`、`db.rs`、`lib.rs`、`PARSED_PREVIEW_NOTES.md` 同时包含 2B 与解析服务改动，按文件无法干净拆分；可接受两种策略——(a) 用 `git add -p` 按 hunk 拆成 "2B" 与 "PDF parse service" 两个逻辑 commit；(b) 若追求低风险，先整体提交一条带详细说明的 commit，再在后续迭代中整理历史。

### 3.4 粗略进度判断

| 维度 | 估计 | 依据 |
| --- | --- | --- |
| 已确认需求的功能实现 | **约 75%** | 三阶段需求中前两阶段+2A/2B 基本落地，解析服务代码完成；第三阶段未开始 |
| 可发布/可交付完成度 | **约 55–60%** | 真实联调与真机验收为 0；两条二阶段必做项缺失；性能/安全加固未做 |
| 自动化测试覆盖 | **较好** | 123 + 82 项全过，关键竞态/状态机覆盖充分；但真实环境与部分 UI 规则无测试 |

---

## 4. 本轮验证结果（2026-10-18 实测）

### 4.1 实际运行

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 前端全量测试 | `npm test` | **12 个套件 / 123 项通过，exit 0**（约 25.4s；`parsedDocumentPreview` 40、`pdfParseFlow` 27、`phase1RealRegression` 22、`jumpPositioningRegression` 8、`performanceAndTextBenchmark` 5、`regressionOmissions` 5、`threeColumnMinimapLayout` 4、`aiDispatcherCancellation` 3、`layoutAndPositioning` 3、`detailModalStateAndTurns` 2、`notebookLifecycleAndPagination` 2、`unifiedCardDeletion` 2） |
| Rust 全量测试 | `cargo test --manifest-path src-tauri/Cargo.toml` | **82 项通过，0 failed / 0 ignored，exit 0**（增量编译 18.6s + 测试 1.0s） |
| 前端生产构建 | `npm run build`（`tsc && vite build`） | **exit 0，TypeScript 0 错误**；产物 `index-*.js` 1,783.61 kB（gzip 537.59 kB）、CSS 318.77 kB（gzip 60.96 kB）、`pdf.worker` 2,229.71 kB、KaTeX 字体若干；仅既有的 **>500 kB 分包体积警告** |

### 4.2 验证性质（不可混淆）

- **前端**：JSDOM + mock IPC + mock PDF.js，部分用例用可控 Promise/`ResizeObserver`/`scrollTop` 模拟时序；**不能**证明真实 Tauri 序列化、真实 WebView、真实 PDF 渲染、真实图片解码、GPU/DPI 与滚动手感。
- **Rust**：真实临时文件系统、真实 SQLite 文件/事务、本地 TCP mock 服务；**没有访问 MinerU / Datalab 真实接口**；原生凭据用例使用独立临时服务名与假值，未验证重启后持久性。
- **未执行**：`npm run tauri dev` 桌面交互、真实 PDF 解析、真实 Token 提交/上传/轮询/下载、数百 MB 大文件吞吐与内存、百万字/万级记录真机性能。

### 4.3 文档宣称 vs 实测

| 文档 | 宣称 | 实际核对 |
| --- | --- | --- |
| `PARSE_CONTENT_FIXES.md` §四 | 12 套件 123 项、Rust 82 项、build exit 0 | **一致**（本轮复现） |
| `PDF_PARSE_USER_FLOW.md` §四 | 12 套件 123 项、Rust 82 项、build exit 0 | **一致**；且正确标注"全部为 mock IPC" |
| `PARSE_SERVICE_API.md` | 抬头"离线测试 72 项通过"，§七"82 passed" | **自相矛盾**，应以 82 为准（本轮实测 82） |
| `PARSED_PREVIEW_NOTES.md` | 11 套件 95 项、Rust 32 项（10-17） | **已过期**；当前 123 / 82 |
| `PROJECT_CONTEXT.md` | 8 套件 44 项、Rust 12 项（10-13）；三栏布局列为未实施 | **已过期**；三栏已在 10-16 提交 |

---

## 5. 质量评估

### 5.1 做得好的部分

- **解析管线设计成熟**：9 阶段状态机；取消与入库使用同一条 SQL 条件更新做互斥；`submission_unknown` 防重复提交（提交意图先落盘，结果不明绝不重新 POST）；按检查点恢复（normalized/raw 产物完整时无需联网/凭据）；版本登记与任务成功同事务回滚；固定 `ver_<job_id>` 避免重复版本。对应 24 项 `parse_jobs` 测试含 mock HTTP 全链路。
- **安全护栏较全**：ZIP Slip/路径穿越/软链接拦截、图片引用歧义精确报错、跨域重定向不转发凭据、文件/包/JSON/图片体积上限、预览路径 canonicalize、keyring 写入/清除回读校验。
- **异步竞态防御**：打开序号、解析操作代次、视图手动代次、任务 `update_seq`、终态去重、迟到会话释放；前端 123 项中大量是竞态/回归用例。
- **数据层**：单激活版本部分唯一索引、事务化激活、级联、复合游标分页、WAL。
- **文档纪律**：阶段文档能明确区分"真实执行/模拟执行/未验证"，这在同类项目中较少见。

### 5.2 主要风险与技术债（按严重度）

| 级别 | 领域 | 问题 | 证据 |
| --- | --- | --- | --- |
| **高** | 安全 | CSP 为 `null`；预览/导入命令接受前端任意本地路径并回传大 JSON，放大 XSS/路径面 | `src-tauri/tauri.conf.json:21`；`parsed_preview_open`、`parsed_workspace_import_dir` |
| **高** | 安全 | 伴读模型 API Key 明文存 localStorage | `src/utils/aiConfig.ts:69` |
| **高** | 性能 | 42 个 IPC 全为同步命令：`parse_job_start` 在主线程做整文件 SHA-256、`db_save_asset` 直接写盘、workspace 导入持 DB 锁做 50MB 读+目录复制 → 大文件/大解析包时 UI 卡顿、DB 串行 | `parse_jobs.rs:1420`、`db.rs:1475`、`parsed_workspace.rs:1088` |
| **高** | 可靠性 | 迁移无版本记录（`schema_migrations` 只建不写），`ALTER`/唯一索引失败被 `let _ =` 静默吞掉，旧库可能带脏数据启动 | `db.rs:284`、`db.rs:404-411`、`db.rs:490-494` |
| **中** | 性能 | 预览/重排全量渲染无虚拟化 + 2000 块硬上限；raw_json/raw_node 双份驻留；Blob URL 全量缓存至 dispose | `parsedDocumentLoader.ts:14`、`ParsedReflowReaderArea.tsx` |
| **中** | 性能 | 万级记录：前端 `allRecords` 全量累积、每个流式 delta 全表 map；连线层每次滚动逐卡 `getBoundingClientRect` | `RightCompanionPanel.tsx`、`ConnectionLinesOverlay.tsx` |
| **中** | 正确性 | AI 请求无超时/重试；取消写库（interrupted）与 500ms 节流写并发，可能晚到覆盖中断态 | `aiDispatcher.ts:400`、`:153-177`、`:391-393` |
| **中** | 正确性 | 资产 ObjectURL LRU(30) 直接 revoke、无引用计数，>30 张已挂载缩略图可能失效 | `recordStorage.ts:157-165` |
| **中** | 正确性 | `applyActiveParsedWorkspaceForDoc` 把异常与"无版本"都返回 `"missing"`，掩盖真实错误；多处空 `catch {}` | `App.tsx:1900-1901`、`:1930` |
| **中** | 磁盘 | 成功任务的快照/raw 产物不清理（仅取消时清理），长期膨胀 | `parse_jobs.rs:1567-1579` |
| **中** | 稳定性 | 全局 `Mutex.lock().unwrap()` + release `panic="abort"`：一处 panic 退出整个应用 | `parse_settings.rs:123` 等、`Cargo.toml` |
| **低** | 可维护性 | `App.tsx` 2,728 行、5 类异步代次；`ReaderArea`/`PDFReaderArea` 4 段重复逻辑；`App.css` 2,650 行且有覆盖式重复定义 | `App.tsx`、`App.css` |
| **低** | 可维护性 | 死代码/重复：`AIPanel.tsx` 独立 SSE 路径已无引用、`db_get_asset` 前端未用、workspace 两个导入函数约 200 行重复、多处 `as any` | 见相关文件 |
| **低** | 安全 | provider 错误信息可能携带响应体并写入 `error_message` 展示，未脱敏 | `mineru.rs:194-198` |
| **低** | 兼容 | 解析阅读位置表上限 200 条按时间淘汰；提示词 v1→v2 迁移；文档级语言覆盖强制继承全局 | `parsedReadingPreferences.ts`、`promptConfig.ts:55` |

### 5.3 测试盲区

- 真实 Tauri IPC 序列化/桌面 WebView/PDF.js 真实渲染/Worker。
- 真实云端 MinerU/Datalab（提交、上传、轮询、下载、错误码、真实 Token 持久性）。
- EPUB 真实解包、`read_local_file`/`read_file_chunk` 边界、IPC 命令封装层、MinerU 客户端单测、迁移失败路径、worker 调度并发。
- 前端：五行/两行截断规则本身、FloatingAskBar（含中文输入法）、三个设置/工作区弹窗、资产 LRU、连线层大量卡片性能、AI 超时、万级记录真压测。
- 大文件（数百 MB PDF/ZIP、1.2M 字文本）端到端吞吐与内存曲线。

---

## 6. 文档一致性

| 文档 | 日期/状态 | 问题 |
| --- | --- | --- |
| `README.md` | 10-11 已提交 | 仍是 Tauri 模板文案，未链接 4 篇阶段文档 |
| `PROJECT_CONTEXT.md` | 10-13（10-16 随 v1.1 提交） | **过期**：44/12 测试数字；三栏布局被列为"尚未实施"；未覆盖 2A/2B/解析服务 |
| `docs/PARSED_PREVIEW_NOTES.md` | HEAD 版 122 行（2A）；工作区版 201 行（2A/2B，+179/−100） | 测试数字 95/32 过期；§四把 `parsed_workspace.rs` 标"修改"，实为未跟踪新文件 |
| `docs/PARSE_SERVICE_API.md` | 10-18 未跟踪 | "72 项"与"82 passed"自相矛盾；其余契约描述与代码一致 |
| `docs/PARSE_CONTENT_FIXES.md` | 10-18 未跟踪 | 与实测一致，质量高 |
| `docs/PDF_PARSE_USER_FLOW.md` | 10-18 未跟踪 | 与实测一致，明确标注 mock/未验证 |
| `tools/pdf-parse-eval/README.md` | 10-16 已提交 | 独立评测工具说明，未在根 README 中索引 |

---

## 7. 下一步建议（按优先级）

### P0 — 发布前必须做（先验证，再决定功能投入）

1. **真实桌面验收**：`npm run tauri dev`，按 `PARSED_PREVIEW_NOTES.md`§六 9 项与 `PDF_PARSE_USER_FLOW.md`§五 9 步执行，重点：大文件打开/滚动、双视图切换与位置恢复、缩放/DPI、卡片回到原文、图片/公式渲染。
2. **真实云端联调**：小体积 PDF × MinerU 与 Datalab 各一轮，验证凭据保存/回读、上传轮询、真实错误码、`submission_unknown`、取消/继续/重新解析；确认 Token 不出现在日志。
3. **安全加固**：设置 CSP；预览/导入限定应用数据目录或用户选择目录；资产读取加上限；伴读 API Key 迁移到 keyring；错误信息脱敏。
4. **迁移可靠性**：`schema_migrations` 写入版本号；`ALTER`/索引失败显式上报；补旧库升级回归测试。

### P1 — 工程化与性能

5. **整理工作树并提交**：按 §3.3 建议拆分/提交；同步 `PROJECT_CONTEXT.md`（阶段性重写或标注被取代）、更新 `PARSED_PREVIEW_NOTES` 数字、修正 `PARSE_SERVICE_API` 72→82、README 补文档索引。
6. **IPC 重 IO 移出主线程**（async / `spawn_blocking`）；成功任务产物清理与磁盘配额；worker 并发与退避；轮询间隔调整。
7. **AI 稳定性**：请求超时/重试、写库 genId 校验（防中断态被旧写覆盖）、资产 URL 引用计数、万级记录前端增量更新与性能基准。

### P2 — 功能补齐

8. **重排视图打通"选区→锚点→卡片"**（需要 block→source 映射 schema）；预览/重排虚拟化并解除 2000 块上限、改为分页/懒加载。
9. **第二阶段遗留**：记录本移到顶部「当前文档记录」；阅读区底部参数状态栏；菜单/卡片/设置视觉统一真机确认。
10. **第三阶段**：空白导入状态、恢复上次文档与位置、提示词草稿、卡片创建后自动生成主回答、持久化统一梳理。

### P3 — 清理与优化

11. 死代码清理（`AIPanel`、`db_get_asset`、重复导入函数、未用 prop）；拆 `App.tsx`、抽公共 hook、去重 `App.css`。
12. 代码分割（KaTeX/PDF.js 动态 import）解决 >500 kB 警告；PDF.js `cleanup()` 异步拒绝处理；错误日志结构化。

---

## 8. 总体结论

FlowRead 已经从原型走到了**功能覆盖较完整的 v1.1+ 形态**：阅读与伴读主链路、结构化解析预览、隐式工作区、PDF 云端解析管线都有真实代码与较扎实的离线测试（前端 123 + Rust 82 = 205 项本轮实测全过；评测工具 23 项未运行）。后端解析管线的状态机/恢复/幂等/安全护栏达到中上水准，文档对"已验证/未验证"的区分也很克制。

但当前状态的本质是**"实现跑在验证前面"**：所有 10-17/10-18 成果未提交，2A/2B/解析服务均未经过真实桌面与真实云端；重排视图仍是只读原型（无法选区提问/建卡），第二阶段还有 2 项确认需求未落地，第三阶段尚未开始；同时存在同步 IPC 重 IO、迁移静默失败、CSP/明文 Key 等发布前风险。

因此建议的顺序是：**真实验收与安全/迁移修复（P0）→ 提交与文档同步（P1）→ 性能与 AI 稳定性（P1）→ 重排交互与二/三阶段功能（P2/P3）**，不要在未完成真机验收前继续扩大功能面。

---

## 附录 A：关键文件地图

| 领域 | 文件 |
| --- | --- |
| 应用编排/状态 | `src/App.tsx`、`src/main.tsx` |
| 文本阅读/选区/锚点 | `src/components/ReaderArea.tsx`、`src/utils/textDocumentManager.ts`、`textAnchorIndexer.ts`、`sourceAnchorUtils.ts` |
| PDF 阅读 | `src/components/PDFReaderArea.tsx`、`PDFPage.tsx`、`src/utils/pdfTransport.ts` |
| 结构化解析预览/重排 | `src/components/ParsedDocumentPreview.tsx`、`ParsedBlock.tsx`、`ControlledContentRenderer.tsx`、`ParsedReflowReaderArea.tsx`、`src/utils/parsedDocumentLoader.ts`、`parsedReadingPreferences.ts`、`src/types/parsedDocument.ts` |
| 伴读卡片/AI | `src/components/RightCompanionPanel.tsx`、`CompanionCardItem.tsx`、`FullAnswerModal.tsx`、`ConnectionLinesOverlay.tsx`、`FiveLineClampedView.tsx`、`src/utils/aiDispatcher.ts`、`translationManager.ts`、`aiConfig.ts` |
| 存储/设置/工作区 | `src/utils/recordStorage.ts`、`promptConfig.ts`、`themeManager.ts`、`workspaceManager.ts`、`src/types/records.ts` |
| 解析 UI/IPC | `src/components/ParserSettingsModal.tsx`、`PdfParseImportModal.tsx`、`ParseJobsPanel.tsx`、`src/utils/parserService.ts`、`src/types/parserService.ts` |
| Rust 入口/数据层 | `src-tauri/src/lib.rs`、`db.rs`、`parsed_preview.rs` |
| Rust 解析管线 | `parse_jobs.rs`、`parse_normalize.rs`、`parse_settings.rs`、`parse_providers/`、`parsed_workspace.rs` |
| 测试 | `src/__tests__/`（12 套件 123 项）、`src-tauri/src/**/tests`（82 项）、`tools/pdf-parse-eval/tests/test_eval.py`（23 项） |
| 阶段文档 | `PROJECT_CONTEXT.md`、`docs/PARSED_PREVIEW_NOTES.md`、`docs/PARSE_SERVICE_API.md`、`docs/PDF_PARSE_USER_FLOW.md`、`docs/PARSE_CONTENT_FIXES.md` |

## 附录 B：验证命令与输出摘要

```powershell
# 前端测试：12 个套件 / 123 项通过
npm test

# 生产构建：TypeScript 0 错误，exit 0
npm run build
# dist/assets/index-*.js  1,783.61 kB │ gzip 537.59 kB
# dist/assets/index-*.css   318.77 kB │ gzip  60.96 kB
# dist/assets/pdf.worker-*.mjs  2,229.71 kB

# Rust 测试：82 项通过，0 failed / 0 ignored
cargo test --manifest-path src-tauri/Cargo.toml
```

## 附录 C：文档阅读顺序（给后续 AI/评审）

1. `PROJECT_CONTEXT.md`（产品背景与三阶段需求；注意测试数字已过期）
2. `docs/PARSED_PREVIEW_NOTES.md`（阶段 2A/2B 边界、断言、真机验收清单）
3. `docs/PARSE_SERVICE_API.md`（后端解析契约与状态机）
4. `docs/PDF_PARSE_USER_FLOW.md`（用户流程与前端实现、联调步骤）
5. `docs/PARSE_CONTENT_FIXES.md`（本轮缺陷修复与回归）
6. 本文（整体与进度、风险、优先级）
