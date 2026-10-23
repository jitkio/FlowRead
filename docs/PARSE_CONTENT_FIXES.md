# FlowRead 内容转换与前端集成修复说明

更新日期：2026-10-18  
责任范围：
- `src-tauri/src/parse_normalize.rs`
- `src-tauri/src/parse_providers/datalab.rs`
- `src/App.tsx`
- `src/__tests__/pdfParseFlow.test.tsx`
- `src/__tests__/parsedDocumentPreview.test.tsx`
- `docs/PDF_PARSE_USER_FLOW.md`

验收结果：**前端 12 套件 123 项通过、Rust 82 项通过、生产构建 exit 0**。

---

## 一、HTML 实体与公式处理顺序修复

### 1. 缺陷根因
此前 `parse_normalize.rs` 在获取结构块内容后，立即对整串字符执行 `decode_html_entities`。
- **比较式吞尾**：`<p>Keep <math>x &lt; y</math> and keep this tail.</p>` 中的 `&lt;` 提前被转成字面 `<`。当 `<math>` 替换为 LaTeX ` $x < y$ ` 之后，后续的 `strip_tag_re`（`r"<[^>]+>"`）将 `< y$ and keep this tail.</p>` 误判为一个完整的 HTML 标签，从而将比较式后方直到 `</p>` 的全部文字直接删除，导致正文严重残缺。
- **字面标签被删或渲染消失**：`<p>Use &lt;node&gt; here.</p>` 提前解码为 `<node>`，随后被 `strip_tag_re` 当成标签完全移除，得到 `Use here.`；即使在 normalized 字符串中保留 `<node>`，传给下游 `ControlledContentRenderer`（使用 `rehypeRaw`）时，也会被作为未知 HTML 元素解析而无法在阅读器中显示字面文字。

### 2. 修复方案
1. **输入格式区分**：优先提取 `markdown/md`，其次提取 `html`，再次回退到 `content/text`。对已是 Markdown 的输入，严禁执行 HTML 删标签正则与整串实体解码。
2. **公式先行提取与保护**：
   - 提取 `<math[^>]*>(.*?)</math>`，其内部作为 LaTeX 源码解码 HTML 实体（如 `&lt;` $\to$ `<`, `&amp;` $\to$ `&`），保留完整的公式源码；
   - 在 HTML 结构中用无 `<` 和 `>` 的占位符（`\u{E000}MATH_FR_{idx}\u{E001}`）临时替换数学块；
   - 公式源码**决不经过**删除 HTML 标签的正则（`strip_tag_re`）。
3. **安全正文实体保留与解码**：
   - 在 HTML 结构经 `strip_tag_re` 移除 `<p>`, `<div>`, `<b>` 等真实标签后，使用 `decode_safe_text_entities` 解码 `&quot;`, `&#39;`, `&nbsp;`, `&amp;`；
   - **保留 `&lt;` 与 `&gt;` 为实体**：确保输出到 Markdown / HTML 阅读器时，`&lt;node&gt;` 会被 `rehypeRaw` 解析为文字节点 `<node>` 呈现给读者，避免被误判为 HTML 标签丢弃；
   - 还原公式占位符为 ` $LaTeX$ `。
4. **表格结构与单元格安全**：
   - 对 HTML 表格保留 `content_format = "html"`，不提前全局解码实体以防破坏单元格结构或生成虚假标签；
   - 仅将单元格内的 `<math>` 替换为 `$LaTeX$`，交由 `rehypeMathInHtml` 受控渲染。

### 3. 验证用例
- Rust `parse_normalize::tests::test_html_entities_and_formula_order`：
  - `<p>Keep <math>x &lt; y</math> and keep this tail.</p>` $\to$ 前缀 `Keep`、公式 `$x < y$`、尾句 `and keep this tail.` 完整保留；
  - `<p>Use &lt;node&gt; here.</p>` $\to$ 完整保留字面 `&lt;node&gt;`，不输出 `Use here.`；
  - 多个行内公式与比较符、独立公式块、表格和图注均正确保留。
- 前端 `src/__tests__/parsedDocumentPreview.test.tsx`：
  - 核对 `ParsedBlockView` 与 `ControlledContentRenderer` 真实渲染后的 DOM 文本；
  - 确认 DOM 输出包含 `Use <node> here.`，公式 annotation 包含 `x < y`，尾句文本完整挂载。

---

## 二、统一图片原始引用与落盘路径

### 1. 缺陷根因
- Datalab 服务商响应中的图片键为 `a/fig.png` 等结构树相对键；
- Provider 在 `save_results` 时将图片存放在 `dest_raw_dir.join("images").join("a/fig.png")`；
- Normalizer 以 `raw_dir` 为根收集图片，得到相对路径 `images/a/fig.png`；
- 正文解析 `a/fig.png` 时，`by_rel.get("a/fig.png")` 精确匹配失败，退回 `by_basename.get("fig.png")`。此时若还有 `b/fig.png`，候选项数量 $>1$，误报“图片引用存在歧义”，阻断了正常文档解析。

### 2. 修复方案
1. **持久映射（Images Manifest）**：
   - `DatalabClient::save_results` 保存每张图片后，在 `dest_raw_dir` 写入 `images_manifest.json`，持久化记录 `original_key -> images/{rel}` 的明确映射基准；
   - `normalize_datalab_results` 在归一化时加载该 manifest，建立原始引用到资产落盘文件的直接对应。
2. **基准前缀兼容（Search Root Alias）**：
   - 在 `collect_and_copy_images` 中，针对收集到的 `images/` 子路径，自动注册去除 `images/` 前缀后的相对键映射（如 `a/fig.png`）；
   - 同时兼容历史评测和手动解压的原始目录结构（无论是 `raw/images/` 还是直放 `raw/`）；
   - 保留同内容哈希去重与安全路径校验。
3. **精确歧义界定**：
   - `a/fig.png` 与 `b/fig.png` 精确匹配各自相对路径，互不干扰；
   - 只有当引用本身缺少路径（如字面裸 `fig.png`）且存在多个候选文件时，才明确抛出歧义错误。

### 3. 验证用例
- Rust `parse_normalize::tests::test_datalab_e2e_images_save_and_normalize`（贯通测试）：
  - 模拟真实 Datalab 状态响应 $\to$ 调用真实 `save_results` $\to$ 调用真实 `normalize_datalab_results` $\to$ 从磁盘读取 `blocks.json` 与 `assets/` 真实字节；
  - 覆盖同名不同内容（`a/fig.png` 与 `b/fig.png` 分别对应各自真实字节）；
  - 覆盖不同路径相同内容（`a/fig.png` 与 `c/fig.png` 经哈希去重共享同一资产）；
  - 覆盖缺少路径的裸文件名歧义（引用裸 `fig.png` 且存在候选时准确拦截报错）。

---

## 三、提交响应迟到不得抢回旧书

### 1. 缺陷根因
在 `src/App.tsx` 的 `handleStartPdfParse` 中，`await apiParseJobStart` 返回后无条件调用了 `openDocument(sourcePath)`。若用户在等待提交返回期间切到了书籍 B，A 的响应到达后会强制将阅读区切回书籍 A；随后的重排保护无法拦截这次由于原版打开造成的抢书行为。同时，迟到响应还会无条件清理可能已属于更新操作的弹窗状态。

### 2. 修复方案
1. **提交前固定导航意图**：
   - 记录提交开始时的 `docSeqAtSubmit = openSequenceRef.current`、`pinnedCurrentDocId = currentDocRef.current?.id` 以及目标文件路径 `sourcePath`。
2. **提交返回后校验意图有效性**：
   - 校验 `openSequenceRef.current === docSeqAtSubmit && currentDocRef.current?.id === pinnedCurrentDocId`；
   - 若用户已切书、关闭文档或开启了新导航，判定导航意图已失效，**绝对不调用 `openDocument(sourcePath)`**。
3. **保留后台跟踪与结果入口**：
   - 不因为禁止抢书而取消后台任务；任务依然通过 `parseTrackerRef.current?.track(job)` 正常登记与轮询；
   - 对新任务记录元数据，但将其代次标记为已失效，使后续任务成功时也不会抢回视野；
   - 发出轻提示通知任务已提交或已复用，引导用户在任务面板中按需查看。
4. **受保护的缓存复用分支**：
   - 后端直接返回 `status === "succeeded"` 时，同样先校验本次导航意图；意图失效时不自动打开目标原版也不切换重排视图。
5. **弹窗状态安全清理**：
   - 仅当 `pdfParseTarget?.filePath === sourcePath` 时才清理当前导入弹窗，防止迟到响应误关或清空用户为其他书籍打开的弹窗。

### 3. 验证用例
- `src/__tests__/pdfParseFlow.test.tsx`：
  - `11. 提交解析响应迟到不会抢回旧书`：使用 deferred promise 延迟 `parse_job_start`，在等待期间打开 `b.txt`，A 响应返回后确认当前阅读区依然保持书籍 B；
  - `12. 提交解析直接复用历史成功结果，响应迟到同样不得抢回旧书`：验证历史成功缓存复用分支同样不抢回书籍 B；
  - `13. 正常提交未切书时，正常打开目标文档与后续处理`：验证用户未切书时，原有自动打开目标文档并推进后续流程的功能完全保留。

---

## 四、回归测试汇总

```bash
# 前端单元与集成测试（12 个文件全部通过）
npm test
# Test Files  12 passed (12)
# Tests       123 passed (123)

# Rust 模块测试（全量通过）
cargo test --manifest-path src-tauri/Cargo.toml
# test result: ok. 82 passed; 0 failed; 0 ignored

# 生产环境编译构建
npm run build
# tsc && vite build -> exit 0
```
