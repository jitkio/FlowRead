/**
 * FlowRead - 正文锚点与高亮哈希索引系统
 * 将原本每次渲染逐段 JSON.parse 的 O(N * A) 扫描降级为 O(1) 段落级哈希查找
 */

import { SourceAnchorRecord, HighlightRecord, TextParagraphSegment } from "../types/records";

export interface ParagraphAnchorSpan {
  anchor_id: string;
  startOffset: number;
  endOffset: number;
  color: string;
  isActive: boolean;
}

export interface ParagraphAnchorIndex {
  /** 根据逻辑段落索引快速获取该段落包含的所有锚点切片 */
  getByParagraph: (paragraphIndex: number) => ParagraphAnchorSpan[];
  /** 判断特定段落是否存在任何锚点切片 */
  hasParagraphAnchors: (paragraphIndex: number) => boolean;
  /** 全部有效锚点段落的总数 */
  indexedParagraphCount: number;
  /** 索引的所有锚点总数 */
  totalAnchorsIndexed: number;
}

/**
 * 在数据变动（anchors、highlights、revision 或 activeAnchorId 变化）时构建单次哈希索引
 */
export function buildParagraphAnchorIndex(
  anchors: SourceAnchorRecord[],
  highlights: HighlightRecord[],
  documentRevision?: string,
  activeAnchorId?: string | null
): ParagraphAnchorIndex {
  // 1. O(H) 构建高亮颜色哈希表
  const highlightColorMap = new Map<string, string>();
  for (const hl of highlights) {
    highlightColorMap.set(hl.anchor_id, hl.color);
  }

  // 2. O(A) 预解析并按逻辑段落分组
  const paragraphMap = new Map<number, ParagraphAnchorSpan[]>();

  for (const anc of anchors) {
    if (anc.source_type !== "text_segment") continue;

    // 校验修订版本，避免混淆新旧版本段落
    if (documentRevision && anc.document_revision && anc.document_revision !== documentRevision) {
      continue;
    }

    try {
      const loc = JSON.parse(anc.location_json);
      const segs: TextParagraphSegment[] = loc.segments || [];

      for (const seg of segs) {
        const pIdx = seg.paragraphIndex;
        if (typeof pIdx !== "number" || pIdx < 0) continue;

        const start = Math.max(0, seg.startOffset || 0);
        const end = Math.max(start, seg.endOffset || 0);
        if (end <= start) continue;

        const color = highlightColorMap.get(anc.anchor_id) || "var(--hlc, rgba(230,200,70,.35))";
        const isActive = anc.anchor_id === activeAnchorId;

        const span: ParagraphAnchorSpan = {
          anchor_id: anc.anchor_id,
          startOffset: start,
          endOffset: end,
          color,
          isActive,
        };

        const existing = paragraphMap.get(pIdx);
        if (existing) {
          existing.push(span);
        } else {
          paragraphMap.set(pIdx, [span]);
        }
      }
    } catch {
      // 容错非法 JSON
    }
  }

  return {
    getByParagraph: (pIdx: number) => paragraphMap.get(pIdx) || [],
    hasParagraphAnchors: (pIdx: number) => paragraphMap.has(pIdx),
    indexedParagraphCount: paragraphMap.size,
    totalAnchorsIndexed: anchors.length,
  };
}
