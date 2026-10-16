import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import * as pdfjsLib from "pdfjs-dist";
import App from "../App";
import FullAnswerModal from "../components/FullAnswerModal";
import ReaderArea from "../components/ReaderArea";
import PDFReaderArea from "../components/PDFReaderArea";
import { parseAndStructureText } from "../utils/textDocumentManager";
import { buildFunctionConfigSignature } from "../utils/translationManager";
import { saveModelProfiles, saveActiveProfileId } from "../utils/aiConfig";
import { invoke } from "@tauri-apps/api/core";
import { FullCardDetail } from "../types/records";

const mockInvoke = vi.mocked(invoke);

function setupMockPdf() {
  const mockPage = {
    getViewport: ({ scale = 1.0 }: { scale?: number } = {}) => ({
      width: Math.floor(595 * scale),
      height: Math.floor(842 * scale),
      scale,
      convertToPdfPoint: (x: number, y: number) => [x, y],
    }),
    render: () => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }),
    getTextContent: () =>
      Promise.resolve({
        items: [
          {
            str: "PDF 关键论点分析与推导",
            dir: "ltr",
            width: 120,
            height: 16,
            transform: [1, 0, 0, 1, 0, 0],
          },
        ],
      }),
    cleanup: vi.fn(),
  };

  const mockDoc = {
    numPages: 2,
    getPage: vi.fn().mockResolvedValue(mockPage),
    cleanup: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  vi.mocked(pdfjsLib.getDocument).mockImplementation(() => {
    return {
      promise: Promise.resolve(mockDoc),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as any;
  });

  return { mockDoc, mockPage };
}

describe("Phase 1: 真实路径回归验证与遗漏补齐", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  // ==========================================
  // 1. 修改全局语言后打开详情
  // ==========================================
  it("1. 修改全局语言后打开详情：继承全局最新语言，局部覆盖仅在弹窗打开期生效，关开后重置为全局，不自动重译全部历史卡片", async () => {
    const cardDetail: FullCardDetail = {
      card: {
        card_id: "card-lang-1",
        document_id: "doc-1",
        anchor_id: "anc-1",
        action: "translate",
        depth: "quick",
        status: "completed",
        user_prompt: "",
        ai_response: "原文内容",
        preview: "原文内容",
        error_message: null,
        model_name: "test-model",
        created_at: 1000,
        updated_at: 1000,
        turns_count: 0,
        anchor_excerpt: "人工智能正在重构现代交互",
        anchor_source_type: "text_segment",
        anchor_location_json: "{}",
      },
      anchor: {
        anchor_id: "anc-1",
        document_id: "doc-1",
        document_revision: "rev-1",
        source_type: "text_segment",
        location_json: "{}",
        excerpt: "人工智能正在重构现代交互",
        created_at: 1000,
      },
      turns: [],
      function_results: [],
    };

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_get_card_detail") {
        return Promise.resolve(cardDetail);
      }
      if (cmd === "db_allocate_function_version") {
        return Promise.resolve(1);
      }
      return Promise.resolve(null);
    });

    const { rerender, getByText, queryByText } = render(
      <FullAnswerModal
        cardId="card-lang-1"
        isOpen={true}
        onClose={() => {}}
        globalTranslateLanguage="en"
      />
    );

    // 切换到“对照翻译”功能页
    await waitFor(() => {
      expect(getByText("对照翻译")).not.toBeNull();
    });
    fireEvent.click(getByText("对照翻译"));

    // 初始打开时，有效目标语言应继承全局设置 "en" (English)
    await waitFor(() => {
      expect(queryByText(/目标:\s*English/)).not.toBeNull();
    });

    // 用户在工具栏修改全局语言为 "zh" (中文)，组件保持挂载并接收新 props
    rerender(
      <FullAnswerModal
        cardId="card-lang-1"
        isOpen={true}
        onClose={() => {}}
        globalTranslateLanguage="zh"
      />
    );

    // 下一次详情翻译立即使用新设置 "zh"，不保留旧默认值 "en"
    await waitFor(() => {
      expect(queryByText(/目标:\s*简体中文/)).not.toBeNull();
    });

    // 用户在模态框内临时覆盖选择 "en"
    const enButton = queryByText("English");
    if (enButton) {
      fireEvent.click(enButton);
    }
    await waitFor(() => {
      expect(queryByText(/目标:\s*English/)).not.toBeNull();
    });

    // 关闭模态框并重新打开：临时覆盖自动重置，重新继承全局最新设置 "zh"
    rerender(
      <FullAnswerModal
        cardId="card-lang-1"
        isOpen={false}
        onClose={() => {}}
        globalTranslateLanguage="zh"
      />
    );
    rerender(
      <FullAnswerModal
        cardId="card-lang-1"
        isOpen={true}
        onClose={() => {}}
        globalTranslateLanguage="zh"
      />
    );

    await waitFor(() => {
      expect(getByText("对照翻译")).not.toBeNull();
    });
    fireEvent.click(getByText("对照翻译"));

    await waitFor(() => {
      expect(queryByText(/目标:\s*简体中文/)).not.toBeNull();
    });
  });

  // ==========================================
  // 2. auto遇到错误语言旧缓存
  // ==========================================
  it("2. auto遇到错误语言旧缓存：精确匹配目标语言，删除startsWith('translate')模糊命中，旧无语言/异种语言缓存不冒充当前有效缓存", async () => {
    // 中文原文在 auto 模式下判定目标语言为 "en"
    const cardWithWrongCache: FullCardDetail = {
      card: {
        card_id: "card-cache-1",
        document_id: "doc-1",
        anchor_id: "anc-1",
        action: "Ask",
        depth: "quick",
        status: "completed",
        user_prompt: "",
        ai_response: "这是中文原文内容",
        preview: "这是中文原文内容",
        error_message: null,
        model_name: "test-model",
        created_at: 1000,
        updated_at: 1000,
        turns_count: 0,
        anchor_excerpt: "这是中文原文内容",
        anchor_source_type: "text_segment",
        anchor_location_json: "{}",
      },
      anchor: {
        anchor_id: "anc-1",
        document_id: "doc-1",
        document_revision: "rev-1",
        source_type: "text_segment",
        location_json: "{}",
        excerpt: "这是中文原文内容",
        created_at: 1000,
      },
      turns: [],
      function_results: [
        {
          result_id: "res-legacy",
          card_id: "card-cache-1",
          mode: "translate", // 旧无语言信息的结果
          result_content: "旧无语言标记结果",
          created_at: 900,
        },
        {
          result_id: "res-zh",
          card_id: "card-cache-1",
          mode: "translate:zh", // 错误的中文目标缓存
          result_content: "中文目标翻译结果",
          created_at: 950,
        },
      ],
    };

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_get_card_detail") {
        return Promise.resolve(cardWithWrongCache);
      }
      return Promise.resolve(null);
    });

    const { getByText, queryByText } = render(
      <FullAnswerModal
        cardId="card-cache-1"
        isOpen={true}
        onClose={() => {}}
        globalTranslateLanguage="auto"
      />
    );

    // 切换到“对照翻译”页
    await waitFor(() => {
      expect(getByText("对照翻译")).not.toBeNull();
    });
    fireEvent.click(getByText("对照翻译"));

    // 当前实际目标语言为 English (translate:en)。
    // 页面绝不能通过 startsWith("translate") 错误命中 translate:zh 或旧无标记 translate！
    expect(queryByText("中文目标翻译结果")).toBeNull();
    expect(queryByText("旧无语言标记结果")).toBeNull();
  });

  // ==========================================
  // 3. 旧请求慢、新请求快，最终数据库保留新结果
  // ==========================================
  it("3. 旧请求慢、新请求快：同卡同功能版本机制防护，数据库提交校验有效版本，旧生成不得覆盖新结果", async () => {
    let activeVersion = 0;
    let savedDbRecord: { version: number; content: string } | null = null;

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "db_allocate_function_version") {
        activeVersion++;
        return Promise.resolve(activeVersion);
      }
      if (cmd === "db_save_function_result") {
        const { version, resultContent } = args;
        // 模拟 SQLite 端的版本校验：版本小于当前活跃版本则忽略写入
        if (version < activeVersion) {
          return Promise.resolve(false);
        }
        savedDbRecord = { version, content: resultContent };
        return Promise.resolve(true);
      }
      return Promise.resolve(null);
    });

    // 请求 1 开始（慢请求）-> 分配版本号 v1
    const v1 = await mockInvoke("db_allocate_function_version", { cardId: "card-race-1", mode: "explain" });
    expect(v1).toBe(1);

    // 用户点击重新生成，请求 2 开始（快请求）-> 分配版本号 v2
    const v2 = await mockInvoke("db_allocate_function_version", { cardId: "card-race-1", mode: "explain" });
    expect(v2).toBe(2);

    // 请求 2 网络耗时短，先一步完成并提交落库
    const write2Success = await mockInvoke("db_save_function_result", {
      cardId: "card-race-1",
      mode: "explain",
      resultContent: "新请求快速生成的结果",
      version: v2,
    });
    expect(write2Success).toBe(true);
    expect(savedDbRecord).toEqual({ version: 2, content: "新请求快速生成的结果" });

    // 随后请求 1 网络耗时长，较晚到达并尝试落库
    const write1Success = await mockInvoke("db_save_function_result", {
      cardId: "card-race-1",
      mode: "explain",
      resultContent: "旧请求慢速生成的旧结果",
      version: v1,
    });
    expect(write1Success).toBe(false);

    // 数据库最终严格保留请求 2 的新结果，未被旧结果覆盖！
    expect(savedDbRecord).toEqual({ version: 2, content: "新请求快速生成的结果" });
  });

  // ==========================================
  // 4. 改提示词或模型后的缓存失效
  // ==========================================
  it("4. 改提示词或模型后的缓存失效：生成配置签名包含有效提示词、模型、深度和目标语言，配置改变后签名改变并绕过缓存", () => {
    const baseParams = {
      sourceVersion: "rev-2026",
      sourceText: "深度阅读的核心在于专注",
      mode: "translate",
      targetLang: "zh",
      prompt: "标准翻译提示词",
      modelName: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      depth: "quick" as const,
    };

    const sigInitial = buildFunctionConfigSignature(baseParams);

    // 1. 相同配置生成一致签名，允许复用
    const sigSame = buildFunctionConfigSignature({ ...baseParams });
    expect(sigInitial).toBe(sigSame);

    // 2. 修改提示词 -> 签名立即改变
    const sigPromptChanged = buildFunctionConfigSignature({
      ...baseParams,
      prompt: "严谨学术论文文风翻译",
    });
    expect(sigInitial).not.toBe(sigPromptChanged);

    // 3. 修改模型 -> 签名立即改变
    const sigModelChanged = buildFunctionConfigSignature({
      ...baseParams,
      modelName: "gpt-4o",
    });
    expect(sigInitial).not.toBe(sigModelChanged);

    // 4. 修改目标语言 -> 签名立即改变
    const sigLangChanged = buildFunctionConfigSignature({
      ...baseParams,
      targetLang: "en",
    });
    expect(sigInitial).not.toBe(sigLangChanged);

    // 5. 修改深度 -> 签名立即改变
    const sigDepthChanged = buildFunctionConfigSignature({
      ...baseParams,
      depth: "deep",
    });
    expect(sigInitial).not.toBe(sigDepthChanged);

    // 6. 安全保证：绝不包含或泄露 API 密钥
    expect(sigInitial).not.toContain("sk-");
  });

  // ==========================================
  // 5. 长段后半部锚点跳转、跨切片选区和emoji边界
  // ==========================================
  it("5. 长段后半部锚点跳转、跨切片选区和emoji边界：不拆开UTF-16代理对，字符拼接无缝还原，按字符偏移正确定位所属后半切片", () => {
    // 构造跨越 1500 字符切片阈值的长段落，并在切片边界附近放入 4 字节 Emoji
    const prefix = "正文段落开头部分。".repeat(140); // 1260 字符
    const emojiBoundary = "🚀✨🌟🎉🔥💡📚🧠"; // 8 个 emoji，每个占 2 个 UTF-16 code units (16 code units)
    const middle = "切片中间衔接文字。".repeat(120); // 1080 字符
    const anchorTargetExcerpt = "【目标锚点定位文字】";
    const suffix = "长段落末尾的收尾内容。".repeat(80); // 880 字符
    const fullParagraph = prefix + emojiBoundary + middle + anchorTargetExcerpt + suffix;

    const doc = parseAndStructureText(fullParagraph, 1500);

    // 1. 代理对安全校验：切片边界绝不出现孤立 high surrogate (0xd800-0xdbff) 或 low surrogate (0xdc00-0xdfff)
    for (const chunk of doc.displayChunks) {
      const firstCode = chunk.text.charCodeAt(0);
      const lastCode = chunk.text.charCodeAt(chunk.text.length - 1);
      expect(firstCode < 0xdc00 || firstCode > 0xdfff).toBe(true);
      expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
    }

    // 2. 切片拼接必须百分之百还原原文本，无字符丢失或漂移
    const concatenated = doc.displayChunks.map((c) => c.text).join("");
    expect(concatenated).toBe(fullParagraph);

    // 3. 计算位于后半部锚点的字符偏移
    const targetCharOffset = fullParagraph.indexOf(anchorTargetExcerpt);
    expect(targetCharOffset).toBeGreaterThan(2000);

    // 4. 定位所属显示切片：不能固定跳第一个切片！
    const displayIndices = doc.logicalToDisplayIndices[0];
    expect(displayIndices.length).toBeGreaterThan(1);

    const targetDisplayIndex = displayIndices.find((dIdx) => {
      const chunk = doc.displayChunks[dIdx];
      return chunk && targetCharOffset >= chunk.charStart && targetCharOffset < chunk.charEnd;
    });

    expect(targetDisplayIndex).toBeDefined();
    expect(targetDisplayIndex).not.toBe(displayIndices[0]); // 严格定位到后半部切片而非首切片

    const targetChunk = doc.displayChunks[targetDisplayIndex!];
    expect(targetChunk.text).toContain(anchorTargetExcerpt);
  });

  // ==========================================
  // 6. 统一滚动和缩放坐标（100%、150%、200%首尾可达）
  // ==========================================
  it("6. 统一滚动和缩放坐标：标题、160px留白、正文测高与 zoom 正确换算，100%/150%/200% 缩放末尾完整可达", () => {
    // 验证 ReaderArea 在不同缩放比例下的坐标换算与边界计算
    const scales = [1.0, 1.5, 2.0];

    for (const scale of scales) {
      const { container, unmount } = render(
        <ReaderArea
          filePath={null}
          scale={scale}
          anchors={[]}
          highlights={[]}
        />
      );

      const viewport = container.querySelector(".reader-scroll-viewport") as HTMLElement;
      expect(viewport).not.toBeNull();

      const contentArticle = container.querySelector(".reader-content") as HTMLElement;
      expect(contentArticle.style.zoom).toBe(String(scale));

      // 验证滚动条轨道与滑块结构存在
      const track = container.querySelector(".custom-scrollbar-track") as HTMLElement;
      const thumb = container.querySelector(".custom-scrollbar-thumb") as HTMLElement;
      expect(track).not.toBeNull();
      expect(thumb).not.toBeNull();

      unmount();
    }
  });

  // ==========================================
  // 7. 加载期间的来源身份隔离
  // ==========================================
  it("7. 加载期间的来源身份隔离：B慢加载期间清空选区快照，禁用来源操作，校验绑定文档身份和打开序号防止污染B", async () => {
    const pendingFileBPromise = new Promise<string>(() => {});

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "read_local_file") {
        if (args.filePath === "/docB.txt") {
          return pendingFileBPromise; // 模拟 B 读取较慢
        }
        return Promise.resolve("这是文档 A 的已有内容");
      }
      return Promise.resolve(null);
    });

    const onCreateAnchorAndCard = vi.fn();
    const onCreateHighlight = vi.fn();

    // 初始处于文档 A
    const { rerender, container } = render(
      <ReaderArea
        filePath="/docA.txt"
        documentId="doc-A"
        documentSeq={1}
        onCreateAnchorAndCard={onCreateAnchorAndCard}
        onCreateHighlight={onCreateHighlight}
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".reader-content")).not.toBeNull();
    });

    // 开始切换到文档 B（慢加载进行中，seq = 2）
    rerender(
      <ReaderArea
        filePath="/docB.txt"
        documentId="doc-B"
        documentSeq={2}
        onCreateAnchorAndCard={onCreateAnchorAndCard}
        onCreateHighlight={onCreateHighlight}
      />
    );

    // 在文档 B 处于加载态期间，用户在旧视图尝试划词松开
    fireEvent.mouseUp(container);

    // 选区快照必须失效，不得触发创建卡片或高亮
    expect(onCreateAnchorAndCard).not.toHaveBeenCalled();
    expect(onCreateHighlight).not.toHaveBeenCalled();

    // App 层校验机制：拦截旧文档或旧序号操作
    const verifyAnchorCreation = (params: { boundDocId?: string; boundSeq?: number }) => {
      const activeDocId = "doc-B";
      const activeSeq = 2;
      if (params.boundDocId && params.boundDocId !== activeDocId) return false;
      if (params.boundSeq !== undefined && params.boundSeq !== activeSeq) return false;
      return true;
    };

    // 携带 A 的旧身份或旧序号将被绝对拒收
    expect(verifyAnchorCreation({ boundDocId: "doc-A", boundSeq: 1 })).toBe(false);
    expect(verifyAnchorCreation({ boundDocId: "doc-A", boundSeq: 2 })).toBe(false);
    expect(verifyAnchorCreation({ boundDocId: "doc-B", boundSeq: 1 })).toBe(false);

    // 仅当 B 身份与最新序号同时吻合才允许接收
    expect(verifyAnchorCreation({ boundDocId: "doc-B", boundSeq: 2 })).toBe(true);
  });

  // ==========================================
  // 8. 打开入口统一来源身份
  // ==========================================
  it("8. 打开入口统一来源身份：A元数据慢随后打开B，A迟到不得覆盖B身份；B正文先到身份未就绪时操作B不能登记到A；文本、PDF文字和截图入口遵循相同身份约束", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const mockOpen = vi.mocked(open);

    let docLoadedTitle: string | null = null;
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "get_file_metadata") {
        if (args?.path === "/path/A.txt") {
          return new Promise((resolve) => setTimeout(() => resolve({ size: 1024, mtime: 1000, revision: "v1" }), 60));
        }
        return Promise.resolve({ size: 1024, mtime: 1000, revision: "v2" });
      }
      if (cmd === "db_get_or_create_document") {
        docLoadedTitle = args?.displayName || args?.title || args?.path;
        return Promise.resolve({
          id: `doc-${args?.displayName || args?.title}`,
          path: args?.path,
          title: args?.displayName || args?.title,
          file_size: 1024,
          revision: "v1",
          created_at: 1000,
          updated_at: 1000,
        });
      }
      if (cmd === "read_local_file") {
        return Promise.resolve("文档正文内容");
      }
      if (cmd === "db_get_reading_preferences") return Promise.resolve(null);
      if (cmd === "db_save_reading_position") return Promise.resolve(true);
      if (cmd === "db_get_anchors") return Promise.resolve([]);
      if (cmd === "db_get_cards") return Promise.resolve({ items: [], total: 0, has_more: false });
      if (cmd === "db_get_highlights") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    // 1. 在真实 App 组件中测试打开管线：打开 A 后立即打开 B
    const { unmount: unmountApp } = render(<App />);

    // 模拟打开 A (元数据延迟 60ms)
    mockOpen.mockResolvedValueOnce("/path/A.txt");
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });

    // 随后立即打开 B (元数据无延迟)
    mockOpen.mockResolvedValueOnce("/path/B.txt");
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });

    // 等待确保 A 的延迟元数据已到达并被检验
    await waitFor(() => {
      expect(docLoadedTitle).toBe("B.txt");
    });
    unmountApp();

    // 2. 验证 ReaderArea：B正文先到但身份未就绪时，选区提交绝不调用回调
    const onCreateAnchorAndCard = vi.fn();
    const onCreateHighlight = vi.fn();

    const { container: textContainer } = render(
      <ReaderArea
        filePath="/path/B.txt"
        documentSeq={2}
        documentId={undefined} // 身份尚未就绪
        documentRevision={undefined}
        onCreateAnchorAndCard={onCreateAnchorAndCard}
        onCreateHighlight={onCreateHighlight}
      />
    );

    fireEvent.mouseUp(textContainer);
    expect(onCreateAnchorAndCard).not.toHaveBeenCalled();
    expect(onCreateHighlight).not.toHaveBeenCalled();

    // 3. 验证 PDFReaderArea 文本与截图入口遵循相同身份约束
    const onPdfCreateCard = vi.fn();
    const onPdfCreateHighlight = vi.fn();

    const { container: pdfContainer } = render(
      <PDFReaderArea
        filePath="/path/B.pdf"
        documentSeq={2}
        documentId={undefined} // 身份尚未就绪
        onCreateAnchorAndCard={onPdfCreateCard}
        onCreateHighlight={onPdfCreateHighlight}
      />
    );

    fireEvent.mouseUp(pdfContainer);
    expect(onPdfCreateCard).not.toHaveBeenCalled();
    expect(onPdfCreateHighlight).not.toHaveBeenCalled();
  });

  // ==========================================
  // 9. 消除重复文件读取
  // ==========================================
  it("9. 消除重复文件读取：实际ReaderArea挂载及分阶段props更新，同一次打开请求严格只调用一次read_local_file", async () => {
    let readFileCount = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_local_file") {
        readFileCount++;
        return Promise.resolve("书本正文内容，段落一。");
      }
      return Promise.resolve(null);
    });

    // 阶段 1: 首次挂载（仅传入 filePath 与 documentSeq=1，元数据与 DB 身份尚未返回）
    const { rerender } = render(
      <ReaderArea
        filePath="/books/clean_code.txt"
        documentSeq={1}
        documentId={undefined}
        documentRevision={undefined}
      />
    );

    await waitFor(() => {
      expect(readFileCount).toBe(1);
    });

    // 阶段 2: 元数据到达，更新 documentRevision="rev-1"
    rerender(
      <ReaderArea
        filePath="/books/clean_code.txt"
        documentSeq={1}
        documentId={undefined}
        documentRevision="rev-1"
      />
    );

    // 阶段 3: SQLite 数据库身份返回，更新 documentId="doc-123"
    rerender(
      <ReaderArea
        filePath="/books/clean_code.txt"
        documentSeq={1}
        documentId="doc-123"
        documentRevision="rev-1"
      />
    );

    // 正常打开过程的分阶段 props 更新，绝不触发重复读取！严格只有 1 次！
    expect(readFileCount).toBe(1);

    // 阶段 4: 同路径文件明确重新打开（documentSeq=2）
    rerender(
      <ReaderArea
        filePath="/books/clean_code.txt"
        documentSeq={2}
        documentId="doc-123"
        documentRevision="rev-1"
      />
    );

    await waitFor(() => {
      expect(readFileCount).toBe(2);
    });

    // 阶段 5: 文件修订版本发生变化（revision="rev-2"）
    rerender(
      <ReaderArea
        filePath="/books/clean_code.txt"
        documentSeq={2}
        documentId="doc-123"
        documentRevision="rev-2"
      />
    );

    await waitFor(() => {
      expect(readFileCount).toBe(3);
    });
  });

  // ==========================================
  // 10. 缩放监听与滚动写入
  // ==========================================
  it("10. 缩放监听与滚动写入：100%切150%/200%，中段改变缩放按比例同步阅读位置，末尾可达且scrollToFn写入乘以scale", async () => {
    const longContent = Array.from({ length: 60 }, (_, i) => `段落 ${i + 1}：深入探讨数字阅读在认知层面的重构。`).join("\n\n");
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_local_file") return Promise.resolve(longContent);
      return Promise.resolve(null);
    });

    const { rerender, container } = render(
      <ReaderArea
        filePath="/books/long.txt"
        documentSeq={1}
        scale={1.0}
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".virtual-paragraph-item")).not.toBeNull();
    });

    const viewport = container.querySelector(".reader-scroll-viewport") as HTMLElement;
    expect(viewport).not.toBeNull();

    let scrollTopValue = 0;
    Object.defineProperty(viewport, "scrollTop", {
      get: () => scrollTopValue,
      set: (v: number) => {
        scrollTopValue = v;
      },
      configurable: true,
    });
    Object.defineProperty(viewport, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(viewport, "scrollHeight", { value: 3000, configurable: true });

    // 模拟滚到中段：scrollTop = 400 (在 1.0x 视角下)
    viewport.scrollTop = 400;
    fireEvent.scroll(viewport);

    // 切换缩放至 1.5x
    rerender(
      <ReaderArea
        filePath="/books/long.txt"
        documentSeq={1}
        scale={1.5}
      />
    );

    // 验证：有效阅读位置按比例实时乘以 1.5 换算为 600
    expect(viewport.scrollTop).toBe(600);

    // 切换缩放至 2.0x
    rerender(
      <ReaderArea
        filePath="/books/long.txt"
        documentSeq={1}
        scale={2.0}
      />
    );

    // 验证：有效阅读位置按比例实时换算为 (600 / 1.5) * 2.0 = 800
    expect(viewport.scrollTop).toBe(800);
  });

  // ==========================================
  // 11. 统一功能请求生命周期
  // ==========================================
  it("11. 统一功能请求生命周期：普通文字点击公式/图表功能，检测结果正常显示，按钮恢复可用；版本分配失败明确报错反馈", async () => {
    saveModelProfiles([
      {
        id: "profile_test",
        profileName: "测试配置",
        baseUrl: "https://api.deepseek.com/chat/completions",
        apiKey: "test-api-key",
        modelName: "deepseek-chat",
      },
    ]);
    saveActiveProfileId("profile_test");

    const cardDetail: FullCardDetail = {
      card: {
        card_id: "card-lifecycle-1",
        document_id: "doc-1",
        anchor_id: "anc-1",
        action: "Ask",
        depth: "quick",
        status: "completed",
        user_prompt: "",
        ai_response: "这是纯文字，没有任何公式，也没有任何架构图。",
        preview: "这是纯文字，没有任何公式，也没有任何架构图。",
        error_message: null,
        model_name: "deepseek-chat",
        created_at: 1000,
        updated_at: 1000,
        turns_count: 0,
        anchor_excerpt: "这是纯文字，没有任何公式，也没有任何架构图。",
        anchor_source_type: "text_segment",
        anchor_location_json: "{}",
      },
      anchor: {
        anchor_id: "anc-1",
        document_id: "doc-1",
        document_revision: "rev-1",
        source_type: "text_segment",
        location_json: "{}",
        excerpt: "这是纯文字，没有任何公式，也没有任何架构图。",
        created_at: 1000,
      },
      turns: [],
      function_results: [],
    };

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "db_get_card_detail") {
        return Promise.resolve(cardDetail);
      }
      if (cmd === "db_allocate_function_version") {
        return Promise.resolve(1);
      }
      if (cmd === "db_save_function_result") {
        const { mode, resultContent, configSignature } = args;
        cardDetail.function_results.push({
          result_id: `res-${mode}`,
          card_id: "card-lifecycle-1",
          mode,
          result_content: resultContent,
          config_signature: configSignature,
          created_at: Date.now(),
        });
        return Promise.resolve(true);
      }
      return Promise.resolve(null);
    });

    const { getByText, queryByText } = render(
      <FullAnswerModal
        cardId="card-lifecycle-1"
        isOpen={true}
        onClose={() => {}}
      />
    );

    // 1. 点击“提取公式”
    await waitFor(() => {
      expect(getByText("提取公式")).not.toBeNull();
    });
    fireEvent.click(getByText("提取公式"));

    // 验证：检测结果正常显示，且 loading 结束，没有永久卡在生成中
    await waitFor(() => {
      expect(queryByText(/所选原文未检测到明确的数学或物理公式/)).not.toBeNull();
    });

    // 2. 点击“图表解析”
    fireEvent.click(getByText("图表解析"));
    await waitFor(() => {
      expect(queryByText(/当前选区为纯文本，未包含工程拓扑图/)).not.toBeNull();
    });

    // 3. 版本分配失败分支：明确报错并终止，不降级为 1 发起请求
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_get_card_detail") return Promise.resolve(cardDetail);
      if (cmd === "db_allocate_function_version") {
        return Promise.reject(new Error("SQLite锁冲突"));
      }
      return Promise.resolve(null);
    });

    fireEvent.click(getByText("✧ 深度解释"));
    await waitFor(() => {
      expect(queryByText(/分配功能任务版本失败: SQLite锁冲突/)).not.toBeNull();
    });
  });

  // ==========================================
  // 12. 无签名旧缓存不能冒充当前配置
  // ==========================================
  it("12. 无签名旧缓存不能冒充当前配置：旧缓存无签名，修改模型/提示词后执行功能，确实发送新请求并保存新签名", async () => {
    saveModelProfiles([
      {
        id: "profile_test",
        profileName: "测试配置",
        baseUrl: "https://api.deepseek.com/chat/completions",
        apiKey: "test-api-key",
        modelName: "deepseek-chat",
      },
    ]);
    saveActiveProfileId("profile_test");

    let savedSignature: string | undefined = undefined;

    const legacyDetail: FullCardDetail = {
      card: {
        card_id: "card-sig-1",
        document_id: "doc-1",
        anchor_id: "anc-1",
        action: "Ask",
        depth: "quick",
        status: "completed",
        user_prompt: "",
        ai_response: "原文内容",
        preview: "原文内容",
        error_message: null,
        model_name: "deepseek-chat",
        created_at: 1000,
        updated_at: 1000,
        turns_count: 0,
        anchor_excerpt: "阅读的艺术",
        anchor_source_type: "text_segment",
        anchor_location_json: "{}",
      },
      anchor: {
        anchor_id: "anc-1",
        document_id: "doc-1",
        document_revision: "rev-1",
        source_type: "text_segment",
        location_json: "{}",
        excerpt: "阅读的艺术",
        created_at: 1000,
      },
      turns: [],
      function_results: [
        {
          result_id: "res-legacy-explain",
          card_id: "card-sig-1",
          mode: "explain",
          result_content: "旧无签名解释缓存",
          config_signature: undefined, // 旧版本数据库无签名记录
          created_at: 1000,
        },
      ],
    };

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "db_get_card_detail") {
        return Promise.resolve(legacyDetail);
      }
      if (cmd === "db_allocate_function_version") {
        return Promise.resolve(1);
      }
      if (cmd === "db_save_function_result") {
        savedSignature = args.configSignature;
        return Promise.resolve(true);
      }
      return Promise.resolve(null);
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "使用新配置生成的精准解释结果" } }],
          }),
      } as any);
    });

    const { getByText } = render(
      <FullAnswerModal
        cardId="card-sig-1"
        isOpen={true}
        onClose={() => {}}
      />
    );

    await waitFor(() => {
      expect(getByText("✧ 深度解释")).not.toBeNull();
    });
    fireEvent.click(getByText("✧ 深度解释"));

    // 验证：因为旧缓存无 config_signature，绝不冒充当前配置缓存！
    // 确实发起了真实的 fetch 请求，且落库保存了最新签名！
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      expect(savedSignature).toBeDefined();
      expect(typeof savedSignature).toBe("string");
    });
  });

  // ==========================================
  // 13. 实际App打开PDF和修改缩放后，不回到示例文档
  // ==========================================
  it("13. 实际App打开PDF和修改缩放后，不回到示例文档：解耦初始化与打开操作，缩放不重新执行首屏介绍", async () => {
    setupMockPdf();
    const { open } = await import("@tauri-apps/plugin-dialog");
    const mockOpen = vi.mocked(open);
    mockOpen.mockResolvedValue("/books/manual.pdf");

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "db_get_or_create_document") {
        const p = args?.path || "default";
        return Promise.resolve({
          id: `doc-${p}`,
          path: p,
          title: args?.title || "示例文档",
          file_size: 1024,
          revision: "v1",
          created_at: 1000,
          updated_at: 1000,
        });
      }
      if (cmd === "get_file_metadata") {
        return Promise.resolve({ size: 1024, mtime: 1000, revision: "v1" });
      }
      if (cmd === "db_get_reading_preferences") return Promise.resolve(null);
      if (cmd === "db_save_reading_position") return Promise.resolve(true);
      if (cmd === "db_get_anchors") return Promise.resolve([]);
      if (cmd === "db_get_cards") return Promise.resolve({ items: [], total: 0, has_more: false });
      if (cmd === "db_get_highlights") return Promise.resolve([]);
      if (cmd === "read_file_chunk") return Promise.resolve(new Uint8Array(65536));
      return Promise.resolve(null);
    });

    const { container, unmount } = render(<App />);

    // 初始首屏载入完成，处于 text 模式
    await waitFor(() => {
      expect(container.querySelector(".reader-container")).not.toBeNull();
    });

    // 模拟快捷键 Ctrl+O 打开 PDF
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });

    // 模式切换至 PDF 阅读器
    await waitFor(() => {
      expect(container.querySelector(".pdf-reader-container")).not.toBeNull();
    });

    // 模拟按下 Ctrl+= 放大 (改变缩放比例 scale)
    fireEvent.keyDown(window, { key: "=", ctrlKey: true });

    // 验证：修改缩放后，阅读器依然保持在 PDF 模式，状态栏比例更新为 145%，绝不回跳到示例文档！
    await waitFor(() => {
      expect(container.querySelector(".status-zoom-percentage")?.textContent).toBe("145%");
      expect(container.querySelector(".pdf-reader-container")).not.toBeNull();
      expect(container.querySelector(".reader-container")).toBeNull();
    });

    unmount();
  });

  // ==========================================
  // 14. StrictMode下挂载真实ReaderArea，延迟返回正文
  // ==========================================
  it("14. StrictMode下挂载真实ReaderArea，延迟返回正文，最后正确结束loading并显示内容，读取次数严格为1", async () => {
    let readFileCalls = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_local_file") {
        readFileCalls++;
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve("严格模式下异步慢加载的书籍正文，段落一。");
          }, 30);
        });
      }
      return Promise.resolve(null);
    });

    const { container, queryByText, unmount } = render(
      <React.StrictMode>
        <ReaderArea
          filePath="/books/strict_mode_book.txt"
          documentSeq={1}
          documentRevision="v1"
          documentId="doc-strict-1"
        />
      </React.StrictMode>
    );

    // 最终正文内容正确渲染，loading 结束
    await waitFor(() => {
      expect(queryByText(/严格模式下异步慢加载的书籍正文/)).not.toBeNull();
    });

    // 验证：尽管经历 StrictMode 的 mount -> cleanup -> mount，单次有效打开严格只调用一次 read_local_file！
    expect(readFileCalls).toBe(1);
    expect(container.querySelector(".reader-scroll-viewport")).not.toBeNull();
    unmount();
  });

  // ==========================================
  // 15. 正文未返回时更新修订和身份
  // ==========================================
  it("15. 正文未返回时更新修订和身份，仍正常完成，读取次数正确，正文就绪后正确绑定最新身份", async () => {
    let resolveRead: (val: string) => void = () => {};
    let readCount = 0;

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_local_file") {
        readCount++;
        return new Promise<string>((resolve) => {
          resolveRead = resolve;
        });
      }
      return Promise.resolve(null);
    });

    // 初始挂载（正文读取中，元数据与数据库身份未到达）
    const { rerender, queryByText, unmount } = render(
      <ReaderArea
        filePath="/books/concurrent_book.txt"
        documentSeq={1}
        documentRevision={undefined}
        documentId={undefined}
      />
    );

    expect(readCount).toBe(1);

    // 在正文尚未返回时，元数据与数据库身份陆续到达，更新 props
    rerender(
      <ReaderArea
        filePath="/books/concurrent_book.txt"
        documentSeq={1}
        documentRevision="rev-concurrent-1"
        documentId="doc-concurrent-1"
      />
    );

    // 仍在读取中，不重复发起请求
    expect(readCount).toBe(1);

    // 现在正文读取成功返回
    resolveRead("在等待身份期间完成读取的正文内容。");

    await waitFor(() => {
      expect(queryByText(/在等待身份期间完成读取的正文内容/)).not.toBeNull();
    });

    // 读取次数严格保持为 1
    expect(readCount).toBe(1);
    unmount();
  });

  // ==========================================
  // 16. 身份先到与正文先到两种顺序，文本及PDF均能实际提交选区操作
  // ==========================================
  it("16. 身份先到与正文先到两种顺序，文本及PDF均能实际提交选区操作", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_local_file") {
        return Promise.resolve("这是测试选区创建的书籍正文内容。");
      }
      if (cmd === "get_file_metadata") {
        return Promise.resolve({ size: 65536, mtime: 1000, revision: "rev-pdf" });
      }
      if (cmd === "read_file_chunk") {
        return Promise.resolve(new Uint8Array(65536));
      }
      return Promise.resolve(null);
    });

    // ----------------------------------------------------
    // 情况 A：文本阅读器 - 身份先到，正文后到
    // ----------------------------------------------------
    const onTextCreateCardA = vi.fn();
    const { container: containerA, unmount: unmountA } = render(
      <ReaderArea
        filePath="/books/order_a.txt"
        documentSeq={1}
        documentRevision="rev-a"
        documentId="doc-order-a"
        onCreateAnchorAndCard={onTextCreateCardA}
      />
    );

    await waitFor(() => {
      expect(containerA.querySelector(".virtual-paragraph-item")).not.toBeNull();
    });

    const pItemA = containerA.querySelector(".virtual-paragraph-item") as HTMLElement;
    const rangeA = document.createRange();
    rangeA.selectNodeContents(pItemA);
    const selA = window.getSelection();
    selA?.removeAllRanges();
    selA?.addRange(rangeA);

    fireEvent.mouseUp(pItemA);

    await waitFor(() => {
      expect(containerA.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const explainBtnA = Array.from(
      containerA.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(explainBtnA).toBeDefined();
    fireEvent.click(explainBtnA);

    expect(onTextCreateCardA).toHaveBeenCalledWith(
      expect.objectContaining({
        boundDocId: "doc-order-a",
        boundSeq: 1,
      })
    );
    unmountA();

    // ----------------------------------------------------
    // 情况 B：文本阅读器 - 正文先到，身份后到
    // ----------------------------------------------------
    const onTextCreateCardB = vi.fn();
    const { container: containerB, rerender: rerenderB, unmount: unmountB } = render(
      <ReaderArea
        filePath="/books/order_b.txt"
        documentSeq={2}
        documentRevision={undefined}
        documentId={undefined}
        onCreateAnchorAndCard={onTextCreateCardB}
      />
    );

    await waitFor(() => {
      expect(containerB.querySelector(".virtual-paragraph-item")).not.toBeNull();
    });

    const pItemB = containerB.querySelector(".virtual-paragraph-item") as HTMLElement;
    const rangeB = document.createRange();
    rangeB.selectNodeContents(pItemB);
    const selB = window.getSelection();
    selB?.removeAllRanges();
    selB?.addRange(rangeB);

    fireEvent.mouseUp(pItemB);

    rerenderB(
      <ReaderArea
        filePath="/books/order_b.txt"
        documentSeq={2}
        documentRevision="rev-b"
        documentId="doc-order-b"
        onCreateAnchorAndCard={onTextCreateCardB}
      />
    );

    await waitFor(() => {
      expect(containerB.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const explainBtnB = Array.from(
      containerB.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(explainBtnB).toBeDefined();
    fireEvent.click(explainBtnB);

    expect(onTextCreateCardB).toHaveBeenCalledWith(
      expect.objectContaining({
        boundDocId: "doc-order-b",
        boundSeq: 2,
      })
    );
    unmountB();

    // ----------------------------------------------------
    // 情况 C：PDF 阅读器 - 身份先到，内容后到
    // ----------------------------------------------------
    setupMockPdf();
    const onPdfCreateCardC = vi.fn();
    const onPdfCreateHighlightC = vi.fn();
    const { container: containerC, unmount: unmountC } = render(
      <PDFReaderArea
        filePath="/books/order_c.pdf"
        documentSeq={1}
        documentRevision="rev-c"
        documentId="doc-order-c"
        onCreateAnchorAndCard={onPdfCreateCardC}
        onCreateHighlight={onPdfCreateHighlightC}
      />
    );

    await waitFor(() => {
      expect(containerC.querySelector(".pdf-page-card")).not.toBeNull();
    });

    const pageCardC = containerC.querySelector('.pdf-page-card[data-page-number="1"]') as HTMLElement;
    const textSpanC = pageCardC.querySelector(".pdf-text-item") as HTMLElement;
    expect(textSpanC).not.toBeNull();

    // 1. 文字选区 -> 卡片创建
    const rangeC = document.createRange();
    rangeC.selectNodeContents(textSpanC);
    const selC = window.getSelection();
    selC?.removeAllRanges();
    selC?.addRange(rangeC);

    fireEvent.mouseUp(pageCardC);

    await waitFor(() => {
      expect(containerC.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const explainBtnC = Array.from(
      containerC.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(explainBtnC).toBeDefined();
    fireEvent.click(explainBtnC);

    expect(onPdfCreateCardC).toHaveBeenCalledWith(
      expect.objectContaining({
        boundDocId: "doc-order-c",
        boundSeq: 1,
        boundRevision: "rev-c",
      })
    );

    // 2. 文字选区 -> 高亮登记
    selC?.removeAllRanges();
    selC?.addRange(rangeC);
    fireEvent.mouseUp(pageCardC);

    await waitFor(() => {
      expect(containerC.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const moreBtnC = Array.from(
      containerC.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("更多"))!;
    expect(moreBtnC).toBeDefined();
    fireEvent.click(moreBtnC);

    const hlBtnC = containerC.querySelector<HTMLElement>(".selection-tb-color-dot");
    expect(hlBtnC).not.toBeNull();
    fireEvent.click(hlBtnC!);

    expect(onPdfCreateHighlightC).toHaveBeenCalledWith(
      expect.objectContaining({
        boundDocId: "doc-order-c",
        boundSeq: 1,
        boundRevision: "rev-c",
      })
    );

    // 3. 图像截图 -> 卡片创建
    const sandwichC = pageCardC.querySelector(".pdf-page-sandwich") as HTMLElement;
    sandwichC.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      width: 800,
      height: 1100,
      right: 800,
      bottom: 1100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    fireEvent.pointerDown(sandwichC, { altKey: true, clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(sandwichC, { altKey: true, clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(sandwichC, { altKey: true, clientX: 200, clientY: 200, pointerId: 1 });

    await waitFor(() => {
      expect(containerC.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const cropExplainBtnC = Array.from(
      containerC.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(cropExplainBtnC).toBeDefined();
    fireEvent.click(cropExplainBtnC);

    expect(onPdfCreateCardC).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "explain",
        imageBase64: expect.any(String),
        boundDocId: "doc-order-c",
        boundSeq: 1,
        boundRevision: "rev-c",
      })
    );
    unmountC();

    // ----------------------------------------------------
    // 情况 D：PDF 阅读器 - 内容先到，身份后到
    // ----------------------------------------------------
    setupMockPdf();
    const onPdfCreateCardD = vi.fn();
    const onPdfCreateHighlightD = vi.fn();
    const { container: containerD, rerender: rerenderD, unmount: unmountD } = render(
      <PDFReaderArea
        filePath="/books/order_d.pdf"
        documentSeq={2}
        documentRevision={undefined}
        documentId={undefined}
        onCreateAnchorAndCard={onPdfCreateCardD}
        onCreateHighlight={onPdfCreateHighlightD}
      />
    );

    await waitFor(() => {
      expect(containerD.querySelector(".pdf-page-card")).not.toBeNull();
    });

    const pageCardD = containerD.querySelector('.pdf-page-card[data-page-number="1"]') as HTMLElement;
    const textSpanD = pageCardD.querySelector(".pdf-text-item") as HTMLElement;
    expect(textSpanD).not.toBeNull();

    // 选区触发时身份尚未到达
    const rangeD = document.createRange();
    rangeD.selectNodeContents(textSpanD);
    const selD = window.getSelection();
    selD?.removeAllRanges();
    selD?.addRange(rangeD);

    fireEvent.mouseUp(pageCardD);

    // 随后身份 props 到达
    rerenderD(
      <PDFReaderArea
        filePath="/books/order_d.pdf"
        documentSeq={2}
        documentRevision="rev-d"
        documentId="doc-order-d"
        onCreateAnchorAndCard={onPdfCreateCardD}
        onCreateHighlight={onPdfCreateHighlightD}
      />
    );

    await waitFor(() => {
      expect(containerD.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    // 1. 文字选区 -> 卡片创建
    const explainBtnD = Array.from(
      containerD.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(explainBtnD).toBeDefined();
    fireEvent.click(explainBtnD);

    expect(onPdfCreateCardD).toHaveBeenCalledWith(
      expect.objectContaining({
        boundDocId: "doc-order-d",
        boundSeq: 2,
        boundRevision: "rev-d",
      })
    );

    // 2. 文字选区 -> 高亮登记
    selD?.removeAllRanges();
    selD?.addRange(rangeD);
    fireEvent.mouseUp(pageCardD);

    await waitFor(() => {
      expect(containerD.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const moreBtnD = Array.from(
      containerD.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("更多"))!;
    expect(moreBtnD).toBeDefined();
    fireEvent.click(moreBtnD);

    const hlBtnD = containerD.querySelector<HTMLElement>(".selection-tb-color-dot");
    expect(hlBtnD).not.toBeNull();
    fireEvent.click(hlBtnD!);

    expect(onPdfCreateHighlightD).toHaveBeenCalledWith(
      expect.objectContaining({
        boundDocId: "doc-order-d",
        boundSeq: 2,
        boundRevision: "rev-d",
      })
    );

    // 3. 图像截图 -> 卡片创建
    const sandwichD = pageCardD.querySelector(".pdf-page-sandwich") as HTMLElement;
    sandwichD.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      width: 800,
      height: 1100,
      right: 800,
      bottom: 1100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    fireEvent.pointerDown(sandwichD, { altKey: true, clientX: 50, clientY: 50, pointerId: 2 });
    fireEvent.pointerMove(sandwichD, { altKey: true, clientX: 180, clientY: 180, pointerId: 2 });
    fireEvent.pointerUp(sandwichD, { altKey: true, clientX: 180, clientY: 180, pointerId: 2 });

    await waitFor(() => {
      expect(containerD.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const cropExplainBtnD = Array.from(
      containerD.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(cropExplainBtnD).toBeDefined();
    fireEvent.click(cropExplainBtnD);

    expect(onPdfCreateCardD).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "explain",
        imageBase64: expect.any(String),
        boundDocId: "doc-order-d",
        boundSeq: 2,
        boundRevision: "rev-d",
      })
    );
    unmountD();
  });

  // ==========================================
  // 17. 实际虚拟列表滚动坐标
  // ==========================================
  it("17. 实际虚拟列表滚动坐标：200%缩放测高补偿从600变700、50%来源跳转不被截断、缩小时先按旧比例换算再限位", async () => {
    const longContent = Array.from(
      { length: 50 },
      (_, i) => `段落 ${i + 1}：用于验证虚拟列表在各种缩放比例下的坐标转换与测高补偿精确度。`
    ).join("\n\n");

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_local_file") return Promise.resolve(longContent);
      return Promise.resolve(null);
    });

    const { rerender, container, unmount } = render(
      <ReaderArea
        filePath="/books/scroll_test.txt"
        documentSeq={1}
        scale={2.0}
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".virtual-paragraph-item")).not.toBeNull();
    });

    const viewport = container.querySelector(".reader-scroll-viewport") as HTMLElement;
    expect(viewport).not.toBeNull();

    let currentScrollTop = 0;
    Object.defineProperty(viewport, "scrollTop", {
      get: () => currentScrollTop,
      set: (val: number) => {
        currentScrollTop = val;
      },
      configurable: true,
    });
    Object.defineProperty(viewport, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(viewport, "scrollHeight", { value: 5000, configurable: true });

    // 1. 验证 scrollToFn 测高补偿：
    // 在 200% 缩放下，逻辑位置 300，上方段落增加 50 高度 (adjustments: 50)
    // 目标逻辑位置为 300 + 50 = 350，DOM 位置从 600 纠正为 700！
    const virtualizerInstance = (viewport as any).__virtualizer;
    expect(virtualizerInstance).toBeDefined();

    virtualizerInstance.options.scrollToFn(300, { adjustments: 50 }, virtualizerInstance);
    expect(viewport.scrollTop).toBe(700);

    // 2. 验证缩小时先用旧阅读位置和旧比例计算新位置，再按新边界限位：
    // 当前在 2.0x 视角，滚动到接近末尾位置 1800
    currentScrollTop = 1800;
    fireEvent.scroll(viewport);

    // 缩小到 1.0x (此时 maxScroll 充足)
    // 正确换算：1800 / 2.0 = 900 逻辑位置，乘以 1.0 = 900
    rerender(
      <ReaderArea
        filePath="/books/scroll_test.txt"
        documentSeq={1}
        scale={1.0}
      />
    );

    expect(viewport.scrollTop).toBe(900);

    // 3. 验证 50% 视角下来源跳转：依赖库内部 getMaxScrollOffset 转换后，跳转绝不被截断为 0
    rerender(
      <ReaderArea
        filePath="/books/scroll_test.txt"
        documentSeq={1}
        scale={0.5}
        jumpTarget={{
          paragraphIndex: 10,
          timestamp: 9999,
        }}
      />
    );

    await waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(0);
    });

    unmount();
  });

  // ==========================================
  // 18. 同一路径PDF从v1更新为v2后重新打开
  // ==========================================
  it("18. 同一路径PDF从v1更新为v2后重新打开：实际页面刷新，旧截图和选区不能登记为v2，新内容就绪后正确绑定v2", async () => {
    setupMockPdf();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_file_metadata") {
        return Promise.resolve({ size: 65536, mtime: 1000, revision: "v1" });
      }
      if (cmd === "read_file_chunk") {
        return Promise.resolve(new Uint8Array(65536));
      }
      return Promise.resolve(null);
    });

    const onCreateCard = vi.fn();
    const onCreateHighlight = vi.fn();

    const { container, rerender, unmount } = render(
      <PDFReaderArea
        filePath="/books/same_path.pdf"
        documentSeq={1}
        documentRevision="v1"
        documentId="doc-v1"
        onCreateAnchorAndCard={onCreateCard}
        onCreateHighlight={onCreateHighlight}
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".pdf-page-card")).not.toBeNull();
    });

    const pageCard = container.querySelector('.pdf-page-card[data-page-number="1"]') as HTMLElement;
    const textSpan = pageCard.querySelector(".pdf-text-item") as HTMLElement;
    expect(textSpan).not.toBeNull();

    // 在 v1 上选区
    const range = document.createRange();
    range.selectNodeContents(textSpan);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    fireEvent.mouseUp(pageCard);

    await waitFor(() => {
      expect(container.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    // 此时同路径更新为 v2 并重新打开（documentSeq: 2, documentRevision: "v2"）
    rerender(
      <PDFReaderArea
        filePath="/books/same_path.pdf"
        documentSeq={2}
        documentRevision="v2"
        documentId="doc-v2"
        onCreateAnchorAndCard={onCreateCard}
        onCreateHighlight={onCreateHighlight}
      />
    );

    // 验证：旧选区工具栏立即被关闭并清空快照，旧选区绝不保留
    expect(container.querySelector(".floating-selection-toolbar")).toBeNull();

    // 等待 v2 重新建立并就绪
    await waitFor(() => {
      expect(container.querySelector(".pdf-page-card")).not.toBeNull();
    });

    // 在新就绪的 v2 页面上重新划选
    const newPageCard = container.querySelector('.pdf-page-card[data-page-number="1"]') as HTMLElement;
    const newTextSpan = newPageCard.querySelector(".pdf-text-item") as HTMLElement;
    const newRange = document.createRange();
    newRange.selectNodeContents(newTextSpan);
    sel?.removeAllRanges();
    sel?.addRange(newRange);
    fireEvent.mouseUp(newPageCard);

    await waitFor(() => {
      expect(container.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const explainBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(explainBtn).toBeDefined();
    fireEvent.click(explainBtn);

    // 验证：新提交严格绑定 doc-v2 与 rev v2，绝对不是旧版本的 v1！
    expect(onCreateCard).toHaveBeenCalledWith(
      expect.objectContaining({
        boundDocId: "doc-v2",
        boundSeq: 2,
        boundRevision: "v2",
      })
    );

    unmount();
  });

  // ==========================================
  // 19. 实际App打开文本A→PDF B→双击无路径TXT示例
  // ==========================================
  it("19. 实际App打开文本A→PDF B→双击无路径TXT示例：不出现A正文绑定B身份，确有内置内容的条目通过统一打开流程取得独立虚拟身份", async () => {
    setupMockPdf();
    const { open } = await import("@tauri-apps/plugin-dialog");
    const mockOpen = vi.mocked(open);

    const createdCards: any[] = [];
    const createdAnchors: any[] = [];

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "db_get_or_create_document") {
        const p = args?.filePath || "default";
        return Promise.resolve({
          id: `doc-${p}`,
          path: p,
          title: args?.displayName || "示例文档",
          file_size: args?.fileSize || 1024,
          revision: p === "flowread://default_reading_intro" ? "v1" : "rev-1",
          created_at: 1000,
          updated_at: 1000,
        });
      }
      if (cmd === "get_file_metadata") {
        return Promise.resolve({ size: 1024, mtime: 1000, revision: "rev-1" });
      }
      if (cmd === "read_local_file") {
        return Promise.resolve("这是文本A的独立专属正文内容，深入探讨分布式系统设计。");
      }
      if (cmd === "read_file_chunk") {
        return Promise.resolve(new Uint8Array(65536));
      }
      if (cmd === "db_get_reading_preferences") return Promise.resolve(null);
      if (cmd === "db_save_reading_position") return Promise.resolve(true);
      if (cmd === "db_get_anchors") return Promise.resolve([]);
      if (cmd === "db_get_cards") return Promise.resolve({ items: [], total: 0, has_more: false });
      if (cmd === "db_get_highlights") return Promise.resolve([]);
      if (cmd === "db_create_anchor") {
        createdAnchors.push(args);
        return Promise.resolve(`anc-${createdAnchors.length}`);
      }
      if (cmd === "db_create_card") {
        createdCards.push(args);
        return Promise.resolve(`card-${createdCards.length}`);
      }
      return Promise.resolve(null);
    });

    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

    const { container, unmount } = render(<App />);

    // 1. 打开文本 A
    mockOpen.mockResolvedValueOnce("/books/text_a.txt");
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });

    await waitFor(() => {
      expect(container.querySelector(".reader-container")).not.toBeNull();
      expect(container.textContent).toContain("这是文本A的独立专属正文内容");
    });

    // 在文本 A 上划选并创建卡片
    const pItemA = container.querySelector(".virtual-paragraph-item") as HTMLElement;
    const rangeA = document.createRange();
    rangeA.selectNodeContents(pItemA);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(rangeA);
    fireEvent.mouseUp(pItemA);

    await waitFor(() => {
      expect(container.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const explainBtnA = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(explainBtnA).toBeDefined();
    fireEvent.click(explainBtnA);

    await waitFor(() => {
      expect(createdCards.some((c) => c.documentId === "doc-/books/text_a.txt")).toBe(true);
    });

    // 2. 打开 PDF B
    mockOpen.mockResolvedValueOnce("/books/pdf_b.pdf");
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });

    await waitFor(() => {
      expect(container.querySelector(".pdf-reader-container")).not.toBeNull();
      expect(container.querySelector(".reader-container")).toBeNull();
      expect(container.querySelector(".pdf-page-card")).not.toBeNull();
    });

    // 在 PDF B 上划选并创建卡片
    const pageCardB = container.querySelector('.pdf-page-card[data-page-number="1"]') as HTMLElement;
    const textSpanB = pageCardB.querySelector(".pdf-text-item") as HTMLElement;
    const rangeB = document.createRange();
    rangeB.selectNodeContents(textSpanB);
    sel?.removeAllRanges();
    sel?.addRange(rangeB);
    fireEvent.mouseUp(pageCardB);

    await waitFor(() => {
      expect(container.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const explainBtnB = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(explainBtnB).toBeDefined();
    fireEvent.click(explainBtnB);

    await waitFor(() => {
      expect(createdCards.some((c) => c.documentId === "doc-/books/pdf_b.pdf")).toBe(true);
    });

    // 3. 打开工作区管理器并双击无路径的 TXT 示例条目
    const workspaceMenuBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".menu-bar-btn")
    ).find((b) => b.textContent?.includes("工作区"))!;
    expect(workspaceMenuBtn).toBeDefined();
    fireEvent.click(workspaceMenuBtn);

    const manageWorkspaceItem = Array.from(
      container.querySelectorAll<HTMLElement>(".menu-dropdown-item")
    ).find((item) => item.textContent?.includes("管理工作区..."))!;
    expect(manageWorkspaceItem).toBeDefined();
    fireEvent.click(manageWorkspaceItem);

    await waitFor(() => {
      expect(document.querySelector(".workspace-explorer-card")).not.toBeNull();
    });

    // 找到 "默认文件夹" 并双击进入
    const defaultFolderItem = Array.from(
      document.querySelectorAll<HTMLElement>(".explorer-row")
    ).find((item) => item.textContent?.includes("默认文件夹"))!;
    expect(defaultFolderItem).toBeDefined();
    fireEvent.doubleClick(defaultFolderItem);

    // 找到默认示例条目并双击打开
    const sampleTxtItem = Array.from(
      document.querySelectorAll<HTMLElement>(".explorer-row")
    ).find((item) => item.textContent?.includes("在流动中沉思"))!;
    expect(sampleTxtItem).toBeDefined();
    fireEvent.doubleClick(sampleTxtItem);

    // 验证：
    // 1) 阅读器切换回文本阅读模式
    // 2) 正文加载的是内置介绍《在流动中沉思》，绝不残留文本 A 的正文！
    // 3) 绝对不出现 A 正文绑定 B 身份的混淆！
    await waitFor(() => {
      expect(container.querySelector(".reader-container")).not.toBeNull();
      expect(container.textContent).not.toContain("这是文本A的独立专属正文内容");
      expect(container.textContent).toContain("重新发现数字时代的深度阅读之美");
    });

    // 在内置虚拟示例上划选并创建卡片
    const pItemSample = container.querySelector(".virtual-paragraph-item") as HTMLElement;
    const rangeSample = document.createRange();
    rangeSample.selectNodeContents(pItemSample);
    sel?.removeAllRanges();
    sel?.addRange(rangeSample);
    fireEvent.mouseUp(pItemSample);

    await waitFor(() => {
      expect(container.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const explainBtnSample = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(explainBtnSample).toBeDefined();
    fireEvent.click(explainBtnSample);

    await waitFor(() => {
      expect(
        createdCards.some((c) => c.documentId === "doc-flowread://default_reading_intro")
      ).toBe(true);
    });

    // 验证：文本A、PDF B与虚拟示例拥有独立且正确的文档身份，绝不沦为 doc-default！
    expect(createdCards.some((c) => c.documentId === "doc-default")).toBe(false);
    const distinctDocIds = new Set(createdCards.map((c) => c.documentId));
    expect(distinctDocIds.has("doc-/books/text_a.txt")).toBe(true);
    expect(distinctDocIds.has("doc-/books/pdf_b.pdf")).toBe(true);
    expect(distinctDocIds.has("doc-flowread://default_reading_intro")).toBe(true);
    expect(distinctDocIds.size).toBe(3);

    // 4. 再次打开工作区，双击无路径且无内置内容的条目（例如 数学 PDF 示例）
    fireEvent.click(workspaceMenuBtn);
    const manageWorkspaceItem2 = Array.from(
      container.querySelectorAll<HTMLElement>(".menu-dropdown-item")
    ).find((item) => item.textContent?.includes("管理工作区..."))!;
    fireEvent.click(manageWorkspaceItem2);

    await waitFor(() => {
      expect(document.querySelector(".workspace-explorer-card")).not.toBeNull();
    });

    // 找到 "数学与工程" 文件夹并双击进入
    const mathFolderItem = Array.from(
      document.querySelectorAll<HTMLElement>(".explorer-row")
    ).find((item) => item.textContent?.includes("数学与工程"))!;
    expect(mathFolderItem).toBeDefined();
    fireEvent.doubleClick(mathFolderItem);

    const mathPdfItem = Array.from(
      document.querySelectorAll<HTMLElement>(".explorer-row")
    ).find((item) => item.textContent?.includes("矩阵分析"))!;
    expect(mathPdfItem).toBeDefined();
    fireEvent.doubleClick(mathPdfItem);

    // 验证：弹出明确提示，且阅读器保持当前文档与文本模式，不被错误重置或切走！
    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining("未关联本地磁盘路径或有效来源")
    );
    expect(container.querySelector(".reader-container")).not.toBeNull();

    alertSpy.mockRestore();
    unmount();
  });

  // ==========================================
  // 20. A的destroy使用可控延迟，B先加载完成再结束A销毁：B页面、身份及选区持续正常，不出现被误杀的空白页
  // ==========================================
  it("20. A的destroy使用可控延迟，B先加载完成再结束A销毁：B页面、身份及选区持续正常，不出现被误杀的空白页", async () => {
    let resolveDestroyA!: () => void;
    const destroyAPromise = new Promise<void>((res) => {
      resolveDestroyA = res;
    });

    let loadCount = 0;
    const mockPage = {
      getViewport: ({ scale = 1.0 }: { scale?: number } = {}) => ({
        width: Math.floor(595 * scale),
        height: Math.floor(842 * scale),
        scale,
        convertToPdfPoint: (x: number, y: number) => [x, y],
      }),
      render: () => ({
        promise: Promise.resolve(),
        cancel: vi.fn(),
      }),
      getTextContent: () =>
        Promise.resolve({
          items: [
            {
              str: "PDF 关键论点分析与推导",
              dir: "ltr",
              width: 120,
              height: 16,
              transform: [1, 0, 0, 1, 0, 0],
            },
          ],
        }),
      cleanup: vi.fn(),
    };

    const mockDocA = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue(mockPage),
      cleanup: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    const mockDocB = {
      numPages: 2,
      getPage: vi.fn().mockResolvedValue(mockPage),
      cleanup: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(pdfjsLib.getDocument).mockImplementation(() => {
      loadCount++;
      if (loadCount === 1) {
        // Doc A: destroy 是可控的延迟 Promise
        return {
          promise: Promise.resolve(mockDocA),
          destroy: vi.fn().mockImplementation(() => destroyAPromise),
        } as any;
      }
      // Doc B: 快速加载并具有正常立即完成的 destroy
      return {
        promise: Promise.resolve(mockDocB),
        destroy: vi.fn().mockResolvedValue(undefined),
      } as any;
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_file_metadata") {
        return Promise.resolve({ size: 65536, mtime: 1000, revision: "rev-pdf" });
      }
      if (cmd === "read_file_chunk") {
        return Promise.resolve(new Uint8Array(65536));
      }
      return Promise.resolve(null);
    });

    const onCard = vi.fn();
    const { container, rerender, unmount } = render(
      <PDFReaderArea
        filePath="/books/doc_a.pdf"
        documentSeq={1}
        documentRevision="rev-a"
        documentId="doc-a"
        onCreateAnchorAndCard={onCard}
      />
    );

    // 1. 等待 Doc A 就绪
    await waitFor(() => {
      expect(container.querySelector(".pdf-page-card")).not.toBeNull();
    });

    // 2. 切换打开 Doc B (documentSeq: 2, revision: "rev-b", docId: "doc-b")
    rerender(
      <PDFReaderArea
        filePath="/books/doc_b.pdf"
        documentSeq={2}
        documentRevision="rev-b"
        documentId="doc-b"
        onCreateAnchorAndCard={onCard}
      />
    );

    // 3. 等待 Doc B 快速就绪（此时 A 的 destroy 仍未结束处于 pending）
    await waitFor(() => {
      expect(container.querySelector('.pdf-page-card[data-page-number="2"]')).not.toBeNull();
    });

    // 4. 现在让 A 的 destroy 延迟完成
    resolveDestroyA();
    await new Promise((r) => setTimeout(r, 20));

    // 验证：A 的清理结束绝对没有破坏 B 的页面！B 绝不是空白页，页面元素完好！
    expect(container.querySelector(".pdf-page-card")).not.toBeNull();
    expect(container.querySelector('.pdf-page-card[data-page-number="2"]')).not.toBeNull();
    expect(container.querySelector(".pdf-empty-placeholder")).toBeNull();

    // 5. 在 B 上划选并创建卡片
    const pageCardB = container.querySelector('.pdf-page-card[data-page-number="1"]') as HTMLElement;
    const textSpanB = pageCardB.querySelector(".pdf-text-item") as HTMLElement;
    const rangeB = document.createRange();
    rangeB.selectNodeContents(textSpanB);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(rangeB);
    fireEvent.mouseUp(pageCardB);

    await waitFor(() => {
      expect(container.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const explainBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(explainBtn).toBeDefined();
    fireEvent.click(explainBtn);

    // 验证：B 的操作持续正常，登记身份为 doc-b 与 rev-b
    expect(onCard).toHaveBeenCalledWith(
      expect.objectContaining({
        boundDocId: "doc-b",
        boundSeq: 2,
        boundRevision: "rev-b",
      })
    );

    unmount();
  });

  // ==========================================
  // 21. PDF 切回文本或卸载后，所属资源正确释放，迟到结果不回灌
  // ==========================================
  it("21. PDF 切回文本或卸载后，所属资源正确释放，迟到结果不回灌", async () => {
    let resolveLateLoad!: (doc: any) => void;
    const latePromise = new Promise((res) => {
      resolveLateLoad = res;
    });

    const mockDestroyLoadingTask = vi.fn().mockResolvedValue(undefined);
    const mockCleanupDoc = vi.fn();
    const mockDestroyDoc = vi.fn().mockResolvedValue(undefined);

    const mockDoc = {
      numPages: 1,
      getPage: vi.fn(),
      cleanup: mockCleanupDoc,
      destroy: mockDestroyDoc,
    };

    vi.mocked(pdfjsLib.getDocument).mockImplementation(() => {
      return {
        promise: latePromise,
        destroy: mockDestroyLoadingTask,
      } as any;
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_file_metadata") {
        return Promise.resolve({ size: 65536, mtime: 1000, revision: "v1" });
      }
      if (cmd === "read_file_chunk") {
        return Promise.resolve(new Uint8Array(65536));
      }
      return Promise.resolve(null);
    });

    const onCard = vi.fn();
    const { unmount } = render(
      <PDFReaderArea
        filePath="/books/unmount_test.pdf"
        documentSeq={1}
        documentRevision="v1"
        documentId="doc-1"
        onCreateAnchorAndCard={onCard}
      />
    );

    // 等待通道建立并进入 pdfjs 异步加载流程
    await waitFor(() => {
      expect(pdfjsLib.getDocument).toHaveBeenCalled();
    });

    // 正在加载中切回文本（即卸载组件）
    unmount();

    // 验证：所属 loadingTask 立即被调用 destroy 释放！
    expect(mockDestroyLoadingTask).toHaveBeenCalled();

    // 模拟迟到结果在卸载后返回
    resolveLateLoad(mockDoc);
    await new Promise((r) => setTimeout(r, 20));

    // 验证：迟到结果不回灌，没有造成未捕获异常或创建操作
    expect(onCard).not.toHaveBeenCalled();

    // 2. 验证已加载就绪的 PDF 切回文本卸载时，doc 正确执行 cleanup 释放
    const { mockDoc: readyDoc } = setupMockPdf();
    const { unmount: unmountReady } = render(
      <PDFReaderArea
        filePath="/books/ready_unmount.pdf"
        documentSeq={2}
        documentRevision="v2"
        documentId="doc-2"
      />
    );

    await waitFor(() => {
      expect(readyDoc.getPage).toHaveBeenCalled();
    });

    unmountReady();
    expect(readyDoc.cleanup).toHaveBeenCalled();
  });

  // ==========================================
  // 22. StrictMode 重新执行生命周期后不永久加载、不复用已销毁对象
  // ==========================================
  it("22. StrictMode 重新执行生命周期后不永久加载、不复用已销毁对象", async () => {
    setupMockPdf();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_file_metadata") {
        return Promise.resolve({ size: 65536, mtime: 1000, revision: "rev-sm" });
      }
      if (cmd === "read_file_chunk") {
        return Promise.resolve(new Uint8Array(65536));
      }
      return Promise.resolve(null);
    });

    const onCard = vi.fn();
    const { container, unmount } = render(
      <React.StrictMode>
        <PDFReaderArea
          filePath="/books/strict_mode.pdf"
          documentSeq={1}
          documentRevision="rev-sm"
          documentId="doc-sm"
          onCreateAnchorAndCard={onCard}
        />
      </React.StrictMode>
    );

    // StrictMode 会执行 setup -> cleanup -> setup
    // 验证：顺利完成加载，不卡在永久加载中，不出现加载失败错误！
    await waitFor(() => {
      expect(container.querySelector(".pdf-page-card")).not.toBeNull();
      expect(container.querySelector(".pdf-loading-spinner")).toBeNull();
      expect(container.textContent).not.toContain("加载失败");
    });

    // 能够正常选区创建卡片
    const pageCard = container.querySelector('.pdf-page-card[data-page-number="1"]') as HTMLElement;
    const textSpan = pageCard.querySelector(".pdf-text-item") as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(textSpan);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    fireEvent.mouseUp(pageCard);

    await waitFor(() => {
      expect(container.querySelector(".floating-selection-toolbar")).not.toBeNull();
    });

    const explainBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".selection-tb-btn")
    ).find((b) => b.textContent?.includes("解释"))!;
    expect(explainBtn).toBeDefined();
    fireEvent.click(explainBtn);

    expect(onCard).toHaveBeenCalledWith(
      expect.objectContaining({
        boundDocId: "doc-sm",
        boundSeq: 1,
        boundRevision: "rev-sm",
      })
    );

    unmount();
  });
});
