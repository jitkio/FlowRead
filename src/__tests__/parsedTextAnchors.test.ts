import { describe, it, expect, beforeEach } from "vitest";
import {
  computeTextHash,
  adjustSurrogatePairOffset,
  getBlockTextProjection,
  validateAndMapDOMSelection,
  verifyAndLocateAnchor,
  indexAnchorsByBlock,
} from "../utils/parsedTextAnchors";
import { ParsedTextLocation, SourceAnchorRecord, HighlightRecord } from "../types/records";

describe("parsedTextAnchors 单元测试", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    container.className = "parsed-reflow-scroll-area";
    document.body.appendChild(container);
  });

  describe("1. 哈希与代理对安全", () => {
    it("computeTextHash 确定性一致", () => {
      const h1 = computeTextHash("Hello FlowRead");
      const h2 = computeTextHash("Hello FlowRead");
      const h3 = computeTextHash("Hello FlowRead!");
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(8);
      expect(h1).not.toBe(h3);
    });

    it("adjustSurrogatePairOffset 保护 Emoji 不被切碎", () => {
      const emojiText = "A😀B"; // 'A' (0), '\uD83D\uDE00' (1, 2), 'B' (3)
      // 偏移落在 2 处（Emoji 内部）
      expect(adjustSurrogatePairOffset(emojiText, 2, false)).toBe(1);
      expect(adjustSurrogatePairOffset(emojiText, 2, true)).toBe(3);
      // 普通字符不影响
      expect(adjustSurrogatePairOffset(emojiText, 1, false)).toBe(1);
      expect(adjustSurrogatePairOffset(emojiText, 3, false)).toBe(3);
    });
  });

  describe("2. 统一正文投影 (getBlockTextProjection)", () => {
    it("提取纯净文本，排除 MathML 与修补提示，公式作为原子占位符", () => {
      const block = document.createElement("div");
      block.className = "parsed-paragraph-container";
      block.setAttribute("data-block-id", "blk_1");
      block.innerHTML = `<p>Let <strong>V_in</strong> be the input voltage <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>V</mi></mrow></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord mathnormal">V</span></span></span></span> and <em>V_out</em> be the output.<span class="parsed-formula-repair-note"><span class="parsed-formula-repair-badge">已兼容显示</span><button class="parsed-formula-raw-toggle">查看原式</button></span></p>`;
      container.appendChild(block);

      const proj = getBlockTextProjection(block);
      expect(proj.blockId).toBe("blk_1");
      // 必须包含占位符 \uFFFC，不包含 MathML 和 repair-note
      expect(proj.text).toContain("Let V_in be the input voltage \uFFFC and V_out be the output.");
      expect(proj.text).not.toContain("已兼容显示");
      expect(proj.text).not.toContain("查看原式");
      expect(proj.textHash).toBe(computeTextHash(proj.text));

      const formulaSeg = proj.segments.find((s) => s.isFormula);
      expect(formulaSeg).toBeDefined();
      expect(formulaSeg?.projEnd! - formulaSeg?.projStart!).toBe(1);
    });

    it("跨越粗体、链接等多文本节点正确连续拼接", () => {
      const block = document.createElement("div");
      block.className = "parsed-paragraph-container";
      block.setAttribute("data-block-id", "blk_2");
      block.innerHTML = `<p>FlowRead 支持 <strong>深度</strong> <a href="#">学习</a> 与阅读。</p>`;
      container.appendChild(block);

      const proj = getBlockTextProjection(block);
      expect(proj.text).toBe("FlowRead 支持 深度 学习 与阅读。");
    });
  });

  describe("3. 选区校验与映射 (validateAndMapDOMSelection)", () => {
    it("段落内有效普通文字选区成功捕获并计算精确 quote 与 prefix/suffix", () => {
      const block = document.createElement("div");
      block.className = "parsed-paragraph-container";
      block.setAttribute("data-block-id", "blk_p");
      const p = document.createElement("p");
      const textNode = document.createTextNode("Power electronics is an enabling technology.");
      p.appendChild(textNode);
      block.appendChild(p);
      container.appendChild(block);

      const range = document.createRange();
      range.setStart(textNode, 6); // "electronics"
      range.setEnd(textNode, 17);

      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);

      const res = validateAndMapDOMSelection(sel, container);
      expect(res.valid).toBe(true);
      expect(res.blockId).toBe("blk_p");
      expect(res.startOffset).toBe(6);
      expect(res.endOffset).toBe(17);
      expect(res.quote).toBe("electronics");
      expect(res.prefix).toBe("Power ");
      expect(res.suffix).toBe(" is an enabling technology.");
      expect(res.textHash).toBe(computeTextHash("Power electronics is an enabling technology."));
    });

    it("支持 Element + childOffset 边界映射 (如 selectNodeContents)", () => {
      const block = document.createElement("div");
      block.className = "parsed-paragraph-container";
      block.setAttribute("data-block-id", "blk_elem");
      const p = document.createElement("p");
      p.innerHTML = "A <strong>B</strong> C";
      block.appendChild(p);
      container.appendChild(block);

      // 1. selectNodeContents(p)
      const range = document.createRange();
      range.selectNodeContents(p);

      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);

      const res = validateAndMapDOMSelection(sel, container);
      expect(res.valid).toBe(true);
      expect(res.blockId).toBe("blk_elem");
      expect(res.startOffset).toBe(0);
      expect(res.endOffset).toBe(5);
      expect(res.quote).toBe("A B C");

      // 2. 选择 p 的子节点 1 (即 <strong>B</strong>)
      const subRange = document.createRange();
      subRange.setStart(p, 1);
      subRange.setEnd(p, 2);
      sel.removeAllRanges();
      sel.addRange(subRange);

      const subRes = validateAndMapDOMSelection(sel, container);
      expect(subRes.valid).toBe(true);
      expect(subRes.startOffset).toBe(2);
      expect(subRes.endOffset).toBe(3);
      expect(subRes.quote).toBe("B");
    });

    it("段落内内联图片：两侧文字可选，跨图选区明确拒绝，加载前后正文偏移恒定", () => {
      const block = document.createElement("div");
      block.className = "parsed-paragraph-container";
      block.setAttribute("data-block-id", "blk_img");
      const p = document.createElement("p");
      p.innerHTML = `Before <span class="parsed-inline-image-wrapper" data-inline-image="true"><span class="parsed-image-inline-loading">正在加载图片...</span></span> After`;
      block.appendChild(p);
      container.appendChild(block);

      // 加载中状态投影
      const projLoading = getBlockTextProjection(block);
      expect(projLoading.text).not.toContain("正在加载图片");
      expect(projLoading.text).toBe("Before \uFFFC After");
      const hashLoading = projLoading.textHash;

      // 模拟图片加载完成
      const imgWrapper = p.querySelector(".parsed-inline-image-wrapper")!;
      imgWrapper.innerHTML = `<img src="blob:mock" alt="test" class="parsed-inline-image" />`;

      // 加载完成状态投影：正文字符串、长度与文本哈希必须绝对一致！
      const projLoaded = getBlockTextProjection(block);
      expect(projLoaded.text).toBe("Before \uFFFC After");
      expect(projLoaded.textHash).toBe(hashLoading);

      // 1. 选择图片前方的普通文字
      const beforeNode = p.firstChild as Text;
      const rangeBefore = document.createRange();
      rangeBefore.setStart(beforeNode, 0);
      rangeBefore.setEnd(beforeNode, 6);

      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(rangeBefore);

      const resBefore = validateAndMapDOMSelection(sel, container);
      expect(resBefore.valid).toBe(true);
      expect(resBefore.quote).toBe("Before");

      // 2. 选择图片后方的普通文字
      const afterNode = p.lastChild as Text;
      const rangeAfter = document.createRange();
      rangeAfter.setStart(afterNode, 1); // "After"
      rangeAfter.setEnd(afterNode, 6);

      sel.removeAllRanges();
      sel.addRange(rangeAfter);

      const resAfter = validateAndMapDOMSelection(sel, container);
      expect(resAfter.valid).toBe(true);
      expect(resAfter.quote).toBe("After");

      // 3. 跨越图片的选区必须明确拒绝
      const crossRange = document.createRange();
      crossRange.setStart(beforeNode, 0);
      crossRange.setEnd(afterNode, 6);

      sel.removeAllRanges();
      sel.addRange(crossRange);

      const resCross = validateAndMapDOMSelection(sel, container);
      expect(resCross.valid).toBe(false);
      expect(resCross.errorReason).toContain("内联图片");
    });

    it("跨内容块选择被明确拒绝", () => {
      const b1 = document.createElement("div");
      b1.className = "parsed-paragraph-container";
      b1.setAttribute("data-block-id", "blk_1");
      const t1 = document.createTextNode("Paragraph 1");
      b1.appendChild(t1);

      const b2 = document.createElement("div");
      b2.className = "parsed-paragraph-container";
      b2.setAttribute("data-block-id", "blk_2");
      const t2 = document.createTextNode("Paragraph 2");
      b2.appendChild(t2);

      container.appendChild(b1);
      container.appendChild(b2);

      const range = document.createRange();
      range.setStart(t1, 0);
      range.setEnd(t2, 5);

      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);

      const res = validateAndMapDOMSelection(sel, container);
      expect(res.valid).toBe(false);
      expect(res.errorReason).toContain("不支持跨内容块选择");
    });

    it("选区进入或穿过公式被明确拒绝，但公式两侧普通文字可选", () => {
      const block = document.createElement("div");
      block.className = "parsed-paragraph-container";
      block.setAttribute("data-block-id", "blk_math");
      block.innerHTML = `<p>Before <span class="katex"><span class="katex-html">x=1</span></span> After</p>`;
      container.appendChild(block);

      const beforeText = block.querySelector("p")!.childNodes[0];
      const katexEl = block.querySelector(".katex")!;
      const afterText = block.querySelector("p")!.childNodes[2];

      const sel = window.getSelection()!;

      // 1. 公式前文字合法
      const r1 = document.createRange();
      r1.setStart(beforeText, 0);
      r1.setEnd(beforeText, 6);
      sel.removeAllRanges();
      sel.addRange(r1);
      const res1 = validateAndMapDOMSelection(sel, container);
      expect(res1.valid).toBe(true);
      expect(res1.quote).toBe("Before");

      // 2. 公式后文字合法
      const r2 = document.createRange();
      r2.setStart(afterText, 1);
      r2.setEnd(afterText, 6);
      sel.removeAllRanges();
      sel.addRange(r2);
      const res2 = validateAndMapDOMSelection(sel, container);
      expect(res2.valid).toBe(true);
      expect(res2.quote).toBe("After");

      // 3. 选区穿过公式被拒绝
      const rCross = document.createRange();
      rCross.setStart(beforeText, 2);
      rCross.setEnd(afterText, 3);
      sel.removeAllRanges();
      sel.addRange(rCross);
      const resCross = validateAndMapDOMSelection(sel, container);
      expect(resCross.valid).toBe(false);
      expect(resCross.errorReason).toContain("数学公式");

      // 4. 选区进入公式内部被拒绝
      const rInside = document.createRange();
      rInside.setStart(katexEl, 0);
      rInside.setEnd(katexEl, 1);
      sel.removeAllRanges();
      sel.addRange(rInside);
      const resInside = validateAndMapDOMSelection(sel, container);
      expect(resInside.valid).toBe(false);
      expect(resInside.errorReason).toContain("数学公式");
    });

    it("不支持的块类型（如表格、图片）被明确拒绝", () => {
      const tableBlock = document.createElement("div");
      tableBlock.className = "parsed-table-container";
      tableBlock.setAttribute("data-block-id", "tbl_1");
      const tNode = document.createTextNode("Table cell text");
      tableBlock.appendChild(tNode);
      container.appendChild(tableBlock);

      const range = document.createRange();
      range.setStart(tNode, 0);
      range.setEnd(tNode, 5);

      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);

      const res = validateAndMapDOMSelection(sel, container);
      expect(res.valid).toBe(false);
      expect(res.errorReason).toContain("表格");
    });
  });

  describe("4. 来源校验与恢复 (verifyAndLocateAnchor)", () => {
    const validLoc: ParsedTextLocation = {
      type: "parsed_text",
      schemaVersion: 1,
      parsedVersionId: "ver_123",
      sourceRevision: "rev_abc",
      projectionVersion: 1,
      segments: [
        {
          blockId: "blk_rec",
          startOffset: 0,
          endOffset: 8,
          quote: "FlowRead",
          prefix: "",
          suffix: " is fast",
          textHash: computeTextHash("FlowRead is fast"),
        },
      ],
    };

    it("有效来源正常恢复 Range 并定位", () => {
      const block = document.createElement("div");
      block.className = "parsed-paragraph-container";
      block.setAttribute("data-block-id", "blk_rec");
      block.innerHTML = `<p>FlowRead is fast</p>`;
      container.appendChild(block);

      const result = verifyAndLocateAnchor(container, "ver_123", validLoc);
      expect(result.verified).toBe(true);
      expect(result.blockEl).toBe(block);
      expect(result.range).toBeDefined();
    });

    it("解析版本不匹配时拒绝定位并给出明确提示", () => {
      const block = document.createElement("div");
      block.className = "parsed-paragraph-container";
      block.setAttribute("data-block-id", "blk_rec");
      block.innerHTML = `<p>FlowRead is fast</p>`;
      container.appendChild(block);

      const result = verifyAndLocateAnchor(container, "ver_other", validLoc);
      expect(result.verified).toBe(false);
      expect(result.failReason).toContain("历史解析版本");
    });

    it("正文变更导致 textHash 不匹配时拒绝定位，不猜测、不高亮其他位置", () => {
      const block = document.createElement("div");
      block.className = "parsed-paragraph-container";
      block.setAttribute("data-block-id", "blk_rec");
      block.innerHTML = `<p>FlowRead is CHANGED</p>`;
      container.appendChild(block);

      const result = verifyAndLocateAnchor(container, "ver_123", validLoc);
      expect(result.verified).toBe(false);
      expect(result.failReason).toContain("正文内容已变更");
    });

    it("正文被替换为同长度其他文字时，哈希与切片均拒绝定位，不发生错误对齐", () => {
      const block = document.createElement("div");
      block.className = "parsed-paragraph-container";
      block.setAttribute("data-block-id", "blk_rec");
      // 原正文为 "FlowRead is fast" (长度 16)
      // 现替换为同长度的 "1234567890123456" (长度 16)
      block.innerHTML = `<p>1234567890123456</p>`;
      container.appendChild(block);

      const result = verifyAndLocateAnchor(container, "ver_123", validLoc);
      expect(result.verified).toBe(false);
      expect(result.failReason).toContain("正文内容已变更");
    });

    it("结构块不存在时明确报错，不发生崩溃", () => {
      const result = verifyAndLocateAnchor(container, "ver_123", validLoc);
      expect(result.verified).toBe(false);
      expect(result.failReason).toContain("不存在");
    });
  });

  describe("5. 锚点高效预分组 (indexAnchorsByBlock)", () => {
    it("O(A) 过滤属于当前解析版本与修订的有效锚点，校验来源数据结构并分组", () => {
      const curHash = computeTextHash("test1 extra text");
      const anchors: SourceAnchorRecord[] = [
        {
          anchor_id: "anc_1",
          document_id: "doc_1",
          document_revision: "rev_1",
          source_type: "parsed_text",
          excerpt: "test1",
          location_json: JSON.stringify({
            type: "parsed_text",
            schemaVersion: 1,
            projectionVersion: 1,
            parsedVersionId: "ver_cur",
            sourceRevision: "rev_1",
            segments: [
              {
                blockId: "b1",
                startOffset: 0,
                endOffset: 5,
                quote: "test1",
                textHash: curHash,
              },
            ],
          }),
          created_at: 100,
        },
        {
          anchor_id: "anc_2",
          document_id: "doc_1",
          document_revision: "rev_1",
          source_type: "parsed_text",
          excerpt: "test2",
          location_json: JSON.stringify({
            type: "parsed_text",
            schemaVersion: 1,
            projectionVersion: 1,
            parsedVersionId: "ver_old", // 旧版本
            sourceRevision: "rev_1",
            segments: [
              {
                blockId: "b1",
                startOffset: 0,
                endOffset: 5,
                quote: "test2",
                textHash: computeTextHash("test2"),
              },
            ],
          }),
          created_at: 200,
        },
        {
          anchor_id: "anc_3",
          document_id: "doc_1",
          document_revision: "rev_1",
          source_type: "pdf_text", // 非重排
          excerpt: "pdf text",
          location_json: "{}",
          created_at: 300,
        },
      ];

      const highlights: HighlightRecord[] = [
        {
          highlight_id: "hl_1",
          anchor_id: "anc_1",
          document_id: "doc_1",
          color: "rgba(92,184,112,.4)",
          created_at: 100,
          excerpt: "test1",
          location_json: "{}",
          source_type: "parsed_text",
        },
      ];

      const map = indexAnchorsByBlock(anchors, highlights, "ver_cur", "rev_1");
      expect(map.size).toBe(1);
      expect(map.has("b1")).toBe(true);

      const list = map.get("b1")!;
      expect(list).toHaveLength(1);
      expect(list[0].anchorId).toBe("anc_1");
      expect(list[0].color).toBe("rgba(92,184,112,.4)");
      expect(list[0].hasHighlight).toBe(true);
    });
  });
});
