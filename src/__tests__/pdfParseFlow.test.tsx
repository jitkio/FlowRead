import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import App from "../App";
import ParserSettingsModal from "../components/ParserSettingsModal";
import ParseJobsPanel from "../components/ParseJobsPanel";
import {
  ParseJobDto,
  ParseJobListResponse,
  ParseJobStatus,
  ParseSettings,
} from "../types/parserService";
import { ParseJobTracker } from "../utils/parserService";
import { PARSED_READING_STORAGE_KEY } from "../utils/parsedReadingPreferences";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);
const mockOpen = vi.mocked(open);

const PDF_A_PATH = "C:\\docs\\a.pdf";
const TXT_B_PATH = "C:\\docs\\b.txt";

function makeSettings(mineruConfigured: boolean, datalabConfigured = false): ParseSettings {
  return {
    default_provider: "mineru",
    providers: [
      { provider: "mineru", display_name: "MinerU", credential_configured: mineruConfigured },
      {
        provider: "datalab",
        display_name: "Datalab Convert",
        credential_configured: datalabConfigured,
      },
    ],
  };
}

function makeJob(overrides: Partial<ParseJobDto> = {}): ParseJobDto {
  return {
    job_id: "job_1",
    document_id: "doc_a",
    source_path: PDF_A_PATH,
    document_name: "a.pdf",
    source_revision: "rev_a",
    provider: "mineru",
    status: "processing",
    progress_percent: 42,
    completed_pages: 4,
    total_pages: 10,
    version_id: null,
    activated: null,
    can_cancel: true,
    can_resume: false,
    error_code: null,
    error_message: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_100_000,
    update_seq: 1,
    ...overrides,
  };
}

function makeActiveWorkspace(versionId: string, body: string) {
  return {
    version_id: versionId,
    document_id: "doc_a",
    source_revision: "rev_a",
    provider: "mineru",
    block_count: 1,
    asset_count: 0,
    created_at: Date.now(),
    session_id: `sess_${versionId}`,
    blocks_path: "C:\\docs\\blocks.json",
    doc_dir: "C:\\docs",
    raw_json: JSON.stringify([{ id: "b1", type: "paragraph", content: body }]),
    has_assets: false,
  };
}

interface MockState {
  settings: ParseSettings;
  jobList: ParseJobDto[];
  activeWorkspace: any;
  startCalls: any[];
  setTokenCalls: any[];
  clearTokenCalls: any[];
  saveSettingsCalls: any[];
  listCalls: number;
  resumeCalls?: any[];
  cancelCalls?: any[];
  retryCalls?: any[];
  closePreviewCalls?: any[];
  jobStartResult?: any;
  importDirResult?: any;
  getOrCreateDocument?: (args: any) => any;
}

function installAppMock(overrides: Partial<MockState> = {}): MockState {
  const state: MockState = {
    settings: makeSettings(true),
    jobList: [],
    activeWorkspace: null,
    startCalls: [],
    setTokenCalls: [],
    clearTokenCalls: [],
    saveSettingsCalls: [],
    listCalls: 0,
    resumeCalls: [],
    cancelCalls: [],
    retryCalls: [],
    closePreviewCalls: [],
    ...overrides,
  };

  mockInvoke.mockImplementation(async (cmd: string, args: any) => {
    switch (cmd) {
      case "parse_settings_get":
        return state.settings;
      case "parse_settings_save": {
        state.saveSettingsCalls.push(args);
        state.settings = { ...state.settings, default_provider: args.request.default_provider };
        return state.settings;
      }
      case "parse_provider_set_token": {
        state.setTokenCalls.push(args);
        state.settings = {
          ...state.settings,
          providers: state.settings.providers.map((p) =>
            p.provider === args.request.provider ? { ...p, credential_configured: true } : p
          ),
        };
        return { provider: args.request.provider, credential_configured: true };
      }
      case "parse_provider_clear_token": {
        state.clearTokenCalls.push(args);
        state.settings = {
          ...state.settings,
          providers: state.settings.providers.map((p) =>
            p.provider === args.request.provider ? { ...p, credential_configured: false } : p
          ),
        };
        return { provider: args.request.provider, credential_configured: false };
      }
      case "parse_job_start": {
        state.startCalls.push(args);
        if (state.jobStartResult) {
          return typeof state.jobStartResult === "function" ? state.jobStartResult(args) : state.jobStartResult;
        }
        return makeJob({ job_id: `job_${state.startCalls.length}`, status: "processing", update_seq: 1 });
      }
      case "parse_job_resume": {
        state.resumeCalls?.push(args);
        const existing = state.jobList.find((j) => j.job_id === args.jobId);
        const seq = (existing?.update_seq ?? 1) + 1;
        const updated: ParseJobDto = existing
          ? { ...existing, status: "queued", can_resume: false, can_cancel: true, update_seq: seq }
          : makeJob({ job_id: args.jobId, status: "queued", update_seq: seq });
        state.jobList = state.jobList.map((j) => (j.job_id === args.jobId ? updated : j));
        return updated;
      }
      case "parse_job_cancel": {
        state.cancelCalls?.push(args);
        const existing = state.jobList.find((j) => j.job_id === args.jobId);
        const seq = (existing?.update_seq ?? 1) + 1;
        const updated: ParseJobDto = existing
          ? { ...existing, status: "cancelled", can_resume: false, can_cancel: false, update_seq: seq }
          : makeJob({ job_id: args.jobId, status: "cancelled", update_seq: seq });
        state.jobList = state.jobList.map((j) => (j.job_id === args.jobId ? updated : j));
        return updated;
      }
      case "parse_job_list": {
        state.listCalls += 1;
        return { items: state.jobList, next_cursor: null };
      }
      case "parse_job_get":
        return state.jobList.find((j) => j.job_id === args.jobId) ?? null;
      case "parse_job_result":
        return {
          document_id: "doc_a",
          source_revision: "rev_a",
          version_id: "ver_result",
          blocks_path: "C:\\docs\\result\\blocks.json",
          activated: false,
        };
      case "parsed_workspace_get_active":
        if (args?.documentId === "doc_intro") return null;
        return typeof state.activeWorkspace === "function"
          ? state.activeWorkspace(args)
          : state.activeWorkspace;
      case "parsed_preview_open":
        return {
          session_id: "sess_preview_result",
          blocks_path: args.path,
          doc_dir: "C:\\docs\\result",
          raw_json: JSON.stringify([{ id: "b1", type: "paragraph", content: "历史任务结果正文" }]),
          has_assets: false,
        };
      case "parsed_preview_read_asset":
        return [0xff, 0xd8];
      case "parsed_preview_close":
        state.closePreviewCalls?.push(args);
        return {};
      case "parsed_workspace_import_dir":
        return typeof state.importDirResult === "function"
          ? state.importDirResult(args)
          : state.importDirResult ?? makeActiveWorkspace("ver_imported", "新导入版本正文");
      case "get_file_metadata":
        return { size: 100, mtime: 1000, revision: "rev_a" };
      case "db_get_reading_preferences":
        return null;
      case "db_get_anchors":
      case "db_get_highlights":
        return [];
      case "db_get_cards":
        return { items: [], total: 0 };
      case "read_local_file":
        return "# 书籍B正文";
      case "db_get_or_create_document": {
        if (typeof state.getOrCreateDocument === "function") {
          return state.getOrCreateDocument(args);
        }
        const filePath = String(args.filePath);
        const id = filePath.endsWith("a.pdf") ? "doc_a" : filePath.endsWith("b.txt") ? "doc_b" : "doc_intro";
        return {
          id,
          file_path: filePath,
          display_name: args.displayName || filePath,
          file_size: 100,
          revision: args.revision || (id === "doc_intro" ? "v1" : "rev_a"),
          last_read_position: null,
          created_at: 0,
          updated_at: 0,
        };
      }
      default:
        return {};
    }
  });

  return state;
}

async function flush(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(PARSED_READING_STORAGE_KEY);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("PDF 云端解析：设置、导入与任务界面", () => {
  it("1. 解析服务设置：两家凭据相互独立，空输入不清除已保存凭据", async () => {
    let settings = makeSettings(true, false);
    const setTokenCalls: any[] = [];
    const clearTokenCalls: any[] = [];

    mockInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "parse_settings_get") return settings;
      if (cmd === "parse_settings_save") {
        settings = { ...settings, default_provider: args.request.default_provider };
        return settings;
      }
      if (cmd === "parse_provider_set_token") {
        setTokenCalls.push(args);
        settings = makeSettings(true, true);
        return { provider: args.request.provider, credential_configured: true };
      }
      if (cmd === "parse_provider_clear_token") {
        clearTokenCalls.push(args);
        return { provider: args.request.provider, credential_configured: false };
      }
      return {};
    });

    render(<ParserSettingsModal isOpen onClose={() => {}} />);
    await flush(40);

    expect(screen.getByTestId("credential-status-mineru").textContent).toContain("已配置");
    expect(screen.getByTestId("credential-status-datalab").textContent).toContain("未配置");

    // 空输入点击保存：不发起任何请求，也不清除已有凭据
    const datalabSection = screen.getByRole("region", { name: "Datalab Convert 凭据" });
    fireEvent.click(within(datalabSection).getByRole("button", { name: "保存凭据" }));
    await flush(30);
    expect(setTokenCalls).toHaveLength(0);
    expect(clearTokenCalls).toHaveLength(0);
    expect(within(datalabSection).getByText(/请输入 Token/)).not.toBeNull();

    // 只给 MinerU 保存凭据：Datalab 状态不受影响
    const mineruSection = screen.getByRole("region", { name: "MinerU 凭据" });
    fireEvent.change(within(mineruSection).getByLabelText("API Token"), {
      target: { value: "  tok_mineru  " },
    });
    fireEvent.click(within(mineruSection).getByRole("button", { name: "替换凭据" }));
    await flush(40);

    expect(setTokenCalls).toHaveLength(1);
    expect(setTokenCalls[0].request).toEqual({ provider: "mineru", token: "tok_mineru" });
    expect(screen.getByTestId("credential-status-datalab").textContent).toContain("未配置");

    // 已保存的 Token 不回填到输入框
    expect(
      (within(mineruSection).getByLabelText("API Token") as HTMLInputElement).value
    ).toBe("");
  });

  it("2. 导入 PDF：取消文件选择零任务零上传", async () => {
    const state = installAppMock();
    mockOpen.mockResolvedValueOnce(null);

    const { unmount } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(state.startCalls).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: "导入 PDF 并解析" })).toBeNull();
    unmount();
  });

  it("3. 缺少凭据时可前往设置，保存后返回原面板且不自动提交", async () => {
    const state = installAppMock({ settings: makeSettings(false, false) });
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });

    const importDialog = screen.getByRole("dialog", { name: "导入 PDF 并解析" });
    expect(within(importDialog).getByTestId("import-credential-status").textContent).toContain(
      "尚未配置凭据"
    );
    // 缺少凭据时主按钮不可用
    expect(
      (within(importDialog).getByRole("button", { name: "上传并解析" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

    // 前往配置 → 打开解析服务设置
    await act(async () => {
      fireEvent.click(within(importDialog).getByRole("button", { name: /前往配置 MinerU/ }));
      await new Promise((r) => setTimeout(r, 60));
    });
    const settingsDialog = screen.getByRole("dialog", { name: "PDF 解析服务设置" });
    const mineruSection = within(settingsDialog).getByRole("region", { name: "MinerU 凭据" });
    fireEvent.change(within(mineruSection).getByLabelText("API Token"), {
      target: { value: "tok_new" },
    });
    await act(async () => {
      fireEvent.click(within(mineruSection).getByRole("button", { name: "保存凭据" }));
      await new Promise((r) => setTimeout(r, 60));
    });
    // 保存成功只表示已配置
    expect(state.setTokenCalls).toHaveLength(1);
    expect(within(settingsDialog).getByText(/已保存，仅表示本机已配置/)).not.toBeNull();

    // 关闭设置，回到原导入面板；此时仍未提交任务
    await act(async () => {
      fireEvent.click(within(settingsDialog).getByRole("button", { name: "完成" }));
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(state.startCalls).toHaveLength(0);
    const importDialogAgain = screen.getByRole("dialog", { name: "导入 PDF 并解析" });
    expect(
      within(importDialogAgain).getByTestId("import-credential-status").textContent
    ).toContain("已配置");

    await act(async () => {
      fireEvent.click(within(importDialogAgain).getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0].request).toEqual({
      source_path: PDF_A_PATH,
      provider: "mineru",
      force_new: false,
    });
    unmount();
  });

  it("4. 提交绑定所选 PDF：任务身份来自后端返回，原 PDF 复用既有打开流程", async () => {
    const state = installAppMock();
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });

    const dialog = screen.getByRole("dialog", { name: "导入 PDF 并解析" });
    expect(within(dialog).getByText("a.pdf")).not.toBeNull();
    expect(within(dialog).getByText(/文件将上传到所选解析服务商/)).not.toBeNull();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 120));
    });

    // 提交绑定的是面板中所选文件，而不是此刻的 currentDoc
    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0].request.source_path).toBe(PDF_A_PATH);
    expect(state.startCalls[0].request.provider).toBe("mineru");

    // 原 PDF 通过既有 openDocument 登记为同一书籍
    const docCalls = mockInvoke.mock.calls.filter((c) => c[0] === "db_get_or_create_document");
    expect(docCalls.some((c) => (c[1] as any).filePath === PDF_A_PATH)).toBe(true);

    // 提交后面板关闭，给出可继续查看的轻提示
    expect(screen.queryByRole("dialog", { name: "导入 PDF 并解析" })).toBeNull();
    expect(container.textContent).toContain("已提交");

    await act(async () => {
      fireEvent.click(screen.getByText("查看任务"));
      await new Promise((r) => setTimeout(r, 60));
    });
    const jobsPanel = screen.getByRole("dialog", { name: "解析任务" });
    expect(within(jobsPanel).getByText("a.pdf")).not.toBeNull();
    // 进度为真实值 42%，不是编造的
    expect(within(jobsPanel).getByText("42%")).not.toBeNull();
    unmount();
  });

  it("5. A 任务完成时用户已切到 B：不抢回 A，只给轻提示", async () => {
    const state = installAppMock();
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    // 提交 A 的解析任务
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(container.textContent).toContain("已提交");

    // 用户切到另一本文档 B
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    mockOpen.mockResolvedValueOnce(TXT_B_PATH);
    await act(async () => {
      fireEvent.click(screen.getByText("打开本地文件..."));
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(container.textContent).toContain("书籍B正文");

    // A 的任务完成
    state.jobList = [
      makeJob({
        job_id: "job_1",
        status: "succeeded",
        progress_percent: 100,
        version_id: "ver_a1",
        activated: true,
        can_cancel: false,
        update_seq: 5,
      }),
    ];
    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 80));
    });

    // 仍停留在 B，不会自动切回 A 的重排视图
    expect(container.textContent).toContain("书籍B正文");
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();
    expect(container.textContent).toContain("解析完成");
    unmount();
  });

  it("6. 用户手动切回原版后，旧任务完成不得强制切重排", async () => {
    const state = installAppMock({ activeWorkspace: makeActiveWorkspace("ver_a0", "已有版本正文") });
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 120));
    });

    // 提交后用户先看已有重排版本，再手动切回原版
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "流式重排" }));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "原版视图" }));
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();

    // 任务完成
    state.jobList = [
      makeJob({
        job_id: "job_1",
        status: "succeeded",
        progress_percent: 100,
        version_id: "ver_a1",
        activated: true,
        can_cancel: false,
        update_seq: 4,
      }),
    ];
    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 100));
    });

    // 用户在提交后手动切到原版：不得被旧任务强制改回重排
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();
    expect(container.textContent).toContain("解析完成");
    unmount();
  });

  it("7. 自动打开时若激活版本不符：立即释放迟到会话并保留原视图", async () => {
    const state = installAppMock();
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 120));
    });

    // 任务成功，但当前激活版本是另一个版本
    state.activeWorkspace = makeActiveWorkspace("ver_other", "另一个版本正文");
    state.jobList = [
      makeJob({
        job_id: "job_1",
        status: "succeeded",
        progress_percent: 100,
        version_id: "ver_a1",
        activated: true,
        can_cancel: false,
        update_seq: 6,
      }),
    ];

    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 100));
    });

    // 迟到的阅读会话被关闭
    const closed = mockInvoke.mock.calls
      .filter((c) => c[0] === "parsed_preview_close")
      .map((c) => (c[1] as any)?.sessionId);
    expect(closed).toContain("sess_ver_other");

    // 再次刷新不得重复处理同一终态任务、也不得反复创建阅读会话
    const getActiveCallsBefore = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_workspace_get_active"
    ).length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(
      mockInvoke.mock.calls.filter((c) => c[0] === "parsed_workspace_get_active").length
    ).toBe(getActiveCallsBefore);

    // 界面保持原版，不展示任何版本
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();
    expect(container.textContent).not.toContain("另一个版本正文");
    unmount();
  });

  it("8. 查看历史任务结果：只读预览且不提供绑定入口", async () => {
    const state = installAppMock({
      jobList: [
        makeJob({
          job_id: "job_hist",
          status: "succeeded",
          progress_percent: 100,
          version_id: "ver_hist",
          activated: false,
          can_cancel: false,
          update_seq: 9,
        }),
      ],
    });

    const { unmount } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 80));
    });

    const jobsPanel = screen.getByRole("dialog", { name: "解析任务" });
    await act(async () => {
      fireEvent.click(within(jobsPanel).getByRole("button", { name: "查看任务结果" }));
      await new Promise((r) => setTimeout(r, 100));
    });

    // 复用既有只读预览器打开任务结果
    const openCalls = mockInvoke.mock.calls.filter((c) => c[0] === "parsed_preview_open");
    expect(openCalls.some((c) => (c[1] as any).path === "C:\\docs\\result\\blocks.json")).toBe(true);

    // 任务结果预览不得出现“绑定到当前文档”
    expect(screen.queryByRole("button", { name: "绑定到当前文档" })).toBeNull();
    expect(state.startCalls).toHaveLength(0);
    unmount();
  });

  it("9. 关闭任务面板不取消任务；卸载后停止轮询", async () => {
    const state = installAppMock({ jobList: [makeJob({ can_cancel: true })] });
    const { unmount } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    const panel = screen.getByRole("dialog", { name: "解析任务" });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "关闭" }));
      await new Promise((r) => setTimeout(r, 40));
    });

    // 关闭面板既没有取消任务，也没有停止跟踪
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "parse_job_cancel")).toHaveLength(0);

    const listCallsBeforeUnmount = state.listCalls;
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(state.listCalls).toBe(listCallsBeforeUnmount);
  });

  it("10. 重启后恢复上次的重排视图与位置，新版本从顶部开始", async () => {
    const state = installAppMock({ activeWorkspace: makeActiveWorkspace("ver_a1", "版本一正文") });
    // 模拟上次退出前的持久化状态
    localStorage.setItem(
      PARSED_READING_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        modes: { doc_a: "reflow" },
        positions: { "doc_a:rev_a:ver_a1": { top: 350, updated_at: Date.now() } },
      })
    );

    const { unmount, container } = render(<App />);
    await flush();

    // 打开同一本文档
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);
    await act(async () => {
      fireEvent.click(screen.getByText("打开本地文件..."));
      await new Promise((r) => setTimeout(r, 120));
    });

    // 恢复上次选择的重排视图与位置
    const reflowArea = screen.getByRole("region", { name: "FlowRead 流式重排阅读区" });
    expect(reflowArea).not.toBeNull();
    expect(container.textContent).toContain("版本一正文");
    const scrollEl = container.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
    expect(scrollEl.scrollTop).toBe(350);

    // 导入新版本：没有该版本的位置记录，必须回到顶部
    state.activeWorkspace = makeActiveWorkspace("ver_a2", "版本二正文");
    fireEvent.click(screen.getByText("工具 (Tools)"));
    mockOpen.mockResolvedValueOnce("C:\\docs\\blocks.json");
    await act(async () => {
      fireEvent.click(screen.getByText("导入/绑定解析结果到当前文档…"));
      await new Promise((r) => setTimeout(r, 120));
    });

    expect(container.textContent).toContain("新导入版本正文");
    const newScrollEl = container.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
    expect(newScrollEl.scrollTop).toBe(0);
    unmount();
  });

  it("11. 任务跟踪器：按 update_seq 丢弃乱序/重复响应，列表缺失时单独查询", async () => {
    let listItems: ParseJobDto[] = [makeJob({ update_seq: 3 })];
    const listJobs = vi.fn(async (): Promise<ParseJobListResponse> => ({
      items: listItems,
      next_cursor: null,
    }));
    const getJob = vi.fn(async () =>
      makeJob({
        status: "succeeded" as ParseJobStatus,
        update_seq: 9,
        version_id: "ver_1",
        activated: true,
      })
    );

    const tracker = new ParseJobTracker({ listJobs, getJob, intervalMs: 60_000 });
    const snapshots: ParseJobDto[][] = [];
    tracker.subscribeJobs((jobs) => snapshots.push(jobs));

    tracker.track(makeJob({ update_seq: 5 }));
    expect(tracker.getJobById("job_1")?.update_seq).toBe(5);

    // 列表返回更旧的 seq：必须被丢弃，且该任务在列表中，不需要单独查询
    await tracker.pollOnce();
    expect(tracker.getJobById("job_1")?.update_seq).toBe(5);
    expect(getJob).not.toHaveBeenCalled();

    // 任务从列表中消失（例如刚完成）：单独 parse_job_get 补齐完成状态
    listItems = [makeJob({ job_id: "job_2", update_seq: 1 })];
    await tracker.pollOnce();
    expect(getJob).toHaveBeenCalledWith("job_1");
    expect(tracker.getJobById("job_1")?.update_seq).toBe(9);

    // 重复或更旧的响应不生效
    expect(tracker.applyJob(makeJob({ update_seq: 9 }))).toBe(false);
    expect(tracker.applyJob(makeJob({ update_seq: 8 }))).toBe(false);
    expect(snapshots.length).toBeGreaterThan(0);

    // 请求重叠保护：同一时刻只允许一次列表请求
    let resolveList: (v: ParseJobListResponse) => void = () => {};
    const pending = new Promise<ParseJobListResponse>((resolve) => {
      resolveList = resolve;
    });
    const slowList = vi.fn(() => pending);
    const tracker2 = new ParseJobTracker({ listJobs: slowList, getJob, intervalMs: 60_000 });
    const first = tracker2.pollOnce();
    const second = tracker2.pollOnce();
    expect(slowList).toHaveBeenCalledTimes(1);
    resolveList({ items: [], next_cursor: null });
    await Promise.all([first, second]);
  });

  it("12. 任务面板：继续任务与重新解析区分，submission_unknown 只能显式重新解析", () => {
    const paused = makeJob({
      job_id: "job_paused",
      status: "paused",
      can_resume: true,
      can_cancel: false,
      progress_percent: null,
      update_seq: 2,
    });
    const failed = makeJob({
      job_id: "job_failed",
      status: "failed",
      can_resume: false,
      can_cancel: false,
      progress_percent: null,
      completed_pages: null,
      total_pages: null,
      error_message: "服务商返回 401",
      update_seq: 3,
    });
    const unknown = makeJob({
      job_id: "job_unknown",
      status: "submission_unknown",
      can_resume: false,
      can_cancel: false,
      progress_percent: null,
      update_seq: 4,
    });
    // 运行中但服务商还没有给出百分比：界面只能显示阶段
    const runningNoProgress = makeJob({
      job_id: "job_running",
      status: "processing",
      progress_percent: null,
      completed_pages: null,
      total_pages: null,
      can_cancel: true,
      update_seq: 5,
    });

    const onResume = vi.fn();
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    const onClose = vi.fn();

    render(
      <ParseJobsPanel
        isOpen
        jobs={[paused, failed, unknown, runningNoProgress]}
        loading={false}
        errorMessage={null}
        nextCursor={null}
        busyJobIds={[]}
        currentDocumentId="doc_a"
        onClose={onClose}
        onRefresh={() => {}}
        onLoadMore={() => {}}
        onCancel={onCancel}
        onResume={onResume}
        onRetry={onRetry}
        onViewResult={() => {}}
        onOpenResultDocument={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "继续任务" }));
    expect(onResume).toHaveBeenCalledWith(paused);

    // 失败任务与“状态待确认”任务都只能通过显式“重新解析”重试
    const retryButtons = screen.getAllByRole("button", { name: "重新解析" });
    expect(retryButtons).toHaveLength(2);
    fireEvent.click(retryButtons[0]);
    expect(onRetry).toHaveBeenCalledWith(failed);

    // 状态不明时提示仍然存在，但只能通过“重新解析”（显式新任务）重试，不能被自动重提
    expect(screen.getByText(/暂时无法确认服务商是否受理/)).not.toBeNull();
    expect(screen.queryAllByRole("button", { name: "重新解析" })).toHaveLength(2);

    // 进度未知时只显示阶段，不编造百分比；可取消的任务才显示“停止”
    expect(screen.getByText(/进度未知，仅显示当前阶段/)).not.toBeNull();
    expect(screen.queryByText(/%$/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("13. 缺少凭据时提交按钮不可用，且不会发出任务请求", async () => {
    const state = installAppMock({ settings: makeSettings(false, false) });
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });

    const dialog = screen.getByRole("dialog", { name: "导入 PDF 并解析" });
    const submit = within(dialog).getByRole("button", { name: "上传并解析" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    await flush(40);
    expect(state.startCalls).toHaveLength(0);
    unmount();
  });

  it("14. 满足全部条件时自动切到重排、接管会话并按文档记住视图模式", async () => {
    const state = installAppMock();
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 140));
    });

    // 任务成功，且后端激活版本与任务版本一致
    state.activeWorkspace = makeActiveWorkspace("ver_a1", "自动打开的重排正文");
    state.jobList = [
      makeJob({
        job_id: "job_1",
        status: "succeeded",
        progress_percent: 100,
        version_id: "ver_a1",
        activated: true,
        can_cancel: false,
        update_seq: 7,
      }),
    ];

    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 140));
    });

    // 自动进入重排并展示新版本
    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("自动打开的重排正文");

    // 会话被接管，没有被误关
    const closed = mockInvoke.mock.calls
      .filter((c) => c[0] === "parsed_preview_close")
      .map((c) => (c[1] as any)?.sessionId);
    expect(closed).not.toContain("sess_ver_a1");

    // 按文档记住重排模式，供重启恢复
    const stored = JSON.parse(localStorage.getItem(PARSED_READING_STORAGE_KEY) || "{}");
    expect(stored.modes?.doc_a).toBe("reflow");
    unmount();
  });

  it("15. 任务面板展示排队细分、调度异常横幅、云端页数进度与可复制诊断（脱敏验证）", async () => {
    const queuedJob = makeJob({
      job_id: "job_queued_1",
      status: "queued",
      progress_percent: null,
      completed_pages: null,
      total_pages: null,
      can_cancel: true,
    });

    const parsingJob = makeJob({
      job_id: "job_parsing_1",
      status: "processing",
      progress_percent: null,
      completed_pages: 5,
      total_pages: 12,
      can_cancel: true,
    });

    const failedJob = makeJob({
      job_id: "job_failed_1",
      status: "failed",
      error_code: "ERR_AUTH_FAILED",
      error_message: "MinerU 认证拒绝: Bearer secret_token_1234567890",
      completed_pages: null,
      total_pages: null,
      can_cancel: false,
      can_resume: true,
    });

    const serviceHealthError = {
      scheduler_status: "error" as const,
      current_job_id: null,
      current_job_stage: null,
      last_scheduler_error: "数据库锁竞争超时: timeout waiting for lock",
      last_scheduler_error_at: 1_700_000_200_000,
      last_heartbeat_at: 1_700_000_200_000,
    };

    const { rerender } = render(
      <ParseJobsPanel
        isOpen
        jobs={[queuedJob, parsingJob, failedJob]}
        loading={false}
        errorMessage={null}
        nextCursor={null}
        busyJobIds={[]}
        currentDocumentId="doc_a"
        serviceHealth={serviceHealthError}
        onClose={() => {}}
        onRefresh={() => {}}
        onLoadMore={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onRetry={() => {}}
        onViewResult={() => {}}
        onOpenResultDocument={() => {}}
      />
    );

    // 1. 调度异常时展示横幅，排队任务显示为“排队（后台调度异常）”
    expect(screen.getByText("后台任务调度器异常，新排队任务暂未开始执行")).not.toBeNull();
    expect(screen.getByText(/数据库锁竞争超时/)).not.toBeNull();
    expect(screen.getByText("排队（后台调度异常）")).not.toBeNull();

    // 2. 点击“复制调度诊断”，剪贴板写入脱敏报告
    const copySchedulerBtn = screen.getByRole("button", { name: "复制调度诊断" });
    fireEvent.click(copySchedulerBtn);
    const calls = vi.mocked(navigator.clipboard.writeText).mock.calls;
    const schedulerReport = calls[calls.length - 1][0] as string;
    expect(schedulerReport).toContain("调度器状态: error");
    expect(schedulerReport).toContain("数据库锁竞争超时");

    // 3. 服务商正在执行其他任务时，排队任务显示为“排队（等待前一任务）”
    const serviceHealthBusy = {
      scheduler_status: "busy" as const,
      current_job_id: "job_other",
      current_job_stage: "uploading",
      last_scheduler_error: null,
      last_scheduler_error_at: null,
      last_heartbeat_at: 1_700_000_200_000,
    };
    rerender(
      <ParseJobsPanel
        isOpen
        jobs={[queuedJob, parsingJob, failedJob]}
        loading={false}
        errorMessage={null}
        nextCursor={null}
        busyJobIds={[]}
        currentDocumentId="doc_a"
        serviceHealth={serviceHealthBusy}
        onClose={() => {}}
        onRefresh={() => {}}
        onLoadMore={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onRetry={() => {}}
        onViewResult={() => {}}
        onOpenResultDocument={() => {}}
      />
    );
    expect(screen.getByText("排队（等待前一任务）")).not.toBeNull();
    expect(screen.getByText(/前序任务执行中/)).not.toBeNull();

    // 4. 云端页数进度：显示 5/12 页，并明确标注非全流程比例
    expect(screen.getByText(/云端解析进度:/)).not.toBeNull();
    expect(screen.getByText("5/12 页")).not.toBeNull();
    expect(screen.getByText(/云端解析阶段进度，非全流程完成比例/)).not.toBeNull();

    // 5. 错误块展示当前状态、错误码、说明，展开详细诊断与复制
    expect(screen.getByText("当前状态: 失败")).not.toBeNull();
    expect(screen.getByText("错误码: ERR_AUTH_FAILED")).not.toBeNull();

    const expandBtn = screen.getAllByRole("button", { name: "展开详细诊断" })[2];
    fireEvent.click(expandBtn);
    expect(screen.getByText(/FlowRead 解析任务诊断报告/)).not.toBeNull();

    const copyJobBtn = screen.getAllByRole("button", { name: "复制诊断信息" })[2];
    fireEvent.click(copyJobBtn);
    const jobCalls = vi.mocked(navigator.clipboard.writeText).mock.calls;
    const jobReport = jobCalls[jobCalls.length - 1][0] as string;
    expect(jobReport).toContain("任务 ID: job_failed_1");
    expect(jobReport).toContain("当前状态: 失败");
    expect(jobReport).toContain("ERR_AUTH_FAILED");
    // 关键断言：Token 必须已被脱敏，不得泄漏明文
    expect(jobReport).not.toContain("secret_token_1234567890");
    expect(jobReport).toContain("[REDACTED_TOKEN]");
  });
});

describe("可控异步回归测试与状态协调", () => {
  it("1. 旧 getActive 延迟返回，新手动导入先完成：新版本不被覆盖，仅旧响应 session 被关闭", async () => {
    let resolveSlowActive: ((val: any) => void) | null = null;
    const state = installAppMock();
    let getActiveCallCount = 0;
    state.activeWorkspace = () => {
      getActiveCallCount++;
      if (getActiveCallCount === 1) {
        return new Promise((resolve) => {
          resolveSlowActive = resolve;
        });
      }
      return null;
    };

    mockOpen.mockResolvedValueOnce(PDF_A_PATH);
    const { unmount, container } = render(<App />);
    await flush();

    // 打开文档 A：由于 resolveSlowActive 未解决，初始 getActive 一直挂起
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("打开本地文件..."));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 用户在挂起期间手动导入新版本
    fireEvent.click(screen.getByText("工具 (Tools)"));
    mockOpen.mockResolvedValueOnce("C:\\docs\\blocks.json");
    await act(async () => {
      fireEvent.click(screen.getByText("导入/绑定解析结果到当前文档…"));
      await new Promise((r) => setTimeout(r, 80));
    });

    // 手动导入先完成，接管 session 并切到重排
    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("新导入版本正文");

    // 此时旧的 getActive 延迟返回
    await act(async () => {
      resolveSlowActive!(makeActiveWorkspace("ver_delayed_old", "延迟返回的旧版本正文"));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 断言：新版本未被旧响应覆盖
    expect(container.textContent).toContain("新导入版本正文");
    expect(container.textContent).not.toContain("延迟返回的旧版本正文");

    // 断言 session 生命周期：仅延迟返回的旧 session 被关闭，当前使用的 imported session 保持有效
    const closed = mockInvoke.mock.calls
      .filter((c) => c[0] === "parsed_preview_close")
      .map((c) => (c[1] as any)?.sessionId);
    expect(closed).toContain("sess_ver_delayed_old");
    expect(closed).not.toContain("sess_ver_imported");

    unmount();
  });

  it("2. 同一本书关闭再打开，旧打开代次的结果不能接管", async () => {
    localStorage.setItem(
      PARSED_READING_STORAGE_KEY,
      JSON.stringify({ version: 1, modes: { doc_a: "reflow" } })
    );
    let resolveFirstOpenActive: ((val: any) => void) | null = null;
    const state = installAppMock();
    let getActiveCallCount = 0;

    state.activeWorkspace = () => {
      getActiveCallCount++;
      if (getActiveCallCount === 1) {
        return new Promise((resolve) => {
          resolveFirstOpenActive = resolve;
        });
      }
      return makeActiveWorkspace("ver_second", "第二代打开正文");
    };

    mockOpen.mockResolvedValueOnce(PDF_A_PATH);
    const { unmount, container } = render(<App />);
    await flush();

    // 第一次打开文档 A
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("打开本地文件..."));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 在第一次 getActive 挂起期间，再次打开同一本书（触发新的代次）
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("打开本地文件..."));
      await new Promise((r) => setTimeout(r, 80));
    });

    // 第二次打开已成功接管第二代版本
    expect(container.textContent).toContain("第二代打开正文");

    // 此时第一代挂起的 getActive 才返回
    await act(async () => {
      resolveFirstOpenActive!(makeActiveWorkspace("ver_first", "第一代打开正文"));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 断言：第一代结果因代次过期被拒绝，正文仍是第二代
    expect(container.textContent).toContain("第二代打开正文");
    expect(container.textContent).not.toContain("第一代打开正文");

    // 断言：第一代的 session 被关闭，第二代的 session 未被误关
    const closed = mockInvoke.mock.calls
      .filter((c) => c[0] === "parsed_preview_close")
      .map((c) => (c[1] as any)?.sessionId);
    expect(closed).toContain("sess_ver_first");
    expect(closed).not.toContain("sess_ver_second");

    unmount();
  });

  it("3. 暂停→继续→成功，完成行为恰好执行一次", async () => {
    const state = installAppMock();
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    // 打开文档 A 并提交解析
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 120));
    });

    // 任务变为暂停状态
    state.jobList = [
      makeJob({
        job_id: "job_1",
        status: "paused",
        can_resume: true,
        can_cancel: true,
        update_seq: 2,
      }),
    ];

    // 打开任务面板并点击“继续任务”
    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });

    const resumeBtn = screen.getByRole("button", { name: "继续任务" });
    await act(async () => {
      fireEvent.click(resumeBtn);
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(state.resumeCalls).toHaveLength(1);

    // 恢复后任务变为成功
    state.activeWorkspace = makeActiveWorkspace("ver_resumed_ok", "恢复并成功后的正文");
    state.jobList = [
      makeJob({
        job_id: "job_1",
        status: "succeeded",
        version_id: "ver_resumed_ok",
        activated: true,
        can_resume: false,
        can_cancel: false,
        update_seq: 4,
      }),
    ];

    // 刷新触发完成处理
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 120));
    });

    // 正确切换到重排并展示内容
    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("恢复并成功后的正文");

    const getActiveCountAfterSuccess = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_workspace_get_active"
    ).length;

    // 再次刷新：由于 handledSuccessKeys 去重，不会重复查询或重复切换
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 80));
    });

    const getActiveCountAfterSecondRefresh = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_workspace_get_active"
    ).length;
    expect(getActiveCountAfterSecondRefresh).toBe(getActiveCountAfterSuccess);

    unmount();
  });

  it("4. 失败→继续→成功，完成行为不被永久过滤", async () => {
    const state = installAppMock();
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    // 打开文档 A 并提交任务
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 120));
    });

    // 任务失败（但支持继续或恢复）
    state.jobList = [
      makeJob({
        job_id: "job_1",
        status: "failed",
        can_resume: true,
        error_code: "network_err",
        error_message: "网络抖动",
        update_seq: 2,
      }),
    ];

    // 打开任务面板并刷新以记录失败状态
    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 80));
    });

    // 点击继续任务恢复运行
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续任务" }));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 任务成功完成
    state.activeWorkspace = makeActiveWorkspace("ver_recovered_ok", "失败恢复成功后的正文");
    state.jobList = [
      makeJob({
        job_id: "job_1",
        status: "succeeded",
        version_id: "ver_recovered_ok",
        activated: true,
        can_resume: false,
        can_cancel: false,
        update_seq: 5,
      }),
    ];

    // 再次刷新：完成行为不能被之前的 failed 状态永久过滤
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 120));
    });

    // 成功打开重排并展示正文
    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("失败恢复成功后的正文");

    unmount();
  });

  it("5. 历史列表已出现的 succeeded 任务再次被导入，正确执行本次自动打开", async () => {
    // 历史列表中已存在该 succeeded 任务
    const histJob = makeJob({
      job_id: "job_hist_reuse",
      document_id: "doc_a",
      source_revision: "rev_a",
      status: "succeeded",
      version_id: "ver_hist_reuse",
      activated: true,
      can_cancel: false,
      can_resume: false,
      update_seq: 8,
    });
    installAppMock({
      jobList: [histJob],
      activeWorkspace: makeActiveWorkspace("ver_hist_reuse", "已有解析包重排正文"),
      jobStartResult: histJob,
    });

    mockOpen.mockResolvedValueOnce(PDF_A_PATH);
    const { unmount, container } = render(<App />);
    await flush();

    // 用户在导入弹窗中导入同一本书（后端直接复用返回 histJob）
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 140));
    });

    // 提示“已使用已有解析结果”，而非“已提交，等待解析”
    expect(screen.getByRole("status").textContent).toContain("已有解析结果");
    expect(screen.queryByText(/已提交，等待解析/)).toBeNull();

    // 成功自动打开流式重排视图并渲染已有版本正文
    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("已有解析包重排正文");

    unmount();
  });

  it("6. parse_job_start 立即返回 succeeded，而目标文档仍在加载；身份就绪后正确打开重排", async () => {
    let resolveDoc: ((val: any) => void) | null = null;
    const fastJob = makeJob({
      job_id: "job_fast_sync",
      document_id: "doc_a",
      source_revision: "rev_a",
      status: "succeeded",
      version_id: "ver_fast_sync",
      activated: true,
      update_seq: 9,
    });

    installAppMock({
      jobStartResult: fastJob,
      activeWorkspace: makeActiveWorkspace("ver_fast_sync", "极速成功结果正文"),
      getOrCreateDocument: (args: any) => {
        if (args.filePath?.endsWith("a.pdf")) {
          return new Promise((resolve) => {
            resolveDoc = resolve;
          });
        }
        return { id: "doc_intro", file_path: "intro", revision: "v1" };
      },
    });

    mockOpen.mockResolvedValueOnce(PDF_A_PATH);
    const { unmount, container } = render(<App />);
    await flush();

    // 用户发起导入解析
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 此时 parse_job_start 返回 succeeded，但 openDocument 由于 resolveDoc 尚未返回而挂起
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 文档身份尚未就绪，暂不切换
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();

    // 文档加载完成，身份就绪
    await act(async () => {
      resolveDoc!({
        id: "doc_a",
        file_path: PDF_A_PATH,
        display_name: "a.pdf",
        file_size: 100,
        revision: "rev_a",
        last_read_position: null,
        created_at: 0,
        updated_at: 0,
      });
      await new Promise((r) => setTimeout(r, 120));
    });

    // 身份确认后，自动完成流式重排接管
    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("极速成功结果正文");

    unmount();
  });

  it("7. 等待期间切到其他书或手动改视图，不抢回", async () => {
    // 子场景 7A: 等待期间切书
    const stateA = installAppMock();
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount: unmountA, container: containerA } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 100));
    });

    // 用户切换到书籍 B
    mockOpen.mockResolvedValueOnce(TXT_B_PATH);
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("打开本地文件..."));
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(containerA.textContent).toContain("书籍B正文");

    // 此时书籍 A 的解析任务完成
    stateA.activeWorkspace = makeActiveWorkspace("ver_a_late", "书籍A重排正文");
    stateA.jobList = [
      makeJob({
        job_id: "job_1",
        document_id: "doc_a",
        status: "succeeded",
        version_id: "ver_a_late",
        activated: true,
        update_seq: 10,
      }),
    ];

    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 100));
    });

    // 书籍 B 不被抢回重排，也不显示书籍 A 的正文
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();
    expect(containerA.textContent).toContain("书籍B正文");
    expect(containerA.textContent).not.toContain("书籍A重排正文");
    unmountA();

    // 子场景 7B: 等待期间用户手动切换到原版视图
    const stateB = installAppMock({
      activeWorkspace: makeActiveWorkspace("ver_prev", "先前版本正文"),
    });
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount: unmountB } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 100));
    });

    // 用户在等待解析期间，明确点击“原版视图”按钮
    fireEvent.click(screen.getByRole("button", { name: "原版视图" }));
    await flush(30);

    // 此时任务完成
    stateB.activeWorkspace = makeActiveWorkspace("ver_a_view", "书籍A视图正文");
    stateB.jobList = [
      makeJob({
        job_id: "job_1",
        document_id: "doc_a",
        status: "succeeded",
        version_id: "ver_a_view",
        activated: true,
        update_seq: 11,
      }),
    ];

    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 100));
    });

    // 用户主动选择原版，不能被迟到结果抢回重排
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();
    unmountB();
  });

  it("8. 重复成功响应不会反复切换", async () => {
    const state = installAppMock();
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 100));
    });

    state.activeWorkspace = makeActiveWorkspace("ver_dup", "成功正文");
    state.jobList = [
      makeJob({
        job_id: "job_1",
        status: "succeeded",
        version_id: "ver_dup",
        activated: true,
        update_seq: 12,
      }),
    ];

    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("成功正文");

    const getActiveCallsAfterFirst = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_workspace_get_active"
    ).length;

    // 多次轮询/刷新相同的成功响应
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "刷新" }));
        await new Promise((r) => setTimeout(r, 60));
      });
    }

    const getActiveCallsAfterRepeats = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_workspace_get_active"
    ).length;

    // 活跃会话查询次数未增长，无重复切换
    expect(getActiveCallsAfterRepeats).toBe(getActiveCallsAfterFirst);

    unmount();
  });

  it("9. 同版本查询产生的未使用 session 得到释放", async () => {
    localStorage.setItem(
      PARSED_READING_STORAGE_KEY,
      JSON.stringify({ version: 1, modes: { doc_a: "reflow" } })
    );
    // 初始打开已有版本 ver_same
    const state = installAppMock({
      activeWorkspace: makeActiveWorkspace("ver_same", "相同版本正文"),
    });
    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("打开本地文件..."));
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(screen.getByRole("region", { name: "FlowRead 流式重排阅读区" })).not.toBeNull();
    expect(container.textContent).toContain("相同版本正文");

    // 后续背景任务或查询返回了同一个版本，但产生了一个新的查询 session
    let querySessionCreated = false;
    state.activeWorkspace = () => {
      querySessionCreated = true;
      return {
        ...makeActiveWorkspace("ver_same", "相同版本正文"),
        session_id: "sess_same_second",
      };
    };

    // 模拟触发一次同版本查询（通过历史任务打开流式重排触发）
    state.jobList = [
      makeJob({
        job_id: "job_same",
        status: "succeeded",
        version_id: "ver_same",
        activated: true,
        update_seq: 15,
      }),
    ];

    fireEvent.click(screen.getByText("工具 (Tools)"));
    await act(async () => {
      fireEvent.click(screen.getByText("解析任务…"));
      await new Promise((r) => setTimeout(r, 60));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "打开流式重排" }));
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(querySessionCreated).toBe(true);

    const closed = mockInvoke.mock.calls
      .filter((c) => c[0] === "parsed_preview_close")
      .map((c) => (c[1] as any)?.sessionId);

    // 新产生的未接管 session 必须释放
    expect(closed).toContain("sess_same_second");
    // 正在使用的有效 session 决不能被误关
    expect(closed).not.toContain("sess_ver_same");

    unmount();
  });

  it("10. submission_unknown 不会因点击普通继续而发出新的 parse_job_start", async () => {
    const unknownJob = makeJob({
      job_id: "job_unknown",
      status: "submission_unknown",
      can_resume: true,
      can_cancel: false,
      update_seq: 3,
    });
    const state = installAppMock({
      jobList: [unknownJob],
    });

    render(
      <ParseJobsPanel
        isOpen
        jobs={[unknownJob]}
        loading={false}
        errorMessage={null}
        nextCursor={null}
        busyJobIds={[]}
        currentDocumentId="doc_a"
        onClose={() => {}}
        onRefresh={() => {}}
        onLoadMore={() => {}}
        onCancel={() => {}}
        onResume={() => {
          // 普通恢复调用 parse_job_resume，决不调用 parse_job_start
          void invoke("parse_job_resume", { jobId: unknownJob.job_id });
        }}
        onRetry={() => {
          void invoke("parse_job_start", { filePath: unknownJob.source_path, provider: unknownJob.provider, forceNew: true });
        }}
        onViewResult={() => {}}
        onOpenResultDocument={() => {}}
      />
    );
    await flush(30);

    // 状态不明时明确展示警告；重试只能走显式“重新解析”（新任务），普通“继续”不会重新提交
    expect(screen.getByText(/暂时无法确认服务商是否受理/)).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "重新解析" })).toHaveLength(1);

    // 点击“继续任务”
    const resumeBtn = screen.getByRole("button", { name: "继续任务" });
    fireEvent.click(resumeBtn);
    await flush(30);

    // 断言：resume 被调用，而 parse_job_start 绝没有被调用
    expect(mockInvoke.mock.calls.some((c) => c[0] === "parse_job_resume")).toBe(true);
    expect(mockInvoke.mock.calls.some((c) => c[0] === "parse_job_start")).toBe(false);
    expect(state.startCalls).toHaveLength(0);
  });

  it("11. 提交解析响应迟到不会抢回旧书", async () => {
    let resolveStart: (job: ParseJobDto) => void = () => {};
    const deferredStart = new Promise<ParseJobDto>((resolve) => {
      resolveStart = resolve;
    });

    const state = installAppMock();
    state.jobStartResult = () => deferredStart;

    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    // 1. 用户选择 PDF_A 进行解析导入
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 2. 点击上传并解析（开始异步提交 A，挂在 deferredStart 上）
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(state.startCalls.length).toBe(1);

    // 3. 在等待 A 提交响应期间，用户切书打开了 B (TXT_B_PATH)
    mockOpen.mockResolvedValueOnce(TXT_B_PATH);
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("打开本地文件..."));
      await new Promise((r) => setTimeout(r, 100));
    });

    // 确认当前已经切换到了书籍 B
    expect(container.textContent).toContain("b.txt");

    // 4. 此时 A 的提交响应终于迟到返回
    await act(async () => {
      resolveStart(
        makeJob({
          job_id: "job_a_late",
          document_id: "doc_a",
          source_path: PDF_A_PATH,
          document_name: "a.pdf",
          status: "processing",
        })
      );
      await new Promise((r) => setTimeout(r, 100));
    });

    // 5. 校验：当前阅读界面必须依然是书籍 B，不能被 A 强行抢回打开
    expect(container.textContent).toContain("书籍B正文");
    // 轻提示正常告知 A 已提交，但当前活动阅读器未被切走
    expect(container.textContent).toContain("已提交《a.pdf》的解析任务");

    unmount();
  });

  it("12. 提交解析直接复用历史成功结果，响应迟到同样不得抢回旧书", async () => {
    let resolveStart: (job: ParseJobDto) => void = () => {};
    const deferredStart = new Promise<ParseJobDto>((resolve) => {
      resolveStart = resolve;
    });

    const state = installAppMock();
    state.jobStartResult = () => deferredStart;

    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    // 1. 用户选择 PDF_A 进行解析导入（默认勾选完成后打开重排）
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 2. 点击上传并解析（开始异步提交 A，挂在 deferredStart 上）
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 3. 在等待 A 返回期间，用户切书打开了 B (TXT_B_PATH)
    mockOpen.mockResolvedValueOnce(TXT_B_PATH);
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("打开本地文件..."));
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(container.textContent).toContain("书籍B正文");

    // 4. 后端直接返回历史 succeeded 结果（复用缓存分支）
    await act(async () => {
      resolveStart(
        makeJob({
          job_id: "job_a_cached",
          document_id: "doc_a",
          source_path: PDF_A_PATH,
          document_name: "a.pdf",
          status: "succeeded",
          version_id: "ver_cached",
          activated: true,
        })
      );
      await new Promise((r) => setTimeout(r, 100));
    });

    // 5. 校验：不能抢回原版 A 也不能切入 A 的重排，活动阅读界面必须保持书籍 B
    expect(container.textContent).toContain("书籍B正文");
    expect(screen.queryByRole("region", { name: "FlowRead 流式重排阅读区" })).toBeNull();
    // 提示“已使用已有解析结果”，但不会强制跳回
    expect(container.textContent).toContain("已使用《a.pdf》的已有解析结果");

    unmount();
  });

  it("13. 正常提交未切书时，正常打开目标文档与后续处理", async () => {
    let resolveStart: (job: ParseJobDto) => void = () => {};
    const deferredStart = new Promise<ParseJobDto>((resolve) => {
      resolveStart = resolve;
    });

    const state = installAppMock();
    state.jobStartResult = () => deferredStart;

    mockOpen.mockResolvedValueOnce(PDF_A_PATH);

    const { unmount, container } = render(<App />);
    await flush();

    // 1. 用户选择 PDF_A 进行解析导入
    fireEvent.click(screen.getByText("工作区 (Workspace)"));
    await act(async () => {
      fireEvent.click(screen.getByText("导入 PDF 并解析…"));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 2. 点击上传并解析
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
      await new Promise((r) => setTimeout(r, 60));
    });

    // 3. 用户未切书，保持在当前状态，A 的提交响应返回
    await act(async () => {
      resolveStart(
        makeJob({
          job_id: "job_a_normal",
          document_id: "doc_a",
          source_path: PDF_A_PATH,
          document_name: "a.pdf",
          status: "processing",
        })
      );
      await new Promise((r) => setTimeout(r, 100));
    });

    // 4. 目标 PDF A 正常被调用打开（PDF 阅读区被挂载）
    expect(container.textContent).toContain("a.pdf");
    expect(container.textContent).toContain("已提交《a.pdf》的解析任务");

    unmount();
  });

  it("14. 跟踪器接收同状态递增序号的进度，面板从 1/20 更新到 6/20，重复与旧序号被拒绝", async () => {
    const tracker = new ParseJobTracker({
      listJobs: async () => ({ items: [], next_cursor: null }),
      getJob: async (id) => makeJob({ job_id: id }),
      intervalMs: 60_000,
    });

    const snapshots: ParseJobDto[][] = [];
    tracker.subscribeJobs((jobs) => snapshots.push([...jobs]));

    // 初始进度: 1/20, seq 2
    tracker.track(
      makeJob({
        job_id: "job_prog",
        status: "processing",
        completed_pages: 1,
        total_pages: 20,
        update_seq: 2,
      })
    );
    expect(tracker.getJobById("job_prog")?.completed_pages).toBe(1);

    // 同状态新进度: 6/20, seq 3（递增序号）必须被成功接受
    const applied = tracker.applyJob(
      makeJob({
        job_id: "job_prog",
        status: "processing",
        completed_pages: 6,
        total_pages: 20,
        update_seq: 3,
      })
    );
    expect(applied).toBe(true);
    expect(tracker.getJobById("job_prog")?.completed_pages).toBe(6);
    expect(tracker.getJobById("job_prog")?.update_seq).toBe(3);

    // 重复序号 seq 3 必须被拒绝
    const dup = tracker.applyJob(
      makeJob({
        job_id: "job_prog",
        status: "processing",
        completed_pages: 6,
        total_pages: 20,
        update_seq: 3,
      })
    );
    expect(dup).toBe(false);

    // 更旧序号 seq 2 必须被拒绝，页数保持 6/20
    const old = tracker.applyJob(
      makeJob({
        job_id: "job_prog",
        status: "processing",
        completed_pages: 1,
        total_pages: 20,
        update_seq: 2,
      })
    );
    expect(old).toBe(false);
    expect(tracker.getJobById("job_prog")?.completed_pages).toBe(6);
  });

  it("15. 没有错误的运行中任务可以展开、复制诊断，且不会调用解析启动接口", () => {
    const runningJob = makeJob({
      job_id: "job_running_diag",
      status: "processing",
      progress_percent: null,
      completed_pages: 3,
      total_pages: 15,
      can_cancel: true,
      error_code: null,
      error_message: null,
      update_seq: 4,
    });

    const onRetry = vi.fn();
    const onResume = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParseJobsPanel
        isOpen
        jobs={[runningJob]}
        loading={false}
        errorMessage={null}
        nextCursor={null}
        busyJobIds={[]}
        currentDocumentId="doc_a"
        serviceHealth={{
          scheduler_status: "busy",
          current_job_id: "job_running_diag",
          current_job_stage: "processing",
          last_scheduler_error: null,
          last_scheduler_error_at: null,
          last_heartbeat_at: Date.now(),
        }}
        onClose={() => {}}
        onRefresh={() => {}}
        onLoadMore={() => {}}
        onCancel={onCancel}
        onResume={onResume}
        onRetry={onRetry}
        onViewResult={() => {}}
        onOpenResultDocument={() => {}}
      />
    );

    // 运行中任务无错误卡片
    expect(screen.queryByText(/当前状态:.*失败/)).toBeNull();
    expect(screen.queryByText(/错误码:/)).toBeNull();

    // 展开详细诊断按钮依然可用
    const expandBtn = screen.getByRole("button", { name: "展开详细诊断" });
    expect(expandBtn).not.toBeNull();
    fireEvent.click(expandBtn);

    // 详细诊断内容正常展示
    expect(screen.getByText(/FlowRead 解析任务诊断报告/)).not.toBeNull();

    // 复制诊断信息
    const copyBtn = screen.getByRole("button", { name: "复制诊断信息" });
    fireEvent.click(copyBtn);
    const calls = vi.mocked(navigator.clipboard.writeText).mock.calls;
    const report = calls[calls.length - 1][0] as string;
    expect(report).toContain("任务 ID: job_running_diag");
    expect(report).toContain("当前状态: 服务商排队/解析");
    expect(report).toContain("已解析页数/总页数: 3/15 页");
    expect(report).toContain("错误码: 无");
    expect(report).toContain("错误摘要: 无");
    expect(report).toContain("后台调度状态: busy");
    expect(report).toContain("当前后台任务: job_running_diag");

    // 复制诊断不得触发新任务、重试、继续或取消
    expect(onRetry).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("16. 时间标签与实际数据含义一致，活跃任务显示距最近更新", () => {
    const nowMs = Date.now();
    const activeJob = makeJob({
      job_id: "job_time_label",
      status: "processing",
      created_at: nowMs - 120_000,
      updated_at: nowMs - 30_000,
      update_seq: 5,
    });

    render(
      <ParseJobsPanel
        isOpen
        jobs={[activeJob]}
        loading={false}
        errorMessage={null}
        nextCursor={null}
        busyJobIds={[]}
        currentDocumentId="doc_a"
        onClose={() => {}}
        onRefresh={() => {}}
        onLoadMore={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onRetry={() => {}}
        onViewResult={() => {}}
        onOpenResultDocument={() => {}}
      />
    );

    expect(screen.getByText(/距最近更新/)).not.toBeNull();
    expect(screen.queryByText(/当前阶段已持续/)).toBeNull();
  });

});


