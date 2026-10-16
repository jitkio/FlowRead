/**
 * FlowRead - 解析结果只读预览数据契约 (阶段 2A 原型)
 * 注意：本定义仅作为当前只读预览原型的数据交互结构，不视为最终生产数据库或持久化契约。
 */

export type ParsedBlockType =
  | "paragraph"
  | "heading"
  | "formula"
  | "image"
  | "table"
  | "caption"
  | "page_header"
  | "page_number"
  | "unknown";

export type ContentFormat = "markdown" | "latex" | "html" | string;

export interface InlineRun {
  type: "text" | "equation_inline" | string;
  content: string;
}

export interface ParsedBlock {
  id: string;
  server_id?: string | null;
  type: ParsedBlockType;
  raw_type?: string | null;
  reading_order?: number;
  content: string;
  content_format?: ContentFormat;
  inline_runs?: InlineRun[];
  asset_ref?: string | null;
  caption?: string | null;
  in_image_text?: string[];
  page_sample?: number;
  page_source?: number;
  raw_bbox?: number[] | null;
  /**
   * 归一化坐标: [x0, y0, x1, y1] (0.0 ~ 1.0)
   * 注意：顺序严格为 [x0, y0, x1, y1]，并非 [ymin, xmin, ymax, xmax]
   */
  normalized_bbox?: [number, number, number, number] | null;
  pt_bbox?: number[] | null;
  coordinate_system?: string;
  raw_node?: unknown;
  /** 运行时或校验时局部错误信息（若有） */
  parse_error?: string;
}

export interface ParsedDocument {
  version: "parsed_preview_v1";
  sessionId: string;
  filePath: string;
  fileName: string;
  docDir: string;
  hasAssets: boolean;
  blocks: ParsedBlock[];
}

export interface ParsedDocumentStats {
  totalBlocks: number;
  renderableBlocks: number;
  paragraphCount: number;
  headingCount: number;
  formulaCount: number;
  imageCount: number;
  tableCount: number;
  captionCount: number;
  pageHeaderFooterCount: number;
  unknownCount: number;
}

export interface ParsedDocumentValidationResult {
  valid: boolean;
  document?: ParsedDocument;
  errors: string[];
  warnings: string[];
  stats: ParsedDocumentStats;
}
