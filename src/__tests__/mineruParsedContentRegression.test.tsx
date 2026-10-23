/**
 * MinerU 真实结构内容回归（合成脱敏 fixture）
 *
 * 数据来源：src-tauri/tests/fixtures/mineru_v2_real_shape_normalized.json
 *   = 真实 MinerU v2 结构（title_content / content.html / math_content / image_source）
 *     经生产解析器 `normalize_mineru_results` 归一化后的产物（文本已脱敏替换）。
 *   该 fixture 由 Rust 测试 `test_mineru_v2_normalized_fixture_no_drift` 锁定防漂移。
 *
 * 本测试只覆盖合成 fixture 的渲染校验；真实 part07 产物回放见
 * docs/MINERU_REAL_OUTPUT_REPLAY.md（离线回放入口，不走 API）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

import { validateParsedBlocks, normalizeBlockType, ParsedAssetManager } from "../utils/parsedDocumentLoader";
import ParsedBlockView, { getRenderableBlockContent } from "../components/ParsedBlock";
import { ParsedBlock } from "../types/parsedDocument";
// @ts-ignore - JSON fixture 位于 src-tauri/tests/fixtures（跨目录共享，避免两套 fixture）
import NORMALIZED_FIXTURE from "../../src-tauri/tests/fixtures/mineru_v2_real_shape_normalized.json";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

/** 读取 KaTeX 节点的 TeX 源码，用于断言公式内容本身 */
function katexTexs(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll(".katex")).map((node) => {
    const annotation = node.querySelector("annotation");
    return (annotation?.textContent || node.textContent || "").trim();
  });
}

function normalizedText(node: Node | null): string {
  return (node?.textContent || "").replace(/\s+/g, " ").trim();
}

/** 建立带资产 mock 的渲染环境 */
async function renderBlocks(blocks: ParsedBlock[]) {
  const assetManager = new ParsedAssetManager("session_fixture");
  const container = document.createElement("div");
  document.body.appendChild(container);

  await act(async () => {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container);
    root.render(
      <>
        {blocks.map((block) => (
          <ParsedBlockView key={block.id} block={block} assetManager={assetManager} />
        ))}
      </>
    );
    await new Promise((r) => setTimeout(r, 0));
  });

  return {
    container,
    cleanup: () => {
      container.remove();
    },
  };
}

describe("MinerU 真实结构（脱敏 fixture）内容回归", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!URL.createObjectURL) {
      (URL as any).createObjectURL = vi.fn(() => "blob:fixture-asset");
    } else {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture-asset");
    }
    (URL as any).revokeObjectURL = vi.fn();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "parsed_preview_read_asset") return [0xff, 0xd8, 0xff, 0xe0];
      if (cmd === "parsed_preview_close") return {};
      return null;
    });
  });

  it("1. 归一化 fixture 校验统计与真实结构一致", () => {
    const result = validateParsedBlocks(
      NORMALIZED_FIXTURE,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );

    expect(result.valid).toBe(true);
    expect(result.stats.totalBlocks).toBe(10);
    expect(result.stats.headingCount).toBe(2);
    expect(result.stats.tableCount).toBe(1);
    expect(result.stats.formulaCount).toBe(1);
    expect(result.stats.imageCount).toBe(2);
    // 页眉/页码/页脚统一计入 pageHeaderFooterCount（page_footer 已正式归一化）
    expect(result.stats.pageHeaderFooterCount).toBe(3);
    // 页脚不再落入 unknown
    expect(result.stats.unknownCount).toBe(0);
    // 可渲染块 = 10 - 3 个页眉/页码/页脚
    expect(result.stats.renderableBlocks).toBe(7);
  });

  it("2. 标题文字与层级在阅读器中真实渲染为 h2/h1", async () => {
    const result = validateParsedBlocks(
      NORMALIZED_FIXTURE,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    const headings = result.document!.blocks.filter((b) => b.type === "heading");
    expect(headings).toHaveLength(2);

    const { container, cleanup } = await renderBlocks(headings);
    try {
      const h2 = container.querySelector(".parsed-heading-container h2");
      const h1 = container.querySelector(".parsed-heading-container h1");
      expect(h2, "v2 二级标题必须渲染为 h2").not.toBeNull();
      expect(normalizedText(h2)).toContain("4.5.3 Sample Section Title");
      expect(h1, "v2 一级标题必须渲染为 h1").not.toBeNull();
      expect(normalizedText(h1)).toContain("The Chapter Level Title");
      // 标题文字不得丢失或只余层级标记
      for (const h of [h1, h2]) {
        expect(normalizedText(h).replace(/#/g, "").trim().length).toBeGreaterThan(3);
      }
    } finally {
      cleanup();
    }
  });

  it("3. 表格保留 HTML 结构、合并单元格、单元格公式与图注", async () => {
    const result = validateParsedBlocks(
      NORMALIZED_FIXTURE,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    const table = result.document!.blocks.find((b) => b.type === "table")!;
    expect(table.content_format).toBe("html");
    expect(table.caption).toBe("Table 4.6 Characteristics of sample devices");

    const { container, cleanup } = await renderBlocks([table]);
    try {
      const tableEl = container.querySelector("table");
      expect(tableEl, "真实表格必须渲染出 <table> 元素").not.toBeNull();

      const text = normalizedText(container);
      expect(text).toContain("SAMPLE-DEVICE-01");
      expect(text).toContain("600 V");
      expect(text).toContain("0.62 μs");
      // 合并单元格结构保留
      expect(container.querySelector('td[rowspan="2"]')).not.toBeNull();
      // 单元格内公式经 KaTeX 渲染
      const cellTexs = katexTexs(container);
      expect(cellTexs.some((t) => t.includes("V")), `单元格公式未渲染: ${cellTexs.join(" | ")}`).toBe(true);
      // 图注在表格上方渲染
      expect(text).toContain("Table 4.6 Characteristics of sample devices");
      // loader 已透传 footnote：表格脚注渲染在 DOM 文本中
      expect(text).toContain("Notes: values are typical at 25 C.");
      // 不得静默显示空表格
      expect(container.querySelector(".parsed-table-container.is-error")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("4. 独立公式经 KaTeX 渲染，源码未丢失", async () => {
    const result = validateParsedBlocks(
      NORMALIZED_FIXTURE,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    const formula = result.document!.blocks.find((b) => b.type === "formula")!;
    expect(formula.content_format).toBe("latex");

    const { container, cleanup } = await renderBlocks([formula]);
    try {
      const tex = katexTexs(container);
      if (tex.length === 0) {
        // KaTeX 无法编译时必须明确保留源码，而不是渲染成空白
        expect(normalizedText(container.querySelector(".parsed-formula-raw"))).toContain("W _ { C }");
      } else {
        expect(tex.join(" ")).toContain("W _ { C }");
        expect(container.querySelector(".parsed-formula-container.is-error")).toBeNull();
      }
    } finally {
      cleanup();
    }
  });

  it("5. 段落保留正文与行内公式顺序", async () => {
    const result = validateParsedBlocks(
      NORMALIZED_FIXTURE,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    const paragraph = result.document!.blocks.find((b) => b.type === "paragraph")!;
    expect(paragraph.inline_runs?.filter((r) => r.type === "equation_inline")).toHaveLength(3);

    const { container, cleanup } = await renderBlocks([paragraph]);
    try {
      const text = normalizedText(container);
      expect(text).toContain("A converter circuit containing an ideal diode is illustrated in Fig. 4.68.");
      expect(text).toContain("rises from approximately zero to");
      expect(text).toContain("with interval");
      const tex = katexTexs(container);
      expect(tex.length).toBe(3);
      expect(tex.join(" ")).toContain("\\nu");
      expect(tex.join(" ")).toContain("V _ { g }");
      expect(tex.join(" ")).toContain("t _ { 1 }");
    } finally {
      cleanup();
    }
  });

  it("6. 插图与电路图渲染真实 <img> 并保留图注", async () => {
    const result = validateParsedBlocks(
      NORMALIZED_FIXTURE,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    const images = result.document!.blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);

    const { container, cleanup } = await renderBlocks(images);
    try {
      const imgs = Array.from(container.querySelectorAll("img"));
      expect(imgs.length).toBe(2);
      for (const img of imgs) {
        expect(img.getAttribute("src")).toBe("blob:fixture-asset");
      }
      const text = normalizedText(container);
      expect(text).toContain("Fig. 4.68 Sample switching loss example circuit");
      expect(text).toContain("Fig. 4.77 Sample efficiency vs. switching frequency");
      // 图表 footnote 经 loader 透传后在图片下方渲染
      expect(text).toContain("Chart footnote sample");
      // 未加载失败
      expect(container.querySelector(".parsed-image-error")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("7. 页眉、页码与页脚不在正文流中显示", async () => {
    const result = validateParsedBlocks(
      NORMALIZED_FIXTURE,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    const chrome = result.document!.blocks.filter(
      (b) =>
        b.type === "page_header" || b.type === "page_number" || b.type === "page_footer"
    );
    expect(chrome).toHaveLength(3);

    const { container, cleanup } = await renderBlocks(chrome);
    try {
      expect(normalizedText(container)).toBe("");
    } finally {
      cleanup();
    }
  });

  it("8. 结构表格缺失时明确降级为备援图片，无备援时明确报错", async () => {
    const degraded: ParsedBlock = {
      id: "degraded_table",
      type: "table",
      raw_type: "table",
      reading_order: 1,
      content: "",
      content_format: "html",
      asset_ref: "table_snapshot.jpg",
      caption: "Table X Backup only",
    };
    const empty: ParsedBlock = {
      id: "empty_table",
      type: "table",
      raw_type: "table",
      reading_order: 2,
      content: "",
      content_format: "html",
      asset_ref: null,
      caption: null,
    };

    const { container, cleanup } = await renderBlocks([degraded, empty]);
    try {
      const text = normalizedText(container);
      expect(text).toContain("表格结构不可用");
      expect(text).toContain("Table X Backup only");
      expect(container.querySelector("img")).not.toBeNull();
      expect(text).toContain("表格内容为空");
    } finally {
      cleanup();
    }
  });

  it("9. 渲染内容以原文为基准，不删纯数字也不做语义替换", () => {
    const block: ParsedBlock = {
      id: "keep_original",
      type: "paragraph",
      raw_type: "paragraph",
      reading_order: 1,
      content: "Value 600 V with \\nu _ { A } ( t ) and 25 C.",
      content_format: "markdown",
      inline_runs: [
        { type: "text", content: "Value 600 V with " },
        { type: "equation_inline", content: "\\nu _ { A } ( t )" },
        { type: "text", content: " and 25 C." },
      ],
    };
    const rendered = getRenderableBlockContent(block);
    expect(rendered).toContain("600 V");
    expect(rendered).toContain("25 C.");
    // 不得把 \nu 语义替换为 v
    expect(rendered).toContain("\\nu");
    expect(rendered).not.toMatch(/[^\\]?\bv\b/);
  });

  it("10. v1/v2 页脚形态统一识别为 page_footer，不进正文也不落 unknown", async () => {
    const rawBlocks = [
      {
        id: "v1_footer",
        type: "page_footer",
        raw_type: "footer",
        content: "v1 legacy footer line",
        content_format: "markdown",
      },
      {
        id: "v2_footer",
        type: "page_footer",
        raw_type: "page_footer",
        content: "v2 modern footer line",
        content_format: "markdown",
      },
    ];

    const result = validateParsedBlocks(
      rawBlocks,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );

    expect(result.valid).toBe(true);
    expect(result.document!.blocks.map((b) => b.type)).toEqual(["page_footer", "page_footer"]);
    expect(result.stats.pageHeaderFooterCount).toBe(2);
    expect(result.stats.renderableBlocks).toBe(0);
    expect(result.stats.unknownCount).toBe(0);

    const { container, cleanup } = await renderBlocks(result.document!.blocks);
    try {
      expect(normalizedText(container)).toBe("");
    } finally {
      cleanup();
    }

    // 别名：无 type 仅 raw_type 为 footer / pagefooter 时也归一化为 page_footer
    expect(normalizeBlockType("footer")).toBe("page_footer");
    expect(normalizeBlockType("pagefooter")).toBe("page_footer");
    expect(normalizeBlockType("page_footer")).toBe("page_footer");
    expect(normalizeBlockType("page_number")).toBe("page_number");
  });

  it("11. 截图降级表格：caption 与 footnote 各只渲染一次", async () => {
    const rawBlocks = [
      {
        id: "degraded_snapshot",
        type: "table",
        raw_type: "table",
        reading_order: 1,
        content: "",
        content_format: "html",
        asset_ref: "table_snapshot.jpg",
        caption: "Table Y Degraded snapshot caption",
        footnote: "Table Y Degraded snapshot footnote",
      },
    ];

    const result = validateParsedBlocks(
      rawBlocks,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    expect(result.valid).toBe(true);
    expect(result.document!.blocks[0].footnote).toBe("Table Y Degraded snapshot footnote");

    const { container, cleanup } = await renderBlocks(result.document!.blocks);
    try {
      const fullText = container.textContent || "";
      const captionCount = fullText.split("Table Y Degraded snapshot caption").length - 1;
      const footnoteCount = fullText.split("Table Y Degraded snapshot footnote").length - 1;
      expect(captionCount, "降级表格 caption 只能出现一次").toBe(1);
      expect(footnoteCount, "降级表格 footnote 只能出现一次").toBe(1);
      // 存在降级标识与真实截图
      expect(fullText).toContain("表格结构不可用");
      expect(container.querySelector("img")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it("12. 空表格无截图分支保留错误提示、caption 与 footnote", async () => {
    const rawBlocks = [
      {
        id: "empty_no_snapshot",
        type: "table",
        raw_type: "table",
        reading_order: 1,
        content: "",
        content_format: "html",
        asset_ref: null,
        caption: "Table Z Empty caption",
        footnote: "Table Z Empty footnote",
      },
    ];

    const result = validateParsedBlocks(
      rawBlocks,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    expect(result.valid).toBe(true);

    const { container, cleanup } = await renderBlocks(result.document!.blocks);
    try {
      const fullText = container.textContent || "";
      expect(fullText).toContain("表格内容为空");
      expect(fullText.split("Table Z Empty caption").length - 1).toBe(1);
      expect(fullText.split("Table Z Empty footnote").length - 1).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("13. 图表脚注中的行内公式经 KaTeX 真实渲染", async () => {
    const rawBlocks = [
      {
        id: "chart_with_formula_footnote",
        type: "image",
        raw_type: "chart",
        reading_order: 1,
        content: "",
        content_format: "markdown",
        asset_ref: "chart_curve.jpg",
        caption: "Fig. 9 Sample chart",
        footnote: "Measured at $V _ { g }$ reference.",
      },
    ];

    const result = validateParsedBlocks(
      rawBlocks,
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    expect(result.document!.blocks[0].footnote).toBe("Measured at $V _ { g }$ reference.");

    const { container, cleanup } = await renderBlocks(result.document!.blocks);
    try {
      const texs = katexTexs(container);
      expect(
        texs.some((t) => t.replace(/\s+/g, " ").trim() === "V _ { g }"),
        `图表脚注公式未渲染: ${texs.join(" | ")}`
      ).toBe(true);
      expect(normalizedText(container)).toContain("Measured at");
    } finally {
      cleanup();
    }
  });

  it("14. 图片加载失败仍保留图注与脚注说明文字", async () => {
    // 覆盖全局 mock：资产读取返回空字节 → 加载失败分支
    mockInvoke.mockImplementationOnce(async () => []);

    const block: ParsedBlock = {
      id: "broken_asset",
      type: "image",
      raw_type: "image",
      reading_order: 1,
      content: "",
      content_format: "markdown",
      asset_ref: "broken_chart.jpg",
      caption: "Fig. 10 Broken asset caption",
      footnote: "Fig. 10 Broken asset footnote",
    };

    const { container, cleanup } = await renderBlocks([block]);
    try {
      const text = normalizedText(container);
      expect(container.querySelector(".parsed-image-error")).not.toBeNull();
      expect(text).toContain("Fig. 10 Broken asset caption");
      expect(text).toContain("Fig. 10 Broken asset footnote");
    } finally {
      cleanup();
    }
  });

  it("15. 标题层级：无前缀按 heading_level 加 #，已有前缀不重复不改写", async () => {
    const headings: ParsedBlock[] = [
      {
        id: "plain_heading",
        type: "heading",
        raw_type: "title",
        reading_order: 1,
        content: "Plain Section Heading",
        content_format: "markdown",
        heading_level: 3,
      },
      {
        id: "prefixed_same_level",
        type: "heading",
        raw_type: "title",
        reading_order: 2,
        content: "## Already Prefixed",
        content_format: "markdown",
        heading_level: 2,
      },
      {
        id: "prefixed_wins",
        type: "heading",
        raw_type: "title",
        reading_order: 3,
        content: "## Prefix Wins",
        content_format: "markdown",
        heading_level: 3,
      },
    ];

    const { container, cleanup } = await renderBlocks(headings);
    try {
      // (a) 无前缀 + heading_level=3 → h3，可见文本无 #，原文保留
      const h3 = container.querySelector(".parsed-heading-container h3");
      expect(h3).not.toBeNull();
      expect(normalizedText(h3)).toContain("Plain Section Heading");
      expect(normalizedText(h3)).not.toContain("#");

      // (b) 已有 "## " 前缀 + heading_level=2 → h2，前缀不重复（可见文本无 ##）
      const containers = Array.from(
        container.querySelectorAll(".parsed-heading-container")
      );
      const prefixedSame = containers.find((c) =>
        normalizedText(c).includes("Already Prefixed")
      );
      expect(prefixedSame, "未找到 Already Prefixed 标题容器").toBeDefined();
      expect(prefixedSame!.querySelector("h2")).not.toBeNull();
      expect(normalizedText(prefixedSame!)).not.toContain("##");

      // (c) 已有 "## " 前缀 + heading_level=3 → 前缀优先，仍为 h2 而非 h3
      const prefixWins = containers.find((c) => normalizedText(c).includes("Prefix Wins"));
      expect(prefixWins, "未找到 Prefix Wins 标题容器").toBeDefined();
      expect(prefixWins!.querySelector("h2")).not.toBeNull();
      expect(prefixWins!.querySelector("h3")).toBeNull();
      expect(normalizedText(prefixWins!)).toContain("Prefix Wins");
    } finally {
      cleanup();
    }
  });

  it("16. 旧包兼容与非法字段：字段缺失/非法不丢块、不报错、不误加前缀", async () => {
    // 旧格式：完全不带 footnote / heading_level
    const legacyResult = validateParsedBlocks(
      [
        {
          id: "old_paragraph",
          type: "paragraph",
          raw_type: "paragraph",
          content: "Legacy paragraph body",
          content_format: "markdown",
        },
        {
          id: "old_heading",
          type: "heading",
          raw_type: "title",
          content: "Legacy Heading Text",
          content_format: "markdown",
        },
      ],
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    expect(legacyResult.valid).toBe(true);
    expect(legacyResult.document!.blocks).toHaveLength(2);

    const legacyRender = await renderBlocks(legacyResult.document!.blocks);
    try {
      const legacyText = normalizedText(legacyRender.container);
      expect(legacyText).toContain("Legacy paragraph body");
      expect(legacyText).toContain("Legacy Heading Text");
    } finally {
      legacyRender.cleanup();
    }

    // 非法值：footnote=数字、heading_level=字符串/0/7/2.5 → 丢弃为 null，校验不失败、块不丢
    const invalidResult = validateParsedBlocks(
      [
        {
          id: "numeric_footnote",
          type: "paragraph",
          raw_type: "paragraph",
          content: "Body with numeric footnote field",
          content_format: "markdown",
          footnote: 123,
        },
        {
          id: "string_level",
          type: "heading",
          raw_type: "title",
          content: "String Level Heading",
          content_format: "markdown",
          heading_level: "3",
        },
        {
          id: "zero_level",
          type: "heading",
          raw_type: "title",
          content: "Zero Level Heading",
          content_format: "markdown",
          heading_level: 0,
        },
        {
          id: "seven_level",
          type: "heading",
          raw_type: "title",
          content: "Seven Level Heading",
          content_format: "markdown",
          heading_level: 7,
        },
        {
          id: "fraction_level",
          type: "heading",
          raw_type: "title",
          content: "Fraction Level Heading",
          content_format: "markdown",
          heading_level: 2.5,
        },
      ],
      "C:/fixture/blocks.json",
      "session_fixture",
      "C:/fixture",
      true
    );
    expect(invalidResult.valid).toBe(true);
    expect(invalidResult.document!.blocks).toHaveLength(5);
    expect(invalidResult.document!.blocks[0].footnote ?? null).toBeNull();
    for (const b of invalidResult.document!.blocks.slice(1)) {
      expect(b.heading_level ?? null).toBeNull();
    }

    const invalidRender = await renderBlocks(invalidResult.document!.blocks);
    try {
      const invalidText = normalizedText(invalidRender.container);
      // 标题原文全部保留且不被补 # 前缀
      expect(invalidText).toContain("String Level Heading");
      expect(invalidText).toContain("Zero Level Heading");
      expect(invalidText).toContain("Seven Level Heading");
      expect(invalidText).toContain("Fraction Level Heading");
      expect(invalidText).not.toContain("#");
      // 数字 footnote 不渲染
      expect(invalidText).not.toContain("123");
    } finally {
      invalidRender.cleanup();
    }
  });
});
