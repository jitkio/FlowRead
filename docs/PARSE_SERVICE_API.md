# FlowRead PDF 云端解析：后端服务契约与实现说明 (PARSE_SERVICE_API)

更新日期：2026-10-22  
责任范围：Rust 后端（`src-tauri/src/parse_settings.rs`、`src-tauri/src/parse_providers/`、`src-tauri/src/parse_normalize.rs`、`src-tauri/src/parse_jobs.rs`、`src-tauri/src/db.rs`、`src-tauri/src/parsed_workspace.rs`、`src-tauri/src/lib.rs`）  
文档状态：**任务进度与诊断收尾定点修复完成；受状态保护的原子进度更新（递增 update_seq、CAS 防迟到污染）；只读健康查询与阶段同步；离线测试 104 项全部通过（0 failed）。未做真实云端联调，未读取或使用任何真实 Token。**

> 本文只描述当前代码真实行为。未执行过的验证一律标注为“未验证”。

---

## 一、服务商与凭据

### 1. 服务商

标识严格为小写 `"mineru"` 与 `"datalab"`，其他值在入口处拒绝。

### 2. 系统凭据存储

- 依赖声明：`keyring = { version = "3", features = ["windows-native"] }`。**必须启用平台原生后端**，否则 keyring 3.x 会使用进程内 mock，导致每次新建 `Entry` 都读不到之前写入的密码。
- 服务名 `flowread_parse_provider`，账户名为厂家标识；Token 只写入操作系统凭据库，不落 SQLite、不落配置文件、不回传前端。
- **保存后回读校验**：写入成功后立即读取比对，不一致或读取失败都会返回错误，不会“只把 `credential_configured` 写成 true”。
- **清除后回读校验**：删除后再次读取，仍能读到则报错。
- **区分“未设置”与“读取失败”**：`get_provider_token` 返回 `Result<Option<String>, String>`；`Ok(None)` 才是未配置，读取故障向上传播并在界面/任务中给出不同提示（`ERR_CREDENTIAL_STORE`）。
- 空字符串/纯空白 Token 在写入前拒绝；清除必须走独立命令。

### 3. 凭据测试隔离

- 测试通过 `parse_settings::test_credential_store()` 返回的 **作用域守卫** 把全局后端替换为进程内实现，守卫内部持有一把串行锁，并在 `Drop` 时恢复原后端；并发用例不会互相污染，也不会触碰真实系统凭据。
- 原生存储验证：`test_native_windows_credential_roundtrip` 使用**独立临时服务名**（`flowread_parse_provider_native_test_<uuid>`）与假值，写入后用**另一个 Entry 实例**读回、清除、再确认读不到，最后清理该临时记录；不读写真实服务账户。环境不支持时会打印跳过说明并返回，不会把内存测试冒充为原生验证。

### 4. 未验证项

- 真实 Token 的保存/读取/清除未在本轮执行（政策禁止读取真实 Token）。
- 原生凭据测试只证明“写入后可跨 Entry 读回”，不证明 Windows 重启后仍存在（无跨进程/重启验证）。

---

## 二、任务状态机与并发规则

### 1. 状态

`queued / preparing / submitting / uploading / processing / downloading / normalizing / importing / succeeded / failed / cancelled / paused / submission_unknown`

- `progress_percent`：**只有在可以测量时才给值**；当前实现中中间阶段一律为 `null`（前端显示阶段文案），成功时为 `100`。不再用 5/15/30/50/70/85 等固定数字冒充进度。
- `completed_pages` / `total_pages`：接收入库 MinerU `extract_progress`（已完成页数/总页数），明确作为**云端解析阶段进度**展示，不作为全流程百分比。
  - **受状态保护的原子进度更新（`db::update_parse_job_progress`）**：
    - 仅当当前任务处于 `processing` 状态且 CAS 校验通过时才允许写入，执行一条原子 SQL：`UPDATE parse_jobs SET completed_pages = ?1, total_pages = ?2, update_seq = update_seq + 1, updated_at = ?3 WHERE job_id = ?4 AND status = 'processing' AND update_seq = ?5`；
    - 明确区分四种结果：`Updated(new_seq)`（递增 update_seq 并更新时间）、`NotProcessing`（任务已取消或离开 processing，停止轮询，不污染终态数据）、`NoChange`（页数无有效变化，不写库、不递增序号）、`Err`（写库失败显式报错，不吞异常）；
    - **内存同步时序**：仅在数据库更新成功后才同步内存记录中的 `completed_pages`、`total_pages`、`update_seq` 与 `updated_at`，杜绝“内存更新、写库失败后相同进度不再重试”的隐患；
    - **保留有效数据**：当服务商某次轮询未返回某个可选字段时（如仅返回 completed_pages 而 total_pages 为 None），优先回退保留已有有效值（`effective = st.field.or(job.field)`），绝不无故清空已有有效数值。
- `can_cancel`：`importing` 起为 0；`paused` 允许停止本地跟踪。
- `can_resume`：`paused` / `failed` / 有可靠远端 ID 的 `submission_unknown` 为 1。

### 2. 取消与入库的原子性

- 取消：`UPDATE parse_jobs SET status='cancelled' ... WHERE job_id=? AND status NOT IN ('importing','succeeded','cancelled')`，**一条 SQL 完成判定与写入**；返回是否真的取消。
- 入库执行权：`UPDATE ... SET status='importing' WHERE job_id=? AND status='normalizing'`，只有影响行数为 1 才继续。
- 因此：取消先成功 → 入库执行权必然拿不到，不会入库；入库先成功 → 取消返回 `importing` 的当前记录，`can_cancel=false`。
- 阶段推进同样是条件更新（`WHERE status NOT IN ('importing','succeeded','cancelled')`），旧 worker 不能把已取消/已成功的任务改回中间态。
- **检查点写入与状态转换分离**：`update_parse_job_checkpoint` 只更新快照/远端 ID/上传/下载/归一化等进度字段，绝不改写 `status`、`can_cancel`、`can_resume` 或终态；写入同时校验 `expected_status` 与 `update_seq`，不匹配即返回错误并停止当前执行（例如归一化完成后才发现任务已被取消，不会覆盖 `cancelled`）。
- 领取入库执行权失败时会区分：已取消 / 已有其它执行者 / 状态异常（后者转为可继续的 `paused`，不会静默停留在 `processing`）。

### 3. 恢复与检查点

`parse_jobs` 字段（包含 30 个数据库字段，统一由常量 `PARSE_JOB_SELECT_FIELDS` 维护投影）：

| 列 | 含义 |
| --- | --- |
| `snapshot_rel_path` | 私有快照相对路径（`input/source.pdf`） |
| `remote_submitted` | 是否已成功提交并拿到远端标识 |
| `upload_completed` | MinerU 直传是否完成 |
| `artifacts_downloaded` | 产物是否已完整下载/解压 |
| `normalized_ready` | 归一化是否完成 |
| `activation_baseline_version_id` | **任务创建时固定**的激活基准版本 |
| `submit_attempted` | **在发出首次提交请求之前**写入的提交意图；跨 `preparing/paused/queued` 等显示状态保留 |

- **出队入口与统一字段映射**：
  - 核心排查根因：原 `get_next_queued_job` 手写 `SELECT` 漏了第 30 列 `submit_attempted`，而 `map_parse_job_row` 读取 `row.get(29)` 越界，被 `.ok()` 静默吞掉变为 `None`，导致调度器永远读取不到排队任务。
  - 架构重构：引入共享常量 `PARSE_JOB_SELECT_FIELDS`，所有 5 处针对 `parse_jobs` 表的查询共享该标准列清单，彻底杜绝多处手写与列顺序漂移；
  - `db::get_next_queued_job` 改为显式返回 `Result<Option<ParseJobRecord>, String>`，只有真正无排队任务时返回 `Ok(None)`，SQL 错误、列映射异常或数据库锁故障必须显式向上传播。
  - 调度函数 `schedule_next_job_once` 明确区分三种状态：`QueueEmpty`（记录 idle）、`Busy`（执行中）、`QueueError(err)`（记录 error 状态及详细诊断到内存健康单例，供前端与健康检测实时获取），不静默空转，更不把排队任务批量误标为失败。
- **提交意图先落盘**：在发出首次提交请求之前写入 `submit_attempted=1`。该标记不随 `preparing/paused/queued` 等显示状态变化而丢失；恢复时只要 `submit_attempted=1 && remote_submitted=0`，一律进入 `submission_unknown`，**绝不重新 POST**。
- 明确未被受理的情况（认证拒绝、4xx）会清除 `submit_attempted`，回到可恢复的 `paused/failed`；网络超时、响应丢失、响应缺少任务 ID 等“可能已受理”的情况保留意图。
- 应用启动恢复分四种情况（均为幂等更新）：
  1. `submit_attempted=1` 且无远端 ID → `submission_unknown`（`can_resume=0`）；
  2. **迁移前**处于提交之后状态却无远端 ID 的旧记录 → 保守视为可能已受理；
  3. 迁移前 `paused` 且无法证明发生在提交之前（非凭据/认证原因）→ 同样保守处理；
  4. 其余中间态 → `paused`（`ERR_INTERRUPTED`，可继续）。
- **按检查点恢复**，不再每次先走完整远端流程：
  - `normalized_ready=1` 且产物通过校验（`blocks.json` 非空、引用的资产全部存在、路径合法）→ 直接进入本地入库，**不读取凭据、不访问云端**；
  - `artifacts_downloaded=1` 且 raw 产物可解析 → 直接本地归一化再入库；
  - 检查点为真但文件缺失/损坏 → 清除该检查点并记录诊断，回退到可恢复阶段（诊断会附加到暂停/失败信息中）。
- 原 PDF 不存在但私有快照有效时仍可继续；两者都没有且没有本地产物则 `ERR_FILE_NOT_FOUND`。
- 关键检查点写库失败会**中止流水线**；worker 收尾时若提交可能已被受理，转为 `submission_unknown` 而不是普通 `paused`。

### 4. submission_unknown

- 提交阶段按**结构化错误分类**（见第五节）判定：认证失败 → `paused`；明确未被受理 → `failed`；可能已受理/响应缺少关键标识 → `submission_unknown`。
- 没有可靠远端 ID 时：
  - `can_resume = 0`：前端不显示“继续任务”；
  - 普通“继续”即使被调用也会被拒绝，返回明确错误：*“暂时无法确认服务商是否已受理本次任务，普通‘继续’不会重新提交；如确认需要重试，请使用‘重新解析’创建新任务”*；
  - worker 内部还有一道安全网：即使状态被改成 `queued`，没有 `remote_submitted=1` 也不会重新 POST；
  - 前端提供**显式**“重新解析”（`force_new=true`）作为唯一重新提交入口。
- 有可靠远端 ID（`remote_submitted=1`）的 `submission_unknown`：`can_resume = 1`，可以继续（只查询，不提交）。

### 5. 任务身份与版本

- `version_id` 对任务固定为 `ver_<job_id>`；崩溃重试会复用同一版本号并清理同名残留目录，**不会产生第二个版本目录**。
- 版本登记与“任务成功”更新在**同一个 SQLite 事务**内：版本插入失败或任务条件更新失败都会整体回滚，并清理已发布的目录。
- `parse_job_result` 会反查该版本是否属于当前任务，关联异常时拒绝返回。

---

## 三、11 个 IPC（后端注册命令与契约）

所有命令注册于 `lib.rs`；前端统一用 `{ request: ... }` 包装，`jobId` 为顶层参数。

| 命令 | 入参 | 返回 | 本轮行为变化 |
| --- | --- | --- | --- |
| `parse_settings_get` | 无 | `ParseSettingsResponse` | 凭据读取失败会返回错误，而不是静默 `false` |
| `parse_settings_save` | `{request:{default_provider}}` | 同上 | 无 |
| `parse_provider_set_token` | `{request:{provider,token}}` | `ProviderTokenResult` | 写入后回读校验；`credential_configured` 取自真实读取结果 |
| `parse_provider_clear_token` | `{request:{provider}}` | 同上 | 删除后回读确认 |
| `parse_job_start` | `{request:{source_path,provider,force_new}}` | `ParseJobDto` | 去重限定在同文档+同路径；创建时固定激活基准；`progress_percent` 初始为 `null` |
| `parse_job_get` | `{jobId}` | `ParseJobDto` | 无 |
| `parse_job_cancel` | `{jobId}` | `ParseJobDto` | 先打断在途请求，再原子取消；成功取消后清理该任务的临时产物 |
| `parse_job_resume` | `{jobId}` | `ParseJobDto` | 只允许 `paused/failed/有远端 ID 的 submission_unknown`，否则返回明确错误 |
| `parse_job_list` | `{request:{document_id,active_only,limit,cursor}}` | `ParseJobListResponse` | 无 |
| `parse_job_result` | `{jobId}` | `ParseJobResultResponse` | 增加“版本必须属于该任务”的一致性校验 |
| `parse_service_health` | 无 | `ParseServiceHealthDto` | **本轮修正**：只读调度器健康状态（重复读取不刷新活动时间；真实阶段与活动时间同步；未初始化返回 0） |

### ParseJobDto（未变化）

```typescript
interface ParseJobDto {
  job_id: string;
  document_id: string | null;
  source_path: string;
  document_name: string;
  source_revision: string | null;
  provider: "mineru" | "datalab";
  status: ParseJobStatus;
  progress_percent: number | null; // 中间阶段为 null，成功为 100
  completed_pages: number | null;
  total_pages: number | null;
  version_id: string | null;
  activated: boolean | null;
  can_cancel: boolean;
  can_resume: boolean;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  update_seq: number;
}
```

### ParseServiceHealthDto（契约与只读语义）

```typescript
interface ParseServiceHealthDto {
  scheduler_status: "idle" | "busy" | "error";
  current_job_id: string | null;
  current_job_stage: string | null;
  last_scheduler_error: string | null;
  last_scheduler_error_at: number | null;
  last_heartbeat_at: number; // 毫秒时间戳；0 表示未初始化（尚无活动记录）
}
```

- **只读查询保证**：`parse_service_health`（`get_service_health()`）严格只读，多次调用绝不修改 `last_heartbeat_at`，杜绝“查询本身伪造后台心跳”。
- **活动时间真实驱动**：`last_heartbeat_at` 仅在真实后台调度（出队 `record_scheduler_busy`、阶段推进 `transition`、任务结束 `record_scheduler_idle`、捕获异常 `record_scheduler_error`）时推进，语义为“最近后台活动时间”，不将其描述为解析进度或完成保证。
- **阶段同步与任务收尾**：`current_job_stage` 随持久化成功的实际阶段推进（不再长期停滞在 `queued`，也不被其他任务覆盖）；任务完成或置为空闲时立即清空 `current_job_id` 与 `current_job_stage`。
- **未初始化显式值**：若后台尚未记录任何活动，`last_heartbeat_at` 为 0，前端统一显示“尚无活动记录”，不显示默认当前时间或伪造后台正常。

### 去重规则（`force_new=false`）

1. 只在**同一 document_id 且同一 source_path**内查找活跃任务，直接复用；
2. 成功任务复用前还要确认版本目录与 `blocks.json` 仍存在；
3. 相同字节但不同路径的文件会建立各自的任务与版本，不会返回另一本文档的任务；
4. `force_new=true` 始终创建新任务。

---

## 四、归一化与真实 Datalab 产物

### 1. 字段回退（真实产物关键修复）

真实 Datalab v2 的每个块都是 `markdown: null`，正文在 `html` 中。旧实现用 `get("markdown").or_else(get("html"))`，键存在但值为 null 时不会回退，导致正文全空。

现规则：按**有效字符串值**依次尝试 `markdown → html → content → text`，空字符串与 null 一律跳过；HTML 实体（`&amp;` 等）在进入 LaTeX 前解码。

### 2. 结构与内容

- 正文/标题/图注/表格：保留文本；`<math>` 转为 `$...$`；独立公式提取 `<math>` 内部为 `latex`。
- 图注块：`caption` 存纯文本，正文同样保留。
- 页信息：`page_sample`、`page_source`、`raw_bbox`、`normalized_bbox`（Datalab 使用页面 `bbox` 像素尺寸，无尺寸时为空而不是猜默认纸张）。
- 图内 OCR（`<p class="img-text">`）仍写入 `in_image_text`，不混入正文。

### 3. 失败页与有效内容

- `metadata.failed_pages` 非空 → **明确失败**：写出 `diagnostics.json`（含 `failed_pages`），保留原始产物，不生成 `blocks.json`，不激活版本。产品当前没有“部分成功”流程。
- 有效内容检查：既要求存在正文/图片类块，也要求至少有一个非空内容或带资产引用的图片块；**允许整页只有图片的正常文档**，但拒绝“块很多、内容全空”。

### 4. 外置 result_url

- 只有内联结果确实缺失（`markdown/html/json/children/pages` 均无有效内容）时才下载 `result_url`。
- 下载失败、HTTP 非 2xx、JSON 解析失败都会返回可定位错误，不再静默忽略。
- 重包装 `children` 时保留顶层 `metadata`、`failed_pages`、`status` 等诊断字段（`merge_result_metadata` / `build_result_json`）。
- 结果树中每个块的 `images` 会被**递归收集**并落盘；单张图片失败产生诊断（`download-warnings.json`），归一化阶段若该图被引用则明确失败。

### 5. 图片身份

- 收集阶段建立两张表：`相对路径 → 资产文件名`、`basename → [相对路径]`；SHA-256 只用于内容去重。
- 解析引用时：完整相对路径优先；只有 basename 且唯一才回退；**多个候选直接报歧义**，不会随便选一张。
- 同名不同内容会各自落盘并各自绑定；同内容不同路径共享同一资产。
- 图片仍跳过符号链接、拒绝绝对路径与 `..`；资产最终由工作区导入再次校验。

---

## 五、传输与安全

| 项目 | 实现 |
| --- | --- |
| PDF 上传 | `reqwest::Body::wrap_stream` 分块读取文件，Datalab multipart 使用 `Part::stream_with_length`；不整份读入内存 |
| ZIP / 图片下载 | 按 chunk 流式写入 `.part` 临时文件，校验大小上限后原子改名；失败删除临时文件 |
| 体积上限 | JSON 响应 8MB；外置结果 JSON 64MB；ZIP 512MB；单图 64MB |
| 超时 | 普通 API 60s；上传/下载 15min |
| 重定向 | 带凭据的 API 客户端**只允许同源重定向**，跨域直接报错；对象存储客户端不携带厂家凭据，允许最多 5 次重定向 |
| 连接复用 | worker 在单个任务管道执行周期内**复用 HTTP Client 连接池**，轮询与下载不反复重建 Client |
| 轮询容错 | 严格区分 401/403 认证拒绝（转 `ERR_AUTH_REJECTED`）、429 限流（解析 `Retry-After`，按上限退避）、5xx 临时错误（有限重试），不无故把远端任务判定为已完成或重复计费 |
| Datalab 状态守卫 | Datalab 查询响应 HTTP 非 200 或缺少明确 status 时**绝不默认成 processing**，而是解析错误或中断，避免隐蔽死循环 |
| 取消 | 任务层通过 `tokio::select!` 在取消信号到达时直接放弃在途 future（提交、上传、轮询、下载、sleep） |
| 错误分类 | `ProviderErrorClass::{Auth, Rejected, Uncertain, Protocol}`，由 `reqwest::Error` 类型标志与 HTTP 状态码决定，**不依赖匹配“超时”字符串** |

---

## 六、错误码

| 错误码 | 产生阶段 | 处理 |
| --- | --- | --- |
| `ERR_AUTH_REJECTED` | 提交/轮询 | 任务转 `paused`，提示重新配置凭据 |
| `ERR_CREDENTIAL_STORE` | 读取凭据 | 任务转 `paused`，明确“读取失败≠未配置” |
| `ERR_SUBMISSION_TIMEOUT` | 提交 | `submission_unknown`，不自动重提 |
| `ERR_REMOTE_FAILED` | 提交/轮询/上传 | 明确失败 |
| `ERR_POLL_FAILED` | 轮询 | 连续 5 次失败或超时 → `paused`，保留远端 ID |
| `ERR_DOWNLOAD_FAILED` | 下载 | 明确失败，可继续重试 |
| `ERR_NORMALIZE_FAILED` | 归一化 | 明确失败，保留原始产物与诊断 |
| `ERR_IMPORT_FAILED` | 入库 | 事务回滚并清理目录 |
| `ERR_SOURCE_CHANGED` | 快照校验 | 源文件哈希与任务记录不一致 |
| `ERR_FILE_NOT_FOUND` | 快照 | 源文件与私有快照都不存在 |
| `ERR_INTERRUPTED` | 启动恢复 | 转为 `paused`，可继续 |
| `ERR_SUBMISSION_UNCONFIRMED` | 提交中断 / 旧库迁移 | 转为 `submission_unknown`；无远端 ID 时不可“继续”，只能显式“重新解析” |
| `ERR_CANCELLED` | 取消 | 终态 |

---

## 七、离线测试（本轮实际执行）

命令：`cargo test --manifest-path src-tauri/Cargo.toml --offline`  
结果：**104 passed; 0 failed; 0 ignored**（`parse_jobs` 35、`parse_normalize` 15、`db` 13、`parsed_workspace` 19、`parse_settings` 5、`parse_providers` 5、`mineru_replay` 5、`parsed_preview` 1 等）。

### 本轮新增/关键用例

| 用例 | 覆盖 |
| --- | --- |
| `parse_jobs::tests::test_progress_update_increments_seq_during_processing` | **原子进度推进**：同一 processing 阶段持续收到有效页数更新（1/20 → 6/20），原子递增 update_seq 与 updated_at，内存模型在写库成功后才同步 |
| `parse_jobs::tests::test_late_progress_after_cancel_does_not_pollute` | **防迟到污染**：任务取消后收到的迟到轮询进度返回 NotProcessing，终态页数、更新时间与 update_seq 丝毫不受污染 |
| `parse_jobs::tests::test_progress_no_change_returns_no_change` | **幂等无变动防刷**：页数无有效变化时返回 NoChange，不递增 update_seq，不产生无效写库 |
| `parse_jobs::tests::test_health_read_does_not_advance_heartbeat` | **只读健康查询**：重复查询调度器健康状态绝不推进 last_heartbeat_at，消除虚假心跳 |
| `parse_jobs::tests::test_health_stage_syncs_with_pipeline_transitions` | **真实阶段与生命周期同步**：进入 uploading/processing 后调度器健康阶段实时推进，任务完成后自动清理当前任务与阶段 |
| `parse_jobs::tests::test_uninitialized_health_returns_zero_heartbeat` | **未初始化明确表达**：调度器无历史活动时返回 last_heartbeat_at: 0，界面明确展示“尚无活动记录” |
| `parse_jobs::tests::test_queued_job_e2e_from_queue_to_import` | **真实出队全贯通**：真实 SQLite 插入包含 `submit_attempted` 的 queued 任务，通过 `schedule_next_job_once` 从实际出队入口拉取，经本地 HTTP mock 模拟全流程，最终核对版本入库与 checkpoints |
| `parse_jobs::tests::test_empty_queue_returns_none_and_idle` | 真实队列为空时返回 `Ok(None)`，调度器单例记录 `scheduler_status = "idle"` |
| `parse_jobs::tests::test_queue_query_error_captured_in_diagnostics` | 队列查询故障时不静默吞噬，向上传播 `QueueError`，调度健康状态记录 `error` 与诊断 |
| `parse_jobs::tests::test_all_checkpoint_fields_roundtrip_consistency` | 全部 30 个数据库字段通过插入、投影查询 `PARSE_JOB_SELECT_FIELDS` 与恢复保持一致 |
| `parse_jobs::tests::test_cancelled_and_failed_jobs_not_dequeued` | 已取消与失败的任务绝对不会被 `get_next_queued_job` 取出执行 |
| `db::test_parse_job_checkpoint_columns_migrate_existing_database` | 旧库（无检查点列）幂等迁移，不要求重建数据库 |
| `parse_settings::test_native_windows_credential_roundtrip` | 原生 Credential Manager 跨 Entry 读写与清理（临时服务名 + 假值） |
| `parse_settings::test_read_failure_is_not_reported_as_unconfigured` | 读取故障不得伪装成未配置 |
| `parse_settings::test_credential_lifecycle_in_memory` | 作用域内存后端下的保存/读取/清除 |
| `parse_normalize::test_datalab_real_fixture_null_markdown_uses_html` | 脱敏真实结构：markdown 全 null、正文在 html、公式实体、图注、图片字节 |
| `parse_normalize::test_datalab_failed_pages_reject_result` | 失败页 → 明确失败并保留诊断 |
| `parse_normalize::test_datalab_all_empty_blocks_rejected` | 全空块不得视为成功 |
| `parse_normalize::test_same_basename_different_content_is_ambiguous` | 同名不同图报歧义，路径引用各自字节正确 |
| `parse_jobs::test_cancel_before_import_wins` | 取消先成功 → 不得入库 |
| `parse_jobs::test_import_wins_then_cancel_is_rejected` | 入库先取得执行权 → 取消被拒绝 |
| `parse_jobs::test_cancel_during_normalization_barrier_prevents_import` | 归一化完成、入库前屏障处取消 → 不入库 |
| `parse_jobs::test_import_transaction_rolls_back_when_job_status_changed` | 版本登记与任务更新同事务，状态变化整体回滚 |
| `parse_jobs::test_import_retry_reuses_fixed_version_id_without_duplicates` | 崩溃残留目录 + 固定版本号重试，不产生重复版本 |
| `parse_jobs::test_pipeline_resume_skips_submit_and_upload` | 重建运行时后继续原任务：0 次 POST、0 次 PUT |
| `parse_jobs::test_stale_job_does_not_override_newer_active_version` | 旧任务不覆盖后来选择的版本 |
| `parse_jobs::test_dedupe_isolated_by_document_identity` | 同字节不同路径的文档身份隔离 |
| `parse_jobs::test_cross_origin_redirect_does_not_forward_credentials` | 跨域重定向被拒，目标服务器 0 请求 |
| `parse_jobs::test_datalab_external_result_without_credentials_and_null_markdown` | 外置结果下载不带 X-API-Key；null markdown 走 html |
| `parse_jobs::test_datalab_required_image_failure_is_reported` | 必需图片失败产生诊断并阻断归一化 |
| `parse_jobs::test_resume_after_attempted_submission_never_reposts` | 提交中断后普通继续：POST 次数为 0，转待确认 |
| `parse_jobs::test_recovery_marks_attempted_submission_as_unknown` | 启动恢复：新记录与旧记录都保守处理，提交前暂停仍可继续 |
| `parse_jobs::test_pipeline_failure_marks_unconfirmed_submission_unknown` | worker 失败收尾不得把不确定提交包装成 paused |
| `parse_jobs::test_checkpoint_write_does_not_overwrite_cancellation` | 归一化完成、检查点未写入时取消：最终仍 cancelled，无版本 |
| `parse_jobs::test_resume_from_normalized_checkpoint_without_network_or_credentials` | 无快照/无凭据/无网络，仅凭完整归一化产物直接入库 |
| `parse_jobs::test_resume_from_raw_artifacts_without_remote` | raw 产物完整时本地归一化入库，不查询云端 |
| `parse_jobs::test_resume_after_import_crash_keeps_single_version` | 入库崩溃残留目录后继续，只产生一个版本 |
| `parse_jobs::test_missing_normalized_artifact_reports_explicit_state` | 检查点文件缺失：清除检查点、给出诊断、不永久 processing |

### 测试性质

- 全部为**离线**测试：真实临时文件系统、真实 SQLite 文件/内存库、本地 TCP 模拟服务；**没有访问 MinerU / Datalab 真实接口**。
- 原生凭据用例会访问本机 Windows Credential Manager，但只使用独立临时服务名与假值，并在结束时清除。
- “中断后重建任务管理器”通过“新建 `JobRuntime` + 复用数据库中的任务记录”模拟，未真正重启进程。

### 未验证项

1. 真实 Token 下的提交、上传、轮询、下载与错误码；
2. 真实 Windows 服务商的响应体差异（字段名/分页/多文件 batch）；
3. 重启进程后的凭据持久性（无跨进程读回验证）；
4. 大文件（数百 MB PDF / ZIP）的实际吞吐与内存曲线；
5. Tauri 桌面端的完整交互（由统一验收与人工桌面验收覆盖）。
