# FlowRead 阶段 2A / 2B：软件内解析结果只读阅读原型与隐式重排视图稳定性规范

更新日期：2026-10-17（第二轮：内容保真 / 请求顺序 / 滚动隔离收敛）  
责任模块：`src-tauri/src/parsed_workspace.rs`, `src-tauri/src/db.rs`, `src-tauri/src/parsed_preview.rs`, `src/components/ParsedReflowReaderArea.tsx`, `src/components/ControlledContentRenderer.tsx`, `src/components/ParsedBlock.tsx`, `src/App.tsx`  
文档状态：**自动化验收全量通过**（前端 11 个套件 95 项、Rust 32 项、生产构建 exit 0）；**Windows 桌面真实体验待人工验收**  

---

## 一、阶段 2A 与 2B 核心定位与设计边界

本阶段（阶段 2A/2B）的目标是：在 **真实的 FlowRead 桌面客户端软件环境** 内，既支持打开外部解析结果（阶段 2A 临时只读预览），又支持将解析产物作为书籍专属版本导入到本地隐式工作区（阶段 2B 无纸化重排视图），实现真正的双视图自由无缝切换。

### 核心安全与设计边界（本轮严格遵守）：
1. **0 远端请求与 0 Token 消耗**：不调用 MinerU、Datalab Convert 或任何外部大模型/OCR 接口，不消耗云端 Token。
2. **纯本地资产隔离与版本化存储**：
   - 临时 staging 目录：`<app_data_dir>/parsed_workspace/staging/<staging_id>/`；
   - 正式版本持久化目录：`<app_data_dir>/parsed_workspace/documents/<doc_id>/versions/<version_id>/`；
   - 资产读取通过 `clean_local_asset_path` 规范化，仅允许安全的相对子路径（`assets/`、`./assets/`、`./`、纯文件名），严禁跨目录路径穿透（`..`）、绝对路径、盘符逃逸或 symlink 软链接逃逸；忽略外部 `http://`、`https://`、协议相对 `//`、`data:` 与 `blob:` URL；
   - 严格区分临时预览会话（`sess_prev_*`）与文档激活持久化版本（`sess_ws_*`），支持多文档独立版本管理。
3. **主阅读器状态与业务身份完全保护**：
   - 不修改底层业务 `documentId` 与卡片存储机制；
   - 双视图切换时不卸载原 PDF 阅读器 DOM（使用 `display: none` 隐藏），`PDFReaderArea` 与 `ReaderArea` 在隐藏状态（宽高为 0）时守卫 `checkVisible`，防止抹除已就绪的可见锚点；
   - 重排视图下的视口滚动位置基于内存按 `${docId}:${rev}:${verId}` 严格隔离记忆，切回重排视图时执行单次有限（最长 1000ms）、可取消的恢复，用户交互立即中止恢复；
   - 重排模式下自动隐藏小地图、连线层，锁定缩放（拦截快捷键与滚轮缩放）并禁用底部 Ask 输入；
   - 点击伴读卡片“回到原文位置”时自动切回原始版式视图（`original`）后再派发精准定位。
4. **内容解析边界与健壮性**：
   - 不将重排文本的字符偏移量冒充原 PDF 坐标；
   - 严格区分文本转义美元符号（`Price is \$10`）、公式内部转义美元符号（`$x_{\$}=1$`）与行内代码块；
   - `getRenderableBlockContent` 分流：仅在**可证实** `inline_runs` 覆盖完整 `content` 时按 runs 合成（文本 run 中的裸 `$` 转义为 `\$`）；否则保留原 `content` 全部正文，只对缺少定界符的公式定点补齐。

---

## 二、第二轮修复的真实实现与断言覆盖

> 本节内容对应本轮实际落地代码；未在真实桌面环境执行的项目一律标注为“待桌面验收”。

### 1. `inline_runs` 回退不再按比例判定完整（`src/components/ParsedBlock.tsx`）

- **删除的旧实现**：`hasTextRun && (content.length === 0 || totalRunsLen >= content.length * 0.7)` 的长度比例判定。该判定会把“漏掉尾句的残缺 runs”当成完整序列并替换全文。
- **新判定 `runsCoverContentFully(block)`**（导出以便复核）：
  1. 按 runs 原始顺序遍历；公式 run 规范化（仅剥离外层 `$`/`$$` 与首尾空白）后进入待匹配队列；
  2. 每个 text run 以“空白容错正则”在 `content` 中从当前游标向后实际定位，定位失败即判为不完整；
  3. 相邻两次定位之间的空隙必须与**当前待匹配的全部公式 run** 按原顺序、逐字符精确拼合（`pendingMath.join("") === gap`）：字符数量、顺序、标点、运算符与关系符都必须完全一致；公式源码之外不做任何 Unicode / LaTeX 语义等价推断；
  4. 不允许只匹配队列前缀就提前成功：一次匹配成立即整体清空队列，剩余公式既不能跨过后续文本去匹配下一个空隙，也不能留到末尾被追加；
  5. 纯标点或空白空隙不能被直接丢弃：只有真正的空白空隙且没有待匹配公式时才成立，否则判为不完整；
  6. 末尾残余必须为空（或由公式精确匹配），且不得残留未匹配的公式 run —— 否则重建会丢正文或凭空追加正文中不存在的公式；
  7. 无任何 text run 参与对齐（例如 runs 只有公式）时直接判为不完整；
  8. 无法可靠判定时返回 `false`，调用方保留原文。
- **本轮删除的旧判定**：`consumeGap` 把“不含字母数字的空隙”直接当作可丢弃内容，`mathExplainsGap` 用字符集合（忽略数量、顺序与标点）证明公式能解释空隙。二者叠加会把 `Values: x, x.` 重建成 `Values: $x$.`、把 `Value is x-y.` 重建成 `Value is $x+y$.`。**不再有字符集合、覆盖比例或相似度判定。**
- **本处补丁（同一轮追加）**：`consumeGapExactly` 原先在 `accumulated === target` 时只删除已匹配的前缀就返回 `true`，剩余公式会留到下一个文本之后的空隙，或在末尾被整体追加。现改为“当前空隙必须整体等于全部待匹配公式的拼接”，匹配成立即清空队列，否则返回 `false`；修复点不在函数末尾补长度检查，而是在每次匹配处，因此跨文本匹配（反例 B）也被拦下。
- **残缺 runs 的修复路径 `repairIncompleteRuns()`**：以原 `content` 为基准，代码块/行内代码/已定界公式均不参与改写；未定界公式先替换为私有区占位符，然后把普通文本中的裸 `$`（如 `$10`）转义，最后将占位符还原为 `$...$`。该路径只在正文中**字面存在**该公式源码时才补定界符，不会凭空插入正文没有的内容，也不改写正文字符。
- **一处刻意的行为变化（按“无法确认即保留原文”规则）**：`content` 中的公式若以 Unicode 呈现（如 `v ≈ V`），而 runs 中是 LaTeX（`v \approx V`），由于不做语义等价推断，无法证明一一对应，现改为保留原文（不再合成 `$v \approx V$`）。该类内容原本就没有 `$` 定界符，因此不再显示为公式；真实 MinerU 产物的 `content` 与 `inline_runs` 使用同一份 LaTeX 源码，精确匹配仍然成立（见下方真实产物断言）。
- **断言覆盖**：
  - 第 30 项：`content = "Voltage V_g is measured at the input. WARNING."` + 覆盖 74% 的 runs → 去掉公式节点后正文必须逐字等于 `Voltage is measured at the input. WARNING.`，且存在且仅存在一个 `V_g` 公式。修复前该用例失败（尾句在合成结果中消失）。
  - 第 31 项：`content = "Cost is $10 while efficiency eta and gain G are measured."` + 仅 `eta`/`G` 两个公式 run → 真实渲染后 `$10` 留在普通文字，恰好 2 个公式节点，公式内容分别为 `eta` 与 `G`，公式节点内不得出现 `10`/`while`/`measured`。修复前该用例失败（渲染结果为 `Cost is etaG$ are measured.`）。
  - 第 34 项（本轮反例 A）：`content = "Values: x, x."` + 单个 `x` 公式 run → 可读文本（KaTeX 折叠为源码，避免双层 DOM 重复计数）必须是 `Values: x, x.`，两个 x 都保留、逗号仍在普通文字中。修复前重建为 `Values: $x$.`（丢一个 x 与逗号）。
  - 第 35 项（本轮反例 B）：`content = "Value is x-y."` + `x+y` 公式 run → 必须是 `Value is x-y.`，公式节点数为 0，整段不含 `x+y`。修复前重建为 `Value is $x+y$.`（减法被改成加法）。
  - 第 36 项（本轮）：runs 漏掉正文逗号（`"Value is x, and y."`，文本 run 为 `" and y."`）→ 回退保留原文，可读文本仍是 `Value is x, and y.`，逗号未被重建吞掉；公式仍只对应 `x`。修复前重建为 `Value is $x$ and y.`。
  - 第 37 项（本轮）：runs 多出正文没有的 `y` 公式 → 结果必须是 `Value is $x$.`，公式源码仅为 `["x"]`，不得凭空追加 `y`。修复前输出 `Value is $x$.$y$`。
  - 第 38 项：`content = "Value is x"` + runs `[text, x, y]`（y 之后没有任何文本 run）→ `runsCoverContentFully` 必须为 `false`，可读文本严格等于 `Value is x`，公式源码仅 `["x"]`。修复前判定为完整、渲染成 `Value is x$$y`（末位公式被追加且出现残留 `$$`）。
  - 第 39 项：`content = "Value x then y."` + runs `[text "Value ", x, y, text " then ", text "."]`（y 在 runs 中紧跟 x，但正文里两者之间隔着 `then`）→ `runsCoverContentFully` 必须为 `false`，可读文本严格等于 `Value x then y.`，x → then → y 顺序不变。修复前判定为完整、渲染成 `Value x$$y then .`（y 越过 `then`，且标点前多出空格）。
  - 真实产物断言（第 33 项所在的“真实评测产物”套件，本机存在样本时执行）：`mineru_blk_0007`、`mineru_blk_0011` 仍必须合成出 `$v \approx V$`、`$i_{L} \approx I$`，证明精确匹配不会误判真实 MinerU 段落。
  - 第 19 项（强化）：完整 runs 下的金额与公式混排，改为真实渲染断言（`$10` 不进入公式节点、`V_g` 成公式、整段文字完整），不再只比较拼接字符串。
  - 第 28 项（期望值修正）：残缺 runs 补全公式后，正文中的裸 `$` 会被转义，故期望值由 `Cost is $10 ...` 改为 `Cost is \$10 ...`；断言强度不变，并补一条还原后仍为普通文字 `$10` 的断言。渲染侧（第 31 项）证明它不会进入公式。
  - 第 12 项（期望值修正）：`content` 中公式以 Unicode（`v ≈ V`）呈现、runs 为 LaTeX（`v \approx V`）的退化样例，按“不做语义推断”规则改为断言**正文原样保留且不生成公式节点**（原断言要求合成出 `$v \approx V$`）。
  - 既有能力保持：第 18 项（公式内部 `\$`、代码字面量）、第 28 项金额转义、第 31 项残缺 runs 不吞正文，全部保持通过。

### 2. 初始化 `getActive` 查询不再“迟启动”（`src/App.tsx`）

- **旧实现**：`openDocument` 在元数据、阅读偏好、锚点/卡片三阶段都完成后才 `++parsedOpSeqRef.current`。用户在这段延迟内发起导入会先递增代次，随后这条初始化查询又取得更大代次，导致旧查询（返回 `null`、旧版本或异常）反向淘汰刚导入的新版本。
- **新实现**：`openDocument` 在建立打开序号的同时（函数第 1 步）固定 `parsedOpId = ++parsedOpSeqRef.current`，第 9 步直接复用该身份，不再二次递增；过期判定仍为 `未挂载 / 打开序号变化 / 文档身份变化 / parsedOpId 被后续操作超越`。过期分支只调用 `parsed_preview_close` 释放自身会话，不写入正文、模式或资产管理器。
- **断言覆盖**（第 32 项，可控 Promise，三种返回各跑一轮）：
  - 文档身份已建立（导入入口可用）但 `db_get_reading_preferences` 与 `db_get_cards` 挂起时，`parsed_workspace_get_active` 调用次数为 0；
  - 期间用户导入成功，界面出现新版本正文并进入流式重排；
  - 释放偏好与卡片后，旧流程才真正发出 `getActive`（调用次数 1）；
  - 该查询返回 `null`、旧版本、抛异常三种情况下：正文仍是新导入版本、不含旧版本正文、仍停留流式重排（按钮 `is-active`）；
  - 旧版本会话 `sess_old_init_777` 被关闭，新导入会话 `sess_new_import_888` 绝不被误关。
  - 修复前三种情况均失败（`null` 与异常会把重排区清空并退回原版视图，旧版本会覆盖新版本）。
- 既有保护保持：第 23 项（同文档迟到 `getActive`）、第 24 项（导入中切书）、第 25 项（卸载后迟到结果）、第 26 项（取消选择释放忙锁）全部通过。

### 3. 重排视图滚动位置真正隔离与可打断恢复（`src/components/ParsedReflowReaderArea.tsx`）

- **旧实现**：`initialScrollTop <= 0` 时直接 `return`，复用的滚动容器里残留上一版本的位置，导入新版本后仍停在旧位置。
- **新实现**：
  1. 恢复 effect 不再提前返回：先无条件执行一次 `container.scrollTop = target`（无记录即 `0`），真正清除复用 DOM 的旧位置；无记录时不进入恢复流程。
  2. 有记录且首次赋值被内容高度截短（差值 > 2px）时，才建立单次 `ResizeObserver` + 单次 1000ms 超时；两者共用 `stopRestoration()`，一旦停止即断开监听、清除定时器。
  3. 恢复期间新增键盘打断：`PageUp`/`PageDown`/四个方向键/`Home`/`End`/空格。作用域限定为“事件目标在阅读区内或为 `window`/`document`/`body`/`documentElement`”，且排除 `input`/`textarea`/`select`/`contenteditable`，避免干扰输入框与其他控件。
  4. 缓存键与持久化范围未变：仍为内存中的 `${document_id}:${revision}:${version_id}`，未扩展阅读偏好持久化，未引入轮询。
- **断言覆盖**：
  - 第 29 项（重写）：真实切换解析版本并真实断言 `scrollTop`——同版本切回恢复为 `350`；保持重排视图导入新版本后，复用容器必须为 `0`；新版本内滚动到 `120` 再切回仍为 `120`（不串用旧版本位置）。修复前“新版本归零”与“120 恢复”失败。
  - 第 33 项（可控滚动高度 + 可控 `ResizeObserver`）：
    - 场景 A：目标 `350` 因内容高度不足被截短为 `100`，模拟图片加载撑高后恢复为 `350`；
    - 场景 B：在阅读区内的 `input` 上按 `ArrowDown` 不打断恢复，恢复仍完成到 `350`；
    - 场景 C：9 个阅读导航键逐个打断恢复，此后触发 `ResizeObserver` 不再被拉回（保持 `100`）；
    - 场景 D：打断后等待超过 1000ms 超时上限，仍保持 `100`。
    - 修复前场景 C/D 失败（无键盘打断，位置被拉回 `350`）。

### 4. Rust 图片引用扫描修复（`src-tauri/src/parsed_workspace.rs`）

- **`strip_markdown_code` 缩进代码状态机**：新增 `in_indented_code`，连续 4+ 空格或 Tab 行持续留在代码环境中被跳过，代码块内空行不退出；仅遇到“非空且缩进 < 4”的行才退出。保留“未闭合 HTML 标签内不误判缩进代码”的守卫。
- **行内代码按反引号长度匹配**：废除逐字符布尔翻转；计算起始反引号串长度 N，在同一行寻找长度恰为 N 的闭合串，命中区间整体置换为空格，支持 `` ``...`` `` 内部含单个反引号。
- **无引号 HTML `src` 结束符**：废除“遇到 `/` 即截断”的旧判断，无引号值以 ASCII 空白或 `>` 结束，并对自闭合末尾单斜杠做 `trim_end_matches('/')`，使 `src=sub/a.png`、`src=https://example.com/a.png` 完整进入 `clean_local_asset_path`。
- **断言覆盖**（3 个新增用例，均为真实文件系统 + 真实 SQLite 临时库）：
  - `test_consecutive_indented_code_ignored`：连续缩进行内的 `missing.png` 不被提取（`refs == ["real.png"]`），且端到端导入成功（代码示例缺图不再阻断导入）；
  - `test_multi_backtick_inline_code_span`：`fake1/fake2/fake3.png` 均不被提取，代码外 `real_multi_bt.png` 正常提取；
  - `test_unquoted_html_img_src_not_truncated_at_slash`：`src=sub/a.png` 完整提取并可通过会话读回字节；`https://example.com/a.png` 被安全忽略不报错；`src=assets/a.png` 缺失时导入失败且不破坏既有版本。

---

## 二·五、解析内容完整性收尾（2026-10-22）

> 本轮小范围收尾：补齐 `footnote` / `heading_level` 字段从 blocks.json 到界面的传递，统一 `page_footer` 识别，消除表格截图降级分支的重复 caption，补齐空表格分支的 footnote 渲染。不重构渲染器或解析架构，不提高 2000 块上限，未新增阅读功能。

### 1. 数据契约与 loader 透传（`src/types/parsedDocument.ts`、`src/utils/parsedDocumentLoader.ts`）

- `ParsedBlockType` 新增 `"page_footer"`（位于 `"page_number"` 之后）；`ParsedBlock` 正式声明 `footnote?: string | null` 与 `heading_level?: number | null`。
- `normalizeBlockType`：新增 `page_footer` / `footer` / `pagefooter` → `"page_footer"` 映射；原 `footer` / `pagefooter` 别名从 `page_number` 分支移除（此前 v1 形态 raw_type=footer 的页脚被误归页码，`page_footer` 字符串落入 unknown）。v1（raw_type=footer）与 v2（raw_type=page_footer）形态现在统一归一化为 `page_footer`。
- `validateParsedBlocks`：
  - `footnote` 与 caption 同款写法：仅非空字符串保留 trim 值，其余（含数字等非法类型）一律 null，不因此丢块或校验失败；
  - `heading_level` 仅当为 1-6 的合法整数时保留，字符串 `"3"`、越界（0/7）、小数（2.5）不强转、不钳位，直接丢弃为 null；
  - 统计口径：`pageHeaderFooterCount` 计入 `page_footer`，`renderableBlocks` 排除 `page_footer`，页脚不再计入 `unknownCount`。

### 2. 渲染层（`src/components/ParsedBlock.tsx`）

- `ParsedBlockView` 顶部过滤改为 `type === "page_header" | "page_number" | "page_footer"`，删除 raw_type 字符串判断（类型字段为准）。
- `ImageBlockView` 新增可选 prop `showCaption`（默认 true，语义为“是否由本组件渲染图注与脚注这两类说明文字”）；新增 footnote 渲染（`parsed-standalone-caption parsed-image-footnote` + ControlledContentRenderer isInline），与 caption 一样位于 figure 层、不放进图片加载成功条件内（加载失败仍显示）。
- `TableBlockView` 截图降级分支（content 空 + asset_ref 有）向 `ImageBlockView` 传 `showCaption={false}`：caption 与 footnote 只由父组件渲染一次，消除此前 caption 双份（及 footnote 接通后将会出现的双份）。
- `TableBlockView` 空表格分支（content 空 + 无 asset_ref）在 caption 之后补上 footnote 渲染（`parsed-table-footnote`）。
- 标题层级应用规则（新增内部辅助函数 `applyHeadingLevel`）：以 `getRenderableBlockContent(block)` 为基准；heading_level 非法（非 1-6 整数）原样返回；内容已有 Markdown 标题前缀（`/^\s*#{1,6}(?:\s|$)/`）绝不重复加 `#` 且前缀优先于 heading_level；否则前缀 `"#".repeat(level) + " "`；内容为空原样返回。不按文字长度猜测层级、不改写标题原文；含行内公式的标题前缀后仍正常走 ControlledContentRenderer。
- `getRenderableBlockContent` / `runsCoverContentFully` / `repairIncompleteRuns` / `escapeBareDollars` 等原文保真逻辑一律未动。

### 3. 测试（`src/__tests__/mineruParsedContentRegression.test.tsx`，9 项 → 16 项）

- 修改既有：第 1 项 pageHeaderFooterCount 2→3（补 unknownCount=0、renderableBlocks=7 断言）；第 3 项补表格 footnote 断言；第 6 项补图表 footnote 断言；第 7 项过滤条件改按 type。
- 新增：第 10 项页脚统一识别（v1/v2 形态 + footer/pagefooter 别名）；第 11 项截图降级表格 caption/footnote 各恰一次（textContent 计数）；第 12 项空表格无截图分支保留错误提示/caption/footnote；第 13 项图表脚注含行内公式（KaTeX 节点真实生成）；第 14 项图片加载失败仍保留图注与脚注（mockImplementationOnce 覆盖资产读取返回空）；第 15 项标题层级三组（无前缀加 #、已有前缀不重复、前缀优先于 heading_level）；第 16 项旧包兼容与非法字段（无 footnote/heading_level 旧格式正常；数字 footnote、字符串/越界/小数 heading_level 不丢块不误加前缀）。
- `parsedDocumentPreview.test.tsx`（40 项）无 footer 统计断言、heading 块无 heading_level，不受影响，本轮实测全绿。

### 4. 验证边界

- 组件测试（JSDOM）已通过：`npx vitest run src/__tests__/mineruParsedContentRegression.test.tsx src/__tests__/parsedDocumentPreview.test.tsx` → 56 项全绿；`npx tsc --noEmit` 本轮改动文件 0 类型错误。
- **真实桌面视觉检查未执行**（未启动 `npm run tauri dev` 人工验收，WebView 内脚注/层级/页脚过滤效果待用户确认）。
- **真实 API 验证未执行**（不联网、不读 Token）。

---

## 三、阶段 2B 稳定性与安全加固清单（历史条目，仍在生效）

### 1. 数据库事务化激活与单激活约束 (`db.rs`)
- **部分唯一索引保底**：`idx_parsed_doc_single_active`（`ON parsed_document_versions(document_id) WHERE is_active = 1`），迁移阶段先重置同文档历史活跃行，迁移异常向上传递。
- **原子事务与回滚**：`record_parsed_version` 接受 `&mut Connection`，先外键校验 `document_id`，再将同文档历史版本置 `is_active = 0`，最后插入新版本并置 `is_active = 1`；任何错误自动回滚。

### 2. 严格导入沙箱与安全资产拷贝 (`parsed_workspace.rs`, `parsed_preview.rs`)
- **输入限制**：块数量 ≤ 2000，`blocks.json` ≤ 50MB。
- **引用扫描**：Markdown 标题/引用式图片、HTML `<img>` 属性；忽略围栏代码块、缩进代码块、行内代码；拦截绝对路径、盘符、`..` 穿越与协议相对 URL。
- **递归安全拷贝**：支持 `assets/` 多级子目录，逐级 `Component::Normal` 校验并排除 symlink。
- **关键文件强校验**：`content.md` / `source-map.json` 必须完整拷贝，IO 错误立即终止。
- **原子发布与受限清理**：仅用 `fs::rename`；失败时经 `safe_remove_dir_all` 只清理本次创建的版本目录；事务提交后仅会话创建失败不反向删除。

### 3. 操作代次与防乱序生命周期 (`App.tsx`)
- `parsedOpSeqRef` 统一跟踪 `getActive` 与 `import`；本轮补充：初始化流程的代次在打开操作建立时固定。
- `importBusyTokenRef` 在调起文件选择器前加锁，`finally` 中仅释放自身 Token。
- 过期响应、切书、卸载均调用 `parsed_preview_close` 显式释放会话，避免 `ParsedAssetManager` 重复销毁。

### 4. 双视图闭环与交互隔离 (`App.tsx`, `ParsedReflowReaderArea.tsx`)
- 原阅读器在重排模式下 `display: none` 保持挂载；位置按 `${docId}:${rev}:${verId}` 隔离。
- 重排模式隐藏小地图与连线层、禁用 AskBar 与 `/` 穿透、锁定 `Ctrl + 滚轮` 与 `Ctrl + =/-`。
- 卡片“回到原文位置”先切回 `original` 再派发定位。

### 5. 富文本边界与公式转义 (`ControlledContentRenderer.tsx`, `ParsedBlock.tsx`)
- **双占位符**：`ESCAPED_DOLLAR_PLACEHOLDER` 保护普通文本 `\$`；`MATH_ESCAPED_DOLLAR_PLACEHOLDER` 在进入 Markdown 引擎前保护公式内部 `\$`，`rehypeRestoreEscapedDollars` 精准还原。本轮未修改该文件。
- **块内容分流**：见第二节第 1 条（本轮由比例判定改为可证实覆盖判定）。

---

## 四、文件变更清单（累计）

| 文件路径 | 变更类型 | 核心职责 |
| :--- | :--- | :--- |
| `src-tauri/src/db.rs` | 修改 | 版本表名、单激活部分唯一索引与迁移、带外键校验的原子事务。 |
| `src-tauri/src/parsed_workspace.rs` | 修改 | 导入限制、引用扫描（本轮修复缩进代码状态机、多反引号行内代码、无引号 `src` 截断）、递归安全拷贝、原子发布与受限清理；共 19 项用例。 |
| `src-tauri/src/parsed_preview.rs` | 修改 | `clean_local_asset_path` 路径组件与 symlink 加固，拒绝外部网络与 `data:`/`blob:`。 |
| `src/components/ControlledContentRenderer.tsx` | 修改（本轮未动） | 双占位符体系与受控本地图片加载。 |
| `src/components/ParsedBlock.tsx` | 修改（本轮） | `runsCoverContentFully` 可证实完整性判定；残缺 runs 保留原文 + 占位符包裹 + 裸 `$` 转义。2026-10-22 收尾：正式读取 `footnote`（删除交叉类型断言）；`ImageBlockView` 新增 `showCaption` prop 与 footnote 渲染（figure 层、加载失败仍显示）；截图降级表格 `showCaption={false}` 归属父组件消除 caption/footnote 双份；空表格分支补 footnote；`ParsedBlockView` 按 type 过滤 `page_footer`；标题按 `applyHeadingLevel` 应用层级（已有前缀不重复、非法层级原样）。 |
| `src/types/parsedDocument.ts` | 修改（2026-10-22） | `ParsedBlockType` 新增 `page_footer`；`ParsedBlock` 声明 `footnote` / `heading_level`。 |
| `src/utils/parsedDocumentLoader.ts` | 修改（2026-10-22） | `normalizeBlockType` 正式映射 `page_footer` 并统一 `footer`/`pagefooter` 别名；`validateParsedBlocks` 透传 `footnote`/`heading_level`（非法值丢弃为 null），统计与可渲染口径计入 `page_footer`。 |
| `src/__tests__/mineruParsedContentRegression.test.tsx` | 修改（2026-10-22） | 9 项 → 16 项：页脚统一识别、脚注透传、标题层级、降级去重、非法字段兼容等（详见二·五节）。 |
| `src/components/ParsedReflowReaderArea.tsx` | 修改（本轮） | 位置恢复在无记录时真正归零；阅读导航键打断恢复（作用域限定）；有限 RO + 超时。 |
| `src/components/PDFReaderArea.tsx` / `ReaderArea.tsx` | 修改 | `checkVisible` 增加零尺寸守卫。 |
| `src/App.tsx` | 修改（本轮） | `parsedOpId` 在打开操作建立时固定（本轮）；`parsedOpSeqRef`/`importBusyTokenRef`、位置记忆键、重排隔离、卡片跳转切回原文。 |
| `src/__tests__/parsedDocumentPreview.test.tsx` | 修改（本轮） | 39 项集成测试（原 29 项；重写 29；新增 30/31/32/33、34/35/36/37、38/39；强化 19；修正 28、12 期望值）。 |
| `docs/PARSED_PREVIEW_NOTES.md` | 更新（本轮） | 统一记录双方面实现、断言覆盖、模拟/跳过/待验收边界。 |

---

## 五、自动化测试与构建状态（2026-10-17 实测）

| 验证项 | 命令 | 结果 |
| :--- | :--- | :--- |
| 前端全量测试 | `npm test` | **11 个套件，95 项通过（0 failed）**，其中 `parsedDocumentPreview` 39 项 |
| Rust 全量测试 | `cargo test --manifest-path src-tauri/Cargo.toml` | **32 项通过（0 failed，0 ignored）**，其中 `parsed_workspace` 19 项（本轮 Rust 未修改，沿用同日统一验收结果，未重复执行） |
| 前端生产构建 | `npm run build`（`tsc && vite build`） | **exit 0**，TypeScript 0 错误；仅保留既有的 >500 kB 分包体积警告（非失败） |

### 测试性质区分（不可混淆）

- **真实执行**：Rust 用例使用真实临时文件系统、真实 SQLite 文件与真实事务/索引；本轮 `test_symlink_interception` 在实际运行中**未打印跳过说明**，即真实创建了软链接并验证了拦截分支（`asset_count == 1`，`symlink.png` 未被复制）。在无管理员/开发者模式权限的机器上，该用例仍会打印跳过说明并只覆盖兜底分支。
- **模拟执行**：前端所有 Tauri IPC（`invoke`）、文件选择器、PDF.js 均为 mock；第 33 项的“内容高度不足导致位置被截短”通过可控 `scrollTop` 实现，“图片加载后高度增长”通过可控 `ResizeObserver` 模拟，**不是**真实图片解码；第 32 项通过可控 Promise 模拟偏好/卡片/`getActive` 的延迟与返回。
- **条件跳过**：`真实评测产物检查` 两个用例仅在本地存在 `parse-eval` 样本时运行，本机存在样本（本轮计入 95 项内并通过）。
- **未验证**：WebView 真实渲染与滚动居中、真实图片解码引起的高度变化时序、键盘焦点与真实按键、GPU/DPI、大文件首屏与连续滚动性能，均需桌面人工验收。

---

## 六、桌面真机验收清单（状态：待人工验收）

> 自动化只能证明上述断言，不能替代真实桌面体验。请在 Windows 客户端（项目根目录 `npm run tauri dev`）逐项核对。

- [ ] **1. 双视图切换**：打开已导入解析产物的书籍，顶部药丸按钮切换 `原版视图` / `流式重排`，切换无白屏、无重新加载。
- [ ] **2. 位置记忆与版本隔离（本轮重点）**：
  - 重排视图滚动到中部 → 切回原版 → 再切回重排，视口应回到原段落，无抖动；
  - **保持重排视图不变，导入同一本书的新解析版本**：应真的回到顶部（`0`），不再是旧位置；
  - 新版本内滚动后再切换视图往返，应恢复新版本自己的位置。
- [ ] **3. 恢复过程可打断（本轮重点）**：切回重排视图后立刻按 `PageDown`/`PageUp`/方向键/`Home`/`End`/空格，恢复应立即停止且不再被拉回；在设置弹窗或 Ask 输入框里打字不受影响。
- [ ] **4. 正文保真（本轮重点）**：找一段“尾句被 runs 漏掉”的段落，确认尾句仍完整显示、公式正常；检查含 `$10` 与公式混排的段落，`$10` 是普通文字而非公式。
- [ ] **4.1 重复片段与运算符（本轮重点）**：若文档中存在同一符号出现多次（如 `x, x`）或含减号的短公式，确认正文没有少字、没有多字，`x-y` 不会被显示成 `x+y`；runs 多出的公式不会凭空出现在段落里。
- [ ] **5. 重排视图隔离**：小地图隐藏、连线层不渲染、`Ctrl + 滚轮`/`Ctrl + = -` 不改变缩放、`/` 不激活问答框（显示置灰提示）。
- [ ] **6. 卡片回到原文**：重排视图点击卡片“回到原文位置”，自动切回原版并定位高亮。
- [ ] **7. 图片与公式渲染**：Fig. 2.11 / 2.16 图片与图注正常；点击插图打开 Lightbox，`Esc` 关闭；行内公式上下标清晰。
- [ ] **8. 导入容错（本轮后端相关）**：含缩进代码块、双反引号行内代码、无引号 `<img src=sub/a.png>` 的解析包导入成功且不误报缺图；`src=https://...` 被忽略且不报错。
- [ ] **9. 菜单与文件选择**：工具菜单导入时取消选择无报错，可再次调起（忙锁已释放）。

---

## 七、未验证项与残留风险

1. 真实桌面下的滚动恢复依赖布局时序，自动化仅以可控 `scrollTop`/`ResizeObserver` 模拟，仍需人工确认无抖动。
2. **公式呈现方式的取舍（本轮新增）**：`content` 中的公式若为 Unicode 文本、runs 为 LaTeX（如 `v ≈ V` 对 `v \approx V`），因不做语义等价推断而回退保留原文，该段不再显示为公式。真实 MinerU 产物两者同源，不受影响；若后续解析器在 `content` 中输出 Unicode 公式，需要由解析侧补齐 `$` 定界符，而不是在渲染层猜测对应关系。
3. `repairIncompleteRuns()` 仍沿用既有规则：正文中同一公式源码字面出现多次时，会对每个出现位置补定界符（如 `Values: x, x.` 回退后两个 `x` 都成为公式）。字符、顺序与标点不受影响，本轮未改变该行为。
4. `parse_img_src_attribute` 对“其他属性值内部出现 `src=`”的极端写法（如 `<img alt="a src=b" src="real.png">`）会优先取内部那个值；当前 MinerU/Datalab 产物不产生该写法，本轮未修改，若后续出现需单独评估。
5. 缩进代码判定使用字节长度计算前导空白，遇到非 ASCII 空白（如全角空格）可能高估缩进；现有产物未出现，未在本轮扩大处理范围。
6. 生产构建仍有 >500 kB 分包体积警告，属于体积优化项，不代表编译失败或运行卡顿。
7. 本轮未提交、未推送、未切换分支、未执行 stash/reset/clean；工作区同时包含上一轮未提交改动与未跟踪文件。
