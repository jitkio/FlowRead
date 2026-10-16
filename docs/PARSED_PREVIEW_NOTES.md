# FlowRead 阶段 2A：软件内解析结果只读阅读原型说明与待办记录

更新日期：2026-10-16  
责任模块：`tools/pdf-parse-eval` 与 `src/components/ParsedDocumentPreview`  
文档版本：v1.1.0 (Phase 2A Polish & Wrap-up)

---

## 一、阶段 2A 定位与核心设计边界

本阶段（阶段 2A）的目标是：在 **真实的 FlowRead 桌面客户端软件环境** 内打开本地已有的结构化解析结果 (`blocks.json`)，将正文、LaTeX 数学公式、电路原理插图与图注连续排布在 FlowRead 的主题背景上，验证排版表现与阅读体验。

### 核心安全与设计边界（本轮严格遵守）：
1. **0 远端请求与 0 Token 依赖**：不调用 MinerU、Datalab Convert 或任何外部大模型/OCR 权重，不新增设置页面的 Token 输入框。
2. **纯临时只读阅读层**：通过“工具”菜单下的“打开解析结果预览…”入口弹出原生文件选择器。打开后作为临时图层覆盖主工作区（`position: absolute; inset: 0; z-index: 100`）。
3. **主阅读器状态与业务身份完全隔离**：
   - 不修改底层业务 `documentId` 与 `revision`；
   - 不调用 `db_get_or_create_document` 或任何 SQLite 文档创建/卡片持久化接口（测试中有严格的零调用断言）；
   - 不清空、覆盖底层正在阅读书籍的阅读位置、伴读卡片与高亮；
   - 预览层打开期间，底层阅读工作区被 `inert` 与 `pointer-events: none` 隔离保护；
   - 快捷键（如 `/`、全局 Ctrl+滚轮等）被拦截隔离，避免误触底层文档；
   - 顶部菜单中会更改底本文档身份的操作（“打开本地文件”、“管理工作区”等）在预览期间明确禁用；
   - 关闭预览层（Esc 键或点击“关闭预览”）后立即恢复底层原书的原视口位置及正常交互。
4. **不提前进入正式资产入库与来源回跳**：
   - 图片资产仅在内存中按需转换为 Blob URL，关闭预览、切换文档或组件卸载时立即通过 `URL.revokeObjectURL` 彻底释放；
   - 不向正式 `appData` 资产库拷贝文件，不写正式数据库；
   - 保留原坐标数据 `normalized_bbox: [x0, y0, x1, y1]`，但本阶段不挂接来源回跳或文本字符偏移锚点算法。

---

## 二、收尾修正主要改动清单

### 1. 交互与快捷键深度隔离
- **Ctrl+滚轮缩放隔离**：在 `App.tsx` 的全局 `handleWheel` 中增设 `parsedPreviewTargetRef.current` 检查。预览打开期间，滚轮事件不会触发底层的 `setScale`，底层 scale 保持完全恒定；
- **FloatingAskBar 快捷键隔离**：在 `FloatingAskBar.tsx` 的全局 `/` 监听及表单提交逻辑中增设 `disabled` 守卫，并在 `App.tsx` 中向 FloatingAskBar 传入 `disabled={!currentDoc || parsedPreviewTarget !== null}`。预览期间，按 `/` 绝不会夺取焦点进入正文底部隐藏的输入框，按 Enter 绝不触发底层卡片创建与 AI 调度；
- **底层工作区物理隔离**：在 `App.tsx` 中为被覆盖的底层三栏阅读器、浮动输入框、分栏手柄及右侧伴读栏添加 `inert={parsedPreviewTarget !== null ? true : undefined}` 以及 `pointer-events: none` / `user-select: none`，从 DOM 规范层面阻断焦点穿透与鼠标穿透；
- **工作区菜单切书防护**：在主菜单的“工作区”下拉项中，对“打开本地文件”、“管理工作区”、“新建文件夹”及最近文件夹列表项添加 `is-disabled` 样式与禁用拦截，阻止在解析预览未关闭时从底层切换主文档导致的原书状态丢失；
- **快捷键分层与 Esc 优先级**：
  - 顶层设置弹窗（如“阅读外观与排版设置”）> 预览内插图大图 (Lightbox) > 解析预览临时层 > 底层主阅读器；
  - 允许在解析预览打开期间打开“阅读外观与排版设置”，且在设置弹窗打开时，按 Esc 优先且仅关闭排版设置弹窗，绝不抢截误关预览；
- **焦点捕获与恢复**：`ParsedDocumentPreview` 挂载时主动聚焦自身（`tabIndex={-1}`，`preventScroll: true`），卸载时平滑恢复原先触发控件的焦点，杜绝失焦跳动。

### 2. 受控安全富文本渲染器 (`ControlledContentRenderer`)
- **标签白名单**：基于安全 DOMParser，支持解析 `<b>`、`<strong>`、`<i>`、`<em>`、`<sup>`、`<sub>`、`<br>`、`<code>` 以及表格结构元素（`table`, `thead`, `tbody`, `tr`, `th`, `td`）；
- **混合公式支持**：支持在图注、文字段落、表格单元格中内嵌 KaTeX 数学公式（`$math$`），并能与 HTML 标签安全共存（如 `<b>Fig. 2.13</b>` 与 `$D/(1-D)$`）；
- **表格属性支持**：白名单允许 `colspan`、`rowspan`、`align`，保证复杂合并单元格与对齐方式正常渲染；
- **恶意注入与网络外链防御**：
  - `<script>`、`<style>`、`<iframe>`、`<object>`、`<embed>` 等危险标签及其内部文本被彻底剔除；
  - 剔除所有 `on*` 事件属性（如 `onclick`、`onerror`）；
  - `<a>` 链接标签被安全降级为带有下划线的普通文本（`.parsed-disabled-link`），剥离 `href`，防止 WebView2 发生页面跳转；
  - `<img>` 外部网络图片被安全降级为受限占位提示（`.parsed-restricted-media`），阻止未经授权的外部网络追踪；
- **图片解码容错**：在 `ParsedBlock.tsx` 的 `ImageView` 中增加 `onError` 监听，图片格式损坏或网络加载失败时呈现清晰局部错误卡片，不导致全篇崩溃。

### 3. 统一目标管理与重选/切换机制
- 引入统一的 `ParsedPreviewTarget` 状态对象：`{ filePath: string, loadKey: number }`；
- 无论是从主工具栏入口打开，还是在预览顶栏点击“打开其他解析结果…”，均走统一入口；
- 若调起文件选择器后用户点击“取消”，当前显示的预览文档保持不变，不置为 null，也不造成意外重新加载；
- 若用户再次选中同一个文件路径，系统自增 `loadKey`，触发重新读取与刷新；
- 切换文档或重选时，自动关闭旧的大图 Lightbox，安全释放旧资产会话，并将预览视口滚动位置重置回顶部。

---

## 三、文件变更清单汇总

| 文件路径 | 变更类型 | 核心职责 |
| :--- | :--- | :--- |
| `src/components/ControlledContentRenderer.tsx` | 新增 | 基于 DOMParser 的受控富文本安全渲染器，支持行内 KaTeX、图注混合格式与表格合并。 |
| `src/components/ParsedBlock.tsx` | 修改 | 集成 ControlledContentRenderer，图注与表格支持混合格式；增加图片解码失败错误边界。 |
| `src/components/FloatingAskBar.tsx` | 修改 | 全局 `/` 快捷键、输入框及提交增加 `disabled` 守卫，杜绝穿透聚焦。 |
| `src/components/ParsedDocumentPreview.tsx` | 修改 | 支持 `ParsedPreviewTarget`、焦点恢复、安全滚动重置、Esc 弹窗优先级分层。 |
| `src/components/ParsedDocumentPreview.css` | 修改 | 增加禁用外链与受限外部图片样式。 |
| `src/App.tsx` | 修改 | `handleWheel` 缩放隔离、`workspace-underlay-content` inert 隔离、工作区菜单禁用、预览目标与弹窗状态联动。 |
| `src/App.css` | 修改 | 增加 `.menu-dropdown-item.is-disabled` 样式。 |
| `src/__tests__/parsedDocumentPreview.test.tsx` | 修改 | 补充 5 大类共 14 项自动化测试（隔离性、切换重选、StrictMode、富文本、零写入）。 |
| `docs/PARSED_PREVIEW_NOTES.md` | 更新 | 记录本轮交付成果、设计边界与人工桌面验证步骤。 |

---

## 四、测试与验证状态说明

### 自动化验证（已 100% 通过）
1. **TypeScript 静态检查**：`npx tsc --noEmit` 0 错误通过；
2. **前端单元与集成测试**：`npm test` 11 个测试套件，69 项测试全部通过；
   - 固定合成数据测试：11 项全部通过（覆盖 Markdown 标题列表、行内/代码块公式、数学比较符 $x<y$、混合 HTML 标签、表格合并、从 activeElement/按钮/大图发送 Esc 分层路由、StrictMode、输入超限与真实操作链路零写入断言）；
   - 真实评测产物检查：2 项全部通过（真实 MinerU 产物校验 5图/10公式/行内公式/BBox/曲线图、真实 Datalab v2 产物校验 4图/10公式/图内文字剥离）；
3. **前端打包构建**：`npm run build` 成功通过。

### 桌面真机体验（状态：桌面体验未验证）
> **注意**：由于执行环境为无头终端沙箱，无法直接启动 Windows 原生 GUI 窗口进行人眼核对与截图。以下功能经自动化测试验证通过，但仍需在真实的 Windows 桌面客户端中进行人工体验验收：
- [ ] **启动软件与打开预览**：启动 FlowRead 桌面客户端，点击顶部“工具 (Tools)”菜单 -> “打开解析结果预览…”，选择 MinerU 或 Datalab 的 `blocks.json`；
- [ ] **视觉排版核对**：正文、公式、电路图是否连续排布在深色主题背景上，公式是否清晰、电路图白底是否完整；
- [ ] **缩放隔离核对**：预览打开时，按 `Ctrl + 滚轮`，检查主阅读器右上角缩放比例（如 135%）是否保持不变；
- [ ] **快捷键隔离核对**：预览打开时，按下 `/` 键，检查焦点是否不会跳到正文底部的 Ask 输入框；
- [ ] **设置弹窗与 Esc 优先级**：在顶部“工具 (Tools)”主菜单中点击“阅读外观与排版设置…”，调整主题色和字号，确认解析排版即时响应；按 Esc 确认仅关闭排版设置弹窗而不误关解析预览；
- [ ] **插图大图与 Esc**：点击插图放大，检查全屏 Lightbox 正常弹出；从焦点处按 Esc 确认仅关闭大图；
- [ ] **重选与切换**：点击预览顶栏“打开其他结果…”，测试选择另一个 `blocks.json` 切换，测试选择相同文件刷新，测试点击“取消”保持原状；
- [ ] **关闭恢复**：点击“关闭预览”或按 Esc，确认平滑恢复到底层原书、原滚动位置和原伴读卡片。

---

## 五、正式云导入与全量接入前需修复的事项清单 (TODO)

在后续进入正式解析服务云端对接（阶段 2B/阶段 3）之前，必须在任务调度与数据管道中逐一落实以下修复（这些事项在当前阶段明确处于**未完成/待办状态**，本轮未予篡改或伪称完成）：

1. **Datalab 任务恢复状态分支对齐**：
   - 现象：`run.py` 中的 `execute_resume` 当前仅判断了 `complete` 与 `error` 状态；
   - 待办：Datalab Convert 适配器服务端实际返回的终态为 `done` 与 `failed`，需在任务状态机中严格对齐。
2. **Datalab 结果拉取方法名纠偏**：
   - 现象：`execute_resume` 在部分恢复路径中调用了不存在的 `fetch_and_save_result`；
   - 待办：适配器实际实现的接口为 `save_results`，需重构调用处以恢复正常下载链路。
3. **请求身份与状态持久化版本隔离**：
   - 现象：若对同一文档多次发起不同参数解析（如 v1 开启图注 vs v2 关闭图注），旧 `state.json` 仍存在被同名目录覆盖的风险；
   - 待办：需在持久化层引入基于请求参数哈希与版本 ID 的版本隔离目录机制。
4. **几何重合度定量测算算法**：
   - 现象：当前评测报告中的“99.3% 重叠度”属于基于单图浮点 BBox 计算的经验描述，未固化为全篇自动 IoU 测算管道；
   - 待办：需实现基于真实多边形/矩形交并比 (IoU) 的自动化几何重叠评分器。
5. **复杂版面、旋转与裁剪视角来源定位验证**：
   - 现象：当前验证仅覆盖了标准正向排版的 3 页切片样本；
   - 待办：涉及带有页面旋转角度（/Rotate 90/270）、非对称裁剪框（CropBox/MediaBox 偏移）的 PDF，来源视口映射算法尚未经验收。
6. **复杂表格与长篇大文件解析能力**：
   - 现象：本阶段的普通与合并单元格表格测试仅验证了前端渲染器的安全展示能力，不代表两家远端 OCR 解析服务已具备稳定的复杂多级表头识别率；
   - 待办：需补充专门的财务报表/论文统计表格样本及超 50 页以上中文扫描件，进行端到端全量压力评测。
