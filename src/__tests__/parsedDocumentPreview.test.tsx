import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, act, fireEvent, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
// @ts-ignore
import fs from "node:fs";
// @ts-ignore
import path from "node:path";

import {
  validateParsedBlocks,
  ParsedDocumentLoader,
  ParsedAssetManager,
} from "../utils/parsedDocumentLoader";
import ParsedBlockView, {
  FormulaBlockView,
  repairLatexFormula,
  getRenderableBlockContent,
  runsCoverContentFully,
} from "../components/ParsedBlock";
import ControlledContentRenderer, {
  ESCAPED_DOLLAR_PLACEHOLDER,
} from "../components/ControlledContentRenderer";
import ParsedDocumentPreview from "../components/ParsedDocumentPreview";
import ParsedReflowReaderArea from "../components/ParsedReflowReaderArea";
import { ParsedBlock } from "../types/parsedDocument";
import { ActiveParsedWorkspaceResponse } from "../utils/recordStorage";
import { PARSED_READING_STORAGE_KEY } from "../utils/parsedReadingPreferences";
import App from "../App";

// Mock Tauri invoke & dialog
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);
const mockOpen = vi.mocked(open);

// ==========================================
// 断言辅助：只读取真实渲染结构，不比较拼接字符串
// ==========================================

/** 读取 KaTeX 节点的 TeX 源码（annotation），用于断言公式内容本身 */
function katexTexs(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll(".katex")).map((node) => {
    const annotation = node.querySelector("annotation");
    return (annotation?.textContent || node.textContent || "").trim();
  });
}

/** 归一化空白，便于断言“整段普通文字完整” */
function normalizedText(node: Node | null): string {
  return (node?.textContent || "").replace(/\s+/g, " ").trim();
}

/** 移除 KaTeX 节点后的纯文字（公式占位不再影响正文断言） */
function textWithoutMath(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  clone.querySelectorAll(".katex").forEach((n) => n.remove());
  return normalizedText(clone);
}

/**
 * 生成“可读文本”：把每个 KaTeX 节点整体折叠为其 TeX 源码（annotation），
 * 避免 KaTeX 的 MathML + HTML 双层 DOM 让同一字符被重复计入。
 */
function readableText(node: Node | null): string {
  if (!node) return "";
  let out = "";
  const walk = (current: Node) => {
    if (current.nodeType === 3) {
      out += current.nodeValue || "";
      return;
    }
    const el = current as Element;
    if (el.classList && el.classList.contains("katex")) {
      const annotation = el.querySelector("annotation");
      out += annotation?.textContent || "";
      return;
    }
    Array.from(current.childNodes).forEach(walk);
  };
  walk(node);
  return out.replace(/\s+/g, " ").trim();
}

/**
 * 用可控的 scrollTop 模拟真实布局：内容不足时浏览器会把目标位置截短，
 * 图片加载导致内容变高后才允许真正到达目标位置。
 */
function installClampedScrollTop(initialMax: number) {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const tops = new WeakMap<Element, number>();
  const state = { max: initialMax };

  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      const numeric = Number(value) || 0;
      tops.set(this, Math.max(0, Math.min(numeric, state.max)));
    },
  });

  return {
    setMax(next: number) {
      state.max = next;
    },
    restore() {
      if (original) {
        Object.defineProperty(Element.prototype, "scrollTop", original);
      } else {
        delete (Element.prototype as any).scrollTop;
      }
    },
  };
}

/** 可控 ResizeObserver：由测试显式触发回调，模拟图片加载后的内容高度变化 */
function installControlledResizeObserver() {
  const original = (window as any).ResizeObserver;
  const instances: any[] = [];

  class ControlledResizeObserver {
    cb: any;
    targets: Element[] = [];
    constructor(cb: any) {
      this.cb = cb;
      instances.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.targets = [];
    }
    trigger() {
      if (typeof this.cb === "function") {
        this.cb(
          this.targets.map((target) => ({
            target,
            contentRect: { width: 400, height: 800, top: 0, left: 0, bottom: 800, right: 400 },
            borderBoxSize: [{ inlineSize: 400, blockSize: 800 }],
          })),
          this
        );
      }
    }
  }

  (window as any).ResizeObserver = ControlledResizeObserver;
  (globalThis as any).ResizeObserver = ControlledResizeObserver;

  return {
    triggerAll() {
      instances.forEach((inst) => inst.trigger());
    },
    restore() {
      (window as any).ResizeObserver = original;
      (globalThis as any).ResizeObserver = original;
    },
  };
}

/** 构造一个最小可用的隐式解析工作区响应 */
function makeActiveWorkspace(
  versionId: string,
  bodyText: string,
  sessionId = `sess_${versionId}`
): ActiveParsedWorkspaceResponse {
  return {
    version_id: versionId,
    document_id: "doc_test",
    source_revision: "v1",
    provider: "mineru",
    block_count: 2,
    asset_count: 0,
    created_at: Date.now(),
    session_id: sessionId,
    blocks_path: "C:\\synthetic\\blocks.json",
    doc_dir: "C:\\synthetic",
    raw_json: JSON.stringify([
      { id: "b1", type: "paragraph", content: bodyText },
      { id: "b2", type: "paragraph", content: "第二段正文" },
    ]),
    has_assets: false,
  };
}

// 固定合成测试数据（用于可重复、脱离外部环境的确定性单元测试）
const SYNTHETIC_MINERU_BLOCKS = [
  {
    id: "mineru_blk_0001",
    type: "image",
    content: "",
    asset_ref: "mineru_p41_img1.jpg",
    normalized_bbox: [0.206, 0.077, 0.742, 0.349],
    caption: "Fig. 2.11 Boost converter circuit",
  },
  { id: "mineru_blk_0002", type: "image", content: "", asset_ref: "mineru_p41_img2.jpg" },
  { id: "mineru_blk_0003", type: "image", content: "", asset_ref: "mineru_p42_img1.jpg" },
  { id: "mineru_blk_0004", type: "image", content: "", asset_ref: "mineru_p42_img2.jpg" },
  {
    id: "mineru_blk_0007",
    type: "paragraph",
    content: "Under small-ripple assumption, $v \\approx V$ holds true.",
    inline_runs: [
      { type: "text", content: "Under small-ripple assumption, " },
      { type: "equation_inline", content: "v \\approx V" },
      { type: "text", content: " holds true." },
    ],
  },
  {
    id: "mineru_blk_0021",
    type: "image",
    raw_type: "chart",
    content: "",
    asset_ref: "fig2_16.jpg",
    caption: "Fig. 2.16 Output voltage vs duty cycle $M(D)$",
  },
  // 10 个独立公式块
  { id: "mineru_f01", type: "formula", content: "v_L(t) = V_g" },
  { id: "mineru_f02", type: "formula", content: "i_C(t) = -v(t)/R" },
  { id: "mineru_f03", type: "formula", content: "v_L(t) = V_g - v(t)" },
  { id: "mineru_f04", type: "formula", content: "i_C(t) = i(t) - v(t)/R" },
  { id: "mineru_f05", type: "formula", content: "\\langle v_L \\rangle = D V_g + D' (V_g - V) = 0" },
  { id: "mineru_f06", type: "formula", content: "V = \\frac{V_g}{D'}" },
  { id: "mineru_f07", type: "formula", content: "\\langle i_C \\rangle = - D \\frac{V}{R} + D' \\left(I - \\frac{V}{R}\\right) = 0" },
  { id: "mineru_f08", type: "formula", content: "I = \\frac{V}{D' R}" },
  { id: "mineru_f09", type: "formula", content: "I = \\frac{V_g}{D'^2 R}" },
  { id: "mineru_f10", type: "formula", content: "M(D) = \\frac{V}{V_g} = \\frac{1}{1-D}" },
];

const SYNTHETIC_DATALAB_BLOCKS = [
  { id: "datalab_blk_0001", type: "image", content: "", asset_ref: "d_img1.jpg" },
  {
    id: "datalab_blk_0002",
    type: "image",
    content: "",
    asset_ref: "d_img2.jpg",
    in_image_text: ["(a)", "(b)", "$V_g$"],
    caption: "<b>Fig. 2.13</b> Boost converter with parasitic elements",
  },
  { id: "datalab_blk_0003", type: "image", content: "", asset_ref: "d_img3.jpg" },
  { id: "datalab_blk_0004", type: "image", content: "", asset_ref: "d_img4.jpg" },
  // 10 个公式
  { id: "datalab_f01", type: "formula", content: "v_L = V_g" },
  { id: "datalab_f02", type: "formula", content: "i_C = -V/R" },
  { id: "datalab_f03", type: "formula", content: "v_L = V_g - V" },
  { id: "datalab_f04", type: "formula", content: "i_C = I - V/R" },
  { id: "datalab_f05", type: "formula", content: "D V_g + D' (V_g - V) = 0" },
  { id: "datalab_f06", type: "formula", content: "V = \\frac{V_g}{D'}" },
  { id: "datalab_f07", type: "formula", content: "- D \\frac{V}{R} + D' \\left(I - \\frac{V}{R}\\right) = 0" },
  { id: "datalab_f08", type: "formula", content: "I = \\frac{V}{D' R}" },
  { id: "datalab_f09", type: "formula", content: "I = \\frac{V_g}{D'^2 R}" },
  { id: "datalab_f10", type: "formula", content: "\\frac{V}{V_g} = \\frac{1}{1-D}" },
];

describe("阶段 2A：软件内解析结果只读阅读原型固定合成测试套件", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重排阅读状态按文档持久化，测试之间必须隔离，避免用例互相影响视图模式与位置
    localStorage.removeItem(PARSED_READING_STORAGE_KEY);
    mockOpen.mockResolvedValue("C:\\synthetic\\blocks.json");

    mockInvoke.mockImplementation(async (cmd, args: any) => {
      if (cmd === "parsed_preview_open") {
        const filePath = args.path as string;
        let jsonStr = "[]";
        if (filePath.includes("mineru")) {
          jsonStr = JSON.stringify(SYNTHETIC_MINERU_BLOCKS);
        } else if (filePath.includes("datalab")) {
          jsonStr = JSON.stringify(SYNTHETIC_DATALAB_BLOCKS);
        } else {
          jsonStr = JSON.stringify([
            { id: "b1", type: "paragraph", content: "合成测试正文" },
            { id: "img1", type: "image", asset_ref: "test.jpg", caption: "测试插图" },
          ]);
        }
        return {
          session_id: "session_mock_123",
          blocks_path: filePath,
          doc_dir: "C:\\synthetic",
          raw_json: jsonStr,
          has_assets: true,
        };
      }
      if (cmd === "parsed_preview_read_asset") {
        return [0xff, 0xd8, 0xff, 0xe0]; // dummy jpeg header
      }
      if (cmd === "parsed_preview_close") {
        return {};
      }
      if (cmd === "read_local_file") {
        return "# 测试内置文档";
      }
      if (cmd === "get_file_metadata") {
        return { size: 100, mtime: 1000, revision: "100-1000" };
      }
      if (cmd === "db_get_reading_preferences") {
        return null;
      }
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") {
        return [];
      }
      if (cmd === "db_get_cards") {
        return { items: [], total: 0 };
      }
      if (cmd === "db_get_or_create_document") {
        return {
          id: "doc_mock_1",
          file_path: args.filePath,
          display_name: args.displayName,
          file_size_bytes: args.sizeBytes || 100,
          revision: args.revision || "v1",
          last_opened_at: Date.now(),
          reading_position_json: null,
          created_at: Date.now(),
        };
      }
      if (cmd === "parsed_workspace_get_active") {
        return null;
      }
      return {};
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  // ==========================================
  // 1. 结构块统计与内容校验 (固定合成数据)
  // ==========================================
  it("1. 结构块校验：5图/10公式/行内公式与图注公式在合成结构中正常保留", () => {
    const mineruRes = validateParsedBlocks(
      SYNTHETIC_MINERU_BLOCKS,
      "C:\\synthetic\\mineru.json",
      "sess_m",
      "C:\\synthetic",
      true
    );
    expect(mineruRes.valid).toBe(true);
    expect(mineruRes.stats.imageCount).toBe(5);
    expect(mineruRes.stats.formulaCount).toBe(10);
    const blk1 = mineruRes.document!.blocks.find((b) => b.id === "mineru_blk_0001");
    expect(blk1?.normalized_bbox).toEqual([0.206, 0.077, 0.742, 0.349]);

    const datalabRes = validateParsedBlocks(
      SYNTHETIC_DATALAB_BLOCKS,
      "C:\\synthetic\\datalab.json",
      "sess_d",
      "C:\\synthetic",
      true
    );
    expect(datalabRes.valid).toBe(true);
    expect(datalabRes.stats.imageCount).toBe(4);
    expect(datalabRes.stats.formulaCount).toBe(10);
    const dImg = datalabRes.document!.blocks.find((b) => b.id === "datalab_blk_0002");
    expect(dImg?.in_image_text).toContain("(a)");
    expect(dImg?.in_image_text).toContain("$V_g$");
  });

  // ==========================================
  // 2. 独立公式错误局部兜底
  // ==========================================
  it("2. 公式错误处理：故意传入无效 LaTeX 时给出局部清晰错误，不使用 includes('katex') 误判，不导致白屏", () => {
    const { container: okContainer } = render(
      <FormulaBlockView content="V = \frac{V_g}{D'}" />
    );
    expect(okContainer.querySelector(".katex-display")).not.toBeNull();
    expect(okContainer.querySelector(".parsed-formula-container.is-error")).toBeNull();

    const invalidTex = "\\begin{array}{l} \\frac{V_g}{D' \\end{array}";
    const { container: errContainer } = render(
      <FormulaBlockView content={invalidTex} />
    );
    const errorBox = errContainer.querySelector(".parsed-formula-container.is-error");
    expect(errorBox).not.toBeNull();
    expect(errContainer.textContent).toContain("公式语法错误");
    expect(errContainer.textContent).toContain(invalidTex);

    // 容错修复验证：OCR/MinerU 产物中在 \text{...} 夹杂未定界下标（如 \text {for K > K_{crit}}）自动修复渲染
    const mineruQuirkTex = "M = \\left\\{ \\begin{array}{c l} \\frac {1}{1 - D} & \\text {for K > K_{crit}} \\\\ \\frac {1 + \\sqrt {1 + \\frac {4 D ^ {2}}{K}}}{2} & \\text {for K <   K_{crit}} \\end{array} \\right.\\tag{5.53}";
    const repaired = repairLatexFormula(mineruQuirkTex);
    expect(repaired).not.toBe(mineruQuirkTex);
    expect(repaired).toContain("\\text{for }K > K_{crit}");

    const { container: quirkContainer } = render(
      <FormulaBlockView content={mineruQuirkTex} />
    );
    expect(quirkContainer.querySelector(".katex-display")).not.toBeNull();
    expect(quirkContainer.querySelector(".parsed-formula-container.is-error")).toBeNull();
    // 修复成功后提供轻量提示和“查看原式”入口
    expect(quirkContainer.querySelector(".parsed-formula-repair-badge")).not.toBeNull();
    const toggleBtn = quirkContainer.querySelector(".parsed-formula-raw-toggle") as HTMLButtonElement;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn.textContent).toBe("查看原式");
    expect(quirkContainer.querySelector(".parsed-formula-raw")).toBeNull();

    // 点击查看原式
    fireEvent.click(toggleBtn);
    expect(toggleBtn.textContent).toBe("收起原式");
    const rawPre = quirkContainer.querySelector(".parsed-formula-raw");
    expect(rawPre).not.toBeNull();
    expect(rawPre?.textContent).toBe(mineruQuirkTex);

    // 原本有效公式：无提示、无“查看原式”、无修复
    const { container: normalContainer } = render(
      <FormulaBlockView content="v(t) \approx V\tag{5.11}" />
    );
    expect(normalContainer.querySelector(".parsed-formula-repair-badge")).toBeNull();
    expect(normalContainer.querySelector(".parsed-formula-raw-toggle")).toBeNull();
    expect(normalContainer.querySelector(".parsed-formula-container")?.className).toContain("has-tag");

    // 无编号公式：有 no-tag 标志，不预留多余编号空间
    const { container: noTagContainer } = render(
      <FormulaBlockView content="v(t) \approx V" />
    );
    expect(noTagContainer.querySelector(".parsed-formula-container")?.className).toContain("no-tag");
    expect(noTagContainer.querySelector(".parsed-formula-container")?.className).not.toContain("has-tag");

    // 保留原式与边界收紧：同一公式包含 \text{signal\_name} 和错误条件表达式时，正确文本保持原样
    const mixedTex = "\\text{signal\\_name} = 1 \\quad \\text{for K > K_{crit}}";
    const mixedRepaired = repairLatexFormula(mixedTex);
    expect(mixedRepaired).toContain("\\text{signal\\_name}");
    expect(mixedRepaired).toContain("\\text{for }K > K_{crit}");

    // 未知文本与无法确认的嵌套结构：保持原样，不强行转换
    const unknownTex = "\\text{unknown_var_with_underscore}";
    expect(repairLatexFormula(unknownTex)).toBe(unknownTex);

    const nestedTex = "\\text{nested {foo {bar}} with _}";
    expect(repairLatexFormula(nestedTex)).toBe(nestedTex);
  });

  // ==========================================
  // 3. 真实 Markdown、混合 HTML、数学比较符语法组合深度校验
  // ==========================================
  it("3. Markdown与数学深度解析：验证粗体公式、标题列表、混合HTML、比较符 $x<y$、代码块及表格合并", () => {
    // 组合 1: **重要结论**，电压为 $V_g$
    const { container: c1 } = render(
      <ControlledContentRenderer content="**重要结论**，电压为 $V_g$" />
    );
    expect(c1.querySelector("strong")?.textContent).toBe("重要结论");
    expect(c1.querySelector(".katex")).not.toBeNull();

    // 组合 2: Markdown 标题与列表
    const { container: c2 } = render(
      <ControlledContentRenderer content={"## 工作原理\n- 步骤一：储能\n- 步骤二：释能"} />
    );
    expect(c2.querySelector("h2")?.textContent).toBe("工作原理");
    const listItems = c2.querySelectorAll("li");
    expect(listItems.length).toBe(2);
    expect(listItems[0].textContent).toContain("步骤一：储能");
    expect(listItems[1].textContent).toContain("步骤二：释能");
    expect(c2.textContent).not.toContain("##");

    // 组合 3: HTML 粗体、Markdown 斜体与数学公式共存
    const { container: c3 } = render(
      <ControlledContentRenderer content="<b>Fig. 2.13</b>，*理想情况*，$M(D)$" />
    );
    expect(c3.querySelector("b")?.textContent).toBe("Fig. 2.13");
    expect(c3.querySelector("em")?.textContent).toBe("理想情况");
    expect(c3.querySelector(".katex")).not.toBeNull();

    // 组合 4: 数学比较符不被当作 HTML 标签吞噬
    const { container: c4 } = render(
      <ControlledContentRenderer content="For $x<y$ and $z>w$." />
    );
    expect(c4.textContent).toContain("For ");
    expect(c4.textContent).toContain(" and ");
    expect(c4.querySelectorAll(".katex").length).toBe(2);
    expect(c4.textContent).not.toContain("<y$"); // 未被当作标签丢弃

    // 组合 5: 代码中的 $ 保持字面内容，转义符按 Markdown 规则处理
    const { container: c5 } = render(
      <ControlledContentRenderer content={"行内代码 `$x$` 与代码块：\n```\n$y = f(x)$\n```\n转义价格：\\$100"} />
    );
    const codeEls = c5.querySelectorAll("code");
    expect(codeEls[0].textContent).toBe("$x$");
    expect(codeEls[1].textContent).toContain("$y = f(x)$");
    expect(c5.textContent).toContain("$100");
    // 代码内的 $ 绝不渲染为 KaTeX 公式容器
    expect(codeEls[0].querySelector(".katex")).toBeNull();

    // 组合 6: HTML 表格中同时包含 rowspan/colspan、sup/sub、br 和 $D/(1-D)$
    const tableHtml = `
      <table>
        <thead>
          <tr>
            <th colspan="2" align="center">转换器特性对比</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td rowspan="2">Buck-Boost</td>
            <td onclick="alert('hack')"><b>Fig</b><sup>1</sup><sub>2</sub><br>输出极性反转</td>
          </tr>
          <tr>
            <td>$D / (1 - D)$</td>
          </tr>
        </tbody>
      </table>
    `;
    const { container: c6 } = render(
      <ControlledContentRenderer content={tableHtml} />
    );
    expect(c6.querySelector("th")?.getAttribute("colspan")).toBe("2");
    expect(c6.querySelector("td[rowspan='2']")?.textContent).toBe("Buck-Boost");
    expect(c6.querySelector("sup")?.textContent).toBe("1");
    expect(c6.querySelector("sub")?.textContent).toBe("2");
    expect(c6.querySelector("br")).not.toBeNull();
    expect(c6.querySelector(".katex")).not.toBeNull();
    // 恶意 onclick 属性被过滤
    expect(c6.querySelector("td[onclick]")).toBeNull();
  });

  // ==========================================
  // 4. 输入边界防御
  // ==========================================
  it("4. 输入边界防御：非数组根结构与超限文档给出明确提示", () => {
    const resNotArray = validateParsedBlocks({ error: "not array" }, "bad.json", "s1", "C:\\", false);
    expect(resNotArray.valid).toBe(false);
    expect(resNotArray.errors[0]).toContain("JSON 数组");

    const hugeArray = new Array(2005).fill({ id: "b", type: "paragraph", content: "test" });
    const resHuge = validateParsedBlocks(hugeArray, "huge.json", "s2", "C:\\", false);
    expect(resHuge.valid).toBe(false);
    expect(resHuge.errors[0]).toContain("超出当前只读原型承载范围");
  });

  // ==========================================
  // 5. 资产生命周期管理
  // ==========================================
  it("5. 资产生命周期管理：读取图片生成 Blob URL，dispose 时调用 revokeObjectURL 并注销会话", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:flowread-asset-1");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const assetMgr = new ParsedAssetManager("test_session_abc");
    const url = await assetMgr.loadAsset("pic1.jpg");
    expect(url).toBe("blob:flowread-asset-1");
    expect(mockInvoke).toHaveBeenCalledWith("parsed_preview_read_asset", {
      sessionId: "test_session_abc",
      assetRef: "pic1.jpg",
    });

    // 缓存命中
    const url2 = await assetMgr.loadAsset("pic1.jpg");
    expect(url2).toBe("blob:flowread-asset-1");
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // 销毁
    assetMgr.dispose();
    expect(revokeSpy).toHaveBeenCalledWith("blob:flowread-asset-1");
    expect(mockInvoke).toHaveBeenCalledWith("parsed_preview_close", {
      sessionId: "test_session_abc",
    });
  });

  // ==========================================
  // 6. Esc 事件分层与路由（必须从 activeElement、内部按钮及大图发送）
  // ==========================================
  it("6. Esc 事件路由：从 activeElement/内部按钮/大图发送 Esc，遵循分层规则并不穿透", async () => {
    const onCloseSpy = vi.fn();

    // 场景 A: 打开预览后从 document.activeElement 直接按 Esc 关闭
    const { unmount } = render(
      <ParsedDocumentPreview
        target={{ filePath: "C:\\test\\blocks.json", loadKey: 1 }}
        onClose={onCloseSpy}
        onOpenAnother={vi.fn()}
      />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    // 焦点位于预览根节点上
    expect(document.activeElement).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onCloseSpy).toHaveBeenCalledTimes(1);

    // 场景 B: 焦点位于内部按钮时按 Esc 关闭
    onCloseSpy.mockClear();
    const otherBtn = screen.getByText("打开其他结果...");
    otherBtn.focus();
    expect(document.activeElement).toBe(otherBtn);
    fireEvent.keyDown(otherBtn, { key: "Escape" });
    expect(onCloseSpy).toHaveBeenCalledTimes(1);

    // 场景 C: 大图 Lightbox 打开时，Esc 仅关闭大图，不关闭预览
    onCloseSpy.mockClear();
    unmount();

    const { container: cWithLightbox, unmount: unmountLightbox } = render(
      <ParsedDocumentPreview
        target={{ filePath: "C:\\test\\blocks.json", loadKey: 1 }}
        onClose={onCloseSpy}
        onOpenAnother={vi.fn()}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    // 点击插图打开大图
    const imgEl = cWithLightbox.querySelector(".parsed-image-element");
    if (imgEl) {
      fireEvent.click(imgEl);
      const lightboxOverlay = cWithLightbox.querySelector(".parsed-lightbox-overlay");
      expect(lightboxOverlay).not.toBeNull();

      // 从大图关闭按钮按 Esc
      const lightboxCloseBtn = cWithLightbox.querySelector(".parsed-lightbox-close");
      expect(lightboxCloseBtn).not.toBeNull();
      fireEvent.keyDown(lightboxCloseBtn!, { key: "Escape" });

      // 大图关闭，预览未关闭
      expect(cWithLightbox.querySelector(".parsed-lightbox-overlay")).toBeNull();
      expect(onCloseSpy).not.toHaveBeenCalled();

      // 再次按 Esc 关闭预览
      fireEvent.keyDown(document.activeElement || cWithLightbox, { key: "Escape" });
      expect(onCloseSpy).toHaveBeenCalledTimes(1);
    }
    unmountLightbox();

    // 场景 D: 阅读设置打开时 (isModalOpenAbove=true)，Esc 仅关闭设置，不关闭预览
    onCloseSpy.mockClear();
    const { unmount: unmountAbove } = render(
      <ParsedDocumentPreview
        target={{ filePath: "C:\\test\\blocks.json", loadKey: 1 }}
        onClose={onCloseSpy}
        onOpenAnother={vi.fn()}
        isModalOpenAbove={true}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    fireEvent.keyDown(document.activeElement || window, { key: "Escape" });
    expect(onCloseSpy).not.toHaveBeenCalled();
    unmountAbove();
  });

  // ==========================================
  // 7. App 隔离性：缩放隔离与 Ask 禁用
  // ==========================================
  it("7. App 隔离性：预览打开期间，Ctrl+滚轮不改变 scale，FloatingAskBar 快捷键与提问被拦截", async () => {
    const { unmount } = render(<App />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const zoomTag = screen.getByTitle("当前阅读缩放 (Ctrl+滚轮 或 Ctrl+加号/减号)");
    expect(zoomTag.textContent).toContain("135%");

    // 打开工具菜单
    const toolsBtn = screen.getByText("工具 (Tools)");
    fireEvent.click(toolsBtn);

    // 点击打开预览
    const menuItem = screen.getByText("打开解析结果预览…");
    fireEvent.click(menuItem);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 确认预览已挂载
    expect(screen.getByText("解析预览")).not.toBeNull();

    // 模拟 window wheel 事件 (Ctrl + 滚轮向上)
    const wheelEvt = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(wheelEvt);
    expect(zoomTag.textContent).toContain("135%");

    // 模拟按下 '/' 键
    const askInput = screen.getByPlaceholderText(/在正文下方随时提问或探讨/i) as HTMLInputElement;
    expect(askInput.disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    expect(document.activeElement).not.toBe(askInput);

    // 模拟在 Ask 输入框按 Enter
    fireEvent.keyDown(askInput, { key: "Enter", ctrlKey: true });
    const invoked = mockInvoke.mock.calls.map((c) => c[0]);
    expect(invoked).not.toContain("db_create_card");

    // 关闭预览后，缩放恢复
    const closeBtn = screen.getByText("关闭预览 (Esc)");
    fireEvent.click(closeBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    await act(async () => {
      window.dispatchEvent(wheelEvt);
    });
    expect(zoomTag.textContent).toContain("145%");

    unmount();
  });

  // ==========================================
  // 8. 切换与重选测试
  // ==========================================
  it("8. 切换与重选：支持 A -> B 切换、取消选择保持原文档、再次选择同一路径刷新", async () => {
    let currentTarget = { filePath: "doc_A.json", loadKey: 1 };
    const onOpenAnotherSpy = vi.fn();
    const onCloseSpy = vi.fn();

    const { rerender, unmount } = render(
      <ParsedDocumentPreview
        target={currentTarget}
        onClose={onCloseSpy}
        onOpenAnother={onOpenAnotherSpy}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(mockInvoke).toHaveBeenCalledWith("parsed_preview_open", { path: "doc_A.json" });

    // 切换到 B (loadKey 递增)
    currentTarget = { filePath: "doc_B.json", loadKey: 2 };
    rerender(
      <ParsedDocumentPreview
        target={currentTarget}
        onClose={onCloseSpy}
        onOpenAnother={onOpenAnotherSpy}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(mockInvoke).toHaveBeenCalledWith("parsed_preview_open", { path: "doc_B.json" });

    // 重选同一文件 B (loadKey 递增为 3)
    currentTarget = { filePath: "doc_B.json", loadKey: 3 };
    rerender(
      <ParsedDocumentPreview
        target={currentTarget}
        onClose={onCloseSpy}
        onOpenAnother={onOpenAnotherSpy}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const bOpens = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_preview_open" && (c[1] as any)?.path === "doc_B.json"
    );
    expect(bOpens.length).toBe(2);

    unmount();
  });

  // ==========================================
  // 9. 真实 React.StrictMode 双重挂载与会话清理
  // ==========================================
  it("9. React.StrictMode 生命周期测试：组件在 StrictMode 包裹下正常加载并能在卸载时释放会话", async () => {
    const { unmount } = render(
      <React.StrictMode>
        <ParsedDocumentPreview
          target={{ filePath: "C:\\strict\\blocks.json", loadKey: 1 }}
          onClose={vi.fn()}
          onOpenAnother={vi.fn()}
        />
      </React.StrictMode>
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(screen.getByText("解析预览")).not.toBeNull();

    // 卸载
    unmount();
    expect(mockInvoke).toHaveBeenCalledWith("parsed_preview_close", expect.anything());
  });

  // ==========================================
  // 10. 竞态守卫与卸载后迟到结果丢弃
  // ==========================================
  it("10. 竞态守卫与卸载后迟到结果丢弃：在途请求未完成即卸载或切换时，迟到结果被安全丢弃", async () => {
    const loader = new ParsedDocumentLoader();
    let resolveA: any;
    const promiseA = new Promise((res) => {
      resolveA = res;
    });

    mockInvoke.mockImplementation(async (cmd, args: any) => {
      if (cmd === "parsed_preview_open") {
        if (args.path === "doc_A.json") {
          await promiseA;
          return {
            session_id: "sess_A",
            blocks_path: "doc_A.json",
            doc_dir: "C:\\",
            raw_json: "[{\"id\":\"blk_A\",\"type\":\"paragraph\",\"content\":\"Doc A\"}]",
            has_assets: false,
          };
        }
        if (args.path === "doc_B.json") {
          return {
            session_id: "sess_B",
            blocks_path: "doc_B.json",
            doc_dir: "C:\\",
            raw_json: "[{\"id\":\"blk_B\",\"type\":\"paragraph\",\"content\":\"Doc B\"}]",
            has_assets: false,
          };
        }
      }
      return {};
    });

    const reqA = loader.loadDocument("doc_A.json");
    const reqB = loader.loadDocument("doc_B.json");

    const resultB = await reqB;
    expect(resultB?.result.document?.blocks[0].content).toBe("Doc B");

    resolveA(true);
    const resultA = await reqA;
    expect(resultA).toBeNull();
  });

  // ==========================================
  // 11. 真实操作链路下的零写入断言
  // ==========================================
  it("11. 零写入断言：实际打开预览、查看渲染、切换文件、关闭预览的全程中，绝不调用任何 SQLite 持久化接口", async () => {
    const { unmount } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    // 清空 App 初始化时产生的数据库调用记录
    mockInvoke.mockClear();

    // 1. 打开预览
    const toolsBtn = screen.getByText("工具 (Tools)");
    fireEvent.click(toolsBtn);
    fireEvent.click(screen.getByText("打开解析结果预览…"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.getByText("解析预览")).not.toBeNull();

    // 2. 检查在此过程中产生的 IPC 调用
    const previewInvocations = mockInvoke.mock.calls.map((c) => c[0]);
    // 确认确实调用了解析预览命令
    expect(previewInvocations).toContain("parsed_preview_open");
    // 核心零写入断言：绝不产生任何文档创建、卡片创建、锚点创建、高亮创建或位置持久化
    expect(previewInvocations).not.toContain("db_get_or_create_document");
    expect(previewInvocations).not.toContain("db_create_card");
    expect(previewInvocations).not.toContain("db_create_anchor");
    expect(previewInvocations).not.toContain("db_save_reading_position");
    expect(previewInvocations).not.toContain("db_create_highlight");

    // 3. 关闭预览
    fireEvent.click(screen.getByText("关闭预览 (Esc)"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    unmount();
  });

  // ==========================================
  // 12. 阶段 2A 定点审查修复专项校验
  // ==========================================
  it("12. 定点审查修复：转义成对美元符号原样输出、代码块不泄漏占位符、受控本地图片与外部拦截、inline_runs回退", async () => {
    // 断言 1: Price is \$10 and \$20, while $V_g < V_{out}$
    const { container: cEscDollar } = render(
      <ControlledContentRenderer content="Price is \$10 and \$20, while $V_g < V_{out}$" />
    );
    // $10 and $20 原样输出为纯文本
    expect(cEscDollar.textContent).toContain("Price is $10 and $20, while ");
    // 仅 $V_g < V_{out}$ 生成 .katex 节点
    const katexNodes = cEscDollar.querySelectorAll(".katex");
    expect(katexNodes.length).toBe(1);
    // 确保 $10 和 $20 绝未进入 .katex 节点内部
    katexNodes.forEach((node) => {
      expect(node.textContent).not.toContain("$10");
      expect(node.textContent).not.toContain("$20");
      expect(node.textContent).not.toContain("10 and 20");
    });

    // 断言 2: 代码块 `\$10` 不出现占位符泄漏
    const { container: cCode } = render(
      <ControlledContentRenderer content={"行内代码 `\\$10` 与代码块：\n```\n\\$10\n```"} />
    );
    expect(cCode.textContent).not.toContain(ESCAPED_DOLLAR_PLACEHOLDER);
    expect(cCode.textContent).not.toContain("FR_ESC_DL");
    const codeBlocks = cCode.querySelectorAll("code");
    expect(codeBlocks.length).toBe(2);
    expect(codeBlocks[0].textContent).toBe("\\$10");
    expect(codeBlocks[1].textContent).toContain("\\$10");

    // 断言 3: 内联本地图片 ![circuit](assets/fig1.jpg) 调用 loadAsset 渲染，而 ![ext](https://example.com/a.jpg) 被拦截为 .parsed-restricted-media
    const mockAssetMgr = {
      loadAsset: vi.fn().mockImplementation(async (ref: string) => {
        if (ref === "assets/fig1.jpg") return "blob:flowread-local-fig1";
        return null;
      }),
    } as unknown as ParsedAssetManager;

    const { container: cImg } = render(
      <ControlledContentRenderer
        content={"![circuit](assets/fig1.jpg)\n\n![ext](https://example.com/a.jpg)"}
        assetManager={mockAssetMgr}
      />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // 本地图片调用 loadAsset 并成功渲染为 img
    expect(mockAssetMgr.loadAsset).toHaveBeenCalledWith("assets/fig1.jpg");
    const localImg = cImg.querySelector("img.parsed-inline-image");
    expect(localImg).not.toBeNull();
    expect(localImg?.getAttribute("src")).toBe("blob:flowread-local-fig1");
    expect(localImg?.getAttribute("alt")).toBe("circuit");

    // 外部图片被拦截并展示 .parsed-restricted-media
    const restrictedMedia = cImg.querySelector(".parsed-restricted-media");
    expect(restrictedMedia).not.toBeNull();
    expect(restrictedMedia?.textContent).toContain("[外部图片已拦截]");
    // 外部图片绝不触发 loadAsset
    expect(mockAssetMgr.loadAsset).not.toHaveBeenCalledWith("https://example.com/a.jpg");

    // 断言 4: 带有 inline_runs (含 equation_inline) 但 content 未加 $ 的段落块
    // 该 content 中的公式是 Unicode 呈现（≈），runs 中是 LaTeX（\approx）。
    // 在不做 Unicode / LaTeX 语义等价推断的前提下无法证明一一对应，
    // 因此按“无法确认归属即保留原文”的规则处理：正文原样保留，不凭空改写或补公式。
    const blockWithRuns: ParsedBlock = {
      id: "blk_fallback_test",
      type: "paragraph",
      reading_order: 1,
      // 故意不带 $，模拟旧版提取丢失数学标记的退化 content
      content: "Under small-ripple assumption, v ≈ V holds true.",
      inline_runs: [
        { type: "text", content: "Under small-ripple assumption, " },
        { type: "equation_inline", content: "v \\approx V" },
        { type: "text", content: " holds true." },
      ],
    };

    // 1) 辅助函数必须原样保留正文
    const synthesized = getRenderableBlockContent(blockWithRuns);
    expect(synthesized).toBe("Under small-ripple assumption, v ≈ V holds true.");

    // 2) 验证 ParsedBlockView 完整渲染：文字无损，且不把无法对应的公式硬塞进正文
    const dummyAssetMgr = new ParsedAssetManager("dummy_session");
    const { container: cBlock } = render(
      <ParsedBlockView block={blockWithRuns} assetManager={dummyAssetMgr} />
    );

    expect(readableText(cBlock.querySelector(".parsed-paragraph-container"))).toBe(
      "Under small-ripple assumption, v ≈ V holds true."
    );
    expect(cBlock.querySelectorAll(".katex").length).toBe(0);
  });

  // ==========================================
  // 阶段 2B：应用内部隐式解析工作区与文档级无纸化重排视图切换
  // ==========================================
  it("15. 视图切换药丸按钮：当文档存在已激活隐式解析工作区时显示，默认原版视图，点击切换为流式重排视图", async () => {
    mockInvoke.mockImplementation(async (cmd, _args: any) => {
      if (cmd === "parsed_workspace_get_active") {
        return {
          version_id: "ver_test_01",
          document_id: "doc_test",
          source_revision: "v1", // 与默认打开的 intro 虚拟文档 revision "v1" 一致
          provider: "mineru",
          block_count: 12,
          asset_count: 5,
          created_at: Date.now(),
          session_id: "session_test_01",
          blocks_path: "C:\\test\\mineru\\normalized\\blocks.json",
          doc_dir: "C:\\test\\mineru\\normalized",
          raw_json: JSON.stringify(SYNTHETIC_MINERU_BLOCKS),
          has_assets: true,
        };
      }
      if (cmd === "get_file_metadata") {
        return { size: 100, mtime: 1000, revision: "v1" };
      }
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "read_local_file") return "# 测试内置正文";
      return {};
    });

    const { unmount } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 检查视图切换胶囊按钮出现
    const reflowToggleBtn = screen.getByRole("button", { name: "流式重排" });
    const originalToggleBtn = screen.getByRole("button", { name: "原版视图" });
    expect(reflowToggleBtn).not.toBeNull();
    expect(originalToggleBtn).not.toBeNull();

    // 默认处于“原版视图”高亮
    expect(originalToggleBtn.classList.contains("is-active")).toBe(true);
    expect(reflowToggleBtn.classList.contains("is-active")).toBe(false);

    // 点击“流式重排”
    await act(async () => {
      fireEvent.click(reflowToggleBtn);
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(reflowToggleBtn.classList.contains("is-active")).toBe(true);
    expect(originalToggleBtn.classList.contains("is-active")).toBe(false);

    // 检查流式重排区域被渲染
    const reflowArea = screen.getByRole("region", { name: "FlowRead 流式重排阅读区" });
    expect(reflowArea).not.toBeNull();
    // 渲染了 MinerU 的图文与公式
    expect(reflowArea.textContent).toContain("Under small-ripple assumption, ");
    expect(reflowArea.textContent).toContain("Fig. 2.11 Boost converter circuit");

    // 点击切换回“原版视图”
    await act(async () => {
      fireEvent.click(originalToggleBtn);
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(originalToggleBtn.classList.contains("is-active")).toBe(true);
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();

    unmount();
  });

  it("16. 源文档版本不一致警示：当 source_revision 与文档当前 revision 不一致时显示警示条与小黄点", async () => {
    mockInvoke.mockImplementation(async (cmd, args: any) => {
      if (cmd === "parsed_workspace_get_active") {
        return {
          version_id: "ver_test_mismatch",
          document_id: "doc_test",
          source_revision: "old_rev_9999", // 与 doc 当前 revision ("v1") 不一致
          provider: "datalab",
          block_count: 10,
          asset_count: 2,
          created_at: Date.now(),
          session_id: "session_mismatch",
          blocks_path: "C:\\test\\datalab\\normalized\\blocks.json",
          doc_dir: "C:\\test\\datalab\\normalized",
          raw_json: JSON.stringify(SYNTHETIC_DATALAB_BLOCKS),
          has_assets: true,
        };
      }
      if (cmd === "get_file_metadata") {
        return { size: 100, mtime: 1000, revision: "v1" };
      }
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "db_get_or_create_document") {
        return {
          id: "doc_test",
          file_path: args.filePath,
          display_name: args.displayName,
          file_size_bytes: 100,
          revision: "v1",
          last_opened_at: Date.now(),
          reading_position_json: null,
          created_at: Date.now(),
        };
      }
      if (cmd === "read_local_file") return "# 测试内置正文";
      return {};
    });

    const { unmount, container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 检查按钮内的小黄点
    const dot = container.querySelector(".view-mode-outdated-dot");
    expect(dot).not.toBeNull();

    // 点击切换到流式重排
    const reflowToggleBtn = screen.getByRole("button", { name: /流式重排/i });
    await act(async () => {
      fireEvent.click(reflowToggleBtn);
      await new Promise((r) => setTimeout(r, 30));
    });

    // 检查提示横幅
    const warningNotice = container.querySelector(".parsed-reflow-revision-warning");
    expect(warningNotice).not.toBeNull();
    expect(warningNotice?.textContent).toContain("源文档自解析以来已发生变更");
    expect(warningNotice?.textContent).toContain("old_rev_9999");

    unmount();
  });

  it("17. 解析预览层通过「绑定到当前文档」原子持久化并自动切换到重排视图", async () => {
    let activeWorkspace: any = null;
    mockInvoke.mockImplementation(async (cmd, args: any) => {
      if (cmd === "parsed_workspace_get_active") {
        return activeWorkspace;
      }
      if (cmd === "parsed_workspace_import_dir") {
        activeWorkspace = {
          version_id: "ver_imported_1",
          document_id: args.documentId,
          source_revision: args.sourceRevision,
          provider: "manual_import",
          block_count: 12,
          asset_count: 5,
          created_at: Date.now(),
          session_id: "session_imported_1",
          blocks_path: args.sourceBlocksPath,
          doc_dir: "C:\\synthetic",
          raw_json: JSON.stringify(SYNTHETIC_MINERU_BLOCKS),
          has_assets: true,
        };
        return activeWorkspace;
      }
      if (cmd === "parsed_preview_open") {
        return {
          session_id: "session_prev_123",
          blocks_path: args.path,
          doc_dir: "C:\\synthetic",
          raw_json: JSON.stringify(SYNTHETIC_MINERU_BLOCKS),
          has_assets: true,
        };
      }
      if (cmd === "parsed_preview_close") return {};
      if (cmd === "get_file_metadata") {
        return { size: 100, mtime: 1000, revision: "v1" };
      }
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "read_local_file") return "# 测试内置正文";
      return {};
    });

    mockOpen.mockResolvedValue("C:\\synthetic\\mineru\\blocks.json");

    const { unmount, container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 初始没有 active workspace，不显示切换胶囊
    expect(container.querySelector(".view-mode-toggle-group")).toBeNull();

    // 打开工具菜单 -> 打开解析结果预览
    const toolsBtn = screen.getByText("工具 (Tools)");
    fireEvent.click(toolsBtn);
    const previewItem = screen.getByText("打开解析结果预览…");
    fireEvent.click(previewItem);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 预览层打开，并渲染「绑定到当前文档」按钮
    const bindBtn = screen.getByRole("button", { name: "绑定到当前文档" });
    expect(bindBtn).not.toBeNull();

    // 点击「绑定到当前文档」
    await act(async () => {
      fireEvent.click(bindBtn);
      await new Promise((r) => setTimeout(r, 50));
    });

    // 预览层被关闭，主界面出现切换胶囊且直接激活流式重排视图
    expect(screen.queryByRole("region", { name: "FlowRead 解析结果预览" })).toBeNull();
    expect(container.querySelector(".view-mode-toggle-group")).not.toBeNull();
    const reflowArea = screen.getByRole("region", { name: "FlowRead 流式重排阅读区" });
    expect(reflowArea).not.toBeNull();

    unmount();
  });

  // ==========================================
  // 18. ControlledContentRenderer 转义美元符号在公式内与代码内的鲁棒性
  // ==========================================
  it("18. ControlledContentRenderer: 成对转义美元符号保护、公式内合法转义 \\$ 与代码字面量原样保留", async () => {
    // 文本包含：成对转义美元符号 \$10 和 \$20、公式内部转义 $x_{\$}=1$ 以及正常公式 $V_g$
    const content = "Price is \\$10 and \\$20, while formula is $x_{\\$}=1$ and $V_g$.";
    const { container } = render(<ControlledContentRenderer content={content} />);

    // 1. 转义符号原样渲染为普通文本 $10 和 $20
    expect(container.textContent).toContain("Price is $10 and $20, while formula is ");

    // 2. 公式生成 KaTeX 节点
    const katexNodes = container.querySelectorAll(".katex");
    expect(katexNodes.length).toBeGreaterThanOrEqual(2);

    // 3. 校验公式内转义 \\$ 未破坏 KaTeX 语法，且未泄漏占位符
    expect(container.textContent).not.toContain(ESCAPED_DOLLAR_PLACEHOLDER);
    expect(container.textContent).not.toContain("FR_ESC_DL");
  });

  // ==========================================
  // 19. ParsedBlock getRenderableBlockContent 货币符号不阻断 inline_runs
  // ==========================================
  it("19. ParsedBlock: 当正文中出现货币符号 $10 或转义符号时，不错误阻断未定界 inline_runs 的公式补全", () => {
    const blockWithCurrency: ParsedBlock = {
      id: "blk_currency_math",
      type: "paragraph",
      reading_order: 1,
      // 正文中含有 $10，但公式 V_g 未定界
      content: "The price is $10 and the small-signal voltage is V_g.",
      inline_runs: [
        { type: "text", content: "The price is $10 and the small-signal voltage is " },
        { type: "equation_inline", content: "V_g" },
        { type: "text", content: "." },
      ],
    };

    const synthesized = getRenderableBlockContent(blockWithCurrency);
    // 验证：文本 run 中的未转义 $10 被安全转义为 \$10，同时 V_g 正确补全了定界符 $V_g$
    expect(synthesized).toBe("The price is \\$10 and the small-signal voltage is $V_g$.");

    // 完整 runs 的金额与公式混排必须真实渲染正确：$10 留在普通文字，V_g 成为公式
    const mgr = new ParsedAssetManager("dummy_session");
    const { container } = render(
      <ParsedBlockView block={blockWithCurrency} assetManager={mgr} />
    );
    const paragraph = container.querySelector(".parsed-paragraph-container")!;
    expect(textWithoutMath(paragraph)).toBe(
      "The price is $10 and the small-signal voltage is ."
    );
    const texs = katexTexs(paragraph);
    expect(texs.length).toBe(1);
    expect(texs[0]).toContain("V_g");
    expect(paragraph.querySelector(".katex")?.textContent).not.toContain("10");
  });

  // ==========================================
  // 20. 重排视图交互隔离闭环
  // ==========================================
  it("20. 重排视图交互隔离闭环：小地图隐藏、虚线层不渲染、AskBar 禁用且更新提示、滚轮与快捷键缩放锁定", async () => {
    mockInvoke.mockImplementation(async (cmd, _args: any) => {
      if (cmd === "parsed_workspace_get_active") {
        return {
          version_id: "ver_isolation_01",
          document_id: "doc_test",
          source_revision: "v1",
          provider: "mineru",
          block_count: 5,
          asset_count: 0,
          created_at: Date.now(),
          session_id: "sess_iso_01",
          blocks_path: "C:\\test\\blocks.json",
          doc_dir: "C:\\test",
          raw_json: JSON.stringify([
            { id: "b1", type: "paragraph", content: "重排正文段落" },
          ]),
          has_assets: false,
        };
      }
      if (cmd === "get_file_metadata") return { size: 100, mtime: 1000, revision: "v1" };
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "read_local_file") return "# 测试内置正文";
      return {};
    });

    const { unmount, container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 初始原版视图下：小地图存在
    expect(container.querySelector(".workspace-minimap-column")).not.toBeNull();

    // 切换至流式重排视图
    const reflowToggleBtn = screen.getByRole("button", { name: "流式重排" });
    await act(async () => {
      fireEvent.click(reflowToggleBtn);
      await new Promise((r) => setTimeout(r, 40));
    });

    // 1. 小地图在重排模式下完全隐藏
    expect(container.querySelector(".workspace-minimap-column")).toBeNull();

    // 2. 关联虚线层不渲染
    expect(container.querySelector(".connection-lines-svg")).toBeNull();

    // 3. AskBar 处于禁用状态且包含重排模式提示文字（提示先划选文字）
    const askInput = screen.getByPlaceholderText(/请先在重排正文中选择一段文字/i);
    expect(askInput).not.toBeNull();
    expect((askInput as HTMLTextAreaElement).disabled).toBe(true);

    // 4. Ctrl+滚轮缩放与 Ctrl+= 快捷键在重排模式下被锁定（不修改 scale）
    const zoomTag = container.querySelector(".status-zoom-percentage")!;
    expect(zoomTag.textContent).toContain("135%");

    // 尝试 Ctrl+滚轮
    const wheelEvt = new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, bubbles: true });
    await act(async () => {
      window.dispatchEvent(wheelEvt);
    });
    expect(zoomTag.textContent).toContain("135%"); // 保持 135% 不变

    // 尝试 Ctrl+=
    const keyEvt = new KeyboardEvent("keydown", { ctrlKey: true, key: "=", bubbles: true });
    await act(async () => {
      window.dispatchEvent(keyEvt);
    });
    expect(zoomTag.textContent).toContain("135%"); // 保持 135% 不变

    // 5. 原版阅读器保持挂载但在 DOM 中 display: none
    const originalWrapper = container.querySelector(".workspace-reader-column > div") as HTMLElement;
    expect(originalWrapper).not.toBeNull();
    expect(originalWrapper.style.display).toBe("none");

    unmount();
  });

  // ==========================================
  // 21. 双视图阅读位置保持与卡片“定位原文”联动
  // ==========================================
  it("21. 双视图切换闭环：会话级阅读位置单次温和保持，卡片“定位原文”自动切回原版视图", async () => {
    mockInvoke.mockImplementation(async (cmd, _args: any) => {
      if (cmd === "parsed_workspace_get_active") {
        return {
          version_id: "ver_jump_01",
          document_id: "doc_test",
          source_revision: "v1",
          provider: "mineru",
          block_count: 5,
          asset_count: 0,
          created_at: Date.now(),
          session_id: "sess_jump_01",
          blocks_path: "C:\\test\\blocks.json",
          doc_dir: "C:\\test",
          raw_json: JSON.stringify([
            { id: "b1", type: "paragraph", content: "重排正文" },
          ]),
          has_assets: false,
        };
      }
      if (cmd === "get_file_metadata") return { size: 100, mtime: 1000, revision: "v1" };
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors") {
        return [
          {
            anchor_id: "anc_001",
            document_id: "doc_test",
            document_revision: "v1",
            source_type: "text_segment",
            location_json: JSON.stringify({
              type: "text_segment",
              segments: [{ paragraphIndex: 0, startOffset: 0, endOffset: 5 }],
            }),
            excerpt: "测试片段",
            created_at: Date.now(),
          },
        ];
      }
      if (cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards_by_anchor_ids") return [];
      if (cmd === "db_get_cards") {
        return {
          items: [
            {
              card_id: "card_001",
              document_id: "doc_test",
              anchor_id: "anc_001",
              action: "Ask",
              status: "completed",
              user_prompt: "提问测试",
              ai_response: "回答测试",
              created_at: Date.now(),
              updated_at: Date.now(),
            },
          ],
          total: 1,
        };
      }
      if (cmd === "read_local_file") return "# 测试内置正文";
      return {};
    });

    const { unmount, container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 切换到重排模式
    const reflowToggleBtn = screen.getByRole("button", { name: "流式重排" });
    await act(async () => {
      fireEvent.click(reflowToggleBtn);
      await new Promise((r) => setTimeout(r, 40));
    });

    const reflowArea = screen.getByRole("region", { name: "FlowRead 流式重排阅读区" });
    expect(reflowArea).not.toBeNull();

    // 模拟重排模式内滚动
    const scrollMain = container.querySelector(".parsed-reflow-scroll-area");
    expect(scrollMain).not.toBeNull();
    await act(async () => {
      fireEvent.scroll(scrollMain!, { target: { scrollTop: 280 } });
      await new Promise((r) => setTimeout(r, 20));
    });

    // 在重排模式下，原版卡片在「记录本」中访问，切换到记录本点击“回到原文位置”
    const recordsTabBtn = screen.getByText("记录本");
    await act(async () => {
      fireEvent.click(recordsTabBtn);
      await new Promise((r) => setTimeout(r, 40));
    });

    const jumpBtn = await screen.findByTitle("回到原文位置");
    await act(async () => {
      fireEvent.click(jumpBtn);
      await new Promise((r) => setTimeout(r, 40));
    });

    // 核心断言：自动切换回“原版视图”
    const originalToggleBtn = screen.getByRole("button", { name: "原版视图" });
    expect(originalToggleBtn.classList.contains("is-active")).toBe(true);
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();

    unmount();
  });

  // ==========================================
  // 22. 切换文档与过时会话显式释放
  // ==========================================
  it("22. 会话生命周期与防泄漏：切换文档时通过 apiParsedPreviewClose 显式释放旧会话", async () => {
    mockInvoke.mockImplementation(async (cmd, _args: any) => {
      if (cmd === "parsed_workspace_get_active") {
        return {
          version_id: "ver_sess_leak_01",
          document_id: "doc_test",
          source_revision: "v1",
          provider: "mineru",
          block_count: 5,
          asset_count: 0,
          created_at: Date.now(),
          session_id: "sess_to_be_closed_123",
          blocks_path: "C:\\test\\blocks.json",
          doc_dir: "C:\\test",
          raw_json: "[]",
          has_assets: false,
        };
      }
      if (cmd === "parsed_preview_close") {
        return {};
      }
      if (cmd === "get_file_metadata") return { size: 100, mtime: 1000, revision: "v1" };
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "read_local_file") return "# 测试正文";
      return {};
    });

    const { unmount } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 卸载组件（模拟关闭应用或切换上下文）
    unmount();

    // 验证：调用了 parsed_preview_close 释放了会话
    const closeCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_preview_close" && (c[1] as any)?.sessionId === "sess_to_be_closed_123"
    );
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ==========================================
  // 23. 同文档下迟到的 getActive 响应不覆盖新导入版本
  // ==========================================
  it("23. 竞态防御：同文档下迟到的 getActive 响应不覆盖新导入的解析版本，且释放旧会话", async () => {
    let resolveGetActive: (val: any) => void;
    const pendingGetActive = new Promise((resolve) => {
      resolveGetActive = resolve;
    });

    mockInvoke.mockImplementation(async (cmd, _args: any) => {
      if (cmd === "parsed_workspace_get_active") {
        return pendingGetActive;
      }
      if (cmd === "parsed_workspace_import_dir") {
        return {
          version_id: "ver_new_imported",
          document_id: "doc_test",
          source_revision: "v1",
          provider: "mineru",
          block_count: 5,
          asset_count: 0,
          created_at: Date.now(),
          session_id: "sess_new_imported_999",
          blocks_path: "C:\\synthetic\\blocks.json",
          doc_dir: "C:\\synthetic",
          raw_json: JSON.stringify([{ id: "b1", type: "paragraph", content: "新导入版本正文" }]),
          has_assets: false,
        };
      }
      if (cmd === "parsed_preview_close") return {};
      if (cmd === "get_file_metadata") return { size: 100, mtime: 1000, revision: "v1" };
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "read_local_file") return "# 测试内置正文";
      return {};
    });

    mockOpen.mockResolvedValue("C:\\synthetic\\blocks.json");

    const { unmount, container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 触发导入（此时 initial getActive 仍在挂起）
    const toolsBtn = screen.getByText("工具 (Tools)");
    fireEvent.click(toolsBtn);
    const importItem = screen.getByText("导入/绑定解析结果到当前文档…");
    await act(async () => {
      fireEvent.click(importItem);
      await new Promise((r) => setTimeout(r, 60));
    });

    // 确认已成功导入并切换至流式重排视图，渲染新版本内容
    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("新导入版本正文");

    // 此时迟到的旧 getActive 终于返回
    await act(async () => {
      resolveGetActive({
        version_id: "ver_old_stale",
        document_id: "doc_test",
        source_revision: "v1",
        provider: "mineru",
        block_count: 5,
        asset_count: 0,
        created_at: Date.now() - 10000,
        session_id: "sess_old_stale_111",
        blocks_path: "C:\\old\\blocks.json",
        doc_dir: "C:\\old",
        raw_json: JSON.stringify([{ id: "b1", type: "paragraph", content: "过时旧版本" }]),
        has_assets: false,
      });
      await new Promise((r) => setTimeout(r, 60));
    });

    // 断言：界面仍然保留新版本内容，绝不被过时旧版本覆盖
    expect(container.textContent).toContain("新导入版本正文");
    expect(container.textContent).not.toContain("过时旧版本");

    // 断言：迟到响应携带的 sess_old_stale_111 会话被调用 parsed_preview_close 及时释放
    const closeCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_preview_close" && (c[1] as any)?.sessionId === "sess_old_stale_111"
    );
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);

    unmount();
  });

  // ==========================================
  // 24. 选书防乱序拦截
  // ==========================================
  it("24. 选书防乱序拦截：导入进行中切换书籍，导入结果安全丢弃并释放会话", async () => {
    let resolveImport: (val: any) => void;
    const pendingImport = new Promise((resolve) => {
      resolveImport = resolve;
    });

    mockInvoke.mockImplementation(async (cmd, _args: any) => {
      if (cmd === "parsed_workspace_get_active") return null;
      if (cmd === "parsed_workspace_import_dir") {
        return pendingImport;
      }
      if (cmd === "parsed_preview_close") return {};
      if (cmd === "get_file_metadata") return { size: 100, mtime: 1000, revision: "v1" };
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "read_local_file") return "# 当前文档正文";
      return {};
    });

    mockOpen.mockResolvedValue("C:\\synthetic\\blocks.json");

    const { unmount } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 打开工具菜单 -> 点击导入
    const toolsBtn = screen.getByText("工具 (Tools)");
    fireEvent.click(toolsBtn);
    const importItem = screen.getByText("导入/绑定解析结果到当前文档…");
    fireEvent.click(importItem);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // 在导入请求在途中（pending），用户在工作区管理中切换了书籍
    const workspaceBtn = screen.getByText("工作区 (Workspace)");
    fireEvent.click(workspaceBtn);
    mockOpen.mockResolvedValueOnce("C:\\docs\\bookB.txt");
    const openFileItem = screen.getByText("打开本地文件...");
    await act(async () => {
      fireEvent.click(openFileItem);
      await new Promise((r) => setTimeout(r, 60));
    });

    // 此时原书籍的导入请求终于完成并返回
    await act(async () => {
      resolveImport({
        version_id: "ver_docA_imported",
        document_id: "doc_test",
        source_revision: "v1",
        provider: "mineru",
        block_count: 5,
        asset_count: 0,
        created_at: Date.now(),
        session_id: "sess_docA_leak_check",
        blocks_path: "C:\\synthetic\\blocks.json",
        doc_dir: "C:\\synthetic",
        raw_json: JSON.stringify([{ id: "b1", type: "paragraph", content: "书籍A的解析内容" }]),
        has_assets: false,
      });
      await new Promise((r) => setTimeout(r, 60));
    });

    // 断言：由于书籍已切换，书籍A的导入结果被安全丢弃，不显示重排区
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();

    // 断言：会话 sess_docA_leak_check 被 parsed_preview_close 显式关闭
    const closeCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_preview_close" && (c[1] as any)?.sessionId === "sess_docA_leak_check"
    );
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);

    unmount();
  });

  // ==========================================
  // 25. 卸载防泄漏
  // ==========================================
  it("25. 卸载防泄漏：组件卸载后在途的 getActive/import 响应安全丢弃并关闭会话", async () => {
    let resolveGetActive: (val: any) => void;
    const pendingGetActive = new Promise((resolve) => {
      resolveGetActive = resolve;
    });

    mockInvoke.mockImplementation(async (cmd, _args: any) => {
      if (cmd === "parsed_workspace_get_active") return pendingGetActive;
      if (cmd === "parsed_preview_close") return {};
      if (cmd === "get_file_metadata") return { size: 100, mtime: 1000, revision: "v1" };
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "read_local_file") return "# 正文";
      return {};
    });

    const { unmount } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    // 组件卸载
    unmount();

    // 在途请求在组件卸载后返回
    await act(async () => {
      resolveGetActive({
        version_id: "ver_unmount_01",
        document_id: "doc_test",
        source_revision: "v1",
        provider: "mineru",
        block_count: 5,
        asset_count: 0,
        created_at: Date.now(),
        session_id: "sess_unmount_discard_99",
        blocks_path: "C:\\synthetic\\blocks.json",
        doc_dir: "C:\\synthetic",
        raw_json: "[]",
        has_assets: false,
      });
      await new Promise((r) => setTimeout(r, 40));
    });

    // 断言：sess_unmount_discard_99 必定被 parsed_preview_close 显式释放
    const closeCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_preview_close" && (c[1] as any)?.sessionId === "sess_unmount_discard_99"
    );
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ==========================================
  // 26. 文件选择取消与忙锁释放
  // ==========================================
  it("26. 文件选择取消：用户取消选择解析文件后正确释放忙锁，可再次调起导入", async () => {
    mockInvoke.mockImplementation(async (cmd, _args: any) => {
      if (cmd === "parsed_workspace_get_active") return null;
      if (cmd === "parsed_workspace_import_dir") {
        return {
          version_id: "ver_imported_after_cancel",
          document_id: "doc_test",
          source_revision: "v1",
          provider: "mineru",
          block_count: 3,
          asset_count: 0,
          created_at: Date.now(),
          session_id: "sess_after_cancel",
          blocks_path: "C:\\synthetic\\blocks.json",
          doc_dir: "C:\\synthetic",
          raw_json: JSON.stringify([{ id: "b1", type: "paragraph", content: "二次导入成功" }]),
          has_assets: false,
        };
      }
      if (cmd === "parsed_preview_close") return {};
      if (cmd === "get_file_metadata") return { size: 100, mtime: 1000, revision: "v1" };
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "read_local_file") return "# 正文";
      return {};
    });

    // 第一次：用户点击取消 (open 返回 null)
    mockOpen.mockResolvedValueOnce(null);

    const { unmount, container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const toolsBtn = screen.getByText("工具 (Tools)");
    fireEvent.click(toolsBtn);
    const importItem = screen.getByText("导入/绑定解析结果到当前文档…");
    await act(async () => {
      fireEvent.click(importItem);
      await new Promise((r) => setTimeout(r, 40));
    });

    // 状态未改变，依然没有重排区域
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();

    // 第二次：用户选择有效路径，忙锁必须已释放，能够再次调起
    mockOpen.mockResolvedValueOnce("C:\\synthetic\\blocks.json");
    fireEvent.click(toolsBtn);
    const importItemSecond = screen.getByText("导入/绑定解析结果到当前文档…");
    await act(async () => {
      fireEvent.click(importItemSecond);
      await new Promise((r) => setTimeout(r, 60));
    });

    // 验证第二次导入正常成功
    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("二次导入成功");

    unmount();
  });

  // ==========================================
  // 27. React.StrictMode 兼容性
  // ==========================================
  it("27. React.StrictMode 生命周期：双重挂载与重排模式下正常渲染与卸载清理", async () => {
    mockInvoke.mockImplementation(async (cmd, _args: any) => {
      if (cmd === "parsed_workspace_get_active") {
        return {
          version_id: "ver_strict_mode_01",
          document_id: "doc_test",
          source_revision: "v1",
          provider: "mineru",
          block_count: 2,
          asset_count: 0,
          created_at: Date.now(),
          session_id: "sess_strict_mode",
          blocks_path: "C:\\synthetic\\blocks.json",
          doc_dir: "C:\\synthetic",
          raw_json: JSON.stringify([{ id: "b1", type: "paragraph", content: "严格模式测试正文" }]),
          has_assets: false,
        };
      }
      if (cmd === "parsed_preview_close") return {};
      if (cmd === "get_file_metadata") return { size: 100, mtime: 1000, revision: "v1" };
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "read_local_file") return "# 正文";
      return {};
    });

    const { unmount, container } = render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });

    // 确认视图切换按钮正常出现
    const reflowToggleBtn = screen.getByRole("button", { name: "流式重排" });
    expect(reflowToggleBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(reflowToggleBtn);
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("严格模式测试正文");

    unmount();
  });

  // ==========================================
  // 28. 残缺 inline_runs 与周围正文完整保真
  // ==========================================
  it("28. ParsedBlock getRenderableBlockContent: 残缺 inline_runs 严密保留周围正文，定点定界未包裹公式且不破坏货币符号", () => {
    // 场景 a: 缺失 text run，仅有 math run（如只有公式被识别为 run，正文未被分流）
    // 必须保留原始 content 正文，且把未包裹的公式补充 $
    const blockA: ParsedBlock = {
      id: "blkA",
      type: "paragraph",
      reading_order: 1,
      content: "The circuit operates at frequency f_s = 100kHz and produces output voltage V_o.",
      inline_runs: [
        { type: "equation_inline", content: "f_s = 100kHz" },
        { type: "equation_inline", content: "V_o" },
      ],
    };
    const resA = getRenderableBlockContent(blockA);
    expect(resA).toBe("The circuit operates at frequency $f_s = 100kHz$ and produces output voltage $V_o$.");

    // 场景 b: 正文中包含货币符号 $10，且有未包裹公式 eta 和 G
    // 定点补全公式后，正文中的裸 $ 必须转义为 \$，否则会与补出的定界符配成假公式吞掉正文
    const blockB: ParsedBlock = {
      id: "blkB",
      type: "paragraph",
      reading_order: 2,
      content: "Cost is $10 while efficiency eta and gain G are measured.",
      inline_runs: [
        { type: "equation_inline", content: "eta" },
        { type: "equation_inline", content: "G" },
      ],
    };
    const resB = getRenderableBlockContent(blockB);
    expect(resB).toBe("Cost is \\$10 while efficiency $eta$ and gain $G$ are measured.");
    // 渲染层还原后仍是普通文字 $10，不产生额外公式
    expect(resB.replace(/\\\$/g, "$")).toContain("Cost is $10 while");

    // 场景 c: 混合场景，部分公式已在 content 中带有 $...$，部分未定界
    const blockC: ParsedBlock = {
      id: "blkC",
      type: "paragraph",
      reading_order: 3,
      content: "Given $v_L(t) = V_g$, then i_C(t) = -v(t)/R holds.",
      inline_runs: [
        { type: "equation_inline", content: "$v_L(t) = V_g$" },
        { type: "equation_inline", content: "i_C(t) = -v(t)/R" },
      ],
    };
    const resC = getRenderableBlockContent(blockC);
    expect(resC).toBe("Given $v_L(t) = V_g$, then $i_C(t) = -v(t)/R$ holds.");
    expect(resC).not.toContain("$$v_L(t)");
  });

  // ==========================================
  // 29. 重排视图滚动位置版本隔离（真正改变版本，真正断言 scrollTop）
  // ==========================================
  it("29. 重排视图滚动位置版本隔离：同版本切回恢复到实际 350，导入新版本实际归零", async () => {
    let currentVersionId = "ver_scroll_v1";
    let currentBody = "版本一正文";

    mockInvoke.mockImplementation(async (cmd, _args: any) => {
      if (cmd === "parsed_workspace_get_active") {
        return makeActiveWorkspace(currentVersionId, currentBody);
      }
      if (cmd === "parsed_workspace_import_dir") {
        currentVersionId = "ver_scroll_v2";
        currentBody = "版本二正文";
        return makeActiveWorkspace(currentVersionId, currentBody);
      }
      if (cmd === "parsed_preview_close") return {};
      if (cmd === "get_file_metadata") return { size: 100, mtime: 1000, revision: "v1" };
      if (cmd === "db_get_reading_preferences") return null;
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
      if (cmd === "db_get_cards") return { items: [], total: 0 };
      if (cmd === "read_local_file") return "# 正文";
      return {};
    });
    mockOpen.mockResolvedValue("C:\\synthetic\\blocks.json");

    const { unmount, container } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // 1. 进入重排视图（ver_scroll_v1）
    const reflowToggleBtn = screen.getByRole("button", { name: "流式重排" });
    await act(async () => {
      fireEvent.click(reflowToggleBtn);
      await new Promise((r) => setTimeout(r, 40));
    });
    const scrollArea = container.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
    expect(scrollArea).not.toBeNull();
    expect(container.textContent).toContain("版本一正文");

    // 2. 在 ver_scroll_v1 实际滚动到 350，位置按版本记录
    await act(async () => {
      fireEvent.scroll(scrollArea, { target: { scrollTop: 350 } });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(scrollArea.scrollTop).toBe(350);

    // 3. 切回原版视图（重排组件卸载），再切回重排：同版本必须恢复真实位置 350
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "原版视图" }));
      await new Promise((r) => setTimeout(r, 40));
    });
    await act(async () => {
      fireEvent.click(reflowToggleBtn);
      await new Promise((r) => setTimeout(r, 40));
    });
    const restoredArea = container.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
    expect(restoredArea).not.toBeNull();
    expect(restoredArea.scrollTop).toBe(350);

    // 4. 保持重排视图不变，真正导入新解析版本：新版本没有任何位置记录，必须实际回到顶部
    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入/绑定解析结果到当前文档…"));
      await new Promise((r) => setTimeout(r, 80));
    });

    const newVersionArea = container.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
    expect(newVersionArea).not.toBeNull();
    // 版本确实发生变化
    expect(container.textContent).toContain("版本二正文");
    expect(container.textContent).not.toContain("版本一正文");
    // 复用 DOM 中残留的 350 必须被真正清除
    expect(newVersionArea.scrollTop).toBe(0);

    // 5. 新版本内部滚动后再切换视图，仍按新版本自己的记录恢复，不串用旧版本位置
    await act(async () => {
      fireEvent.scroll(newVersionArea, { target: { scrollTop: 120 } });
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "原版视图" }));
      await new Promise((r) => setTimeout(r, 40));
    });
    await act(async () => {
      fireEvent.click(reflowToggleBtn);
      await new Promise((r) => setTimeout(r, 40));
    });
    const secondArea = container.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
    expect(secondArea.scrollTop).toBe(120);

    unmount();
  });

  // ==========================================
  // 30. runs 未覆盖全文时不得替换 content（尾句丢失）
  // ==========================================
  it("30. ParsedBlock: inline_runs 未覆盖全文时绝不替换 content，尾句 WARNING. 保留且公式仍正确渲染", () => {
    const tailBlock: ParsedBlock = {
      id: "blk_tail_loss",
      type: "paragraph",
      reading_order: 1,
      content: "Voltage V_g is measured at the input. WARNING.",
      inline_runs: [
        { type: "text", content: "Voltage " },
        { type: "equation_inline", content: "V_g" },
        { type: "text", content: " is measured at the input." },
      ],
    };

    const rendered = getRenderableBlockContent(tailBlock);
    // 尾句绝不能被 runs 的拼接结果截断
    expect(rendered).toContain("WARNING.");
    expect(rendered).toContain("is measured at the input.");
    expect(rendered).toContain("$V_g$");

    const mgr = new ParsedAssetManager("dummy_session");
    const { container } = render(<ParsedBlockView block={tailBlock} assetManager={mgr} />);

    const paragraph = container.querySelector(".parsed-paragraph-container")!;
    // 正文完整：整段普通文字（去掉公式节点后）逐字保留
    expect(textWithoutMath(paragraph)).toBe("Voltage is measured at the input. WARNING.");
    // 公式正确渲染 V_g
    const texs = katexTexs(paragraph);
    expect(texs.length).toBe(1);
    expect(texs[0]).toContain("V_g");
  });

  // ==========================================
  // 31. 残缺 runs（仅公式 run）：金额留在正文，公式各自成立
  // ==========================================
  it("31. ParsedBlock: 残缺 runs（仅 eta/G）下 $10 留在普通文字、eta 与 G 各自成为公式、整段文字完整", () => {
    const block: ParsedBlock = {
      id: "blk_money_math",
      type: "paragraph",
      reading_order: 1,
      content: "Cost is $10 while efficiency eta and gain G are measured.",
      inline_runs: [
        { type: "equation_inline", content: "eta" },
        { type: "equation_inline", content: "G" },
      ],
    };

    const mgr = new ParsedAssetManager("dummy_session");
    const { container } = render(<ParsedBlockView block={block} assetManager={mgr} />);
    const paragraph = container.querySelector(".parsed-paragraph-container")!;

    // 整段普通文字完整，$10 仍是普通文字，不进入任何公式节点
    expect(textWithoutMath(paragraph)).toBe(
      "Cost is $10 while efficiency and gain are measured."
    );

    const katexNodes = Array.from(paragraph.querySelectorAll(".katex"));
    expect(katexNodes.length).toBe(2);
    const texs = katexTexs(paragraph);
    expect(texs.some((t) => t.includes("eta"))).toBe(true);
    expect(texs.some((t) => t === "G")).toBe(true);

    // $10 的金额绝不能被公式吞掉
    katexNodes.forEach((node) => {
      expect(node.textContent).not.toContain("10");
      expect(node.textContent).not.toContain("while");
      expect(node.textContent).not.toContain("measured");
    });
  });

  // ==========================================
  // 32. 初始化查询“迟启动”竞争
  // ==========================================
  it("32. 初始化查询迟启动：身份就绪但偏好/卡片挂起时导入，旧流程返回 null/旧版本/错误均不得覆盖新版本", async () => {
    const OLD_INIT = makeActiveWorkspace("ver_old_init", "旧初始化版本正文", "sess_old_init_777");
    const NEW_IMPORTED = makeActiveWorkspace(
      "ver_new_import",
      "新导入版本正文",
      "sess_new_import_888"
    );

    for (const kind of ["null", "stale", "error"] as const) {
      vi.clearAllMocks();

      // 可控 Promise：偏好与卡片读取挂起，初始化流程尚未发出 getActive
      let releasePrefs!: (value: any) => void;
      const prefsGate = new Promise((resolve) => {
        releasePrefs = resolve;
      });
      let releaseCards!: (value: any) => void;
      const cardsGate = new Promise((resolve) => {
        releaseCards = resolve;
      });

      let getActiveCalls = 0;
      mockInvoke.mockImplementation(async (cmd: string, _args: any) => {
        if (cmd === "parsed_workspace_get_active") {
          getActiveCalls += 1;
          if (kind === "error") {
            throw new Error("旧初始化 getActive 查询失败");
          }
          return kind === "stale" ? OLD_INIT : null;
        }
        if (cmd === "parsed_workspace_import_dir") return NEW_IMPORTED;
        if (cmd === "parsed_preview_close") return {};
        if (cmd === "get_file_metadata") return { size: 100, mtime: 1000, revision: "v1" };
        if (cmd === "db_get_reading_preferences") return prefsGate;
        if (cmd === "db_get_cards") return cardsGate;
        if (cmd === "db_get_anchors" || cmd === "db_get_highlights") return [];
        if (cmd === "read_local_file") return "# 正文";
        return {};
      });
      mockOpen.mockResolvedValue("C:\\synthetic\\blocks.json");

      const { unmount, container } = render(<App />);
      // 文档身份已经建立（导入入口可用），但初始化流程仍卡在偏好与卡片读取
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      expect(getActiveCalls).toBe(0);

      // 用户开始导入并成功
      fireEvent.click(screen.getByText("工具 (Tools)"));
      await act(async () => {
        fireEvent.click(screen.getByText("导入/绑定解析结果到当前文档…"));
        await new Promise((r) => setTimeout(r, 80));
      });
      expect(container.textContent).toContain("新导入版本正文");
      expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();

      // 释放旧初始化流程：偏好与卡片返回后，它的 getActive 才真正发出
      await act(async () => {
        releasePrefs(null);
        releaseCards({ items: [], total: 0 });
        await new Promise((r) => setTimeout(r, 120));
      });

      // 旧流程确实在延迟结束后才发出查询，但不得重新取得更高优先级
      expect(getActiveCalls).toBe(1);
      expect(container.textContent).toContain("新导入版本正文");
      expect(container.textContent).not.toContain("旧初始化版本正文");
      // 正文、模式与资产管理器都没有被过期响应改写
      expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
      expect(screen.getByRole("button", { name: "流式重排" }).className).toContain("is-active");

      // 会话释放：旧版本会话被关闭，新导入会话绝不能被误关
      const closedSessions = mockInvoke.mock.calls
        .filter((call) => call[0] === "parsed_preview_close")
        .map((call) => (call[1] as any)?.sessionId as string);
      if (kind === "stale") {
        expect(closedSessions).toContain("sess_old_init_777");
      }
      expect(closedSessions).not.toContain("sess_new_import_888");

      unmount();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }
  });

  // ==========================================
  // 33. 恢复期间内容高度变化与用户打断
  // ==========================================
  it("33. 重排位置恢复：图片加载撑高内容后恢复真实位置，键盘导航打断后不再被拉回，输入框内按键不打断", async () => {
    // ---- 场景 A：内容高度不足时目标被截短，图片加载撑高后完成恢复 ----
    {
      const clamp = installClampedScrollTop(100);
      const ro = installControlledResizeObserver();
      try {
        const workspace = makeActiveWorkspace("ver_restore_a", "恢复测试正文 A");
        const mgr = new ParsedAssetManager(workspace.session_id);
        const { container, unmount } = render(
          <ParsedReflowReaderArea
            workspaceData={workspace}
            assetManager={mgr}
            initialScrollTop={350}
            onToggleView={() => {}}
          />
        );

        const scrollEl = container.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
        expect(scrollEl).not.toBeNull();
        // 布局尚未就绪（图片未加载），350 被真实浏览器截短
        expect(scrollEl.scrollTop).toBe(100);

        await act(async () => {
          clamp.setMax(3000); // 模拟图片加载完成，内容高度增长
          ro.triggerAll();
          await new Promise((r) => setTimeout(r, 20));
        });
        // 恢复流程在布局就绪后真正到达目标位置
        expect(scrollEl.scrollTop).toBe(350);

        unmount();
      } finally {
        ro.restore();
        clamp.restore();
      }
    }

    // ---- 场景 B：输入框内按键不打断恢复（作用域限定） ----
    {
      const clamp = installClampedScrollTop(100);
      const ro = installControlledResizeObserver();
      try {
        const workspace = makeActiveWorkspace("ver_restore_b", "恢复测试正文 B");
        const mgr = new ParsedAssetManager(workspace.session_id);
        const { container, unmount } = render(
          <ParsedReflowReaderArea
            workspaceData={workspace}
            assetManager={mgr}
            initialScrollTop={350}
            onToggleView={() => {}}
          />
        );

        const scrollEl = container.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
        expect(scrollEl.scrollTop).toBe(100);

        const input = document.createElement("input");
        scrollEl.appendChild(input);
        await act(async () => {
          fireEvent.keyDown(input, { key: "ArrowDown" });
          await new Promise((r) => setTimeout(r, 10));
        });
        await act(async () => {
          clamp.setMax(3000);
          ro.triggerAll();
          await new Promise((r) => setTimeout(r, 20));
        });
        // 输入框内的方向键属于其他作用域，恢复继续完成
        expect(scrollEl.scrollTop).toBe(350);

        unmount();
      } finally {
        ro.restore();
        clamp.restore();
      }
    }

    // ---- 场景 C：任一阅读导航键打断恢复后，ResizeObserver 与超时回调不得再次拉回 ----
    {
      const navKeys = [
        "PageUp",
        "PageDown",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        " ",
      ];

      for (const key of navKeys) {
        const clamp = installClampedScrollTop(100);
        const ro = installControlledResizeObserver();
        try {
          const workspace = makeActiveWorkspace(`ver_restore_${key.trim() || "space"}`, "恢复测试正文 C");
          const mgr = new ParsedAssetManager(workspace.session_id);
          const { container, unmount } = render(
            <ParsedReflowReaderArea
              workspaceData={workspace}
              assetManager={mgr}
              initialScrollTop={350}
              onToggleView={() => {}}
            />
          );

          const scrollEl = container.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
          expect(scrollEl.scrollTop).toBe(100);

          await act(async () => {
            fireEvent.keyDown(scrollEl, { key });
            await new Promise((r) => setTimeout(r, 10));
          });

          await act(async () => {
            clamp.setMax(3000);
            ro.triggerAll();
            await new Promise((r) => setTimeout(r, 20));
          });
          // 用户已打断：ResizeObserver 回调不得把位置拉回 350
          expect(scrollEl.scrollTop).toBe(100);

          unmount();
        } finally {
          ro.restore();
          clamp.restore();
        }
      }
    }

    // ---- 场景 D：打断后有限恢复超时（1000ms）到期也不得拉回 ----
    {
      const clamp = installClampedScrollTop(100);
      const ro = installControlledResizeObserver();
      try {
        const workspace = makeActiveWorkspace("ver_restore_d", "恢复测试正文 D");
        const mgr = new ParsedAssetManager(workspace.session_id);
        const { container, unmount } = render(
          <ParsedReflowReaderArea
            workspaceData={workspace}
            assetManager={mgr}
            initialScrollTop={350}
            onToggleView={() => {}}
          />
        );

        const scrollEl = container.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
        expect(scrollEl.scrollTop).toBe(100);

        await act(async () => {
          fireEvent.keyDown(scrollEl, { key: "PageDown" });
          await new Promise((r) => setTimeout(r, 10));
        });

        // 等待超过恢复超时上限，超时回调不得再执行定位
        await act(async () => {
          await new Promise((r) => setTimeout(r, 1100));
        });
        expect(scrollEl.scrollTop).toBe(100);

        unmount();
      } finally {
        ro.restore();
        clamp.restore();
      }
    }
  });

  // ==========================================
  // 34. 反例 A：重复出现的正文片段不得因重建被合并
  // ==========================================
  it("34. inline_runs 完整判定：正文两个 x 与逗号都保留，绝不能被重建成一个公式", () => {
    const block: ParsedBlock = {
      id: "blk_gap_duplicate_x",
      type: "paragraph",
      reading_order: 1,
      content: "Values: x, x.",
      inline_runs: [
        { type: "text", content: "Values: " },
        { type: "equation_inline", content: "x" },
        { type: "text", content: "." },
      ],
    };

    // 重建会把 "x, x" 变成一个 x 并丢掉逗号，因此必须回退保留原文。
    // 回退路径可能给字面出现的 x 补上 $ 定界符，但字符本身、顺序与标点不得变化。
    const rendered = getRenderableBlockContent(block);
    expect(rendered.replace(/\$/g, "")).toContain("x, x");

    const mgr = new ParsedAssetManager("dummy_session");
    const { container } = render(<ParsedBlockView block={block} assetManager={mgr} />);
    const paragraph = container.querySelector(".parsed-paragraph-container")!;

    // 可读文本（KaTeX 折叠为源码）必须完整保留两个 x 与逗号
    expect(readableText(paragraph)).toBe("Values: x, x.");
    // 公式数量与源码：两个 x 都要保留，不能缩减成一个
    const texs = katexTexs(paragraph);
    expect(texs.length).toBe(2);
    expect(texs.every((t) => t === "x")).toBe(true);
    // 分隔两个 x 的逗号必须仍在普通文字中
    expect(textWithoutMath(paragraph)).toContain(",");
  });

  // ==========================================
  // 35. 反例 B：运算符不得被 runs 篡改
  // ==========================================
  it("35. inline_runs 完整判定：正文 x-y 不得被重建成 x+y 公式，也不得凭空插入公式", () => {
    const block: ParsedBlock = {
      id: "blk_gap_operator_swap",
      type: "paragraph",
      reading_order: 1,
      content: "Value is x-y.",
      inline_runs: [
        { type: "text", content: "Value is " },
        { type: "equation_inline", content: "x+y" },
        { type: "text", content: "." },
      ],
    };

    const rendered = getRenderableBlockContent(block);
    expect(rendered).toBe("Value is x-y.");

    const mgr = new ParsedAssetManager("dummy_session");
    const { container } = render(<ParsedBlockView block={block} assetManager={mgr} />);
    const paragraph = container.querySelector(".parsed-paragraph-container")!;

    // 减号必须原样保留，加法公式绝不能被引入
    expect(readableText(paragraph)).toBe("Value is x-y.");
    expect(katexTexs(paragraph)).toHaveLength(0);
    expect(container.textContent).not.toContain("x+y");
    expect(container.querySelectorAll(".katex").length).toBe(0);
  });

  // ==========================================
  // 36. runs 漏掉正文标点：标点不得消失
  // ==========================================
  it("36. inline_runs 完整判定：runs 漏掉正文标点时保留原文，逗号不得因重建消失", () => {
    const block: ParsedBlock = {
      id: "blk_gap_missing_punct",
      type: "paragraph",
      reading_order: 1,
      content: "Value is x, and y.",
      inline_runs: [
        { type: "text", content: "Value is " },
        { type: "equation_inline", content: "x" },
        // 该 text run 漏掉了正文中的逗号
        { type: "text", content: " and y." },
      ],
    };

    const rendered = getRenderableBlockContent(block);
    // 忽略回退路径补出的 $ 定界符后，正文必须逐字保留（含逗号）
    expect(rendered.replace(/\$/g, "")).toContain("x, and y.");

    const mgr = new ParsedAssetManager("dummy_session");
    const { container } = render(<ParsedBlockView block={block} assetManager={mgr} />);
    const paragraph = container.querySelector(".parsed-paragraph-container")!;

    expect(readableText(paragraph)).toBe("Value is x, and y.");
    // 逗号必须留在普通文字中
    expect(textWithoutMath(paragraph)).toContain(",");
    // 公式仍然只对应原文中的 x
    expect(katexTexs(paragraph)).toEqual(["x"]);
  });

  // ==========================================
  // 37. runs 多出正文没有的公式：不得凭空追加
  // ==========================================
  it("37. inline_runs 完整判定：runs 多出一个正文没有对应内容的公式时，不得凭空插入", () => {
    const block: ParsedBlock = {
      id: "blk_gap_extra_math",
      type: "paragraph",
      reading_order: 1,
      content: "Value is x.",
      inline_runs: [
        { type: "text", content: "Value is " },
        { type: "equation_inline", content: "x" },
        { type: "text", content: "." },
        // 正文中不存在 y，绝不能追加成公式
        { type: "equation_inline", content: "y" },
      ],
    };

    const rendered = getRenderableBlockContent(block);
    expect(rendered).toBe("Value is $x$.");

    const mgr = new ParsedAssetManager("dummy_session");
    const { container } = render(<ParsedBlockView block={block} assetManager={mgr} />);
    const paragraph = container.querySelector(".parsed-paragraph-container")!;

    expect(readableText(paragraph)).toBe("Value is x.");
    expect(katexTexs(paragraph)).toEqual(["x"]);
  });

  // ==========================================
  // 38. 没有后续文本的多余公式：不得残留到末尾被追加
  // ==========================================
  it("38. inline_runs 完整判定：末尾多余公式不得残留，runsCoverContentFully 必须为 false 且正文不追加 y", () => {
    const block: ParsedBlock = {
      id: "blk_tail_extra_math",
      type: "paragraph",
      reading_order: 1,
      content: "Value is x",
      inline_runs: [
        { type: "text", content: "Value is " },
        { type: "equation_inline", content: "x" },
        // 正文中没有 y，且后面没有任何文本 run
        { type: "equation_inline", content: "y" },
      ],
    };

    expect(runsCoverContentFully(block)).toBe(false);

    const mgr = new ParsedAssetManager("dummy_session");
    const { container } = render(<ParsedBlockView block={block} assetManager={mgr} />);
    const paragraph = container.querySelector(".parsed-paragraph-container")!;

    // 可读文本严格相等，不得出现 y
    expect(readableText(paragraph)).toBe("Value is x");
    expect(katexTexs(paragraph)).toEqual(["x"]);
  });

  // ==========================================
  // 39. 公式不得跨过中间文本匹配
  // ==========================================
  it("39. inline_runs 完整判定：公式不得跳过中间文本，runsCoverContentFully 必须为 false 且 x/then/y 顺序不变", () => {
    const block: ParsedBlock = {
      id: "blk_cross_text_math",
      type: "paragraph",
      reading_order: 1,
      content: "Value x then y.",
      inline_runs: [
        { type: "text", content: "Value " },
        { type: "equation_inline", content: "x" },
        // 该公式在 runs 中紧跟 x，但正文里它与 x 之间存在文本 "then"
        { type: "equation_inline", content: "y" },
        { type: "text", content: " then " },
        { type: "text", content: "." },
      ],
    };

    expect(runsCoverContentFully(block)).toBe(false);

    const mgr = new ParsedAssetManager("dummy_session");
    const { container } = render(<ParsedBlockView block={block} assetManager={mgr} />);
    const paragraph = container.querySelector(".parsed-paragraph-container")!;

    // 顺序必须是 x → then → y，不能被重建成 x,y → then
    expect(readableText(paragraph)).toBe("Value x then y.");
    expect(textWithoutMath(paragraph)).toContain("then");
    expect(textWithoutMath(paragraph).startsWith("Value")).toBe(true);
    expect(textWithoutMath(paragraph).endsWith(".")).toBe(true);
    expect(katexTexs(paragraph)).toEqual(["x", "y"]);
  });
});

// ============================================================================
// 真实评测产物检查 (若本地样本不存在则显式跳过，不使用合成数据冒充真实测试通过)
// ============================================================================
describe("真实评测产物检查 (本地样本存在时执行，不存在则显式跳过)", () => {
  const mineruPath =
    "C:\\Users\\lenovo\\AppData\\Local\\FlowRead\\parse-eval\\20261016_024119_review_v3\\results\\boost-converter-p41-43\\mineru\\normalized\\blocks.json";
  const datalabPath =
    "C:\\Users\\lenovo\\AppData\\Local\\FlowRead\\parse-eval\\20261016_024119_review_v3\\results\\boost-converter-p41-43\\datalab_v2\\normalized\\blocks.json";

  const hasMineru = fs && typeof fs.existsSync === "function" && fs.existsSync(mineruPath);
  const hasDatalab = fs && typeof fs.existsSync === "function" && fs.existsSync(datalabPath);

  it.runIf(hasMineru)("真实 MinerU 产物校验：5图/10公式/行内公式 v≈V 与曲线图 M(D) 坐标结构", () => {
    const rawJson = fs.readFileSync(mineruPath, "utf-8");
    const data = JSON.parse(rawJson);
    const res = validateParsedBlocks(
      data,
      mineruPath,
      "sess_m_real",
      path.dirname(mineruPath),
      true
    );

    expect(res.valid).toBe(true);
    expect(res.stats.imageCount).toBe(5);
    expect(res.stats.formulaCount).toBe(10);

    const blk1 = res.document!.blocks.find((b) => b.id === "mineru_blk_0001");
    expect(blk1?.normalized_bbox).toEqual([0.206, 0.077, 0.742, 0.349]);

    const blk7 = res.document!.blocks.find((b) => b.id === "mineru_blk_0007");
    expect(blk7?.content).toContain("$v \\approx V$");

    // 真实产物的 content 与 inline_runs 使用同一份 LaTeX 源码，精确对应必须仍然成立，
    // 新规则不得把这类真实段落误判为残缺（否则会丢掉公式渲染）。
    const rendered7 = getRenderableBlockContent(blk7!);
    expect(rendered7).toContain("$v \\approx V$");
    expect(rendered7).toContain("leads to");

    const blk11 = res.document!.blocks.find((b) => b.id === "mineru_blk_0011");
    const rendered11 = getRenderableBlockContent(blk11!);
    expect(rendered11).toContain("$v \\approx V$");
    expect(rendered11).toContain("$i_{L} \\approx I$");

    const blk21 = res.document!.blocks.find((b) => b.id === "mineru_blk_0021");
    expect(blk21?.raw_type).toBe("chart");
    expect(blk21?.caption).toContain("$M(D)$");
  });

  it.runIf(hasDatalab)("真实 Datalab v2 产物校验：4图/10公式/图内文字剥离", () => {
    const rawJson = fs.readFileSync(datalabPath, "utf-8");
    const data = JSON.parse(rawJson);
    const res = validateParsedBlocks(
      data,
      datalabPath,
      "sess_d_real",
      path.dirname(datalabPath),
      true
    );

    expect(res.valid).toBe(true);
    expect(res.stats.imageCount).toBe(4);
    expect(res.stats.formulaCount).toBe(10);

    const dImg = res.document!.blocks.find((b) => b.id === "datalab_blk_0002");
    expect(dImg?.in_image_text).toContain("(a)");
    expect(dImg?.in_image_text).toContain("$V_g$");
  });

  it("阅读器可读输出核对：HTML 实体与比较符公式不丢文字，<node> 渲染为字面字符", () => {
    const assetManager = new ParsedAssetManager("sess_test");

    // 1. Keep <math>x < y</math> and keep this tail.
    const blk1: ParsedBlock = {
      id: "b1",
      type: "paragraph",
      reading_order: 1,
      content: "Keep $x < y$ and keep this tail.",
      inline_runs: [
        { type: "text", content: "Keep " },
        { type: "equation_inline", content: "x < y" },
        { type: "text", content: " and keep this tail." },
      ],
      page_sample: 1,
    };
    const { container: c1, unmount: u1 } = render(
      <ParsedBlockView block={blk1} assetManager={assetManager} />
    );
    expect(normalizedText(c1)).toContain("Keep");
    expect(normalizedText(c1)).toContain("and keep this tail.");
    expect(katexTexs(c1)).toContain("x < y");
    u1();

    // 2. Use &lt;node&gt; here.
    const blk2: ParsedBlock = {
      id: "b2",
      type: "paragraph",
      reading_order: 2,
      content: "Use &lt;node&gt; here.",
      page_sample: 1,
    };
    const { container: c2, unmount: u2 } = render(
      <ParsedBlockView block={blk2} assetManager={assetManager} />
    );
    // 最终在阅读器中显示为字面量 `<node>`，不可被当作真实标签丢弃或空白
    expect(normalizedText(c2)).toBe("Use <node> here.");
    u2();

    // 3. 多个公式与比较符
    const blk3: ParsedBlock = {
      id: "b3",
      type: "paragraph",
      reading_order: 3,
      content: "Compare $a < b$ and $c > d$ here",
      inline_runs: [
        { type: "text", content: "Compare " },
        { type: "equation_inline", content: "a < b" },
        { type: "text", content: " and " },
        { type: "equation_inline", content: "c > d" },
        { type: "text", content: " here" },
      ],
      page_sample: 1,
    };
    const { container: c3, unmount: u3 } = render(
      <ParsedBlockView block={blk3} assetManager={assetManager} />
    );
    expect(normalizedText(c3)).toContain("Compare");
    expect(normalizedText(c3)).toContain("here");
    expect(katexTexs(c3)).toEqual(["a < b", "c > d"]);
    u3();
  });
});

