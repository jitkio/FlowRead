# FlowRead PDF 云端解析：用户流程与前端实现说明

更新日期：2026-10-22  
责任范围：前端（`src/App.tsx`、`src/components/ParserSettingsModal.tsx`、`src/components/PdfParseImportModal.tsx`、`src/components/ParseJobsPanel.tsx`、`src/utils/parserService.ts`、`src/utils/parsedReadingPreferences.ts`、`src/types/parserService.ts`）  
状态：**任务进度与诊断收尾定点修改完成**（`ParseJobsPanel` 诊断入口独立、运行中任务可展开复制、时间与状态文案纠正；`pdfParseFlow.test.tsx` 增至 31 项全部通过；Rust 全量 104 项通过）。与 `docs/PARSE_SERVICE_API.md` 契约核对一致。真实桌面、真实 PDF 与真实 Token 仍待人工验收。

---

## 一、用户可见流程

### 1. 入口

| 菜单位置 | 入口 | 说明 |
| --- | --- | --- |
| 工作区 | 打开本地文件...（Ctrl+O） | 原有入口，保留 |
| 工作区 | **导入 PDF 并解析…** | 选择 PDF → 确认面板 → 上传解析 |
| 工具 | 模型配置中心 / 提示词工程配置 / 阅读外观 | 原有入口，保留；解析服务设置与本组配置完全独立 |
| 工具 | **PDF 解析服务设置…** | MinerU（API Token）与 Datalab Convert（API Key）分别配置凭据 |
| 工具 | **解析任务…** | 任务列表、进度、停止/继续/重新解析、查看结果 |
| 工具 | **解析当前 PDF…** | 仅当当前文档是本地 PDF 时出现 |

原有“导入/绑定解析结果到当前文档…”“打开解析结果预览…”与双视图切换保持不变。

### 2. 解析服务设置

- 两个独立区域：MinerU（API Token）、Datalab Convert（API Key）。
- 明确区分 Token 与 Key 标签，消除误导。
- 每个区域独立显示状态（`已配置（未验证）` / `未配置`）、独立保存或替换、独立清除；清除需要二次确认。
- 保存结果进行真实校验：只有回读校验成功（`credential_configured === true`）才提示保存成功，系统凭据保存失败或读取异常如实展示错误，绝不将保存失败冒充为成功。
- 输入框只用于**新增或替换**：已保存的 Token 不会回填到前端，空输入点击保存只提示“请输入 Token”，不会清除已有凭据。
- 默认厂家初始 MinerU，可切换；保存默认厂家与保存凭据是两个独立操作。

### 3. 导入 PDF 并解析

1. 选择 PDF（取消选择 → 零任务、零上传，不出现任何面板）。
2. 确认面板显示：文件名、路径、解析服务商（明确标注 MinerU API Token 或 Datalab Convert API Key）、该厂家配置状态、默认勾选的“完成后打开流式重排”。
3. 面板明确提示“文件将上传到所选解析服务商（MinerU / Datalab Convert）”。
4. 缺少凭据时主按钮不可用，可点“前往配置”打开设置；保存后回到本面板，**不会自动提交**。
5. 点击“上传并解析”后锁定本次 `source_path` / `provider`，按钮进入“正在提交…”，防止连击。
6. 任务身份以后端 `parse_job_start` 返回的 `document_id` / `source_revision` 为准；前端随后复用既有 `openDocument` 打开原版 PDF（同一路径只登记一本书）。
7. **复用已成功结果**：若后端命中已成功任务直接返回 `succeeded`，前端提示“已使用已有解析结果”（绝不显示“已提交，等待解析”），并在目标文档完成加载后自动打开流式重排。
8. 正常提交成功后关闭面板并显示轻提示“已提交《…》的解析任务”，可点“查看任务”进入任务面板。

未添加 OCR、语言、页范围等后端未实现的控件；首版使用两家已验证的默认配置。

### 4. 任务面板与运行反馈

- **标准阶段标识**：统一为 `排队`、`准备文件`、`提交`、`上传`、`服务商排队/解析`、`下载`、`整理内容`、`写入本地`、`完成`。
- **排队状态细分**：
  - 若后台检测到调度器异常（`scheduler_status === 'error'`），排队任务显示为 `排队（后台调度异常）`；
  - 若有其他任务正在执行，排队任务显示为 `排队（等待前一任务）`；
  - 其余显示为正常 `排队`。
- **后台健康异常横幅**：当调度器遇到数据库锁或列错误等异常时，面板顶部弹出醒目警告横幅，显示调度异常摘要与“复制诊断”按钮，不再把故障伪装成正常空转。
- **时间与阶段耗时**：
  - 显示最近更新时间（本地时间格式化）；
  - 活跃任务显示距最近更新耗时（例如 `距最近更新 12秒`，文案与 `now - updated_at` 含义精确一致，不误称为“当前阶段持续时间”）；终态任务显示全流程总耗时（例如 `总耗时: 1分30秒`）。
- **云端解析进度**：
  - 接收入库的 `completed_pages` / `total_pages`（如 MinerU `extract_progress`）；
  - 同一 processing 阶段页数变化时，后端递增 `update_seq`，前端跟踪器按序号接收并在面板实时从 `1/20` 刷新至 `6/20`；旧序号与重复序号严格拒绝；
  - 明确标注：`云端解析进度: X/Y 页（云端解析阶段进度，非全流程完成比例）`，不编造虚假百分比。
- **运行中查看/复制诊断与安全脱敏**：
  - **诊断入口全面开放**：诊断折叠框与“复制诊断信息”按钮从错误卡片中完全独立，`queued`、`uploading`、`processing`、`downloading` 等运行中任务均可直接展开与复制，无需等待任务报错；
  - **错误卡片语义校正**：仅在任务确实存在错误时显示错误卡片；未记录具体出错阶段时，标签规范标注为“当前状态: {parseStatusLabel(job.status)}”，绝不把 `failed` 或 `paused` 冒充为实际出错步骤；
  - **诊断报告字段完整**：
    - 任务 ID、文档名称、源文件路径、服务商；
    - 当前状态、更新序号；
    - 创建时间、最近更新、距最近任务更新、累计耗时；
    - 已解析页数/总页数（未知时明确标注，如 `3/15 页` 或 `未知`）；
    - 后台调度状态（`scheduler_status`，空值显示“未知”）、当前后台任务、后台任务阶段、最近后台活动（未初始化时显示“尚无活动记录”）；
    - 错误码（无时显示“无”）、错误摘要（无时显示“无”）；
    - 可否取消、可否继续、版本 ID；
  - **只读操作安全保证**：自动复用现有脱敏过滤（清除 Token、密码、防盗链签名 query 参数），展开与复制诊断为纯只读操作，绝对不触发解析启动、重试、继续或取消接口。
- `submission_unknown` 显示“暂时无法确认服务商是否受理本次任务…系统不会自动重新提交”；普通“继续”只发出 `parse_job_resume`，绝不会偷偷转换为 `parse_job_start`。
- `submission_unknown` 只在后端返回 `can_resume=true`（已有可靠远端 ID，可核查）时才出现“继续任务”；无论是否可继续，都提供**显式**“重新解析”（`force_new = true`，创建新任务），这是该状态下唯一会重新提交的入口。
- `can_cancel` 才出现“停止”；`failed` / `cancelled` / `submission_unknown` 出现“重新解析”。
- “停止”文案注明只停止本地跟踪，不代表服务商已终止处理或退回额度。
- 关闭面板、切换书籍都不会取消任务；列表分页（`next_cursor` → “加载更多”），不加载正文、大 JSON、图片或阅读 session。

### 5. 完成后的自动打开规则

自动切到流式重排需要**同时满足**：

1. 该任务是本会话提交的，且提交时勾选了“完成后打开流式重排”；
2. 当前仍停留在这本书（`document_id` 一致）；
3. 源版本一致（`source_revision` 与当前 `revision` 一致）；
4. 打开代次未被新的打开操作替换；
5. 用户在提交后**没有手动切换过视图**（`原版视图` / `流式重排` 均算手动操作）；
6. `parsed_workspace_get_active` 返回的版本与任务 `version_id` 一致（结果仍是激活版本）。

不满足时只显示轻提示：“《…》解析完成，可在‘解析任务’中查看结果或打开重排。”——包括“A 任务完成时用户已切到 B”和“用户已手动切回原版”两种情况，都不会抢回视图。

获取激活版本失败、或返回的版本不符时，迟到的阅读会话立即 `parsed_preview_close`，且不销毁当前正在使用的有效资产管理器，界面保留原有内容与原版入口。

### 6. 查看任务结果

- “查看任务结果”调用 `parse_job_result`，用返回的 `blocks_path` 复用既有只读预览器。
- 该预览**不提供“绑定到当前文档”**，避免把历史结果误绑到此刻另一本书。
- 仅当任务结果属于当前文档且仍是激活版本时，面板才出现“打开流式重排”。

### 7. 重启后的阅读体验

独立存储键 `flowread_parsed_reading_state_v1`（不覆盖旧阅读、伴读与解析设置）：

- 按 `document_id` 记住用户选择的 `original` / `reflow`；
- 按 `document_id + source_revision + version_id` 记住重排滚动位置；
- 滚动写入经 400ms 防抖，切书与卸载时 flush；快照携带完整文档身份，避免写到新书上；不依赖 `beforeunload`，也没有持续 `scrollTop` 回写；
- 新解析版本没有位置记录时从顶部开始；
- 重启后打开已绑定书籍，若上次选择重排且激活版本仍有效，恢复到该视图与位置；
- 若资源已不可用：回到原版并提示“上次使用的流式重排版本已不可用，已回到原版视图。”
- 原有“有限、可打断”的滚动恢复算法未改动（`ParsedReflowReaderArea.tsx` 本轮未修改）。

---

## 二、IPC 契约使用情况

所有解析 IPC 集中在 `src/utils/parserService.ts`，组件与 App 不直接 `invoke`。

| 命令 | 前端调用位置 | 说明 |
| --- | --- | --- |
| `parse_settings_get` | 打开设置 / 打开导入面板前 | 返回 `default_provider` 与两家 `credential_configured` |
| `parse_settings_save` | 设置弹窗切换默认厂家 | `{ request: { default_provider } }` |
| `parse_provider_set_token` | 设置弹窗保存/替换 | `{ request: { provider, token } }`，空 Token 不发送 |
| `parse_provider_clear_token` | 设置弹窗清除 | `{ request: { provider } }` |
| `parse_job_start` | 导入面板提交、重新解析 | `{ request: { source_path, provider, force_new } }` |
| `parse_job_get` | 跟踪器补齐列表缺失任务 | `{ jobId }` |
| `parse_job_list` | 跟踪器轮询、面板刷新、分页 | `{ request: { document_id: null, active_only: false, limit: 50, cursor } }` |
| `parse_job_cancel` | 面板“停止” | `{ jobId }` |
| `parse_job_resume` | 面板“继续任务” | `{ jobId }` |
| `parse_job_result` | 面板“查看任务结果” | `{ jobId }` → `{ document_id, source_revision, version_id, blocks_path, activated }` |
| `parse_service_health` | 跟踪器轮询健康状态、面板展示 | 无入参 → `ParseServiceHealthDto` |
| `parsed_workspace_get_active` | 自动打开、打开结果 | 复用既有命令，核对版本后接管会话 |
| `parsed_preview_open` / `parsed_preview_close` | 结果只读预览 | 复用既有命令；迟到会话立即关闭 |

**后端契约一致性说明**：已与 `docs/PARSE_SERVICE_API.md` 逐项核对完毕。11 个 IPC 命令名称、入参包装形式（`request` 结构体及顶层 `jobId`）、`ParseJobDto` 字段类型（包括 `progress_percent: number | null`、`update_seq: number`、`completed_pages`、`total_pages`）以及只读健康接口 `ParseServiceHealthDto` 均保持一致。

---

## 三、前端实现要点

### 1. 应用级单一任务跟踪器（`ParseJobTracker`）

- 约 2 秒轮询一次，`inFlight` 标志防止请求重叠；
- 记录本会话启动/继续的任务为 `tracked`；列表（`active_only: false`）里找不到且仍非终态时，单独 `parse_job_get`，避免任务完成瞬间从活动列表消失导致完成状态丢失；
- 按 `update_seq` 丢弃重复与乱序响应；
- 定期调用 `parse_service_health` 查询调度器健康状态（`scheduler_status`、`active_job_id`、`diagnostics`），并通过订阅模式驱动界面响应；
- 面板关闭后继续跟踪；启动时立即查询一次持久任务；卸载时 `stop()`；
- 任务内容与健康状态未变化时不重复通知，避免无意义重渲染。

### 2. 状态协调与竞态防御

- **异步代次严格固定**：
  - `applyActiveParsedWorkspaceForDoc` 在异步查询前固定 `docId`、`source_revision`、`openSequenceRef`（文档打开代次）、递增固定 `parsedOpSeqRef`（解析操作代次）以及 `viewModeManualSeqRef`（视图模式手动代次）；
  - 异步返回后，先行严格核验以上身份；若用户已切书、手动改视图、组件卸载或已被更新的手动导入接管，判定为失效响应（stale）；
  - 失效响应仅静默关闭自身新建的预览 session（`parsed_preview_close`），绝不调用当前活跃资产管理器的 `dispose()`，保护当前有效内容不被冲掉。
- **同版本短路与 Session 生命周期隔离**：
  - 无论后台完成或手动打开，若查询返回的版本与当前激活版本一致，不重复创建 `ParsedAssetManager`，释放本次查询新开且未接管的 session，并保留正在使用的现有 session。
- **终态去重按转换解绑**：
  - 废弃全局永久按 job_id 去重的做法，改用 `${job_id}:${version_id}` 针对成功事件去重，`${job_id}:${update_seq}` 针对失败事件去重；
  - 暂停/失败任务经“继续”恢复成功后，能正常触发一次完成处理与自动打开；重复的成功响应不会反复切换视图或重复查询。
- **复用历史成功结果即时就绪**：
  - 后端直接返回历史 succeeded 任务时，提示“已使用已有解析结果”（不显示“已提交，等待解析”）；
  - `openDocument` 返回 Promise 确保文档就绪，等待身份确立后再根据用户勾选意图执行自动打开，不依赖 `setTimeout` 盲猜。

### 3. 阅读状态持久化（`parsedReadingPreferences.ts`）

- `flowread_parsed_reading_state_v1`：`{ version, modes: {docId: mode}, positions: {"docId:revision:versionId": {top, updated_at}} }`；
- 位置条目上限 200，按更新时间淘汰；损坏数据回退为空结构，不抛错；
- `createReflowPositionWriter(400)`：`schedule` 只保留最后快照，`flush` 立即落盘，`cancel` 丢弃。

### 4. 本轮未改动

- `ControlledContentRenderer.tsx`、`ParsedBlock.tsx`、`ParsedReflowReaderArea.tsx` 的既有算法（由 Worker Body 负责）；
- 伴读模型配置（`SettingsModal.tsx` / `aiConfig`）的数据与功能；
- 原手动绑定 `blocks.json`、临时预览与双视图切换。

---

## 四、测试与构建（2026-10-22 统一验收实测）

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 前端全量测试 | `npm test` | **13 个套件，143 项全部通过（0 failed）** |
| 本模块前端测试 | `npm test -- src/__tests__/pdfParseFlow.test.tsx` | **31 项全部通过（0 failed）** |
| Rust 全量测试 | `cargo test --manifest-path src-tauri/Cargo.toml --offline` | **104 项全部通过（0 failed，0 ignored）** |
| 生产构建 | `npm run build`（`tsc && vite build`） | **exit 0**，TypeScript 0 错误；仅既有 >500 kB 分包体积警告 |

`src/__tests__/pdfParseFlow.test.tsx` 共 31 项：前 15 项覆盖界面与状态机（包含异常横幅、云端页数进度与脱敏诊断），后 16 项为可控异步回归与定点收尾测试。

后 16 项新增重点用例：
- 用例 14：跟踪器接收同状态递增序号的进度，面板从 1/20 更新到 6/20；重复和旧序号严格被拒绝；
- 用例 15：没有错误的运行中任务（processing/queued 等）可以正常展开与复制诊断，且不会调用解析启动接口（`onRetry`/`onResume`）；
- 用例 16：时间标签与实际数据含义一致，活跃任务明确显示“距最近更新”，不显示“当前阶段已持续”。

此外，`src/__tests__/parsedDocumentPreview.test.tsx` 保持核验 HTML 实体与 KaTeX 公式在 reader 中的真实展示效果。

前 15 项简介：

1. 两家凭据相互独立；空输入不清除、不回填；
2. 取消文件选择：零任务零上传；
3. 缺凭据 → 前往设置 → 保存后返回原面板，且不自动提交；
4. 提交绑定所选文件（不是当前书），原 PDF 复用 `openDocument` 登记；
5. A 任务完成时用户已切到 B：不抢回 A，只给轻提示；
6. 用户手动切回原版后，旧任务完成不得强制切重排；
7. 激活版本不符：迟到会话被释放，界面保留原视图；
8. 历史任务结果只读预览、无“绑定到当前文档”；
9. 关闭面板不取消任务；卸载后停止轮询；
10. 重启恢复重排视图与位置（350），新版本归零；
11. 跟踪器按 `update_seq` 丢弃乱序/重复响应、列表缺失时单独查询、请求不重叠；
12. 面板“继续任务”与“重新解析”区分、`submission_unknown` 只能显式重新解析、进度未知不编百分比；
13. 缺凭据时提交按钮不可用且不发请求；
14. 满足全部条件时自动切到重排、接管会话并按文档记住视图模式；
15. 任务面板展示排队细分、调度异常横幅、云端页数进度与可复制诊断（脱敏验证）。

### 测试性质（必须分别说明）

- **全部为 mock IPC**：`invoke` 与文件选择器均为测试桩，任务完成由测试数据驱动，**不代表真实后端已联通**。
- **未验证**：真实 Tauri IPC 序列化（字段名、可空、`request` 层级）、真实上传与轮询时序、真实 Token 的提交结果、真实服务商错误码文案、桌面 WebView 下的弹窗与滚动表现。
- 现有 12 个测试文件中的旧断言未删除、未弱化；`PARSED_READING_STORAGE_KEY` 在测试 `beforeEach` 中清理以保证用例隔离。

---

## 五、真实联调与人工验收步骤（待执行）

1. `docs/PARSE_SERVICE_API.md` 已提供并核对；真实联调前再按该文档确认 DTO 字段名与可空性。
2. `npm run tauri dev` 启动桌面端，进入“工具 → PDF 解析服务设置…”，分别填入 MinerU Token 与 Datalab API Key，确认状态变为“已配置（未验证）”。
3. 工作区 → 导入 PDF 并解析 → 选择一本小体积 PDF → 确认“文件将上传…”提示 → 上传并解析。
4. 观察任务面板：阶段推进、进度百分比是否来自后端真实值；中途关闭面板再打开，任务仍在。
5. 完成瞬间：若停留在同一本书且未手动切换视图，应自动进入流式重排；随后手动切回原版，再重开同一本书，应恢复上次视图。
6. 再启动一个任务，完成前切到另一本书：完成后只出现轻提示，不切回原书。
7. 失败场景：故意使用无效 Token，确认面板显示后端错误且原版 PDF 仍可阅读。
8. 重启应用 → 打开已绑定书籍：上次的重排视图与位置恢复；删除版本后应回到原版并提示。
9. 分页与历史结果：任务超过 50 条时“加载更多”；历史结果预览不出现“绑定到当前文档”。

> 上述步骤需要真实 Token 与可用后端，本轮未执行；在前端侧只能确认界面、状态机与 mock 流程。
