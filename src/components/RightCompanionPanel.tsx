import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CardRecord,
  HighlightRecord,
  CardDepth,
  DocumentRecord,
} from "../types/records";
import CompanionCardItem from "./CompanionCardItem";
import {
  apiGetCards,
  apiGetCardsByAnchorIds,
  apiGetHighlights,
  apiDeleteHighlight,
  apiExportDocumentMarkdown,
} from "../utils/recordStorage";
import { aiDispatcher } from "../utils/aiDispatcher";
import { findVisibleAnchorElement } from "../utils/sourceAnchorUtils";

export interface RightCompanionPanelProps {
  document: DocumentRecord | null;
  activeCardId: string | null;
  width?: number;
  onSelectCard: (cardId: string) => void;
  onOpenFullModal: (cardId: string) => void;
  onJumpToSource: (cardId: string, anchorId?: string) => void;
  onDeleteCard: (cardId: string) => void;
  onSendFollowUp: (cardId: string, prompt: string, depth: CardDepth) => void;
  onBottomAsk?: (prompt: string, depth: CardDepth) => void;
  hasSelection?: boolean;
  selectionExcerpt?: string;
  visibleAnchorIds: string[];
  cards: CardRecord[];
  onRefreshCards: () => void;
}

type PanelView = "following" | "records";
type RecordFilter = "all" | "qa" | "highlights" | "actions";

interface PositionedAnchorGroup {
  anchorId: string;
  cards: CardRecord[];
  naturalTop: number;
  computedTop: number;
}

export default function RightCompanionPanel({
  document: currentDoc,
  activeCardId,
  width,
  onSelectCard,
  onOpenFullModal,
  onJumpToSource,
  onDeleteCard,
  onSendFollowUp,
  visibleAnchorIds,
  cards,
  onRefreshCards,
}: RightCompanionPanelProps): React.JSX.Element {
  const [activeView, setActiveView] = useState<PanelView>("following");
  const [recordFilter, setRecordFilter] = useState<RecordFilter>("all");

  // 记录视图数据状态与复合游标分页
  const [allRecords, setAllRecords] = useState<CardRecord[]>([]);
  const [highlights, setHighlights] = useState<HighlightRecord[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [isLoadingRecords, setIsLoadingRecords] = useState<boolean>(false);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [hasMore, setHasMore] = useState<boolean>(false);

  // 异步序号管理，防止跨文档/跨筛选竞态
  const loadSeqRef = useRef<number>(0);
  const loadMoreSeqRef = useRef<number>(0);
  const currentDocRef = useRef<DocumentRecord | null>(currentDoc);
  currentDocRef.current = currentDoc;
  const recordFilterRef = useRef<RecordFilter>(recordFilter);
  recordFilterRef.current = recordFilter;

  // 记录本独立滚动容器 Ref
  const recordsScrollContainerRef = useRef<HTMLDivElement>(null);
  // 跟随视图容器 Ref
  const followingContainerRef = useRef<HTMLDivElement>(null);

  // 同一来源多卡片时的选中索引跟踪 { [anchorId]: cardIndex }
  const [selectedCardIndexByAnchor, setSelectedCardIndexByAnchor] = useState<Record<string, number>>({});

  // 跟随视图计算得到的排布卡片组
  const [positionedGroups, setPositionedGroups] = useState<PositionedAnchorGroup[]>([]);

  // 跟随缓存与记录本分页缓存彻底隔离，按需加载可见来源卡片
  const followingCacheRef = useRef<Map<string, CardRecord[]>>(new Map());
  // 区分“缓存已有部分卡片”和“该来源已完整查询”，记录已完整从数据库载入全量卡片的锚点ID
  const fullyQueriedAnchorsRef = useRef<Set<string>>(new Set());
  // 跟踪已记录在记录本中的卡片 ID，避免重复递增计数
  const syncedCardIdsRef = useRef<Set<string>>(new Set());
  // 跟踪当前文档已删除的卡片 ID，确保删除清理与计数结算绝对幂等
  const deletedCardIdsRef = useRef<Set<string>>(new Set());

  // 测量得到的实际卡片高度字典 { [anchorId]: heightPx }
  const cardHeightsRef = useRef<Map<string, number>>(new Map());
  const cardObserverRef = useRef<ResizeObserver | null>(null);

  // 加载全文档记录（第一页）- 数据库层完成精准筛选与总量统计
  const loadFirstPageRecords = useCallback(async (docId: string, filter: RecordFilter) => {
    const seq = ++loadSeqRef.current;
    // 重新加载第一页时，使所有旧分页加载更多请求失效
    loadMoreSeqRef.current++;
    setIsLoadingRecords(true);
    setIsLoadingMore(false);

    try {
      const filterParam =
        filter === "all"
          ? "all"
          : filter === "qa"
          ? "Ask"
          : filter === "actions"
          ? "actions"
          : "all";

      const [cardRes, hlRes] = await Promise.all([
        apiGetCards(docId, 50, 0, filterParam),
        apiGetHighlights(docId),
      ]);

      // 返回时校验文档、筛选和请求序号，禁止追加旧结果
      if (
        seq !== loadSeqRef.current ||
        currentDocRef.current?.id !== docId ||
        recordFilterRef.current !== filter
      ) {
        return;
      }

      const validCards = cardRes.items.filter(
        (item) => !deletedCardIdsRef.current.has(item.card_id)
      );
      for (const item of validCards) {
        syncedCardIdsRef.current.add(item.card_id);
      }

      setAllRecords(validCards);
      const deletedDiff = cardRes.items.length - validCards.length;
      setTotalCount(Math.max(0, cardRes.total - deletedDiff));
      setHasMore(cardRes.has_more);
      setHighlights(hlRes || []);
    } catch (err) {
      if (
        seq !== loadSeqRef.current ||
        currentDocRef.current?.id !== docId ||
        recordFilterRef.current !== filter
      ) {
        return;
      }
      console.warn("[RightCompanionPanel] 加载历史记录失败:", err);
    } finally {
      if (
        seq === loadSeqRef.current &&
        currentDocRef.current?.id === docId &&
        recordFilterRef.current === filter
      ) {
        setIsLoadingRecords(false);
      }
    }
  }, []);

  // 复合游标分页加载更多 (created_at + card_id)
  const loadMoreRecords = useCallback(async () => {
    if (!currentDoc || isLoadingMore || !hasMore || allRecords.length === 0) return;
    const lastItem = allRecords[allRecords.length - 1];
    if (!lastItem) return;

    const seq = ++loadMoreSeqRef.current;
    setIsLoadingMore(true);

    const reqDocId = currentDoc.id;
    const reqFilter = recordFilter;

    try {
      const filterParam =
        reqFilter === "all"
          ? "all"
          : reqFilter === "qa"
          ? "Ask"
          : reqFilter === "actions"
          ? "actions"
          : "all";

      const res = await apiGetCards(
        reqDocId,
        50,
        0,
        filterParam,
        lastItem.created_at,
        lastItem.card_id
      );

      // 返回时校验文档、筛选和请求序号，禁止追加旧结果
      if (
        seq !== loadMoreSeqRef.current ||
        currentDocRef.current?.id !== reqDocId ||
        recordFilterRef.current !== reqFilter
      ) {
        return;
      }

      if (res.items.length > 0) {
        const validCards = res.items.filter(
          (item) => !deletedCardIdsRef.current.has(item.card_id)
        );
        for (const item of validCards) {
          syncedCardIdsRef.current.add(item.card_id);
        }
        // 保持状态更新函数纯计算，追加并去重
        setAllRecords((prev) => {
          const existingIds = new Set(prev.map((c) => c.card_id));
          const toAdd = validCards.filter((c) => !existingIds.has(c.card_id));
          return [...prev, ...toAdd];
        });
        setHasMore(res.has_more);
      } else {
        setHasMore(false);
      }
    } catch (err) {
      if (
        seq !== loadMoreSeqRef.current ||
        currentDocRef.current?.id !== reqDocId ||
        recordFilterRef.current !== reqFilter
      ) {
        return;
      }
      console.warn("[RightCompanionPanel] 复合游标分页加载更多失败:", err);
    } finally {
      if (
        seq === loadMoreSeqRef.current &&
        currentDocRef.current?.id === reqDocId &&
        recordFilterRef.current === reqFilter
      ) {
        setIsLoadingMore(false);
      }
    }
  }, [currentDoc, isLoadingMore, hasMore, allRecords, recordFilter]);

  // 记录列表直接呈现 SQLite 过滤后的数据（无需前端二次丢弃造成空页无法翻页）
  const filteredRecordItems = useMemo(() => {
    if (recordFilter === "highlights") {
      return [];
    }
    return allRecords;
  }, [allRecords, recordFilter]);

  // 虚拟列表虚拟化（记录视图）
  const recordsVirtualizer = useVirtualizer({
    count: filteredRecordItems.length,
    getScrollElement: () => recordsScrollContainerRef.current,
    estimateSize: () => 165,
    overscan: 6,
  });

  const virtualItems = recordsVirtualizer.getVirtualItems();
  const lastVirtualIndex =
    virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;

  // 1. 监听虚拟可见末项变化进行触底加载
  useEffect(() => {
    if (
      activeView === "records" &&
      lastVirtualIndex >= 0 &&
      lastVirtualIndex >= filteredRecordItems.length - 3 &&
      hasMore &&
      !isLoadingMore &&
      !isLoadingRecords
    ) {
      void loadMoreRecords();
    }
  }, [
    activeView,
    lastVirtualIndex,
    filteredRecordItems.length,
    hasMore,
    isLoadingMore,
    isLoadingRecords,
    loadMoreRecords,
  ]);

  // 2. 纯滚动监听：无流式更新时纯滚动也能加载下一页
  useEffect(() => {
    if (activeView !== "records") return;
    const scrollEl = recordsScrollContainerRef.current;
    if (!scrollEl) return;

    const handleRecordsScroll = () => {
      if (!hasMore || isLoadingMore || isLoadingRecords) return;
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      if (scrollHeight - (scrollTop + clientHeight) < 220) {
        void loadMoreRecords();
      }
    };

    scrollEl.addEventListener("scroll", handleRecordsScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", handleRecordsScroll);
  }, [activeView, hasMore, isLoadingMore, isLoadingRecords, loadMoreRecords]);

  // 切书时彻底重置跟随与尺寸缓存、清空记录
  useEffect(() => {
    followingCacheRef.current.clear();
    fullyQueriedAnchorsRef.current.clear();
    cardHeightsRef.current.clear();
    syncedCardIdsRef.current.clear();
    deletedCardIdsRef.current.clear();
    setPositionedGroups([]);
    setSelectedCardIndexByAnchor({});
  }, [currentDoc?.id]);

  // 记录本首屏加载生命周期：先失效旧请求、重置必要状态，再发起新请求
  useEffect(() => {
    if (activeView !== "records" || !currentDoc) {
      loadSeqRef.current++;
      loadMoreSeqRef.current++;
      setIsLoadingRecords(false);
      setIsLoadingMore(false);
      if (!currentDoc) {
        setAllRecords([]);
        setHighlights([]);
        setTotalCount(0);
        setHasMore(false);
      }
      return;
    }

    const reqDocId = currentDoc.id;
    const reqFilter = recordFilter;

    // 1. 先失效旧请求
    loadSeqRef.current++;
    loadMoreSeqRef.current++;

    // 2. 重置必要状态
    setIsLoadingRecords(true);
    setIsLoadingMore(false);
    setHasMore(false);
    setAllRecords([]);
    setTotalCount(0);

    // 3. 再发起新首屏请求（保持文档、筛选和复合游标隔离）
    void loadFirstPageRecords(reqDocId, reqFilter);
  }, [activeView, currentDoc?.id, recordFilter, loadFirstPageRecords]);

  // 跟随视图：测量可见锚点在屏幕上的纵向位置，使用实际高度做避碰
  const computeFollowPositions = useCallback(() => {
    if (activeView !== "following" || !followingContainerRef.current) return;
    const container = followingContainerRef.current;
    const containerRect = container.getBoundingClientRect();

    if (!visibleAnchorIds || visibleAnchorIds.length === 0) {
      setPositionedGroups((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const groups: { anchorId: string; cards: CardRecord[]; naturalTop: number }[] = [];

    // 所有来源查找严格限定在左侧阅读区域，避免误命中右侧同名 data-anchor-id
    const leftReaderEl =
      document.querySelector<HTMLElement>('[data-reader-viewport="true"]') ||
      document.querySelector<HTMLElement>(".reader-scroll-viewport") ||
      document.querySelector<HTMLElement>(".pdf-scroll-viewport") ||
      document.querySelector<HTMLElement>(".reader-container") ||
      document.querySelector<HTMLElement>(".pdf-reader-container");
    if (!leftReaderEl) return;

    for (const aid of visibleAnchorIds) {
      // 优先从跟随缓存读取（可包含超 100 条的旧卡片），回退到 cards prop，均彻底过滤已删除ID
      const cached = followingCacheRef.current.get(aid);
      const matched =
        cached && cached.length > 0
          ? cached.filter((c) => !deletedCardIdsRef.current.has(c.card_id))
          : cards.filter(
              (c) => c.anchor_id === aid && !deletedCardIdsRef.current.has(c.card_id)
            );
      if (matched.length === 0) continue;

      // 仅在左侧阅读区内查找来源锚点，严禁命中右侧卡片自身，并优先选取与当前视口相交的片段
      const anchorEl = findVisibleAnchorElement(leftReaderEl, aid);
      if (!anchorEl || !leftReaderEl.contains(anchorEl)) continue;

      const ancRect = anchorEl.getBoundingClientRect();
      const naturalTop = ancRect.top - containerRect.top;

      groups.push({
        anchorId: aid,
        cards: matched,
        naturalTop,
      });
    }

    // 按实际自然纵向位置升序排列
    groups.sort((a, b) => a.naturalTop - b.naturalTop);

    // 避碰算法：使用真实卡片高度或 ResizeObserver 动态更新的高度 (提问栏已迁移至正文下方，释放底部避让空间)
    let currentBottom = 12;
    const maxAllowedBottom = containerRect.height - 24;
    const result: PositionedAnchorGroup[] = [];

    for (const g of groups) {
      const targetTop = Math.max(12, g.naturalTop);
      const computedTop = Math.max(targetTop, currentBottom);

      if (computedTop > maxAllowedBottom && result.length > 0) {
        break;
      }

      // 获取 ResizeObserver 观测到的实际卡片高度，初始预估 160px
      const actualHeight = cardHeightsRef.current.get(g.anchorId) || 160;
      currentBottom = computedTop + actualHeight + 12;

      result.push({
        anchorId: g.anchorId,
        cards: g.cards,
        naturalTop: g.naturalTop,
        computedTop,
      });
    }

    // 相同排布复用原状态，避免无变化时更新和发事件
    setPositionedGroups((prev) => {
      if (
        prev.length === result.length &&
        prev.every((p, i) => {
          const r = result[i];
          return (
            p.anchorId === r.anchorId &&
            Math.abs(p.computedTop - r.computedTop) < 0.5 &&
            Math.abs(p.naturalTop - r.naturalTop) < 0.5 &&
            p.cards.length === r.cards.length &&
            p.cards.every(
              (c, ci) =>
                c.card_id === r.cards[ci]?.card_id &&
                c.updated_at === r.cards[ci]?.updated_at &&
                c.status === r.cards[ci]?.status &&
                c.ai_response === r.cards[ci]?.ai_response
            )
          );
        })
      ) {
        return prev;
      }
      return result;
    });
  }, [activeView, visibleAnchorIds, cards]);

  // 当卡片排布结果发生真实改变后，通知连线层重新刷新端点坐标
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("flowread:card-layout-updated"));
    window.dispatchEvent(new CustomEvent("flowread:layout-updated"));
  }, [positionedGroups]);

  // 根据当前可见锚点，按需查询未完整查询的跟随卡片（不限制最新 100 张，区分缓存已有部分与完整查询）
  useEffect(() => {
    if (!currentDoc || !visibleAnchorIds || visibleAnchorIds.length === 0) return;
    const missingIds = visibleAnchorIds.filter(
      (aid) => !fullyQueriedAnchorsRef.current.has(aid)
    );
    if (missingIds.length === 0) return;

    let isCancelled = false;
    const reqDocId = currentDoc.id;

    void apiGetCardsByAnchorIds(reqDocId, missingIds).then((resCards) => {
      if (isCancelled || currentDocRef.current?.id !== reqDocId) return;
      for (const aid of missingIds) {
        fullyQueriedAnchorsRef.current.add(aid);
        const fromDb = resCards.filter(
          (c) => c.anchor_id === aid && !deletedCardIdsRef.current.has(c.card_id)
        );
        const cached = (followingCacheRef.current.get(aid) || []).filter(
          (c) => !deletedCardIdsRef.current.has(c.card_id)
        );
        const merged = [...fromDb];
        for (const c of cached) {
          if (!merged.some((m) => m.card_id === c.card_id)) {
            merged.unshift(c);
          }
        }
        merged.sort((a, b) => b.created_at - a.created_at);
        if (merged.length > 0) {
          followingCacheRef.current.set(aid, merged);
        } else {
          followingCacheRef.current.delete(aid);
        }
      }
      computeFollowPositions();
    });

    return () => {
      isCancelled = true;
    };
  }, [currentDoc, visibleAnchorIds, computeFollowPositions]);

  // 初始化卡片 ResizeObserver：回答流式输出、字号变化、追问展开后重新排布
  useEffect(() => {
    cardObserverRef.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const aid = el.dataset.anchorId;
        if (aid) {
          const h = el.offsetHeight || entry.contentRect.height;
          if (h > 0 && Math.abs((cardHeightsRef.current.get(aid) || 0) - h) > 2) {
            cardHeightsRef.current.set(aid, h);
            changed = true;
          }
        }
      }
      if (changed) {
        computeFollowPositions();
      }
    });

    return () => {
      cardObserverRef.current?.disconnect();
    };
  }, [computeFollowPositions]);

  // 订阅 AI 调度器流式更新：实时同步到记录本（保留滚动）及跟随缓存
  useEffect(() => {
    const unsubscribe = aiDispatcher.subscribe((update) => {
      // 若该卡片已被标记删除，阻断更新并确保清除可能残留的临时缓存
      if (deletedCardIdsRef.current.has(update.cardId)) {
        setAllRecords((prev) => prev.filter((c) => c.card_id !== update.cardId));
        for (const [aid, cList] of followingCacheRef.current.entries()) {
          if (cList.some((c) => c.card_id === update.cardId)) {
            const filtered = cList.filter((c) => c.card_id !== update.cardId);
            if (filtered.length === 0) {
              followingCacheRef.current.delete(aid);
            } else {
              followingCacheRef.current.set(aid, filtered);
            }
          }
        }
        return;
      }

      // 1. 同步更新记录本列表 (保持虚拟滚动位置不变)
      setAllRecords((prev) =>
        prev.map((c) => {
          if (c.card_id === update.cardId) {
            if (update.turnId) {
              return { ...c, updated_at: Date.now() };
            }
            return {
              ...c,
              ai_response: update.accumulatedText,
              preview: update.accumulatedText.slice(0, 400),
              status: update.status,
              error_message: update.errorMessage || null,
              updated_at: Date.now(),
            };
          }
          return c;
        })
      );

      // 2. 同步更新跟随缓存中的对应卡片
      for (const [aid, cList] of followingCacheRef.current.entries()) {
        let changed = false;
        const updatedList = cList.map((c) => {
          if (c.card_id === update.cardId) {
            changed = true;
            if (update.turnId) {
              return { ...c, updated_at: Date.now() };
            }
            return {
              ...c,
              ai_response: update.accumulatedText,
              preview: update.accumulatedText.slice(0, 400),
              status: update.status,
              error_message: update.errorMessage || null,
              updated_at: Date.now(),
            };
          }
          return c;
        });
        if (changed) {
          followingCacheRef.current.set(aid, updatedList);
          computeFollowPositions();
        }
      }
    });

    return () => unsubscribe();
  }, [computeFollowPositions]);

  // 当外部 cards prop 变动时，同步最新创建的卡片到记录本与跟随缓存
  useEffect(() => {
    if (!cards || cards.length === 0 || !currentDoc) return;

    // 1. 种入部分卡片到跟随缓存（严格过滤已删除ID，坚决禁止重新注入）
    for (const c of cards) {
      if (deletedCardIdsRef.current.has(c.card_id)) continue;
      if (c.anchor_id) {
        const existing = (followingCacheRef.current.get(c.anchor_id) || []).filter(
          (x) => !deletedCardIdsRef.current.has(x.card_id)
        );
        if (!existing.some((x) => x.card_id === c.card_id)) {
          followingCacheRef.current.set(c.anchor_id, [c, ...existing]);
        }
      }
    }

    // 清理跟随缓存中可能残留的已删除卡片
    for (const [aid, list] of followingCacheRef.current.entries()) {
      if (list.some((x) => deletedCardIdsRef.current.has(x.card_id))) {
        const cleaned = list.filter((x) => !deletedCardIdsRef.current.has(x.card_id));
        if (cleaned.length === 0) {
          followingCacheRef.current.delete(aid);
        } else {
          followingCacheRef.current.set(aid, cleaned);
        }
      }
    }

    // 2. 空记录本也必须能插入第一张匹配的新卡片，保留已加载页及滚动位置
    const newCardsToSync: CardRecord[] = [];
    for (const c of cards) {
      if (
        c.document_id === currentDoc.id &&
        !syncedCardIdsRef.current.has(c.card_id) &&
        !deletedCardIdsRef.current.has(c.card_id)
      ) {
        syncedCardIdsRef.current.add(c.card_id);
        const matches =
          recordFilter === "all" ||
          (recordFilter === "qa" && c.action === "Ask") ||
          (recordFilter === "actions" && c.action !== "Ask");
        if (matches) {
          newCardsToSync.push(c);
        }
      }
    }

    if (newCardsToSync.length > 0) {
      // 状态更新函数保持纯计算，独立更新计数与记录
      setTotalCount((t) => t + newCardsToSync.length);
      setAllRecords((prev) => {
        const existingIds = new Set(prev.map((x) => x.card_id));
        const toAdd = newCardsToSync.filter((x) => !existingIds.has(x.card_id));
        if (toAdd.length === 0) return prev;
        return [...toAdd, ...prev];
      });
    }
  }, [cards, recordFilter, currentDoc]);

  // 当滚动、卡片或可见锚点变化时，使用 rAF 节流更新跟随位置
  useEffect(() => {
    let rafId: number | null = null;
    const onUpdate = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        computeFollowPositions();
        rafId = null;
      });
    };

    onUpdate();

    window.addEventListener("scroll", onUpdate, { passive: true, capture: true });
    window.addEventListener("resize", onUpdate);
    window.addEventListener("flowread:source-layout-updated", onUpdate);

    return () => {
      window.removeEventListener("scroll", onUpdate, true);
      window.removeEventListener("resize", onUpdate);
      window.removeEventListener("flowread:source-layout-updated", onUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [computeFollowPositions]);

  const handleExportAllMarkdown = async () => {
    if (!currentDoc) return;
    try {
      const md = await apiExportDocumentMarkdown(currentDoc.id);
      await navigator.clipboard.writeText(md);
      alert(`已成功复制《${currentDoc.display_name}》的全部学习记录与多轮追问 Markdown 至剪贴板！`);
    } catch (err) {
      console.error("[RightCompanionPanel] 导出 Markdown 失败:", err);
      alert("导出 Markdown 失败，请检查数据库。");
    }
  };

  const handleDeleteHighlight = async (hlId: string) => {
    await apiDeleteHighlight(hlId);
    setHighlights((prev) => prev.filter((h) => h.highlight_id !== hlId));
    onRefreshCards();
  };

  // 统一的卡片缓存清理函数：支持从详情大窗、跟随卡片及记录本等所有入口完全同步且绝对幂等
  const removeCardFromCaches = useCallback((cId: string) => {
    const isFirstDelete = !deletedCardIdsRef.current.has(cId);
    deletedCardIdsRef.current.add(cId);
    syncedCardIdsRef.current.delete(cId);

    // 1. 同步记录本分页缓存（彻底清除可能残留的卡片）
    setAllRecords((prev) => prev.filter((c) => c.card_id !== cId));

    // 2. 计数只结算一次！
    if (isFirstDelete) {
      setTotalCount((prev) => Math.max(0, prev - 1));
    }

    // 3. 同步跟随缓存（无论是否属于前 100 张）
    for (const [aid, cList] of followingCacheRef.current.entries()) {
      if (cList.some((c) => c.card_id === cId)) {
        const filtered = cList.filter((c) => c.card_id !== cId);
        if (filtered.length === 0) {
          followingCacheRef.current.delete(aid);
        } else {
          followingCacheRef.current.set(aid, filtered);
        }
      }
    }

    // 4. 同步清除当前已排布的卡片状态（避免切回跟随视图时闪烁或残留已删除卡片）
    setPositionedGroups((prev) =>
      prev
        .map((g) => ({
          ...g,
          cards: g.cards.filter((c) => c.card_id !== cId),
        }))
        .filter((g) => g.cards.length > 0)
    );

    // 5. 纠正同一锚点卡片选中索引
    setSelectedCardIndexByAnchor((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const aid of Object.keys(next)) {
        const list = followingCacheRef.current.get(aid) || [];
        if (next[aid] >= list.length) {
          next[aid] = Math.max(0, list.length - 1);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    // 6. 立即重新计算跟随排布
    computeFollowPositions();
  }, [computeFollowPositions]);

  // 监听全局卡片删除事件（来自详情大窗等），同步全量缓存
  useEffect(() => {
    const handleCardDeletedEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ cardId: string }>;
      const cId = customEvent.detail?.cardId;
      if (cId) {
        removeCardFromCaches(cId);
      }
    };
    window.addEventListener("flowread:card-deleted", handleCardDeletedEvent);
    return () => {
      window.removeEventListener("flowread:card-deleted", handleCardDeletedEvent);
    };
  }, [removeCardFromCaches]);

  const handleDeleteCardInternal = (cId: string) => {
    removeCardFromCaches(cId);
    onDeleteCard(cId);
  };

  return (
    <aside
      className="right-companion-panel"
      style={{
        flex: width ? `0 0 ${width}px` : "0 0 340px",
        width: width ? `${width}px` : "340px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "transparent",
        position: "relative",
        overflow: "hidden",
        userSelect: "text",
      }}
    >
      {/* 顶部紧凑双入口：跟随 (Following) / 记录本 (Notebook) */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
          backgroundColor: "transparent",
          zIndex: 10,
        }}
      >
        <div
          style={{
            display: "inline-flex",
            backgroundColor: "rgba(255, 255, 255, 0.06)",
            border: "1px solid var(--ln, #262523)",
            borderRadius: "8px",
            padding: "2px",
            fontSize: "12px",
          }}
        >
          <button
            type="button"
            onClick={() => setActiveView("following")}
            style={{
              border: "none",
              padding: "3px 10px",
              borderRadius: "6px",
              cursor: "pointer",
              background: activeView === "following" ? "var(--cd, #151514)" : "transparent",
              color: activeView === "following" ? "var(--fg, #e8e5de)" : "var(--mut, #85827b)",
              fontWeight: activeView === "following" ? 600 : 400,
              boxShadow: activeView === "following" ? "0 1px 3px rgba(0,0,0,0.25)" : "none",
            }}
          >
            跟随视图
          </button>
          <button
            type="button"
            onClick={() => setActiveView("records")}
            style={{
              border: "none",
              padding: "3px 10px",
              borderRadius: "6px",
              cursor: "pointer",
              background: activeView === "records" ? "var(--cd, #151514)" : "transparent",
              color: activeView === "records" ? "var(--fg, #e8e5de)" : "var(--mut, #85827b)",
              fontWeight: activeView === "records" ? 600 : 400,
              boxShadow: activeView === "records" ? "0 1px 3px rgba(0,0,0,0.25)" : "none",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <span>记录本</span>
            <span
              style={{
                fontSize: "10px",
                background: "var(--pen, #e8664a)",
                color: "#fff",
                borderRadius: "8px",
                padding: "0 5px",
                fontWeight: 600,
              }}
            >
              {totalCount || cards.length}
            </span>
          </button>
        </div>

        {activeView === "records" && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {isLoadingRecords ? (
              <span style={{ fontSize: "11px", color: "var(--mut, #85827b)" }}>同步中...</span>
            ) : (
              <span style={{ fontSize: "11px", color: "var(--mut, #85827b)" }}>共 {totalCount} 条</span>
            )}
            <button
              type="button"
              onClick={handleExportAllMarkdown}
              title="复制当前文档全部记录为完整 Markdown"
              style={{
                background: "none",
                border: "1px solid var(--border-light, #e2e8f0)",
                borderRadius: "6px",
                padding: "3px 8px",
                fontSize: "11px",
                color: "var(--text-secondary, #475569)",
                cursor: "pointer",
              }}
            >
              ⧉ 导出全部
            </button>
          </div>
        )}
      </header>

      {/* 视图内容区 */}
      {activeView === "following" ? (
        /* 跟随视图：按可见原文纵向位置排布，支持避碰与密集分组，不叠加竞态滚动条 */
        <div
          ref={followingContainerRef}
          className="companion-following-stage"
          style={{
            flex: 1,
            position: "relative",
            overflow: "hidden",
            paddingBottom: "16px",
          }}
        >
          {positionedGroups.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "60px 16px",
                color: "var(--text-muted, #94a3b8)",
                fontSize: "12.5px",
                lineHeight: 1.6,
              }}
            >
              <div style={{ fontSize: "24px", marginBottom: "8px" }}>▤</div>
              <div style={{ fontWeight: 500, color: "var(--text-main, #0f172a)", marginBottom: "4px" }}>
                当前视野暂无伴读卡片
              </div>
              <div>划选左侧文字或 Alt+拖拽框选图表，</div>
              <div>选择 Ask、解释或翻译即可生成跟随卡片。</div>
              <div style={{ marginTop: "8px", fontSize: "11px" }}>
                已有记录可在「记录本」中完整浏览。
              </div>
            </div>
          ) : (
            positionedGroups.map((group) => {
              const activeIdxInGroup = group.cards.findIndex((c) => c.card_id === activeCardId);
              const customSelectedIdx = selectedCardIndexByAnchor[group.anchorId] ?? 0;
              const displayIndex = activeIdxInGroup >= 0 ? activeIdxInGroup : customSelectedIdx;
              const card = group.cards[displayIndex] || group.cards[0];

              return (
                <div
                  key={group.anchorId}
                  data-card-id={card.card_id}
                  data-anchor-id={group.anchorId}
                  ref={(el) => {
                    if (el && cardObserverRef.current) {
                      cardObserverRef.current.observe(el);
                    }
                  }}
                  style={{
                    position: "absolute",
                    top: `${group.computedTop}px`,
                    left: "14px",
                    right: "14px",
                    transition: "top 0.1s ease-out",
                  }}
                >
                  {/* 同一来源多卡片折叠与切换栏 */}
                  {group.cards.length > 1 && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: "4px",
                        padding: "0 4px",
                        fontSize: "11px",
                        color: "var(--mut, #85827b)",
                      }}
                    >
                      <span>📌 同一来源 ({group.cards.length} 条记录)</span>
                      <div style={{ display: "flex", gap: "4px" }}>
                        {group.cards.map((c, idx) => (
                          <button
                            key={c.card_id}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedCardIndexByAnchor((prev) => ({
                                ...prev,
                                [group.anchorId]: idx,
                              }));
                              onSelectCard(c.card_id);
                            }}
                            style={{
                              border: "none",
                              borderRadius: "4px",
                              padding: "1px 6px",
                              fontSize: "10px",
                              cursor: "pointer",
                              background:
                                idx === displayIndex
                                  ? "var(--pen, #e8664a)"
                                  : "var(--bg-subtle, #f1f5f9)",
                              color: idx === displayIndex ? "#fff" : "var(--mut, #85827b)",
                              fontWeight: idx === displayIndex ? 600 : 400,
                            }}
                          >
                            {c.action}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <CompanionCardItem
                    card={card}
                    isActive={card.card_id === activeCardId}
                    onSelectCard={() => onSelectCard(card.card_id)}
                    onOpenFullModal={() => onOpenFullModal(card.card_id)}
                    onJumpToSource={() =>
                      onJumpToSource(card.card_id, card.anchor_id || undefined)
                    }
                    onDelete={() => handleDeleteCardInternal(card.card_id)}
                    onSendFollowUp={(prompt, depth) =>
                      onSendFollowUp(card.card_id, prompt, depth)
                    }
                    sourceLabel={
                      card.anchor_source_type === "pdf_image"
                        ? "图表框选"
                        : card.anchor_source_type === "pdf_text"
                        ? "PDF 划选"
                        : "正文段落"
                    }
                  />
                </div>
              );
            })
          )}
        </div>
      ) : (
        /* 记录视图：独立虚拟滚动列表，支持游标分页浏览 100~10,000+ 条记录 */
        <div
          ref={recordsScrollContainerRef}
          className="companion-records-scroll-viewport"
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "12px 14px 16px",
            position: "relative",
          }}
        >
          {/* 记录视图过滤选项卡 */}
          <div
            style={{
              display: "flex",
              gap: "4px",
              marginBottom: "12px",
              paddingBottom: "8px",
              borderBottom: "1px solid var(--border-light, #e2e8f0)",
            }}
          >
            {[
              { key: "all", label: `全部 (${totalCount || allRecords.length})` },
              { key: "qa", label: "提问 (Q&A)" },
              { key: "highlights", label: `高亮 (${highlights.length})` },
              { key: "actions", label: "指令卡片" },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setRecordFilter(f.key as RecordFilter)}
                style={{
                  border: "none",
                  background: recordFilter === f.key ? "var(--cd, #ffffff)" : "transparent",
                  color: recordFilter === f.key ? "var(--pen, #e8664a)" : "var(--mut, #85827b)",
                  fontWeight: recordFilter === f.key ? 600 : 400,
                  padding: "3px 8px",
                  borderRadius: "6px",
                  fontSize: "11px",
                  cursor: "pointer",
                  boxShadow: recordFilter === f.key ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {recordFilter === "highlights" ? (
            highlights.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "40px 0",
                  color: "var(--mut, #85827b)",
                  fontSize: "12px",
                }}
              >
                当前文档暂无划词高亮
              </div>
            ) : (
              highlights.map((hl) => (
                <div
                  key={hl.highlight_id}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1px solid var(--border-light, #e2e8f0)",
                    backgroundColor: "var(--cd, #ffffff)",
                    marginBottom: "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        width: "12px",
                        height: "12px",
                        borderRadius: "2px",
                        backgroundColor: hl.color,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => handleDeleteHighlight(hl.highlight_id)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--mut, #85827b)",
                        cursor: "pointer",
                        fontSize: "11px",
                      }}
                      title="删除该高亮"
                    >
                      ✕
                    </button>
                  </div>
                  <div style={{ marginTop: "6px", fontSize: "12px", lineHeight: 1.5 }}>
                    <mark style={{ backgroundColor: hl.color }}>{hl.excerpt}</mark>
                  </div>
                </div>
              ))
            )
          ) : filteredRecordItems.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "40px 0",
                color: "var(--mut, #85827b)",
                fontSize: "12px",
              }}
            >
              {isLoadingRecords ? "正在加载记录..." : "暂无匹配的学习记录"}
            </div>
          ) : (
            <div
              style={{
                height: `${recordsVirtualizer.getTotalSize()}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {recordsVirtualizer.getVirtualItems().map((vItem) => {
                const card = filteredRecordItems[vItem.index];
                if (!card) return null;

                return (
                  <div
                    key={card.card_id}
                    data-index={vItem.index}
                    ref={recordsVirtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    <CompanionCardItem
                      card={card}
                      isActive={card.card_id === activeCardId}
                      onSelectCard={() => onSelectCard(card.card_id)}
                      onOpenFullModal={() => onOpenFullModal(card.card_id)}
                      onJumpToSource={() =>
                        onJumpToSource(card.card_id, card.anchor_id || undefined)
                      }
                      onDelete={() => handleDeleteCardInternal(card.card_id)}
                      onSendFollowUp={(prompt, depth) =>
                        onSendFollowUp(card.card_id, prompt, depth)
                      }
                      sourceLabel={
                        card.anchor_source_type === "pdf_image"
                          ? "图表框选"
                          : card.anchor_source_type === "pdf_text"
                          ? "PDF 划选"
                          : "正文段落"
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}

          {isLoadingMore && (
            <div
              style={{
                textAlign: "center",
                padding: "10px 0",
                fontSize: "11px",
                color: "var(--mut, #85827b)",
              }}
            >
              正在载入更多历史记录...
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
