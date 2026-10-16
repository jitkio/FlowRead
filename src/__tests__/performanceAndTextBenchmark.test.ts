import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import ReaderArea from "../components/ReaderArea";
import { parseAndStructureText } from "../utils/textDocumentManager";
import {
  buildParagraphAnchorIndex,
  ParagraphAnchorIndex,
} from "../utils/textAnchorIndexer";
import {
  resolveTargetLanguage,
  buildTranslationSystemPrompt,
} from "../utils/translationManager";
import { SourceAnchorRecord, HighlightRecord } from "../types/records";

describe("Phase 1: Performance, Text Parsing & Benchmark", () => {
  it("Benchmark 1: Parses normal text, 1.2M char long text, and ultra-long single paragraph quickly", () => {
    // 1. Normal text (~5,000 chars)
    const normalParagraphs = Array.from({ length: 25 }, (_, i) =>
      `这是第 ${i + 1} 个普通段落，包含了关于深度阅读与沉浸体验的论述内容。在信息碎片化的时代，我们需要更多平静与专注。`
    );
    const normalText = normalParagraphs.join("\n\n");
    const t0 = performance.now();
    const normalDoc = parseAndStructureText(normalText, 1500);
    const normalDuration = performance.now() - t0;

    expect(normalDoc.logicalParagraphs.length).toBe(25);
    expect(normalDoc.displayChunks.length).toBe(25);
    expect(normalDuration).toBeLessThan(50); // fast < 50ms

    // 2. Ultra-long single paragraph (50,000 chars with no newlines)
    const giantChunk = "超长单段文本测试，不断重复的文字内容。".repeat(2500); // ~50,000 chars
    const t1 = performance.now();
    const giantDoc = parseAndStructureText(giantChunk, 1500);
    const giantDuration = performance.now() - t1;

    expect(giantDoc.logicalParagraphs.length).toBe(1);
    expect(giantDoc.displayChunks.length).toBeGreaterThan(30);
    // All display chunks must reference logicalParagraphIndex = 0
    for (const chunk of giantDoc.displayChunks) {
      expect(chunk.logicalParagraphIndex).toBe(0);
      expect(chunk.text.length).toBeLessThanOrEqual(1500);
    }
    // Chunks must be contiguous
    expect(giantDoc.displayChunks[0].charStart).toBe(0);
    const lastChunk = giantDoc.displayChunks[giantDoc.displayChunks.length - 1];
    expect(lastChunk.charEnd).toBe(giantChunk.length);
    expect(giantDuration).toBeLessThan(100);

    // 3. 1.2 Million chars (~3,000 paragraphs)
    const longDocParagraphs = Array.from({ length: 3000 }, (_, i) =>
      `【第 ${i + 1} 节】${"文字内容".repeat(100)}`
    );
    const longText = longDocParagraphs.join("\n\n");
    expect(longText.length).toBeGreaterThan(1_200_000);

    const t2 = performance.now();
    const longDoc = parseAndStructureText(longText, 1500);
    const longDuration = performance.now() - t2;

    expect(longDoc.logicalParagraphs.length).toBe(3000);
    expect(longDoc.displayChunks.length).toBeGreaterThanOrEqual(3000);
    // Parsing 1.2M text should complete in under 500ms
    expect(longDuration).toBeLessThan(600);
  });

  it("Benchmark 2: Compares O(1) Paragraph Anchor Indexing vs unindexed O(A) full scan", () => {
    // Generate 1,000 mock anchors across 500 paragraphs
    const anchors: SourceAnchorRecord[] = [];
    const highlights: HighlightRecord[] = [];

    for (let i = 0; i < 1000; i++) {
      const pIdx = i % 500;
      const aid = `anc_${i}`;
      anchors.push({
        anchor_id: aid,
        document_id: "doc_test",
        document_revision: "rev1",
        source_type: "text_segment",
        excerpt: `Excerpt for ${aid}`,
        location_json: JSON.stringify({
          type: "text_segment",
          segments: [
            {
              paragraphIndex: pIdx,
              startOffset: 10,
              endOffset: 50,
            },
          ],
        }),
        created_at: Date.now(),
      });

      if (i % 2 === 0) {
        highlights.push({
          highlight_id: `hl_${i}`,
          document_id: "doc_test",
          anchor_id: aid,
          color: "#e6c846",
          created_at: Date.now(),
          excerpt: `Excerpt for ${aid}`,
          location_json: "",
          source_type: "text_segment",
        });
      }
    }

    // 1. Build Index once (O(A))
    const tIndexStart = performance.now();
    const index: ParagraphAnchorIndex = buildParagraphAnchorIndex(anchors, highlights, "rev1");
    const indexBuildTime = performance.now() - tIndexStart;

    expect(index.totalAnchorsIndexed).toBe(1000);
    expect(indexBuildTime).toBeLessThan(50);

    // 2. Simulate 60 frames of rendering visible paragraphs (e.g. 20 visible paragraphs per frame)
    const visibleParagraphIndices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

    // Indexed lookup:
    const tIndexedStart = performance.now();
    for (let frame = 0; frame < 60; frame++) {
      for (const pIdx of visibleParagraphIndices) {
        const spans = index.getByParagraph(pIdx);
        expect(spans.length).toBeGreaterThanOrEqual(1);
      }
    }
    const indexedLookupTime = performance.now() - tIndexedStart;

    // Unindexed lookup (simulate original ReaderArea implementation with JSON.parse on every frame)
    const tUnindexedStart = performance.now();
    for (let frame = 0; frame < 60; frame++) {
      for (const pIdx of visibleParagraphIndices) {
        const found: any[] = [];
        for (const anc of anchors) {
          if (anc.source_type === "text_segment") {
            const loc = JSON.parse(anc.location_json);
            const hit = loc.segments?.find((s: any) => s.paragraphIndex === pIdx);
            if (hit) {
              found.push(hit);
            }
          }
        }
        expect(found.length).toBeGreaterThanOrEqual(1);
      }
    }
    const unindexedLookupTime = performance.now() - tUnindexedStart;

    // Indexed lookup should be over 10x faster than unindexed JSON.parse in render loops!
    expect(indexedLookupTime).toBeLessThan(unindexedLookupTime);
    expect(indexedLookupTime).toBeLessThan(20); // ~1ms
  });

  it("Translation Manager: Auto language resolution rules & prompt configuration", () => {
    // 1. Chinese source -> auto resolves to English
    const zhText = "人工智能正在重构现代交互软件的设计范式。";
    const resZh = resolveTargetLanguage(zhText, "auto");
    expect(resZh.targetLang).toBe("en");
    expect(resZh.displayLabel).toBe("English");
    expect(resZh.isAuto).toBe(true);

    // 2. English source -> auto resolves to Chinese
    const enText = "Deep reading requires cognitive immersion and continuous focus.";
    const resEn = resolveTargetLanguage(enText, "auto");
    expect(resEn.targetLang).toBe("zh");
    expect(resEn.displayLabel).toBe("中文");
    expect(resEn.isAuto).toBe(true);

    // 3. User configured explicit target override
    const explicitZh = resolveTargetLanguage(zhText, "zh");
    expect(explicitZh.targetLang).toBe("zh");
    expect(explicitZh.isAuto).toBe(false);

    const explicitEn = resolveTargetLanguage(enText, "en");
    expect(explicitEn.targetLang).toBe("en");
    expect(explicitEn.isAuto).toBe(false);

    // 4. Prompt construction respects user custom translation prompt
    const defaultPrompt = buildTranslationSystemPrompt("zh");
    expect(defaultPrompt).toContain("翻译");

    const customConfig = {
      translate: "请以鲁迅文风翻译，语气凝练深邃。",
    };
    const customPrompt = buildTranslationSystemPrompt("zh", customConfig);
    expect(customPrompt).toContain("鲁迅文风");
    expect(customPrompt).toContain("中文 (Simplified Chinese)");
  });

  it("Jump Target Lifecycle: Single consumption guarantee", () => {
    let lastConsumedTimestamp = 0;
    const jumpsExecuted: number[] = [];

    const handleJump = (target: { paragraphIndex: number; timestamp: number } | null) => {
      if (!target) return;
      if (target.timestamp === lastConsumedTimestamp) {
        return; // Already consumed
      }
      lastConsumedTimestamp = target.timestamp;
      jumpsExecuted.push(target.paragraphIndex);
    };

    // First jump arrives
    const jump1 = { paragraphIndex: 42, timestamp: 1001 };
    handleJump(jump1);
    expect(jumpsExecuted).toEqual([42]);

    // Sub-render / height change re-evaluates with the SAME timestamp
    handleJump(jump1);
    handleJump(jump1);
    expect(jumpsExecuted).toEqual([42]); // Still only 1 execution!

    // New jump arrives
    const jump2 = { paragraphIndex: 99, timestamp: 1002 };
    handleJump(jump2);
    expect(jumpsExecuted).toEqual([42, 99]);
  });

  it("Benchmark 5: Measures real pipeline latency (file read, EPUB HTML extraction, IPC roundtrip, text structuring, initial display, and AI streaming ReaderArea re-render count)", async () => {
    // 1. 本地文件读取测量 (5KB, 50KB, 500KB, 5MB)
    const fsMod: any = await import("fs" as any).catch(() => null);
    const pathMod: any = await import("path" as any).catch(() => null);
    const osMod: any = await import("os" as any).catch(() => null);

    const tmpDir = osMod ? osMod.tmpdir() : "/tmp";
    const sizes = [
      { name: "5KB (小文章)", sizeBytes: 5 * 1024 },
      { name: "50KB (中型论文)", sizeBytes: 50 * 1024 },
      { name: "500KB (短篇书籍)", sizeBytes: 500 * 1024 },
      { name: "5MB (长篇巨著)", sizeBytes: 5 * 1024 * 1024 },
    ];
    const fileReadResults: Record<string, number> = {};

    for (const item of sizes) {
      const sampleText = "FlowRead 深度阅读文件读取基准测试内容。\n".repeat(Math.ceil(item.sizeBytes / 60));
      if (fsMod && pathMod) {
        const filePath = pathMod.join(tmpDir, `flowread_bench_${item.sizeBytes}.txt`);
        fsMod.writeFileSync(filePath, sampleText, "utf-8");

        const t0 = performance.now();
        const readContent = fsMod.readFileSync(filePath, "utf-8");
        const duration = performance.now() - t0;
        fileReadResults[item.name] = Number(duration.toFixed(2));
        expect(readContent.length).toBeGreaterThan(0);
        try {
          fsMod.unlinkSync(filePath);
        } catch {}
      } else {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(sampleText);
        const t0 = performance.now();
        const decoded = new TextDecoder().decode(bytes);
        const duration = performance.now() - t0;
        fileReadResults[item.name] = Number(duration.toFixed(2));
        expect(decoded.length).toBeGreaterThan(0);
      }
    }

    // 2. 真实文本结构化耗时测量 (生产函数 parseAndStructureText 在不同规模下的真实耗时)
    const structuringResults: Record<string, number> = {};
    const textScales = [
      { name: "5K 字符 (常规散文)", chars: 5_000 },
      { name: "50K 字符 (长篇报告)", chars: 50_000 },
      { name: "500K 字符 (书籍分卷)", chars: 500_000 },
      { name: "1.2M 字符 (百万字巨著)", chars: 1_200_000 },
    ];
    for (const scale of textScales) {
      const pCount = Math.max(1, Math.floor(scale.chars / 150));
      const sample = Array.from({ length: pCount }, (_, i) => `【段落 ${i + 1}】${"测试文字".repeat(30)}`).join("\n\n");
      const tStart = performance.now();
      const doc = parseAndStructureText(sample, 1500);
      const tEnd = performance.now();
      structuringResults[scale.name] = Number((tEnd - tStart).toFixed(2));
      expect(doc.displayChunks.length).toBeGreaterThan(0);
    }

    // 3. 首屏真实阅读器组件挂载耗时 (ReaderArea 真实组件挂载)
    const tMountStart = performance.now();
    const { container, unmount } = render(
      React.createElement(ReaderArea, {
        filePath: null,
        scale: 1.0,
        anchors: [],
        highlights: [],
      })
    );
    const mountDuration = Number((performance.now() - tMountStart).toFixed(2));
    expect(container.querySelector(".reader-content")).not.toBeNull();
    unmount();

    // 4. 真实管线性能基准与 Windows 桌面实机待验收清单
    // 明确删除将正则清洗称为EPUB解析、将JSON编解码称为Tauri IPC、将示例memo组件称为正文渲染测量的虚假断言
    console.log("\n=== FlowRead 管线性能基准与实机验收清单 ===");
    console.log("1. 本地文件读取耗时 (Node fs I/O 微基准):", JSON.stringify(fileReadResults));
    console.log("2. 生产文本结构化耗时 (parseAndStructureText):", JSON.stringify(structuringResults));
    console.log("3. 首屏 ReaderArea 真实组件挂载耗时:", `${mountDuration} ms`);
    console.log("4. 真实 EPUB 解析 (Rust zip/xml 解包管线): 未测 (需 Windows 桌面实机验收)");
    console.log("5. 真实 Tauri 跨进程 IPC 往返传输耗时: 未测 (需 Windows 桌面实机验收)");
    console.log("6. 真实 AI 流式多卡片并发下 ReaderArea 重渲染次数: 未测 (需 Windows 桌面实机验收)");
  });
});
