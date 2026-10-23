# MinerU 真实产物离线回放与结构兼容修复

更新日期：2026-10-18（2026-10-22 前端收尾同步：footnote / heading_level 透传与 page_footer 统一识别）
责任范围（本轮）：
- `src-tauri/src/parse_normalize.rs`
- `src-tauri/src/mineru_replay.rs`（离线回放入口）、`src-tauri/src/bin/mineru_replay.rs`（CLI）、`src-tauri/src/lib.rs`（仅新增一行 `pub mod mineru_replay;`）
- `src-tauri/tests/fixtures/mineru_v1_real_shape.json`、`mineru_v2_real_shape.json`、`mineru_v2_real_shape_normalized.json`
- `src/components/ParsedBlock.tsx`
- `src/__tests__/mineruParsedContentRegression.test.tsx`
- 本文档

未触碰：任务调度、数据库、provider 传输、App、任务面板、真实数据库、原始产物/脚本目录。未提交、未推送、未读取任何 Token、未发起任何云端请求。

---

## 一、真实产物结构（以 part07 为样本核对，不是照搬参考文档）

样本：`D:\AStudyWorkS\CodeSpaces\workbuddyspaces\2026-10-18-11-11-15\mineru\out\extracted\part07`（只读统计：22 页 / 241 块 / 10 标题 / 2 表格 / 25 独立公式 / 30 个图片引用 / 57 个图片文件）

### 1. v2（`*_content_list_v2.json`，顶层为按页二维数组）

| 类型 | 真实字段 | 数量 |
| --- | --- | --- |
| `title` | `content.title_content`（runs 数组）+ `content.level` | 10 |
| `paragraph` | `content.paragraph_content`（含 `equation_inline` run） | 128 |
| `equation_interline` | `content.math_content`（LaTeX）+ `content.image_source.path`（截图） | 25 |
| `table` | **`content.html`**（不是 `table_body`）+ `table_caption` / `table_footnote` / `image_source.path` | 2 |
| `image` | `content.image_source.path` + `image_caption` / `image_footnote` | 21 |
| `chart` | `content.image_source.path` + `chart_caption` / `chart_footnote`（`content` 字段为 `""`） | 9 |
| `page_header` / `page_number` / `page_footer` | `content.{type}_content`（runs 数组） | 23 / 22 / 1 |

### 2. v1（`*_content_list.json`，平铺数组 + `page_idx`）

| 类型 | 真实字段 | 数量 |
| --- | --- | --- |
| `text` | `text`（`$...$` 行内公式已内联） | 138（含 v2 中的 10 个 title） |
| `header` / `footer` | `text`，分别是**页眉/页脚**（v2 对应 `page_header` / `page_footer`），不是文档标题 | 23 / 1 |
| `table` | **`table_body`**（HTML）+ `table_caption` / `table_footnote`（字符串数组）+ `img_path`（截图备援） | 2 |
| `equation` | `text`（`$$...$$` 包裹）+ `img_path` + `text_format: latex` | 25 |
| `image` / `chart` | `img_path` + `image_caption` / `chart_caption`（字符串数组）+ `*_footnote` | 21 / 9 |

### 3. `model.json` 不是 content_list 的等价物

`model.json` 顶层是按页的 `layout_dets`（`cls_id` / `label` / `score`）+ `page_info`，只有版面检测框，没有正文/公式/表格语义。已明确移除“按文件名回退到 model.json”的行为，并在无 content_list 时给出明确错误。

---

## 二、已确认缺陷与本轮修复

| # | 真实缺陷 | 修复 |
| --- | --- | --- |
| 1 | v2 标题只改类型不读文字：`title_content` 未解析 → **10 个标题全空** | 解析 `title_content` runs（含行内公式），读取 `level` 写入 `heading_level`，并以 Markdown 前缀（`#`/`##`）承载层级 |
| 2 | v2 表格读 `table_body`/`content`（真实字段是 `content.html`）→ **2 张表格全空** | 读 `html`（兼容 `table_body`），`content_format = "html"`，保留 `rowspan/colspan` 与单元格内 `$LaTeX$` |
| 3 | `table_caption` / `table_footnote` / `image_source` 未完整保留 | 图注写入 `caption`、脚注写入新增 `footnote`、表格截图备援写入 `asset_ref` |
| 4 | v1 `table_body` / 图注 / chart 图片引用未解析 | v1 表格读 `table_body` + 图注/脚注 + `img_path`；v1 `chart` 按 `img_path` 解析资产；`image_caption`/`chart_caption` 字符串数组解析为 `caption` |
| 5 | v1 `header` 被映射成 `heading`（真实是页眉）；v1 `footer` 落入 `unknown` | `header`→`page_header`、`footer`→`page_footer`（与 v2 `page_header`/`page_footer` 对齐） |
| 6 | v1/v2 未识别块静默输出空内容 | 非预期类型/缺字段时写入 `warnings` 诊断 + 块内 `<!-- 未识别结构: X -->` 诊断文本 |
| 7 | v2 独立公式、图片/表格截图备援（`image_source`）未保留 | 公式保留 `math_content` + 截图 `asset_ref`；图片/图表/表格截图全部解析为资产引用 |
| 8 | `content.md` 对标题二次加 `##`、丢失表格图注脚注 | 已带 Markdown 层级前缀的标题不再重复加前缀；表格按“图注 → 表格 → 脚注”输出 |

保留不做的事：不做 `ν→v` 之类语义替换（回放输出中公式 `\nu _ { d s }` 原样保留），不删除纯数字段落；实体保护、转义美元符号、本地图片、路径校验、哈希去重资产映射行为全部保留。

### schema 新增（向后兼容，仅在有值时序列化）

`ParsedBlock` 新增 `footnote: Option<String>`、`heading_level: Option<i64>`。Rust 侧 blocks.json 已完整承载；前端 loader 已透传 `footnote` 与 `heading_level`（2026-10-22 前端收尾，见第八节第 2、3 项），阅读器内表格/图表脚注与标题层级均已接通渲染。

---

## 三、离线回放入口（复用生产代码，不联网）

### 命令

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin mineru_replay -- \
  "<原始分册目录>" "<输出根目录>"

# 本轮实际执行（真实 part07）
cargo run --manifest-path src-tauri/Cargo.toml --bin mineru_replay -- \
  "D:/AStudyWorkS/CodeSpaces/workbuddyspaces/2026-10-18-11-11-15/mineru/out/extracted/part07" \
  "D:/AStudyWorkS/CodeWorksSpaces/VScodeworkspaces/FlowReadDev/FlowRead/.mineru-replay"
```

### 链路（全部调用生产函数，无第二套转换器）

原始分册目录
→ `parse_normalize::find_mineru_content_list_file`（与生产同一份选文件逻辑）
→ `parse_normalize::normalize_mineru_results`（生产归一化，产出 blocks.json / content.md / source-map.json / diagnostics.json / assets）
→ `parsed_workspace::import_normalized_dir_with_options`（生产隐式工作区导入，写入**回放专用 SQLite** `<out>/partNN/replay.db` 与 `<out>/partNN/workspace/`）
→ `parsed_workspace::get_active_internal` + `parsed_preview::open_preview_internal` / `read_asset_internal`（与阅读器同一条“取激活版本 + 读资产”路径）
→ 对账与校验 → `replay-report.json` / `replay-report.md`

### 隔离与安全

- 不联网、不读凭据；仅依赖文件系统与上述纯函数。
- 工作区、数据库、归一化产物全部写入输出根目录下的独立子目录；**原始产物目录只读**（回放不写回 `extracted/`，实测原始目录无 `normalized/`、`replay.db`）。
- 输出目录带标记文件 `.flowread_replay_marker`；重复回放只清理自己生成的目录，**遇到无标记的用户目录直接拒绝覆盖**（有测试覆盖）。
- 分册页码与整本源页码分离：无可靠 manifest 时按独立分册处理，页码保留分册局部值（1..22），并在报告中显式说明“未做整书页码映射”。
- 回放使用的文档 ID 为 `replay_<part>`，不绑定任何真实文档或当前 part08 任务。

### 输出结构

```
<输出根目录>/part07/
├─ normalized/{blocks.json, content.md, source-map.json, diagnostics.json, assets/}
├─ workspace/documents/replay_part07/versions/ver_.../  ← 可直接用“打开解析结果预览”
├─ replay.db                                            ← 回放专用临时 SQLite
└─ replay-report.{json,md}
```

---

## 四、真实 part07 回放结果（真实产物验证，与合成 fixture 测试分开）

输入 22 页 / 241 块 → 输出 241 块，**8 项校验全部通过**：

| 校验项 | 结果 | 关键数据 |
| --- | --- | --- |
| 块对账 | 通过 | 输入 241 = 输出 241；逐类型对账：`title×10→heading×10`、`equation_interline×25→formula×25`、`image×21 + chart×9→image×30`、`table×2`、`paragraph×128`、`page_header×23`、`page_number×22`、`page_footer×1` |
| 标题内容与层级 | 通过 | 10 个 heading 全部非空、层级（level 1/2）与输入一致、无缺失 |
| 表格内容与图注 | 通过 | 2 张表代表性单元格逐个命中、图注命中、`content_format=html` |
| 独立公式源码 | 通过 | 25 个 formula 块，含源码 25，空源码 0，非 latex 0 |
| 图片资产与图注 | 通过 | 30 个图片引用，经预览会话读取的字节与原始图片**逐字节一致**（含电路图） |
| 页码与块顺序 | 通过 | 22 页逐页块数一致，`reading_order` 连续递增，页码不越界 |
| content.md 代表性内容 | 通过 | 52661 字节，含标题与表注 |
| 工作区导入与会话读取 | 通过 | 登记块数 241 = 实际 241，`has_assets=true`，blocks.json 可经开预览会话读取 |

代表性原文核对（取自 `.mineru-replay/part07/normalized/blocks.json`）：

- 标题（10/10，含层级；最后一个标题含行内公式，未做语义替换）：
  - `## 4.5.3 Thyristors (SCR, GTO)`（页 2，level 2）
  - `# The Discontinuous Conduction Mode`（页 17，level 1）
  - `## 5.2 Analysis of the Conversion Ratio  $M ( D , K )$`（页 22，level 2）
- 表格：
  - 页 2 `Table 4.6 Characteristics of several commercial IGBTs`，HTML 1206 字符，备援截图 `145a7bb8….jpg`
  - 页 22 `Table 5.1 CCM-DCM mode boundaries for the buck, boost, and buck–boost converters`，HTML 915 字符，备援截图 `bf459e4f….jpg`
- 公式（保留 LaTeX 源码与截图引用，例）：`\begin{array} { l } { { \displaystyle W _ { C } = \sum … } } …\end{array}\tag{4.41}`；`W _ { C d s } = \int { \nu _ { d s } i _ { C } d t } …`（`\nu` 原样保留）
- 电路图：`Fig. 4.68 IGBT switching loss example` → `asset_ref = a34e7bd9….jpg`，与原始 `image_source.path` 对应，字节一致
- 资产：原始 57 个图片文件 → 归一化 assets 57 个，原始资产一律保留

报告位置：
`D:\AStudyWorkS\CodeWorksSpaces\VScodeworkspaces\FlowReadDev\FlowRead\.mineru-replay\part07\replay-report.md`（.json 同目录）
预览入口（可在应用内用“打开解析结果预览”打开）：
`.mineru-replay\part07\workspace\documents\replay_part07\versions\ver_1792322574990_41d65d24bbd94b5f98262d642863734e\blocks.json`
（同一份 blocks.json 的归一化产物副本：`.mineru-replay\part07\normalized\blocks.json`；重复回放会生成新的 `ver_*` 目录）

---

## 五、合成 fixture 测试（不受真实产物路径约束）

### Rust（`cargo test --lib`）

新增/更新用例，与既有 82 项一并运行：

- `test_mineru_v2_real_shape_fixture`：脱敏真实 v2 结构 → 标题文字与层级、表格 HTML/`rowspan`/单元格公式/图注/脚注/截图备援、公式源码、行内公式顺序、chart 图注脚注、页眉页码页脚映射、页码与顺序、content.md
- `test_mineru_v1_real_shape_fixture`：v1 `table_body`/图注/脚注、`chart` 图片引用、`header`→页眉、`footer`→页脚、公式 `$$` 源码、页码
- `test_mineru_model_json_not_used_as_fallback`、`test_mineru_v2_unknown_type_diagnostic`、`test_mineru_v2_empty_table_degrades_to_backup_image`
- `test_mineru_v2_normalized_fixture_no_drift`：归一化产物与提交给前端的 fixture 逐字段一致（防漂移）
- `mineru_replay::tests::*`：合成端到端回放、model.json 单独存在、损坏 JSON、缺必需图片、输出目录安全

### 前端（Vitest，`src/__tests__/mineruParsedContentRegression.test.tsx`）

用**归一化后的脱敏 fixture**驱动真实阅读器组件（`ParsedBlockView` + `ControlledContentRenderer` + KaTeX），9 项全部通过：标题渲染为 h1/h2、表格 `<table>` + `rowspan` + 单元格 KaTeX + 图注、公式 KaTeX、段落 3 个行内公式按序、插图 `<img>` + 图注、页眉/页码/页脚不进正文、空表格降级/报错、原文不删纯数字且不做 `ν→v` 替换。

2026-10-22 前端收尾新增断言：页脚统一识别（v1 `footer` / v2 `page_footer` 均归 `page_footer` 且不落 unknown、不进正文）、脚注透传（表格/图表 footnote 渲染进 DOM、图表脚注内行内公式经 KaTeX 渲染、图片加载失败仍保留图注与脚注）、标题层级（无前缀按合法 `heading_level` 补 `#`、已有前缀不重复不改写）、截图降级表格 caption/footnote 各只渲染一次。现共 16 项全部通过。

---

## 六、失败与降级路径（均有明确结果，不静默“全部成功”）

| 场景 | 结果 |
| --- | --- |
| 缺必需图片资产 | 归一化明确失败：`缺少必需的本地图片资产: assets/...`（回放测试 `test_replay_missing_required_image_fails`） |
| 只有 `model.json` | 明确失败：`未找到 content_list.json …（model.json 是版面检测原始输出，不能作为 content_list 的回退）` |
| 损坏 JSON / 未知顶层 schema | 明确失败：`MinerU 结构文件语法错误` / `顶层必须为块数组…` |
| v1/v2 未识别块类型 | 保留诊断文本 `<!-- 未识别结构: X -->` + `warnings`，不输出空块 |
| 结构表格不可用但有可信备援截图 | Rust 保留 `asset_ref` + 警告；阅读器显示“表格结构不可用，已降级显示为表格截图”+ 截图 + 图注 |
| 结构表格与备援都缺 | 阅读器显示“表格内容为空（结构 HTML 与备援截图均缺失，块 #…）” |

---

## 七、容量边界现状与下一阶段设计要点（本轮不扩容）

现状（只读统计 50 份产物）：1081 页 / 11805 结构块 / 474 标题 / 50 表格 / 2270 独立公式，单份最多 335 块。
**2000 块上限同时存在于**：`parse_normalize::MAX_BLOCKS_COUNT`、`parsed_workspace::MAX_BLOCKS_COUNT`、前端 `parsedDocumentLoader.MAX_PROTOTYPE_BLOCKS`；阅读器仍全量挂载。本轮不提高常量，不宣称支持整本教材，也不把 50 份一起只读第一个 JSON 就报“合并成功”。

下一阶段设计要点（仅记录，不在本轮实现）：

1. **分册 manifest**：一本书下的分册清单（顺序、源 PDF 范围、内容哈希、结构文件版本 v1/v2），作为整书的唯一入口。
2. **源页范围与全局页码映射**：manifest 声明每册的源页区间，`page_source`（分册局部）与全局页码分别存储并可互换，避免猜页码。
3. **稳定且唯一的块 ID**：`mineru_blk_%04d` 依赖块序，跨册/重解析不稳定；应改为 `{book}:{volume}:{page}:{local_index}` 或内容哈希派生，保证增量更新与来源锚点可复用。
4. **资产命名空间**：资产按 `assets/{volume}/{hash}.{ext}` 分册命名空间存放，避免跨册同名冲突，并支持按需复制。
5. **分段读取与按需渲染**：blocks.json 分片（按页/按段）+ 后端分页读取接口；前端虚拟列表按视口挂载，替代当前全量挂载与单文件 50MB/30MB 上限。
6. **缺页 / 重复页检测**：导入时按页码序列与 manifest 期望范围校验，缺页/重复页写入 diagnostics 并给出可见提示。
7. **分册预算与整书累计预算**：分册级块数/资产/字节预算 + 整书累计预算与超限策略（提示、分段导入、降级），替换当前单一 2000 常量。

---

## 八、需要交给 Gemini 的接口/依赖清单

1. ~~**`src-tauri/src/parse_jobs.rs:767` 编译错误（E0308）**~~：19:21 前存在 `rt.with_conn(|conn| conn.execute(...))` 与 `Result<T, String>` 不匹配的问题，阻塞整 crate 编译；本轮未修改该文件，先在临时副本上按 `.map_err(|e| format!("更新任务页数失败: {}", e))` 验证。**该问题已由 Gemini 于 19:21 修复**，用户工作区随后直接编译通过并完成全部验证（Rust 98 项、真实 part07 回放）。此处仅作记录，确认无需再处理。
2. **前端 loader 透传新字段**（`src/utils/parsedDocumentLoader.ts` + `src/types/parsedDocument.ts`）：`footnote?: string | null`、`heading_level?: number | null`。**已由本轮前端收尾处理（2026-10-22）**：`ParsedBlock` 正式声明两字段，loader 读取并透传（`footnote` 仅接受非空字符串，`heading_level` 仅接受 1-6 的合法整数、不强转不钳位，非法值丢弃为 null 且不影响校验），表格/图表脚注已进阅读器渲染；标题层级由渲染层按“已有 Markdown 前缀优先、无前缀用合法 heading_level 补 `#`”应用。
3. **`normalizeBlockType` 未映射 `page_footer`**：**已由本轮前端收尾处理（2026-10-22）**：`normalizeBlockType` 正式新增 `page_footer` 映射并统一 `footer` / `pagefooter` 别名（原先这两个别名误归 `page_number`，已移除）；v1（raw_type=footer）与 v2（raw_type=page_footer）形态均归一化为 `page_footer`，统计口径（pageHeaderFooterCount / renderableBlocks / unknownCount）与显示过滤（`ParsedBlockView` 按 type 过滤）已一致，页脚不再落 unknown、不再漏进正文。
4. **解析预览入口命令参数**：目前“打开解析结果预览”接受任意 blocks.json 路径，回放产物可直接打开；若后续改为仅允许工作区路径，请保留外部路径入口或提供“导入隔离产物”入口。
5. **2000 块上限三处常量**（见第七节）需要统一治理时，请确保 normalizer、工作区、前端 loader 一起调整，不要只改一处。

---

## 九、统一验收（Gemini 任务调度/数据库/provider/面板改动合并后）

验收时间：2026-10-18 20:02，工作区为双方改动合并后的当前状态。

| 类别 | 状态 |
| --- | --- |
| 合成 fixture 测试（Rust） | 已执行：`cargo test --manifest-path src-tauri/Cargo.toml --offline` → **98 项全部通过，0 失败**（含本轮新增 11 项；Gemini 的队列/调度用例同批通过） |
| 合成 fixture 测试（前端） | 已执行：`npm test` → **13 个文件 133 项全部通过**（本轮新增 `mineruParsedContentRegression.test.tsx` 9 项；Gemini 新增的任务面板/流程用例同批通过） |
| 生产构建 | 已执行：`npm run build` → tsc + vite **exit 0**（仅有既存的 >500 kB 分包警告） |
| 真实 part07 产物离线回放 | 已执行（合并后代码编译产物直接运行）：241 块 → 241 块，**8/8 校验全部通过**，结果与第四节一致 |
| 交叉接口检查 | 已执行：provider 仍解压到 `raw_dir/extracted`，与归一化搜索根一致；`import_normalized_dir_with_options` / `get_active_internal` / `read_asset_internal` 签名未变；我这侧 5 个文件未被覆盖 |
| 真实桌面视觉检查 | **未执行**（未启动 `npm run tauri dev` 做人工验收；本轮只做数据与渲染层自动化校验） |
| 真实 API 请求 | **未执行**（未联网、未读 Token、未发起任何云端请求；Gemini 侧的 mock HTTP 服务为本地模拟） |

### 验证性质说明（四类验证分开描述，不得互替）

以下四类验证彼此独立，任何一类通过都不能替代另一类：

1. **真实产物离线回放（数据层）**：真实 part07 产物经生产归一化与回放 CLI 对账（第四节），证明 blocks.json 数据层完整；不涉及前端渲染。
2. **组件测试（JSDOM 渲染）**：脱敏 fixture 驱动 `ParsedBlockView` 等真实组件在 jsdom 中渲染（第五节），证明渲染逻辑正确；不是真实 WebView。
3. **真实桌面视觉检查**：**未执行**，需用户在 Windows 客户端 `npm run tauri dev` 人工验收（WebView 内脚注样式、标题层级视觉、页脚过滤效果、真实图片解码与滚动表现）。
4. **真实 API 验证**：**未执行**（不联网、不读 Token、不发起任何云端请求；云端 MinerU/Datalab 解析流程仍待用户实测）。

2026-10-22 前端收尾轮只执行了第 2 类（组件测试，`mineruParsedContentRegression` 16 项 + `parsedDocumentPreview` 40 项全绿）；第 3、4 类仍待用户实测。

### 第 8 节清单的合并后状态

| 清单项 | 状态 |
| --- | --- |
| 1. `parse_jobs.rs:767` 编译错误 | **已解决**（Gemini 修复，`cargo check` 干净） |
| 2. loader 透传 `footnote` / `heading_level` | **已由本轮前端收尾处理（2026-10-22）**：loader 透传两字段（非法值丢弃为 null，不丢块不报错），阅读器表格/图表脚注已渲染；标题层级按“已有前缀优先”应用 |
| 3. `normalizeBlockType` 补 `page_footer` 映射 | **已由本轮前端收尾处理（2026-10-22）**：新增 `page_footer` 类型并统一 `footer`/`pagefooter` 别名，统计与显示口径一致，页脚不再计入 unknown |
| 4. “打开解析结果预览”接受外部 blocks.json | 未变更，回放产物可直接打开（验收时已确认会话可读） |
| 5. 2000 块上限三处常量 | 未变更（`parse_normalize` 2000 / `parsed_workspace` 2000 / 前端 loader 2000），本轮不扩容，见第七节设计要点 |

### 回放产物位置（本次统一验收生成）

- 报告：`.mineru-replay\part07\replay-report.md`（.json 同目录）
- 预览入口：`.mineru-replay\part07\workspace\documents\replay_part07\versions\ver_1792324969700_31c20b02c4c040c7be7b9100154d7ea1\blocks.json`
