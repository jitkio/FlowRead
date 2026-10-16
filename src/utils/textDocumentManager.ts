/**
 * FlowRead - 文本结构化解析与长段落显示切片管理器
 * 保留原始逻辑段落索引 (paragraphIndex) 与全局字符偏移，同时消解超长单段对 DOM 渲染的阻塞
 */

export interface DisplayParagraphChunk {
  /** 虚拟渲染的唯一 key */
  key: string;
  /** 显示切片索引 */
  displayIndex: number;
  /** 原始逻辑段落索引（与 SQLite/锚点记录严格一致） */
  logicalParagraphIndex: number;
  /** 该切片在所属逻辑段落中的起始字符偏移 */
  charStart: number;
  /** 该切片在所属逻辑段落中的终止字符偏移 */
  charEnd: number;
  /** 切片文本内容 */
  text: string;
  /** 是否是由超长段落分割而成 */
  isChunked: boolean;
}

export type DisplayChunk = DisplayParagraphChunk;

export interface StructuredDocument {
  /** 原始逻辑段落列表 (用于大纲、字数统计与段落总数) */
  logicalParagraphs: string[];
  /** 供给虚拟滚动渲染的切片列表 (超长段已被安全拆分) */
  displayChunks: DisplayParagraphChunk[];
  /** 逻辑段落索引 -> 显示切片索引列表映射 */
  logicalToDisplayIndices: number[][];
  /** 总字符数统计 */
  totalChars: number;
}

const MAX_SAFE_PARAGRAPH_LENGTH = 1500;
const CHUNK_TARGET_SIZE = 1000;

/**
 * 将整篇文本解析为逻辑段落，并将超过安全长度的超长单段拆分为渲染切片
 * 严格保留 logicalParagraphIndex 与 charStart/charEnd 映射，历史锚点绝不移位
 */
export function parseAndStructureText(
  rawText: string,
  maxSafeLength: number = MAX_SAFE_PARAGRAPH_LENGTH
): StructuredDocument {
  if (!rawText) {
    return {
      logicalParagraphs: [],
      displayChunks: [],
      logicalToDisplayIndices: [],
      totalChars: 0,
    };
  }

  const lines = rawText.split(/\r?\n/);
  const logicalParagraphs: string[] = [];
  const displayChunks: DisplayParagraphChunk[] = [];
  const logicalToDisplayIndices: number[][] = [];
  let totalChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;

    const pIdx = logicalParagraphs.length;
    logicalParagraphs.push(trimmed);
    totalChars += trimmed.length;
    logicalToDisplayIndices[pIdx] = [];

    // 常规段落：1:1 映射为 1 个渲染切片
    if (trimmed.length <= maxSafeLength) {
      const displayIndex = displayChunks.length;
      displayChunks.push({
        key: `p_${pIdx}_0`,
        displayIndex,
        logicalParagraphIndex: pIdx,
        charStart: 0,
        charEnd: trimmed.length,
        text: trimmed,
        isChunked: false,
      });
      logicalToDisplayIndices[pIdx].push(displayIndex);
      continue;
    }

    // 超长段落：安全分割为显示切片（优先在标点符号处断句，绝不拆开 UTF-16 代理对）
    let currentOffset = 0;
    while (currentOffset < trimmed.length) {
      const remaining = trimmed.length - currentOffset;
      let sliceLen = Math.min(CHUNK_TARGET_SIZE, remaining);

      if (remaining > CHUNK_TARGET_SIZE) {
        const searchWindow = trimmed.slice(
          currentOffset + CHUNK_TARGET_SIZE - 200,
          currentOffset + CHUNK_TARGET_SIZE + 200
        );
        const match = searchWindow.match(/[。！？!?；;\n]/);
        if (match && match.index !== undefined) {
          sliceLen = CHUNK_TARGET_SIZE - 200 + match.index + 1;
        }
      }

      let nextOffset = currentOffset + sliceLen;
      if (nextOffset < trimmed.length) {
        // 校验 UTF-16 代理对边界：绝不能切断高低代理对（例如 emoji 或稀有字符）
        const code = trimmed.charCodeAt(nextOffset);
        if (code >= 0xdc00 && code <= 0xdfff) {
          nextOffset += 1;
        } else {
          const prevCode = trimmed.charCodeAt(nextOffset - 1);
          if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
            nextOffset += 1;
          }
        }
      }
      if (nextOffset > trimmed.length) {
        nextOffset = trimmed.length;
      }

      const chunkText = trimmed.slice(currentOffset, nextOffset);
      const displayIndex = displayChunks.length;
      displayChunks.push({
        key: `p_${pIdx}_${currentOffset}`,
        displayIndex,
        logicalParagraphIndex: pIdx,
        charStart: currentOffset,
        charEnd: nextOffset,
        text: chunkText,
        isChunked: true,
      });
      logicalToDisplayIndices[pIdx].push(displayIndex);

      currentOffset = nextOffset;
    }
  }

  return {
    logicalParagraphs,
    displayChunks,
    logicalToDisplayIndices,
    totalChars,
  };
}
