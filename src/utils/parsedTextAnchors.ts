/**
 * FlowRead - 流式重排正文统一文本投影与锚点管理
 *
 * 核心设计：
 * 1. 统一文本投影 (Unified Text Projection)：
 *    从渲染后的段落/标题 DOM 中提取纯净正文字符串，排除 KaTeX 隐藏 MathML、工具栏与辅助控件。
 *    公式被视作原子标记（占位符 \uFFFC），选区不可进入或穿过公式。
 * 2. 映射保真性：
 *    UTF-16 偏移半开区间 [startOffset, endOffset)，精确计算 quote、prefix、suffix。
 *    保护 Unicode 代理对（Emoji / 特殊字符）不被切碎。
 * 3. 稳定哈希 (textHash)：
 *    采用确定性的 FNV-1a 32 位哈希算法，在创建与恢复时双向校验内容一致性。
 * 4. 边界校验：
 *    严格限制单块正文（paragraph, heading），跨块、表格、图片、公式选区明确拒绝并给出提示。
 */

import {
  HighlightRecord,
  ParsedTextLocation,
  SourceAnchorRecord,
} from "../types/records";

/**
 * 确定性 FNV-1a 32 位文本哈希算法
 * 返回 8 位十六进制小写字符串
 */
export function computeTextHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 调整 UTF-16 偏移量，避免切开代理对 (Surrogate Pairs, 如 Emoji)
 */
export function adjustSurrogatePairOffset(
  text: string,
  offset: number,
  roundUp: boolean = false
): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;

  if (
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  ) {
    return roundUp ? offset + 1 : offset - 1;
  }
  return offset;
}

export interface ProjectionSegment {
  node: Node;
  projStart: number;
  projEnd: number;
  isFormula: boolean;
  isImage?: boolean;
}

export interface BlockTextProjection {
  blockId: string;
  text: string;
  textHash: string;
  segments: ProjectionSegment[];
}

/**
 * 递归遍历块 DOM，提取统一正文投影
 */
export function getBlockTextProjection(blockEl: HTMLElement): BlockTextProjection {
  const blockId = blockEl.getAttribute("data-block-id") || "";
  let fullText = "";
  const segments: ProjectionSegment[] = [];

  function walk(node: Node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      // 1. 过滤非正文及隐藏辅助节点
      if (
        el.classList.contains("katex-mathml") ||
        el.classList.contains("parsed-formula-repair-note") ||
        el.classList.contains("parsed-formula-raw") ||
        el.classList.contains("parsed-block-highlights-layer") ||
        el.classList.contains("floating-selection-toolbar") ||
        el.getAttribute("aria-hidden") === "true" && !el.classList.contains("katex-html")
      ) {
        return;
      }

      // 2. 公式视为原子标记（占位符 \uFFFC，长度 1）
      if (el.classList.contains("katex") || el.classList.contains("katex-display")) {
        const start = fullText.length;
        fullText += "\uFFFC";
        segments.push({
          node: el,
          projStart: start,
          projEnd: start + 1,
          isFormula: true,
          isImage: false,
        });
        return;
      }

      // 3. 内联图片视为原子标记（占位符 \uFFFC，长度 1，加载前后正文偏移稳定不变）
      if (
        el.hasAttribute("data-inline-image") ||
        el.classList.contains("parsed-inline-image-wrapper") ||
        el.classList.contains("parsed-inline-image") ||
        el.classList.contains("parsed-image-inline-loading") ||
        el.classList.contains("parsed-image-inline-error") ||
        el.classList.contains("parsed-restricted-media") ||
        el.tagName === "IMG"
      ) {
        const start = fullText.length;
        fullText += "\uFFFC";
        segments.push({
          node: el,
          projStart: start,
          projEnd: start + 1,
          isFormula: false,
          isImage: true,
        });
        return;
      }

      // 4. 换行符
      if (el.tagName === "BR") {
        const start = fullText.length;
        fullText += "\n";
        segments.push({
          node: el,
          projStart: start,
          projEnd: start + 1,
          isFormula: false,
          isImage: false,
        });
        return;
      }

      for (let i = 0; i < el.childNodes.length; i++) {
        walk(el.childNodes[i]);
      }
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const val = node.textContent || "";
      if (val.length > 0) {
        const start = fullText.length;
        fullText += val;
        segments.push({
          node,
          projStart: start,
          projEnd: start + val.length,
          isFormula: false,
        });
      }
    }
  }

  walk(blockEl);

  return {
    blockId,
    text: fullText,
    textHash: computeTextHash(fullText),
    segments,
  };
}

/**
 * 将 DOM 选区边界点 (Node + offset) 精准解析为正文纯净投影字符偏移
 * 支持 Text 节点字符偏移以及 Element + childOffset 的合法 Range 边界映射
 */
export function resolveDOMBoundaryPoint(
  proj: BlockTextProjection,
  containerNode: Node,
  offset: number,
  isStart: boolean
): number | null {
  // 1. Text 节点直接匹配
  if (containerNode.nodeType === Node.TEXT_NODE) {
    for (const seg of proj.segments) {
      if (!seg.isFormula && !seg.isImage && seg.node === containerNode) {
        const textLen = (containerNode.textContent || "").length;
        const clampedOffset = Math.max(0, Math.min(offset, textLen));
        return seg.projStart + clampedOffset;
      }
    }
    return null;
  }

  // 2. Element 节点按子节点匹配
  if (containerNode.nodeType === Node.ELEMENT_NODE) {
    const el = containerNode as HTMLElement;
    const childNodes = el.childNodes;

    if (childNodes.length === 0) {
      for (const seg of proj.segments) {
        if (seg.node === el) {
          return isStart ? seg.projStart : seg.projEnd;
        }
      }
      return null;
    }

    if (offset <= 0) {
      for (const seg of proj.segments) {
        if (el.contains(seg.node) || el === seg.node) {
          return seg.projStart;
        }
      }
      return null;
    }

    if (offset >= childNodes.length) {
      for (let i = proj.segments.length - 1; i >= 0; i--) {
        const seg = proj.segments[i];
        if (el.contains(seg.node) || el === seg.node) {
          return seg.projEnd;
        }
      }
      return null;
    }

    if (isStart) {
      for (let idx = offset; idx < childNodes.length; idx++) {
        const child = childNodes[idx];
        for (const seg of proj.segments) {
          if (child.contains(seg.node) || child === seg.node) {
            return seg.projStart;
          }
        }
      }
    } else {
      for (let idx = offset - 1; idx >= 0; idx--) {
        const child = childNodes[idx];
        for (let i = proj.segments.length - 1; i >= 0; i--) {
          const seg = proj.segments[i];
          if (child.contains(seg.node) || child === seg.node) {
            return seg.projEnd;
          }
        }
      }
    }
  }

  return null;
}

export interface SelectionValidationResult {
  valid: boolean;
  errorReason?: string;
  blockId?: string;
  blockEl?: HTMLElement;
  startOffset?: number;
  endOffset?: number;
  quote?: string;
  prefix?: string;
  suffix?: string;
  textHash?: string;
  rangeRect?: DOMRect;
}

/**
 * 校验 DOM 选区合法性并投影为块内字符半开区间
 */
export function validateAndMapDOMSelection(
  selection: Selection,
  container: HTMLElement
): SelectionValidationResult {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { valid: false, errorReason: "未选择文本" };
  }

  const range = selection.getRangeAt(0);

  // 1. 查找起止节点所属结构块
  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as HTMLElement)
      : range.startContainer.parentElement;
  const endEl =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as HTMLElement)
      : range.endContainer.parentElement;

  if (!startEl || !endEl) {
    return { valid: false, errorReason: "无法定位选区所在节点" };
  }

  const startBlockEl = startEl.closest<HTMLElement>("[data-block-id]");
  const endBlockEl = endEl.closest<HTMLElement>("[data-block-id]");

  if (!startBlockEl || !endBlockEl) {
    return { valid: false, errorReason: "选区未在有效正文结构块内" };
  }

  if (startBlockEl !== endBlockEl) {
    return {
      valid: false,
      errorReason: "不支持跨内容块选择，请在单一段落或标题内选择文字",
    };
  }

  const blockEl = startBlockEl;
  if (!container.contains(blockEl)) {
    return { valid: false, errorReason: "选区不在当前重排阅读区内" };
  }

  // 2. 限制块类型：本轮仅支持正文段落与标题
  const isParagraph = blockEl.classList.contains("parsed-paragraph-container");
  const isHeading = blockEl.classList.contains("parsed-heading-container");

  if (!isParagraph && !isHeading) {
    if (blockEl.classList.contains("parsed-table-container") || blockEl.closest(".parsed-table-container")) {
      return { valid: false, errorReason: "当前暂不支持在表格中划词标注" };
    }
    if (blockEl.classList.contains("parsed-figure-container") || blockEl.closest(".parsed-figure-container")) {
      return { valid: false, errorReason: "当前暂不支持在图片中划词标注" };
    }
    return { valid: false, errorReason: "当前仅支持在正文段落与标题中选择文字" };
  }

  // 3. 检查是否直接选中或进入公式 / 内联图片
  if (
    startEl.closest(".katex") ||
    endEl.closest(".katex") ||
    startEl.closest(".katex-display") ||
    endEl.closest(".katex-display")
  ) {
    return {
      valid: false,
      errorReason: "选区不能穿过或进入数学公式，请选择公式前后的普通文字",
    };
  }

  if (
    startEl.closest(
      '[data-inline-image], .parsed-inline-image-wrapper, .parsed-inline-image, .parsed-image-inline-loading, .parsed-image-inline-error, .parsed-restricted-media'
    ) ||
    endEl.closest(
      '[data-inline-image], .parsed-inline-image-wrapper, .parsed-inline-image, .parsed-image-inline-loading, .parsed-image-inline-error, .parsed-restricted-media'
    )
  ) {
    return {
      valid: false,
      errorReason: "选区不能穿过或包含内联图片，请选择图片前后的普通文字",
    };
  }

  // 4. 提取块的正文投影并计算偏移 (支持 Text 与 Element + childOffset 边界)
  const proj = getBlockTextProjection(blockEl);

  let projStart = resolveDOMBoundaryPoint(proj, range.startContainer, range.startOffset, true);
  let projEnd = resolveDOMBoundaryPoint(proj, range.endContainer, range.endOffset, false);

  if (projStart === null || projEnd === null) {
    return { valid: false, errorReason: "未能匹配正文投影字符位置" };
  }

  // 用户可能反向选择（从右往左拉取）
  if (projStart > projEnd) {
    const tmp = projStart;
    projStart = projEnd;
    projEnd = tmp;
  }

  // 5. 校验选区是否穿过了中间的公式或内联图片
  for (const seg of proj.segments) {
    if (seg.isFormula && seg.projStart < projEnd && seg.projEnd > projStart) {
      return {
        valid: false,
        errorReason: "选区不能穿过或进入数学公式，请选择公式前后的普通文字",
      };
    }
    if (seg.isImage && seg.projStart < projEnd && seg.projEnd > projStart) {
      return {
        valid: false,
        errorReason: "选区不能穿过或包含内联图片，请选择图片前后的普通文字",
      };
    }
  }

  // 保护 Unicode 代理对
  projStart = adjustSurrogatePairOffset(proj.text, projStart, false);
  projEnd = adjustSurrogatePairOffset(proj.text, projEnd, true);

  const quote = proj.text.slice(projStart, projEnd);
  if (!quote.trim()) {
    return { valid: false, errorReason: "所选区域未包含有效文字" };
  }

  const prefix = proj.text.slice(Math.max(0, projStart - 30), projStart);
  const suffix = proj.text.slice(projEnd, Math.min(proj.text.length, projEnd + 30));

  const rangeRect = range.getBoundingClientRect();

  return {
    valid: true,
    blockId: proj.blockId,
    blockEl,
    startOffset: projStart,
    endOffset: projEnd,
    quote,
    prefix,
    suffix,
    textHash: proj.textHash,
    rangeRect,
  };
}

/**
 * 根据投影偏移恢复 DOM Range
 */
export function createDOMRangeFromProjection(
  blockEl: HTMLElement,
  startOffset: number,
  endOffset: number
): Range | null {
  if (startOffset >= endOffset) return null;

  const proj = getBlockTextProjection(blockEl);
  if (startOffset < 0 || endOffset > proj.text.length) return null;

  let startNode: Node | null = null;
  let startNodeOffset = 0;
  let endNode: Node | null = null;
  let endNodeOffset = 0;

  for (const seg of proj.segments) {
    if (seg.isFormula || seg.isImage) continue;

    if (startNode === null && startOffset >= seg.projStart && startOffset <= seg.projEnd) {
      startNode = seg.node;
      startNodeOffset = Math.min(
        seg.node.textContent?.length || 0,
        startOffset - seg.projStart
      );
    }

    if (endOffset >= seg.projStart && endOffset <= seg.projEnd) {
      endNode = seg.node;
      endNodeOffset = Math.min(
        seg.node.textContent?.length || 0,
        endOffset - seg.projStart
      );
    }
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
    return range;
  } catch {
    return null;
  }
}

export interface SourceVerificationResult {
  valid: boolean;
  failReason?: string;
  blockEl?: HTMLElement;
  range?: Range;
  rects?: DOMRect[];
}

/**
 * 生产代码共用的完整来源验证入口
 * 检查：
 * 1. 结构与版本规范：schemaVersion===1, projectionVersion===1, 单一 segment, 非负整数偏移, quote 与长度一致
 * 2. 身份一致性：parsedVersionId 匹配, sourceRevision 匹配
 * 3. 真实 DOM 完整性（若传入 container）：结构块存在性、FNV-1a textHash 一致性、quote 正文精确切片匹配及 Range 恢复
 */
export function verifyParsedTextLocation(
  container: HTMLElement | null,
  currentParsedVersionId: string,
  currentSourceRevision?: string,
  location?: unknown,
  expectedExcerpt?: string
): SourceVerificationResult {
  if (!location || typeof location !== "object") {
    return { valid: false, failReason: "来源定位数据为空或非法" };
  }

  const loc = location as Partial<ParsedTextLocation>;
  if (loc.type !== "parsed_text") {
    return { valid: false, failReason: "非重排文字来源类型" };
  }

  if (loc.schemaVersion !== 1) {
    return { valid: false, failReason: `不支持的 schemaVersion: ${loc.schemaVersion}` };
  }

  if (loc.projectionVersion !== 1) {
    return { valid: false, failReason: `不支持的 projectionVersion: ${loc.projectionVersion}` };
  }

  if (!loc.parsedVersionId || typeof loc.parsedVersionId !== "string") {
    return { valid: false, failReason: "来源解析版本 ID 缺失或非法" };
  }

  if (loc.parsedVersionId !== currentParsedVersionId) {
    return {
      valid: false,
      failReason: `来源属于历史解析版本 (${loc.parsedVersionId})，与当前激活版本不符`,
    };
  }

  if (currentSourceRevision && loc.sourceRevision) {
    if (loc.sourceRevision.trim() !== currentSourceRevision.trim()) {
      return {
        valid: false,
        failReason: `来源修订版本 (${loc.sourceRevision}) 与当前修订 (${currentSourceRevision}) 不符`,
      };
    }
  }

  if (!Array.isArray(loc.segments) || loc.segments.length !== 1) {
    return { valid: false, failReason: "重排来源片段必须为且仅为一个 segment" };
  }

  const seg = loc.segments[0];
  if (!seg || typeof seg !== "object") {
    return { valid: false, failReason: "来源片段数据缺失" };
  }

  if (!seg.blockId || typeof seg.blockId !== "string") {
    return { valid: false, failReason: "来源块 ID 缺失或非法" };
  }

  if (!Number.isInteger(seg.startOffset) || seg.startOffset < 0) {
    return { valid: false, failReason: "来源 startOffset 必须为非负整数" };
  }

  if (!Number.isInteger(seg.endOffset) || seg.endOffset <= seg.startOffset) {
    return { valid: false, failReason: "来源 endOffset 必须大于 startOffset" };
  }

  if (typeof seg.quote !== "string" || seg.quote.length === 0) {
    return { valid: false, failReason: "来源引用文本缺失或为空" };
  }

  if (seg.quote.length !== seg.endOffset - seg.startOffset) {
    return { valid: false, failReason: "来源引用文本长度与偏移区间长度不一致" };
  }

  if (!seg.textHash || typeof seg.textHash !== "string") {
    return { valid: false, failReason: "来源文本哈希缺失" };
  }

  if (expectedExcerpt && expectedExcerpt !== seg.quote) {
    return { valid: false, failReason: "记录摘录与来源引用不一致" };
  }

  // 若提供了 DOM 容器，进一步执行真实 DOM 校验与 Range 恢复
  if (container) {
    const blockEl = container.querySelector<HTMLElement>(`[data-block-id="${seg.blockId}"]`);
    if (!blockEl) {
      return { valid: false, failReason: `目标结构块 #${seg.blockId} 不存在` };
    }

    const proj = getBlockTextProjection(blockEl);

    // 严格校验正文一致性哈希
    if (proj.textHash !== seg.textHash) {
      return { valid: false, failReason: "正文内容已变更，无法准确定位" };
    }

    // 校验字符范围有效性
    if (seg.endOffset > proj.text.length) {
      return { valid: false, failReason: "字符偏移超出正文总长度" };
    }

    // 校验引用正文不匹配
    const actualQuote = proj.text.slice(seg.startOffset, seg.endOffset);
    if (actualQuote !== seg.quote) {
      return { valid: false, failReason: "引用正文不匹配" };
    }

    // 构建真实 DOM Range
    const range = createDOMRangeFromProjection(blockEl, seg.startOffset, seg.endOffset);
    if (!range) {
      return { valid: false, failReason: "构建显示选区范围失败" };
    }

    const rects = Array.from(range.getClientRects());
    return {
      valid: true,
      blockEl,
      range,
      rects,
    };
  }

  return { valid: true };
}

export interface AnchorVerifyResult {
  verified: boolean;
  failReason?: string;
  blockEl?: HTMLElement;
  range?: Range;
  rects?: DOMRect[];
}

/**
 * 校验已保存的重排来源并恢复其在当前界面的 DOM Range（向后兼容封装）
 */
export function verifyAndLocateAnchor(
  container: HTMLElement,
  currentParsedVersionId: string,
  location: ParsedTextLocation
): AnchorVerifyResult {
  const res = verifyParsedTextLocation(
    container,
    currentParsedVersionId,
    location?.sourceRevision,
    location
  );
  return {
    verified: res.valid,
    failReason: res.failReason,
    blockEl: res.blockEl,
    range: res.range,
    rects: res.rects,
  };
}

export interface ParsedBlockAnchorEntry {
  anchorId: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  prefix: string;
  suffix: string;
  textHash: string;
  color: string;
  hasHighlight: boolean;
}

/**
 * 高效预分组：按 blockId 索引属于当前版本的有效重排锚点
 * 时间复杂度 O(A)，避免在每个块渲染时重复扫描全书锚点
 */
export function indexAnchorsByBlock(
  anchors: SourceAnchorRecord[],
  highlights: HighlightRecord[],
  currentParsedVersionId: string,
  currentSourceRevision?: string
): Map<string, ParsedBlockAnchorEntry[]> {
  const map = new Map<string, ParsedBlockAnchorEntry[]>();
  const highlightColorMap = new Map<string, string>();

  for (const h of highlights) {
    highlightColorMap.set(h.anchor_id, h.color);
  }

  for (const a of anchors) {
    if (a.source_type !== "parsed_text") continue;

    try {
      const loc = JSON.parse(a.location_json);
      // 统一来源结构与版本校验
      const verifyRes = verifyParsedTextLocation(
        null,
        currentParsedVersionId,
        currentSourceRevision,
        loc,
        a.excerpt
      );
      if (!verifyRes.valid) continue;

      const seg = loc.segments[0];
      const color = highlightColorMap.get(a.anchor_id) || "rgba(230,200,70,.4)";
      const hasHighlight = highlightColorMap.has(a.anchor_id);

      const list = map.get(seg.blockId) || [];
      list.push({
        anchorId: a.anchor_id,
        blockId: seg.blockId,
        startOffset: seg.startOffset,
        endOffset: seg.endOffset,
        quote: seg.quote,
        prefix: seg.prefix || "",
        suffix: seg.suffix || "",
        textHash: seg.textHash,
        color,
        hasHighlight,
      });
      map.set(seg.blockId, list);
    } catch {
      // 容错忽略非法 JSON
    }
  }

  return map;
}
