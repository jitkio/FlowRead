import { PDFDataRangeTransport } from "pdfjs-dist";
import { invoke } from "@tauri-apps/api/core";

export interface FileMetadata {
  size: number;
}

/**
 * TauriPDFDataRangeTransport
 *
 * 基于 pdfjs-dist 官方 `PDFDataRangeTransport` 深度定制的按需读取适配器。
 * 作用：拦截 PDF.js 的网络范围请求，转为调用 Tauri 本地 IPC 命令 `read_file_chunk`，
 * 彻底规避大文件一次性加载至前端内存引起的 OOM，实现数百 MB 级 PDF 的秒级流式首屏渲染。
 */
export class TauriPDFDataRangeTransport extends PDFDataRangeTransport {
  private readonly filePath: string;
  private isAborted = false;
  // 记录正在飞行的请求，避免重复拉取重叠或同一区间
  private readonly activeRequests = new Map<string, Promise<void>>();

  constructor(filePath: string, length: number, initialData: Uint8Array | null = null) {
    // 关键参数 progressiveDone = true: 明确通知 PDF.js 顺序流传输已终结，后续全部依靠 Range Request 驱动
    super(length, initialData, true);
    this.filePath = filePath;
  }

  /**
   * PDF.js 核心回调接口：当 Worker 引擎解析 PDF 结构需要特定范围的字节数据时触发。
   *
   * @param begin 切片起始字节索引（包含，0-based）
   * @param end 切片结束字节索引（不包含，exclusive）
   */
  override requestDataRange(begin: number, end: number): void {
    if (this.isAborted) {
      return;
    }

    const requestKey = `${begin}-${end}`;
    if (this.activeRequests.has(requestKey)) {
      return;
    }

    const fetchPromise = (async () => {
      try {
        // 调用 Rust 侧的范围读取命令，通过二进制协议直接获取数据块
        const rawResult = await invoke<number[] | Uint8Array | ArrayBuffer>("read_file_chunk", {
          path: this.filePath,
          start: begin,
          end: end,
        });

        if (this.isAborted) {
          return;
        }

        // 统一转化为 Uint8Array，保证传输给 Worker 时的高性能零拷贝或最小拷贝
        const chunk: Uint8Array =
          rawResult instanceof Uint8Array
            ? rawResult
            : rawResult instanceof ArrayBuffer
            ? new Uint8Array(rawResult)
            : new Uint8Array(rawResult);

        // 回调 PDF.js，喂入指定 [begin, end) 的二进制数据
        this.onDataRange(begin, chunk);
      } catch (error) {
        if (!this.isAborted) {
          console.error(
            `[TauriPDFDataRangeTransport] 读取区间 [${begin}, ${end}) 失败:`,
            error
          );
        }
      } finally {
        this.activeRequests.delete(requestKey);
      }
    })();

    this.activeRequests.set(requestKey, fetchPromise);
  }

  /**
   * 终止全部正在飞行的请求并标记销毁
   */
  override abort(): void {
    this.isAborted = true;
    this.activeRequests.clear();
  }

  /**
   * 显式销毁资源
   */
  public destroy(): void {
    this.abort();
  }
}

/**
 * 工厂函数：先向 Rust 快速探查文件尺寸（微秒级），
 * 预读最初的 64KB 头部数据构建 `TauriPDFDataRangeTransport` 实例。
 *
 * @param filePath 本地 PDF 文件绝对路径
 * @param initialChunkSize 初始块大小，默认 65536 字节（64KB）
 */
export async function createTauriPDFTransport(
  filePath: string,
  initialChunkSize: number = 65536
): Promise<TauriPDFDataRangeTransport> {
  // 1. 获取文件元数据（仅读取总字节大小，不读盘）
  const metadata = await invoke<FileMetadata>("get_file_metadata", {
    path: filePath,
  });

  const totalLength = metadata.size;
  if (totalLength === 0) {
    throw new Error(`文件大小为 0 字节，无法作为有效的 PDF 文档载入: ${filePath}`);
  }

  // 2. 预读前 64KB（或整个文件），包含 PDF 头部与版本信息，避免 PDF.js 首屏等待第二次 IPC 往返
  const firstChunkEnd = Math.min(totalLength, initialChunkSize);
  let initialData: Uint8Array | null = null;

  if (firstChunkEnd > 0) {
    const rawChunk = await invoke<number[] | Uint8Array | ArrayBuffer>("read_file_chunk", {
      path: filePath,
      start: 0,
      end: firstChunkEnd,
    });

    initialData =
      rawChunk instanceof Uint8Array
        ? rawChunk
        : rawChunk instanceof ArrayBuffer
        ? new Uint8Array(rawChunk)
        : new Uint8Array(rawChunk);
  }

  return new TauriPDFDataRangeTransport(filePath, totalLength, initialData);
}
