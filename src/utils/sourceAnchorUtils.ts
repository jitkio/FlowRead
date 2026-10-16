/**
 * FlowRead - 来源锚点定位与可见片段选择工具函数
 */

export function findVisibleAnchorElement(
  leftReaderEl: HTMLElement,
  anchorId: string
): HTMLElement | null {
  if (!leftReaderEl || !anchorId) return null;

  const allCandidateEls: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  // 1. 单锚点匹配
  const singleEls = leftReaderEl.querySelectorAll<HTMLElement>(`[data-anchor-id="${anchorId}"]`);
  singleEls.forEach((el) => {
    if (!seen.has(el) && leftReaderEl.contains(el)) {
      seen.add(el);
      allCandidateEls.push(el);
    }
  });

  // 2. 重叠多锚点匹配
  const multiEls = leftReaderEl.querySelectorAll<HTMLElement>("[data-all-anchor-ids]");
  multiEls.forEach((el) => {
    if (!seen.has(el) && leftReaderEl.contains(el)) {
      const ids = el.dataset.allAnchorIds?.split(",") || [];
      if (ids.includes(anchorId)) {
        seen.add(el);
        allCandidateEls.push(el);
      }
    }
  });

  if (allCandidateEls.length === 0) return null;
  if (allCandidateEls.length === 1) return allCandidateEls[0];

  const viewportRect = leftReaderEl.getBoundingClientRect();

  // 寻找所有与当前阅读视口相交的片段
  const visibleCandidates = allCandidateEls.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > viewportRect.top && r.top < viewportRect.bottom;
  });

  if (visibleCandidates.length > 0) {
    // 选取处于当前视口中最靠上的可见片段
    visibleCandidates.sort((a, b) => {
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });
    return visibleCandidates[0];
  }

  // 若均在视口外，回退到第一个候选片段
  return allCandidateEls[0];
}
