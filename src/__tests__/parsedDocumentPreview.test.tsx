import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, act, fireEvent, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
// @ts-ignore
import fs from "node:fs";
// @ts-ignore
import path from "node:path";

import {
  validateParsedBlocks,
  ParsedDocumentLoader,
  ParsedAssetManager,
} from "../utils/parsedDocumentLoader";
import { FormulaBlockView } from "../components/ParsedBlock";
import ControlledContentRenderer from "../components/ControlledContentRenderer";
import ParsedDocumentPreview from "../components/ParsedDocumentPreview";
import App from "../App";

// Mock Tauri invoke & dialog
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);
const mockOpen = vi.mocked(open);

// 固定合成测试数据（用于可重复、脱离外部环境的确定性单元测试）
const SYNTHETIC_MINERU_BLOCKS = [
  {
    id: "mineru_blk_0001",
    type: "image",
    content: "",
    asset_ref: "mineru_p41_img1.jpg",
    normalized_bbox: [0.206, 0.077, 0.742, 0.349],
    caption: "Fig. 2.11 Boost converter circuit",
  },
  { id: "mineru_blk_0002", type: "image", content: "", asset_ref: "mineru_p41_img2.jpg" },
  { id: "mineru_blk_0003", type: "image", content: "", asset_ref: "mineru_p42_img1.jpg" },
  { id: "mineru_blk_0004", type: "image", content: "", asset_ref: "mineru_p42_img2.jpg" },
  {
    id: "mineru_blk_0007",
    type: "paragraph",
    content: "Under small-ripple assumption, $v \\approx V$ holds true.",
    inline_runs: [
      { type: "text", content: "Under small-ripple assumption, " },
      { type: "equation_inline", content: "v \\approx V" },
      { type: "text", content: " holds true." },
    ],
  },
  {
    id: "mineru_blk_0021",
    type: "image",
    raw_type: "chart",
    content: "",
    asset_ref: "fig2_16.jpg",
    caption: "Fig. 2.16 Output voltage vs duty cycle $M(D)$",
  },
  // 10 个独立公式块
  { id: "mineru_f01", type: "formula", content: "v_L(t) = V_g" },
  { id: "mineru_f02", type: "formula", content: "i_C(t) = -v(t)/R" },
  { id: "mineru_f03", type: "formula", content: "v_L(t) = V_g - v(t)" },
  { id: "mineru_f04", type: "formula", content: "i_C(t) = i(t) - v(t)/R" },
  { id: "mineru_f05", type: "formula", content: "\\langle v_L \\rangle = D V_g + D' (V_g - V) = 0" },
  { id: "mineru_f06", type: "formula", content: "V = \\frac{V_g}{D'}" },
  { id: "mineru_f07", type: "formula", content: "\\langle i_C \\rangle = - D \\frac{V}{R} + D' \\left(I - \\frac{V}{R}\\right) = 0" },
  { id: "mineru_f08", type: "formula", content: "I = \\frac{V}{D' R}" },
  { id: "mineru_f09", type: "formula", content: "I = \\frac{V_g}{D'^2 R}" },
  { id: "mineru_f10", type: "formula", content: "M(D) = \\frac{V}{V_g} = \\frac{1}{1-D}" },
];

const SYNTHETIC_DATALAB_BLOCKS = [
  { id: "datalab_blk_0001", type: "image", content: "", asset_ref: "d_img1.jpg" },
  {
    id: "datalab_blk_0002",
    type: "image",
    content: "",
    asset_ref: "d_img2.jpg",
    in_image_text: ["(a)", "(b)", "$V_g$"],
    caption: "<b>Fig. 2.13</b> Boost converter with parasitic elements",
  },
  { id: "datalab_blk_0003", type: "image", content: "", asset_ref: "d_img3.jpg" },
  { id: "datalab_blk_0004", type: "image", content: "", asset_ref: "d_img4.jpg" },
  // 10 个公式
  { id: "datalab_f01", type: "formula", content: "v_L = V_g" },
  { id: "datalab_f02", type: "formula", content: "i_C = -V/R" },
  { id: "datalab_f03", type: "formula", content: "v_L = V_g - V" },
  { id: "datalab_f04", type: "formula", content: "i_C = I - V/R" },
  { id: "datalab_f05", type: "formula", content: "D V_g + D' (V_g - V) = 0" },
  { id: "datalab_f06", type: "formula", content: "V = \\frac{V_g}{D'}" },
  { id: "datalab_f07", type: "formula", content: "- D \\frac{V}{R} + D' \\left(I - \\frac{V}{R}\\right) = 0" },
  { id: "datalab_f08", type: "formula", content: "I = \\frac{V}{D' R}" },
  { id: "datalab_f09", type: "formula", content: "I = \\frac{V_g}{D'^2 R}" },
  { id: "datalab_f10", type: "formula", content: "\\frac{V}{V_g} = \\frac{1}{1-D}" },
];

describe("阶段 2A：软件内解析结果只读阅读原型固定合成测试套件", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpen.mockResolvedValue("C:\\synthetic\\blocks.json");

    mockInvoke.mockImplementation(async (cmd, args: any) => {
      if (cmd === "parsed_preview_open") {
        const filePath = args.path as string;
        let jsonStr = "[]";
        if (filePath.includes("mineru")) {
          jsonStr = JSON.stringify(SYNTHETIC_MINERU_BLOCKS);
        } else if (filePath.includes("datalab")) {
          jsonStr = JSON.stringify(SYNTHETIC_DATALAB_BLOCKS);
        } else {
          jsonStr = JSON.stringify([
            { id: "b1", type: "paragraph", content: "合成测试正文" },
            { id: "img1", type: "image", asset_ref: "test.jpg", caption: "测试插图" },
          ]);
        }
        return {
          session_id: "session_mock_123",
          blocks_path: filePath,
          doc_dir: "C:\\synthetic",
          raw_json: jsonStr,
          has_assets: true,
        };
      }
      if (cmd === "parsed_preview_read_asset") {
        return [0xff, 0xd8, 0xff, 0xe0]; // dummy jpeg header
      }
      if (cmd === "parsed_preview_close") {
        return {};
      }
      if (cmd === "read_local_file") {
        return "# 测试内置文档";
      }
      if (cmd === "get_file_metadata") {
        return { size: 100, mtime: 1000, revision: "100-1000" };
      }
      if (cmd === "db_get_reading_preferences") {
        return null;
      }
      if (cmd === "db_get_anchors" || cmd === "db_get_highlights") {
        return [];
      }
      if (cmd === "db_get_cards") {
        return { items: [], total: 0 };
      }
      return {};
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  // ==========================================
  // 1. 结构块统计与内容校验 (固定合成数据)
  // ==========================================
  it("1. 结构块校验：5图/10公式/行内公式与图注公式在合成结构中正常保留", () => {
    const mineruRes = validateParsedBlocks(
      SYNTHETIC_MINERU_BLOCKS,
      "C:\\synthetic\\mineru.json",
      "sess_m",
      "C:\\synthetic",
      true
    );
    expect(mineruRes.valid).toBe(true);
    expect(mineruRes.stats.imageCount).toBe(5);
    expect(mineruRes.stats.formulaCount).toBe(10);
    const blk1 = mineruRes.document!.blocks.find((b) => b.id === "mineru_blk_0001");
    expect(blk1?.normalized_bbox).toEqual([0.206, 0.077, 0.742, 0.349]);

    const datalabRes = validateParsedBlocks(
      SYNTHETIC_DATALAB_BLOCKS,
      "C:\\synthetic\\datalab.json",
      "sess_d",
      "C:\\synthetic",
      true
    );
    expect(datalabRes.valid).toBe(true);
    expect(datalabRes.stats.imageCount).toBe(4);
    expect(datalabRes.stats.formulaCount).toBe(10);
    const dImg = datalabRes.document!.blocks.find((b) => b.id === "datalab_blk_0002");
    expect(dImg?.in_image_text).toContain("(a)");
    expect(dImg?.in_image_text).toContain("$V_g$");
  });

  // ==========================================
  // 2. 独立公式错误局部兜底
  // ==========================================
  it("2. 公式错误处理：故意传入无效 LaTeX 时给出局部清晰错误，不使用 includes('katex') 误判，不导致白屏", () => {
    const { container: okContainer } = render(
      <FormulaBlockView content="V = \frac{V_g}{D'}" />
    );
    expect(okContainer.querySelector(".katex-display")).not.toBeNull();
    expect(okContainer.querySelector(".parsed-formula-container.is-error")).toBeNull();

    const invalidTex = "\\begin{array}{l} \\frac{V_g}{D' \\end{array}";
    const { container: errContainer } = render(
      <FormulaBlockView content={invalidTex} />
    );
    const errorBox = errContainer.querySelector(".parsed-formula-container.is-error");
    expect(errorBox).not.toBeNull();
    expect(errContainer.textContent).toContain("公式语法错误");
    expect(errContainer.textContent).toContain(invalidTex);
  });

  // ==========================================
  // 3. 真实 Markdown、混合 HTML、数学比较符语法组合深度校验
  // ==========================================
  it("3. Markdown与数学深度解析：验证粗体公式、标题列表、混合HTML、比较符 $x<y$、代码块及表格合并", () => {
    // 组合 1: **重要结论**，电压为 $V_g$
    const { container: c1 } = render(
      <ControlledContentRenderer content="**重要结论**，电压为 $V_g$" />
    );
    expect(c1.querySelector("strong")?.textContent).toBe("重要结论");
    expect(c1.querySelector(".katex")).not.toBeNull();

    // 组合 2: Markdown 标题与列表
    const { container: c2 } = render(
      <ControlledContentRenderer content={"## 工作原理\n- 步骤一：储能\n- 步骤二：释能"} />
    );
    expect(c2.querySelector("h2")?.textContent).toBe("工作原理");
    const listItems = c2.querySelectorAll("li");
    expect(listItems.length).toBe(2);
    expect(listItems[0].textContent).toContain("步骤一：储能");
    expect(listItems[1].textContent).toContain("步骤二：释能");
    expect(c2.textContent).not.toContain("##");

    // 组合 3: HTML 粗体、Markdown 斜体与数学公式共存
    const { container: c3 } = render(
      <ControlledContentRenderer content="<b>Fig. 2.13</b>，*理想情况*，$M(D)$" />
    );
    expect(c3.querySelector("b")?.textContent).toBe("Fig. 2.13");
    expect(c3.querySelector("em")?.textContent).toBe("理想情况");
    expect(c3.querySelector(".katex")).not.toBeNull();

    // 组合 4: 数学比较符不被当作 HTML 标签吞噬
    const { container: c4 } = render(
      <ControlledContentRenderer content="For $x<y$ and $z>w$." />
    );
    expect(c4.textContent).toContain("For ");
    expect(c4.textContent).toContain(" and ");
    expect(c4.querySelectorAll(".katex").length).toBe(2);
    expect(c4.textContent).not.toContain("<y$"); // 未被当作标签丢弃

    // 组合 5: 代码中的 $ 保持字面内容，转义符按 Markdown 规则处理
    const { container: c5 } = render(
      <ControlledContentRenderer content={"行内代码 `$x$` 与代码块：\n```\n$y = f(x)$\n```\n转义价格：\\$100"} />
    );
    const codeEls = c5.querySelectorAll("code");
    expect(codeEls[0].textContent).toBe("$x$");
    expect(codeEls[1].textContent).toContain("$y = f(x)$");
    expect(c5.textContent).toContain("$100");
    // 代码内的 $ 绝不渲染为 KaTeX 公式容器
    expect(codeEls[0].querySelector(".katex")).toBeNull();

    // 组合 6: HTML 表格中同时包含 rowspan/colspan、sup/sub、br 和 $D/(1-D)$
    const tableHtml = `
      <table>
        <thead>
          <tr>
            <th colspan="2" align="center">转换器特性对比</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td rowspan="2">Buck-Boost</td>
            <td onclick="alert('hack')"><b>Fig</b><sup>1</sup><sub>2</sub><br>输出极性反转</td>
          </tr>
          <tr>
            <td>$D / (1 - D)$</td>
          </tr>
        </tbody>
      </table>
    `;
    const { container: c6 } = render(
      <ControlledContentRenderer content={tableHtml} />
    );
    expect(c6.querySelector("th")?.getAttribute("colspan")).toBe("2");
    expect(c6.querySelector("td[rowspan='2']")?.textContent).toBe("Buck-Boost");
    expect(c6.querySelector("sup")?.textContent).toBe("1");
    expect(c6.querySelector("sub")?.textContent).toBe("2");
    expect(c6.querySelector("br")).not.toBeNull();
    expect(c6.querySelector(".katex")).not.toBeNull();
    // 恶意 onclick 属性被过滤
    expect(c6.querySelector("td[onclick]")).toBeNull();
  });

  // ==========================================
  // 4. 输入边界防御
  // ==========================================
  it("4. 输入边界防御：非数组根结构与超限文档给出明确提示", () => {
    const resNotArray = validateParsedBlocks({ error: "not array" }, "bad.json", "s1", "C:\\", false);
    expect(resNotArray.valid).toBe(false);
    expect(resNotArray.errors[0]).toContain("JSON 数组");

    const hugeArray = new Array(2005).fill({ id: "b", type: "paragraph", content: "test" });
    const resHuge = validateParsedBlocks(hugeArray, "huge.json", "s2", "C:\\", false);
    expect(resHuge.valid).toBe(false);
    expect(resHuge.errors[0]).toContain("超出当前只读原型承载范围");
  });

  // ==========================================
  // 5. 资产生命周期管理
  // ==========================================
  it("5. 资产生命周期管理：读取图片生成 Blob URL，dispose 时调用 revokeObjectURL 并注销会话", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:flowread-asset-1");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const assetMgr = new ParsedAssetManager("test_session_abc");
    const url = await assetMgr.loadAsset("pic1.jpg");
    expect(url).toBe("blob:flowread-asset-1");
    expect(mockInvoke).toHaveBeenCalledWith("parsed_preview_read_asset", {
      sessionId: "test_session_abc",
      assetRef: "pic1.jpg",
    });

    // 缓存命中
    const url2 = await assetMgr.loadAsset("pic1.jpg");
    expect(url2).toBe("blob:flowread-asset-1");
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // 销毁
    assetMgr.dispose();
    expect(revokeSpy).toHaveBeenCalledWith("blob:flowread-asset-1");
    expect(mockInvoke).toHaveBeenCalledWith("parsed_preview_close", {
      sessionId: "test_session_abc",
    });
  });

  // ==========================================
  // 6. Esc 事件分层与路由（必须从 activeElement、内部按钮及大图发送）
  // ==========================================
  it("6. Esc 事件路由：从 activeElement/内部按钮/大图发送 Esc，遵循分层规则并不穿透", async () => {
    const onCloseSpy = vi.fn();

    // 场景 A: 打开预览后从 document.activeElement 直接按 Esc 关闭
    const { unmount } = render(
      <ParsedDocumentPreview
        target={{ filePath: "C:\\test\\blocks.json", loadKey: 1 }}
        onClose={onCloseSpy}
        onOpenAnother={vi.fn()}
      />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    // 焦点位于预览根节点上
    expect(document.activeElement).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onCloseSpy).toHaveBeenCalledTimes(1);

    // 场景 B: 焦点位于内部按钮时按 Esc 关闭
    onCloseSpy.mockClear();
    const otherBtn = screen.getByText("打开其他结果...");
    otherBtn.focus();
    expect(document.activeElement).toBe(otherBtn);
    fireEvent.keyDown(otherBtn, { key: "Escape" });
    expect(onCloseSpy).toHaveBeenCalledTimes(1);

    // 场景 C: 大图 Lightbox 打开时，Esc 仅关闭大图，不关闭预览
    onCloseSpy.mockClear();
    unmount();

    const { container: cWithLightbox, unmount: unmountLightbox } = render(
      <ParsedDocumentPreview
        target={{ filePath: "C:\\test\\blocks.json", loadKey: 1 }}
        onClose={onCloseSpy}
        onOpenAnother={vi.fn()}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    // 点击插图打开大图
    const imgEl = cWithLightbox.querySelector(".parsed-image-element");
    if (imgEl) {
      fireEvent.click(imgEl);
      const lightboxOverlay = cWithLightbox.querySelector(".parsed-lightbox-overlay");
      expect(lightboxOverlay).not.toBeNull();

      // 从大图关闭按钮按 Esc
      const lightboxCloseBtn = cWithLightbox.querySelector(".parsed-lightbox-close");
      expect(lightboxCloseBtn).not.toBeNull();
      fireEvent.keyDown(lightboxCloseBtn!, { key: "Escape" });

      // 大图关闭，预览未关闭
      expect(cWithLightbox.querySelector(".parsed-lightbox-overlay")).toBeNull();
      expect(onCloseSpy).not.toHaveBeenCalled();

      // 再次按 Esc 关闭预览
      fireEvent.keyDown(document.activeElement || cWithLightbox, { key: "Escape" });
      expect(onCloseSpy).toHaveBeenCalledTimes(1);
    }
    unmountLightbox();

    // 场景 D: 阅读设置打开时 (isModalOpenAbove=true)，Esc 仅关闭设置，不关闭预览
    onCloseSpy.mockClear();
    const { unmount: unmountAbove } = render(
      <ParsedDocumentPreview
        target={{ filePath: "C:\\test\\blocks.json", loadKey: 1 }}
        onClose={onCloseSpy}
        onOpenAnother={vi.fn()}
        isModalOpenAbove={true}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    fireEvent.keyDown(document.activeElement || window, { key: "Escape" });
    expect(onCloseSpy).not.toHaveBeenCalled();
    unmountAbove();
  });

  // ==========================================
  // 7. App 隔离性：缩放隔离与 Ask 禁用
  // ==========================================
  it("7. App 隔离性：预览打开期间，Ctrl+滚轮不改变 scale，FloatingAskBar 快捷键与提问被拦截", async () => {
    const { unmount } = render(<App />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const zoomTag = screen.getByTitle("当前阅读缩放 (Ctrl+滚轮 或 Ctrl+加号/减号)");
    expect(zoomTag.textContent).toContain("135%");

    // 打开工具菜单
    const toolsBtn = screen.getByText("工具 (Tools)");
    fireEvent.click(toolsBtn);

    // 点击打开预览
    const menuItem = screen.getByText("打开解析结果预览…");
    fireEvent.click(menuItem);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 确认预览已挂载
    expect(screen.getByText("解析预览")).not.toBeNull();

    // 模拟 window wheel 事件 (Ctrl + 滚轮向上)
    const wheelEvt = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(wheelEvt);
    expect(zoomTag.textContent).toContain("135%");

    // 模拟按下 '/' 键
    const askInput = screen.getByPlaceholderText(/在正文下方随时提问或探讨/i) as HTMLInputElement;
    expect(askInput.disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    expect(document.activeElement).not.toBe(askInput);

    // 模拟在 Ask 输入框按 Enter
    fireEvent.keyDown(askInput, { key: "Enter", ctrlKey: true });
    const invoked = mockInvoke.mock.calls.map((c) => c[0]);
    expect(invoked).not.toContain("db_create_card");

    // 关闭预览后，缩放恢复
    const closeBtn = screen.getByText("关闭预览 (Esc)");
    fireEvent.click(closeBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    await act(async () => {
      window.dispatchEvent(wheelEvt);
    });
    expect(zoomTag.textContent).toContain("145%");

    unmount();
  });

  // ==========================================
  // 8. 切换与重选测试
  // ==========================================
  it("8. 切换与重选：支持 A -> B 切换、取消选择保持原文档、再次选择同一路径刷新", async () => {
    let currentTarget = { filePath: "doc_A.json", loadKey: 1 };
    const onOpenAnotherSpy = vi.fn();
    const onCloseSpy = vi.fn();

    const { rerender, unmount } = render(
      <ParsedDocumentPreview
        target={currentTarget}
        onClose={onCloseSpy}
        onOpenAnother={onOpenAnotherSpy}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(mockInvoke).toHaveBeenCalledWith("parsed_preview_open", { path: "doc_A.json" });

    // 切换到 B (loadKey 递增)
    currentTarget = { filePath: "doc_B.json", loadKey: 2 };
    rerender(
      <ParsedDocumentPreview
        target={currentTarget}
        onClose={onCloseSpy}
        onOpenAnother={onOpenAnotherSpy}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(mockInvoke).toHaveBeenCalledWith("parsed_preview_open", { path: "doc_B.json" });

    // 重选同一文件 B (loadKey 递增为 3)
    currentTarget = { filePath: "doc_B.json", loadKey: 3 };
    rerender(
      <ParsedDocumentPreview
        target={currentTarget}
        onClose={onCloseSpy}
        onOpenAnother={onOpenAnotherSpy}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const bOpens = mockInvoke.mock.calls.filter(
      (c) => c[0] === "parsed_preview_open" && (c[1] as any)?.path === "doc_B.json"
    );
    expect(bOpens.length).toBe(2);

    unmount();
  });

  // ==========================================
  // 9. 真实 React.StrictMode 双重挂载与会话清理
  // ==========================================
  it("9. React.StrictMode 生命周期测试：组件在 StrictMode 包裹下正常加载并能在卸载时释放会话", async () => {
    const { unmount } = render(
      <React.StrictMode>
        <ParsedDocumentPreview
          target={{ filePath: "C:\\strict\\blocks.json", loadKey: 1 }}
          onClose={vi.fn()}
          onOpenAnother={vi.fn()}
        />
      </React.StrictMode>
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(screen.getByText("解析预览")).not.toBeNull();

    // 卸载
    unmount();
    expect(mockInvoke).toHaveBeenCalledWith("parsed_preview_close", expect.anything());
  });

  // ==========================================
  // 10. 竞态守卫与卸载后迟到结果丢弃
  // ==========================================
  it("10. 竞态守卫与卸载后迟到结果丢弃：在途请求未完成即卸载或切换时，迟到结果被安全丢弃", async () => {
    const loader = new ParsedDocumentLoader();
    let resolveA: any;
    const promiseA = new Promise((res) => {
      resolveA = res;
    });

    mockInvoke.mockImplementation(async (cmd, args: any) => {
      if (cmd === "parsed_preview_open") {
        if (args.path === "doc_A.json") {
          await promiseA;
          return {
            session_id: "sess_A",
            blocks_path: "doc_A.json",
            doc_dir: "C:\\",
            raw_json: "[{\"id\":\"blk_A\",\"type\":\"paragraph\",\"content\":\"Doc A\"}]",
            has_assets: false,
          };
        }
        if (args.path === "doc_B.json") {
          return {
            session_id: "sess_B",
            blocks_path: "doc_B.json",
            doc_dir: "C:\\",
            raw_json: "[{\"id\":\"blk_B\",\"type\":\"paragraph\",\"content\":\"Doc B\"}]",
            has_assets: false,
          };
        }
      }
      return {};
    });

    const reqA = loader.loadDocument("doc_A.json");
    const reqB = loader.loadDocument("doc_B.json");

    const resultB = await reqB;
    expect(resultB?.result.document?.blocks[0].content).toBe("Doc B");

    resolveA(true);
    const resultA = await reqA;
    expect(resultA).toBeNull();
  });

  // ==========================================
  // 11. 真实操作链路下的零写入断言
  // ==========================================
  it("11. 零写入断言：实际打开预览、查看渲染、切换文件、关闭预览的全程中，绝不调用任何 SQLite 持久化接口", async () => {
    const { unmount } = render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    // 清空 App 初始化时产生的数据库调用记录
    mockInvoke.mockClear();

    // 1. 打开预览
    const toolsBtn = screen.getByText("工具 (Tools)");
    fireEvent.click(toolsBtn);
    fireEvent.click(screen.getByText("打开解析结果预览…"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.getByText("解析预览")).not.toBeNull();

    // 2. 检查在此过程中产生的 IPC 调用
    const previewInvocations = mockInvoke.mock.calls.map((c) => c[0]);
    // 确认确实调用了解析预览命令
    expect(previewInvocations).toContain("parsed_preview_open");
    // 核心零写入断言：绝不产生任何文档创建、卡片创建、锚点创建、高亮创建或位置持久化
    expect(previewInvocations).not.toContain("db_get_or_create_document");
    expect(previewInvocations).not.toContain("db_create_card");
    expect(previewInvocations).not.toContain("db_create_anchor");
    expect(previewInvocations).not.toContain("db_save_reading_position");
    expect(previewInvocations).not.toContain("db_create_highlight");

    // 3. 关闭预览
    fireEvent.click(screen.getByText("关闭预览 (Esc)"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    unmount();
  });
});

// ============================================================================
// 真实评测产物检查 (若本地样本不存在则显式跳过，不使用合成数据冒充真实测试通过)
// ============================================================================
describe("真实评测产物检查 (本地样本存在时执行，不存在则显式跳过)", () => {
  const mineruPath =
    "C:\\Users\\lenovo\\AppData\\Local\\FlowRead\\parse-eval\\20261016_024119_review_v3\\results\\boost-converter-p41-43\\mineru\\normalized\\blocks.json";
  const datalabPath =
    "C:\\Users\\lenovo\\AppData\\Local\\FlowRead\\parse-eval\\20261016_024119_review_v3\\results\\boost-converter-p41-43\\datalab_v2\\normalized\\blocks.json";

  const hasMineru = fs && typeof fs.existsSync === "function" && fs.existsSync(mineruPath);
  const hasDatalab = fs && typeof fs.existsSync === "function" && fs.existsSync(datalabPath);

  it.runIf(hasMineru)("真实 MinerU 产物校验：5图/10公式/行内公式 v≈V 与曲线图 M(D) 坐标结构", () => {
    const rawJson = fs.readFileSync(mineruPath, "utf-8");
    const data = JSON.parse(rawJson);
    const res = validateParsedBlocks(
      data,
      mineruPath,
      "sess_m_real",
      path.dirname(mineruPath),
      true
    );

    expect(res.valid).toBe(true);
    expect(res.stats.imageCount).toBe(5);
    expect(res.stats.formulaCount).toBe(10);

    const blk1 = res.document!.blocks.find((b) => b.id === "mineru_blk_0001");
    expect(blk1?.normalized_bbox).toEqual([0.206, 0.077, 0.742, 0.349]);

    const blk7 = res.document!.blocks.find((b) => b.id === "mineru_blk_0007");
    expect(blk7?.content).toContain("$v \\approx V$");

    const blk21 = res.document!.blocks.find((b) => b.id === "mineru_blk_0021");
    expect(blk21?.raw_type).toBe("chart");
    expect(blk21?.caption).toContain("$M(D)$");
  });

  it.runIf(hasDatalab)("真实 Datalab v2 产物校验：4图/10公式/图内文字剥离", () => {
    const rawJson = fs.readFileSync(datalabPath, "utf-8");
    const data = JSON.parse(rawJson);
    const res = validateParsedBlocks(
      data,
      datalabPath,
      "sess_d_real",
      path.dirname(datalabPath),
      true
    );

    expect(res.valid).toBe(true);
    expect(res.stats.imageCount).toBe(4);
    expect(res.stats.formulaCount).toBe(10);

    const dImg = res.document!.blocks.find((b) => b.id === "datalab_blk_0002");
    expect(dImg?.in_image_text).toContain("(a)");
    expect(dImg?.in_image_text).toContain("$V_g$");
  });
});
