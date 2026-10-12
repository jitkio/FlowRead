import React, { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SelectionData, SelectionAction } from "./AIPanel";

export interface ReaderAreaProps {
  /** 划词并选择指令后的回调函数，向上传递选中的纯文本与指令 */
  onSelect: (data: SelectionData) => void;
  /** 点击加载本地书籍成功后的可选通知回调 */
  onLoadLocalBook?: (content: string) => void;
  /** 切换至 PDF 极简流式阅读器的回调通知 */
  onOpenPdf?: (filePath?: string) => void;
  /** 当前文档元信息变更通知回调 */
  onDocInfoChange?: (info: { title: string; paragraphs: number }) => void;
  /** 外部传入的文件路径（若提供则自动从本地载入） */
  filePath?: string | null;
  /** 视口缩放比例（默认 1） */
  scale?: number;
}

/** 初始测试长文本 */
const DEFAULT_BOOK_CONTENT = `阅读不仅是一种获取信息的机械过程，更是一场思想与灵魂的幽邃漫游。在如今信息激流奔涌的屏幕世代，我们习惯了被碎片化的推文、跳跃的超链接和刺目的冷光所裹挟，原本属于文字的那份温润与静谧，似乎正一点一滴地流失。

真正具有启发性的阅读，往往需要读者进入一种“心流”（Flow）状态。在此状态下，时间感逐渐消融，思维随着铅字排列的韵律徐徐展开。正如卡尔·诺顿在《深度工作》中所言，深度沉浸不仅能锻造更为深刻的认知结构，也是抵御认知过载与精神焦虑的坚固盾牌。

“书籍是人类用来将思维跨越时空阻隔而传递的至简之器。静默地面对一页纸，便是与世界上最深邃的心智展开最私密的对谈。”

传统的纸质书页之所以让人沉醉，不仅在于油墨的芬芳，更在于其纯粹无扰的环境。它不会在阅读到最动人之处弹出一则推送，也不会用复杂的菜单栏割裂你的凝视。为了在现代应用中重塑这种体验，我们引入了类似“Gloss”风格的极简排版——用温暖柔和的暖纸底色消解眼睛的疲惫，用节制有度的字距行高还给文字应有的呼吸空间。

与此同时，数字阅读也不应仅仅是对纸张的生硬模仿。它真正的魅力在于“延伸”与“赋能”。当你偶遇一个生僻的概念、一段晦涩的隐喻，或者一段跨语言的典故时，你不必离开当前的阅读语境，去四处搜索繁琐的字典词条。

这就是“划词伴读”诞生的意义。只需要用鼠标轻轻划选你感兴趣或疑惑的语句，右侧的 AI 助手便会即刻捕获这一段落。它不是冷冰冰的外部搜索引擎，而是一位随时坐定身旁的知心书童，帮助你拆解长难句、阐释文化背景、提炼核心论点，甚至与你探讨作者未尽的弦外之音。

这种即时、平滑、无缝的交互，让阅读从被动的“接受”变成了主动的“对话”。在这个人机共读的新维度里，复杂的哲学文本不再显得高不可攀，冗长的学术专著也变得层层透彻。

我们每天被成千上万的信息片段轰炸，但信息绝不等于知识，更不等于智慧。唯有经过慢速咀嚼、深度沉思与结构化梳理的文字，才能真正融入你的心智模型，成为支撑你洞察世界的基石。

关掉浮躁的弹窗，让视线沉落在温润的字里行间。在流动的文字中漫步，让思考重新找回它本有的深度与宁静。`;

export default function ReaderArea({
  onSelect,
  onLoadLocalBook,
  onOpenPdf: _onOpenPdf,
  onDocInfoChange,
  filePath,
  scale = 1,
}: ReaderAreaProps): React.JSX.Element {
  // 滚动容器与物理引擎关键 Ref
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const headerWrapperRef = useRef<HTMLDivElement>(null);

  // 动力学平滑滚动的核心状态变量
  const targetYRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);
  const isLerpRunningRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);

  // 滑块是否处于拖拽状态
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [headerHeight, setHeaderHeight] = useState<number>(0);

  // 划词悬浮菜单坐标与当前暂存文本
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [currentSelectedText, setCurrentSelectedText] = useState<string>("");
  const [customPrompt, setCustomPrompt] = useState<string>("");

  // 动态正文内容状态，初始值为预置测试长文
  const [bookContent, setBookContent] = useState<string>(DEFAULT_BOOK_CONTENT);
  const [currentBookTitle, setCurrentBookTitle] = useState<string>(
    "在流动中沉思：重新发现数字时代的深度阅读之美"
  );

  /**
   * 性能优化：按行拆分为段落数组
   */
  const paragraphs = useMemo<string[]>(() => {
    if (!bookContent) return [];
    const lines = bookContent.split(/\r?\n/);
    const result: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length > 0) {
        result.push(line);
      }
    }
    return result;
  }, [bookContent]);

  // 当书籍标题或段落数变化时通知父级全局状态栏
  useEffect(() => {
    onDocInfoChange?.({
      title: currentBookTitle,
      paragraphs: paragraphs.length,
    });
  }, [currentBookTitle, paragraphs.length, onDocInfoChange]);

  // 当外部传入新文件路径时自动通过 Rust 接口加载
  useEffect(() => {
    if (!filePath) return;
    const loadFromPath = async (): Promise<void> => {
      try {
        const content = await invoke<string>("read_local_file", { filePath });
        setBookContent(content);
        const fileName = filePath.split(/[/\\]/).pop();
        if (fileName) {
          setCurrentBookTitle(fileName);
        }
        if (onLoadLocalBook) {
          onLoadLocalBook(content);
        }
        targetYRef.current = 0;
        currentYRef.current = 0;
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = 0;
        }
        setMenuPosition(null);
        setCustomPrompt("");
        updateThumbPosition();
      } catch (error) {
        console.error("[FlowRead] 加载指定书籍失败:", error);
      }
    };
    void loadFromPath();
  }, [filePath, onLoadLocalBook]);

  // 容器可用宽度稳定缓存
  const containerWidthRef = useRef<number>(644);

  useEffect(() => {
    if (!scrollContainerRef.current) return;

    const updateContainerWidth = (): void => {
      if (scrollContainerRef.current) {
        const rawWidth = scrollContainerRef.current.clientWidth - 80;
        containerWidthRef.current = Math.min(Math.max(280, rawWidth), 644);
      }
    };

    updateContainerWidth();

    const resizeObserver = new ResizeObserver(updateContainerWidth);
    resizeObserver.observe(scrollContainerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // 动态测量 Header 容器高度，使虚拟滚动与顶部 Header 自然衔接
  useEffect(() => {
    if (!headerWrapperRef.current) return;

    const updateHeaderHeight = (): void => {
      if (headerWrapperRef.current) {
        setHeaderHeight(headerWrapperRef.current.offsetHeight);
      }
    };

    updateHeaderHeight();

    const resizeObserver = new ResizeObserver(updateHeaderHeight);
    resizeObserver.observe(headerWrapperRef.current);
    return () => resizeObserver.disconnect();
  }, [currentBookTitle, paragraphs.length]);

  /**
   * 初始化虚拟滚动配置优化：
   * - count: 总段落数
   * - getScrollElement: 指向外部滚动容器
   * - estimateSize: 纯变量读取的高精度段落预估，零 reflow 零抖动
   * - overscan: 80 段视口外充足缓冲
   * - scrollMargin: 头部占位偏移量
   */
  const virtualizer = useVirtualizer({
    count: paragraphs.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index: number) => {
      const text = paragraphs[index] || "";
      if (text.length === 0) return 34;

      const charsPerLine = Math.max(1, Math.floor(containerWidthRef.current / 18));
      const lines = Math.ceil(text.length / charsPerLine);
      return Math.max(34, lines * 30 + 24);
    },
    overscan: 80,
    scrollMargin: headerHeight,
  });

  const totalContentSize = virtualizer.getTotalSize();

  /**
   * 同步更新自定义滑块的几何高度与垂直位移
   */
  const updateThumbPosition = useCallback((): void => {
    const thumb = thumbRef.current;
    const container = scrollContainerRef.current;
    if (!thumb || !container) return;

    const cHeight = container.clientHeight;
    const maxScroll = Math.max(0, totalContentSize - cHeight);

    if (maxScroll <= 0) {
      thumb.style.display = "none";
      return;
    }

    thumb.style.display = "block";
    const thumbHeight = Math.max(40, (cHeight / totalContentSize) * cHeight);
    const trackTravel = Math.max(1, cHeight - thumbHeight);
    const progress = currentYRef.current / maxScroll;
    const thumbTop = Math.max(0, Math.min(trackTravel, progress * trackTravel));

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }, [totalContentSize]);

  /**
   * 动力学平滑滚动 (Kinetic/Lerp Scrolling) 核心循环
   * 线性插值公式：currentY += (targetY - currentY) * 0.12
   */
  const startLerpLoop = useCallback((): void => {
    if (isLerpRunningRef.current) return;
    isLerpRunningRef.current = true;

    const tick = (): void => {
      const diff = targetYRef.current - currentYRef.current;

      if (Math.abs(diff) < 0.5) {
        currentYRef.current = targetYRef.current;
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = currentYRef.current;
        }
        updateThumbPosition();
        isLerpRunningRef.current = false;
        rafIdRef.current = null;
        return;
      }

      currentYRef.current += diff * 0.12;

      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = currentYRef.current;
      }

      updateThumbPosition();
      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);
  }, [updateThumbPosition]);

  // 组件卸载时释放 rAF
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // 尺寸或总高度变动时，实时校准滑块尺寸与位移
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const maxScroll = Math.max(0, totalContentSize - container.clientHeight);
    targetYRef.current = Math.min(targetYRef.current, maxScroll);
    currentYRef.current = Math.min(currentYRef.current, maxScroll);
    updateThumbPosition();
  }, [totalContentSize, updateThumbPosition]);

  /**
   * 拦截原生鼠标滚轮事件 (wheel)，将其增量累加进 targetYRef 触发动力学平滑插值
   */
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const cHeight = container.clientHeight;
      const maxScroll = Math.max(0, totalContentSize - cHeight);

      targetYRef.current = Math.max(
        0,
        Math.min(maxScroll, targetYRef.current + e.deltaY)
      );

      startLerpLoop();
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
    };
  }, [totalContentSize, startLerpLoop]);

  /**
   * 自定义滑块拖拽事件处理
   */
  const handleThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();

    const container = scrollContainerRef.current;
    if (!container) return;

    const startClientY = e.clientY;
    const startTarget = targetYRef.current;
    const cHeight = container.clientHeight;
    const maxScroll = Math.max(0, totalContentSize - cHeight);
    const thumbHeight = Math.max(40, (cHeight / totalContentSize) * cHeight);
    const trackTravel = Math.max(1, cHeight - thumbHeight);

    setIsDragging(true);

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const deltaY = moveEvent.clientY - startClientY;
      const scrollDelta = (deltaY / trackTravel) * maxScroll;

      targetYRef.current = Math.max(
        0,
        Math.min(maxScroll, startTarget + scrollDelta)
      );

      startLerpLoop();
    };

    const onPointerUp = (): void => {
      setIsDragging(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  /**
   * 点击滚动槽空白区域：平滑快进至点击位置
   */
  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const track = trackRef.current;
    const container = scrollContainerRef.current;
    if (!track || !container) return;

    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const cHeight = container.clientHeight;
    const maxScroll = Math.max(0, totalContentSize - cHeight);
    const thumbHeight = Math.max(40, (cHeight / totalContentSize) * cHeight);
    const trackTravel = Math.max(1, cHeight - thumbHeight);

    const targetPercent = Math.max(
      0,
      Math.min(1, (clickY - thumbHeight / 2) / trackTravel)
    );
    targetYRef.current = targetPercent * maxScroll;
    startLerpLoop();
  };

  /**
   * 划选鼠标松开事件处理：
   * 捕获选区范围物理坐标，弹出悬浮指令菜单
   */
  const handleMouseUp = (): void => {
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setMenuPosition(null);
        setCustomPrompt("");
        return;
      }

      const text = selection.toString().trim();
      if (text.length === 0) {
        setMenuPosition(null);
        setCustomPrompt("");
        return;
      }

      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0) {
          setCurrentSelectedText(text);

          // 坐标计算：悬浮在选区正上方（如果太接近顶部则降至选区下方展示）
          const showBelow = rect.top < 60;
          const top = showBelow ? rect.bottom + 10 : rect.top - 10;
          const left = rect.left + rect.width / 2;

          setMenuPosition({
            top,
            left,
          });
        }
      } catch (err) {
        console.error("[FlowRead] 无法捕获选区边界:", err);
      }
    }, 10);
  };

  /**
   * 监听全局点击：点击非菜单区域自动隐藏悬浮菜单
   */
  const handleContainerMouseDown = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement;
    if (!target.closest(".selection-toolbar")) {
      setMenuPosition(null);
      setCustomPrompt("");
    }
  };

  /**
   * 悬浮菜单按钮动作点击
   */
  const handleActionClick = (action: SelectionAction, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (currentSelectedText) {
      onSelect({
        type: "text",
        text: currentSelectedText,
        action,
      });
    }
    setCustomPrompt("");
    setMenuPosition(null);
  };

  return (
    <main
      className="reader-container"
      onMouseUp={handleMouseUp}
      onMouseDown={handleContainerMouseDown}
    >
      {/* 动力学平滑滚动的视口容器 */}
      <div className="reader-scroll-viewport" ref={scrollContainerRef}>
        <article className="reader-content" style={{ zoom: scale }}>
          {/* 顶部标题区（测量 offsetHeight 作为 scrollMargin） */}
          <div ref={headerWrapperRef}>
            <header className="article-header">
              <h1 className="article-title">{currentBookTitle}</h1>
              <div className="article-meta">
                <span>FlowRead 本地书库</span>
                <span>·</span>
                <span>总段落：{paragraphs.length} 段</span>
                <span>·</span>
                <span>划选文字即享 AI 深度伴读</span>
              </div>
            </header>
          </div>

          {/* 虚拟滚动占位与动态段落渲染容器 */}
          <div
            className="virtual-article-body"
            style={{
              height: `${totalContentSize}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const paragraph = paragraphs[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="virtual-paragraph-item"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start - headerHeight}px)`,
                  }}
                >
                  <p>{paragraph}</p>
                </div>
              );
            })}
          </div>
        </article>
      </div>

      {/* 自定义动力学滑块轨槽与滑块 */}
      <div
        className="custom-scrollbar-track"
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
      >
        <div
          ref={thumbRef}
          className={`custom-scrollbar-thumb ${isDragging ? "is-dragging" : ""}`}
          onPointerDown={handleThumbPointerDown}
        />
      </div>

      {/* 划词悬浮指令菜单 (Selection Toolbar) - 带自定义输入层与极简快捷按钮 */}
      {menuPosition && (
        <div
          className="selection-toolbar"
          style={{
            top: `${menuPosition.top}px`,
            left: `${menuPosition.left}px`,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 正上方 100% 宽度极简自定义指令输入框 */}
          <div className="toolbar-input-wrapper">
            <input
              type="text"
              className="toolbar-custom-input"
              placeholder="输入自定义指令并回车..."
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customPrompt.trim()) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (currentSelectedText && onSelect) {
                    onSelect({
                      type: "text",
                      text: currentSelectedText,
                      action: "custom",
                      customPrompt: customPrompt.trim(),
                    });
                  }
                  setCustomPrompt("");
                  setMenuPosition(null);
                }
              }}
              autoFocus
            />
          </div>

          {/* 下方等宽排列快捷按钮 */}
          <div className="toolbar-buttons-row">
            <button
              type="button"
              className="toolbar-action-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => handleActionClick("translate", e)}
              title="翻译为流畅中文"
            >
              <span>翻译</span>
            </button>
            <button
              type="button"
              className="toolbar-action-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => handleActionClick("explain", e)}
              title="专业清晰解释核心机理"
            >
              <span>解释</span>
            </button>
            <button
              type="button"
              className="toolbar-action-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => handleActionClick("extract-formula", e)}
              title="严格提取 LaTeX 数学公式"
            >
              <span>提取公式</span>
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
