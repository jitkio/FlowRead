# FlowRead PDF 解析独立横向评测工具 (pdf-parse-eval)

本工具为 FlowRead 文档解析（从原件到统一连续背景流式排版与来源追溯）接入前的**独立对照测试与复核工具**。用于在不影响主应用、数据库及正式前端的前提下，对两家服务商及其不同解析参数进行客观、可复现、有证据的对比测试：

- **MinerU** 精准解析 API（v4 - `vlm` 模式）
- **Datalab** Convert API（`balanced` 模式，支持图注纠偏参数 `disable_image_captions=true`）

---

## 目录结构与职责说明

```
tools/pdf-parse-eval/
├── README.md             # 本说明文档（Windows 步骤与命令）
├── .gitignore            # 忽略虚拟环境、运行产物、本地凭证与样本
├── requirements.txt      # 依赖：requests>=2.31.0, pypdf>=5.0.0, pymupdf>=1.24.0
├── cases.example.json    # 评测样本配置示例（不含真实私密路径）
├── cases.local.json      # 用户本地样本配置（不提交 Git）
├── run.py                # 命令行主入口（check, slice, rebuild, report, run, resume）
├── storage.py            # 任务哈希、状态持久化、PDF 切片、Zip 安全解压
├── geometry.py           # 坐标归一化转换核心（1000 网格、pt 坐标、像素转 [0..1] 浮点）
├── overlay.py            # 视觉叠框实证（PyMuPDF 150 DPI 原位渲染与 BBox 叠框验证）
├── normalize.py          # 标准化提取 content.md, assets/, blocks.json, source-map.json
├── report.py             # 生成 comparison.html 对照仪表盘与 report.md
├── render-preview.mjs    # React SSR + ReactMarkdown + KaTeX MathML 离线渲染，双栏交互检查器
├── providers/
│   ├── __init__.py
│   ├── mineru.py         # MinerU v4 VLM 批次创建、PUT 上传与状态轮询（解耦安全提交）
│   └── datalab.py        # Datalab Balanced 转换与轮询（支持关闭伪图注参数）
└── tests/
    └── test_eval.py      # 全流程离线测试套件（23 项离线测试，无外网请求）
```

---

## 快速上手与操作指南 (Windows PowerShell)

### 第一步：准备独立 Python 虚拟环境

在项目根目录下，进入工具目录并创建虚拟环境：

```powershell
cd tools\pdf-parse-eval
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

### 第二步：配置 API 凭证 (Token)

本工具直接读取运行时环境变量，或工具目录下的 `.env` 文件（已 `.gitignore`）：

```powershell
# 设置 MinerU 凭据 (可在 https://mineru.net 控制台获取)
$env:MINERU_API_TOKEN="your_mineru_token_here"

# 设置 Datalab 凭据 (可在 https://www.datalab.to 控制台获取)
$env:DATALAB_API_KEY="your_datalab_key_here"
```

### 第三步：检查环境就绪状态

```powershell
python run.py check
```

确认 Python、pypdf、PyMuPDF、requests、Node.js 及环境变量状态均显示为已就绪。

### 第四步：运行离线测试套件（100% 离线无需联网）

在发起任何在线请求前，运行全量离线验证：

```powershell
python tests/test_eval.py
```

---

## CLI 子命令与工作流分流说明

为保护用户 API 额度并防止重复扣费，命令行提供严格分流的子命令：

### 1. `check` - 环境与凭证检查
```powershell
python run.py check
```
- 只检查本地 Python 库、Node 及 Token 环境变量。
- **绝不发起任何网络请求**。

### 2. `slice` - 仅切片样本
```powershell
python run.py slice --cases cases.local.json
```
- 仅按配置切取指定页码的 PDF，生成 `samples/<case_id>/input.pdf` 和 `source-pages.json`。
- **不上传、不调用任何云端 API**。

### 3. `rebuild` - 纯离线重建与复核（推荐）
```powershell
# 对最新评测批次重新标准化、生成叠框图、渲染预览和对照报告
python run.py rebuild

# 指定评测批次目录重建
python run.py rebuild --run-id 20261016_024119_review_v3
```
- **完全离线工作**：无需 API Token，无需原始整本大 PDF，仅依赖已保存的 `input.pdf` 和 `raw/` 原始数据。
- 重新执行几何坐标转换、PyMuPDF 叠框图渲染、深色预览生成与报告更新。

### 4. `report` - 纯读状态生成总览
```powershell
python run.py report --run-id 20261016_024119_review_v3
```
- 快速读取各变体的 `state.json` 与 `diagnostics.json`，刷新 `comparison.html` 与 `report.md`。

### 5. `run` - 显式提交新评测任务
```powershell
python run.py run --cases cases.local.json --provider all
```
- 显式入口。默认检查页数上限（超过 10 页自动拦截，需 `--force` 确认）。
- 具备 `submission_unknown` 防连击保护：若任务处于未确认状态，严禁自动重新 POST，彻底防止重复扣费。

### 6. `resume` - 恢复中断任务
```powershell
python run.py resume --run-id <run_id>
```
- 仅恢复已有服务端 Task ID 的任务，绝不凭空创建新任务。

---

## 产物与核对报告查看

评测结果默认输出在：
`%LOCALAPPDATA%\FlowRead\parse-eval\<run_id>\`

### 关键交付产物：
1. **多服务横向对照仪表盘 (`comparison.html`)**：
   - 并排展示 MinerU、Datalab v1（旧基线）、Datalab v2（纠偏参数）三个变体的深色连续排版 iframe。
   - 显示耗时、结构块数、表格数、公式总数与语法错误标记数。
   ```powershell
   start "%LOCALAPPDATA%\FlowRead\parse-eval\20261016_024119_review_v3\comparison.html"
   ```

2. **来源坐标与 BBox 叠框验证报告 (`verification/verification.html`)**：
   - 包含原 PDF 真实页面、MinerU 叠框图、Datalab 叠框图的三栏/多栏原位比对。
   - 带有彩色标注图例（正文=蓝、标题=青、公式=绿、插图/电路图=橙、图注=紫）。
   ```powershell
   start "%LOCALAPPDATA%\FlowRead\parse-eval\20261016_024119_review_v3\verification\verification.html"
   ```

3. **Markdown 对照与选型建议报告 (`report.md`)**：
   - 详细记录 Datalab 纠偏参数实证结论、MinerU 图注异常诊断、几何一致性数据及 FlowRead 正式接入决策建议。
