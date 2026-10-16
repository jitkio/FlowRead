/**
 * FlowRead - 学习记录、来源锚点与阅读偏好数据类型定义
 */

export type SourceType = "pdf_text" | "pdf_image" | "text_segment";

export interface PDFTextSegment {
  pageNumber: number;
  /** 每页在 PDF 原始未缩放坐标系下的矩形序列 [x1, y1, x2, y2] */
  rects: [number, number, number, number][];
}

export interface PDFImageLocation {
  pageNumber: number;
  /** PDF 坐标系下的选区边界 [x1, y1, x2, y2] */
  rect: [number, number, number, number];
  /** 关联图片二进制资源 ID */
  assetId: string;
}

export interface TextParagraphSegment {
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  prefix?: string;
  suffix?: string;
}

export type SourceLocationData =
  | { type: "pdf_text"; segments: PDFTextSegment[] }
  | { type: "pdf_image"; location: PDFImageLocation }
  | { type: "text_segment"; segments: TextParagraphSegment[] };

export interface DocumentRecord {
  id: string;
  file_path: string;
  display_name: string;
  file_size: number;
  revision: string;
  last_read_position: string | null;
  created_at: number;
  updated_at: number;
}

export interface SourceAnchorRecord {
  anchor_id: string;
  document_id: string;
  document_revision: string;
  source_type: SourceType;
  excerpt: string;
  location_json: string;
  created_at: number;
}

export type CardAction =
  | "Ask"
  | "explain"
  | "translate"
  | "simplify"
  | "extract-formula"
  | "analyze-chart"
  | "extract-text"
  | "summarize"
  | "custom"
  | string;

export type CardDepth = "quick" | "deep";

export type CardStatus =
  | "queued"
  | "generating"
  | "completed"
  | "failed"
  | "interrupted";

export interface CardRecord {
  card_id: string;
  document_id: string;
  anchor_id: string | null;
  action: CardAction;
  depth: CardDepth;
  status: CardStatus;
  user_prompt: string;
  preview: string;
  ai_response: string;
  model_name: string;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  anchor_excerpt: string | null;
  anchor_source_type: string | null;
  anchor_location_json: string | null;
  turns_count: number;
}

export interface CardTurnRecord {
  turn_id: string;
  card_id: string;
  user_prompt: string;
  ai_response: string;
  status: string;
  created_at: number;
}

export interface CardFunctionResultRecord {
  result_id: string;
  card_id: string;
  mode: string;
  result_content: string;
  created_at: number;
  config_signature?: string;
  version?: number;
}

export interface FullCardDetail {
  card: CardRecord;
  anchor: SourceAnchorRecord | null;
  turns: CardTurnRecord[];
  function_results: CardFunctionResultRecord[];
}

export interface HighlightRecord {
  highlight_id: string;
  document_id: string;
  anchor_id: string;
  color: string;
  created_at: number;
  excerpt: string;
  location_json: string;
  source_type: string;
}

export interface CardListResponse {
  items: CardRecord[];
  total: number;
  has_more: boolean;
}

export type ThemeMode = "auto" | "paper" | "sepia" | "snow" | "night" | "ink";

export interface ReadingPreferences {
  theme: ThemeMode;
  penColor: string;
  highlighterColor: string;
  fontSize: number; // 15 - 26px
  fontFamily: string;
  lineHeight: number; // 1.5, 1.7, 1.95
  contentWidth: number; // 740, 987, 1160
  textAlign: "left" | "justify";
  paragraphStyle: "spaced" | "indented";
  cardFontSize: number; // 12 - 16px
  defaultDepth: CardDepth;
  translateLanguage: "auto" | "zh" | "en";
}

export const DEFAULT_READING_PREFERENCES: ReadingPreferences = {
  theme: "auto",
  penColor: "#e8664a",
  highlighterColor: "rgba(230,200,70,.4)",
  fontSize: 19,
  fontFamily: "'Newsreader', Georgia, 'Source Han Serif SC', 'Noto Serif CJK SC', 'Songti SC', 'SimSun', serif",
  lineHeight: 1.7,
  contentWidth: 987,
  textAlign: "left",
  paragraphStyle: "spaced",
  cardFontSize: 13,
  defaultDepth: "quick",
  translateLanguage: "auto",
};
