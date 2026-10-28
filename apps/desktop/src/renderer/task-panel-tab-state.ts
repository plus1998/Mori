export function addOpenTaskPanelTab<T extends string>(tabs: T[], tabId: T): T[] {
  return tabs.includes(tabId) ? tabs : [...tabs, tabId];
}

export function moveOpenTaskPanelTab<T extends string>(
  tabs: T[],
  source: T,
  target: T,
  position: "before" | "after",
): T[] {
  if (source === target || !tabs.includes(source) || !tabs.includes(target)) return tabs;
  const next = tabs.filter((id) => id !== source);
  next.splice(next.indexOf(target) + Number(position === "after"), 0, source);
  return next.every((id, index) => id === tabs[index]) ? tabs : next;
}

export function replaceOpenTaskPanelTab<T extends string>(tabs: T[], sourceTabId: T, tabId: T): T[] {
  if (tabs.includes(tabId)) {
    return tabs.filter((openTabId) => openTabId !== sourceTabId || openTabId === tabId);
  }
  if (!tabs.includes(sourceTabId)) {
    return addOpenTaskPanelTab(tabs, tabId);
  }
  return tabs.map((openTabId) => (openTabId === sourceTabId ? tabId : openTabId));
}

/**
 * Reopening the task panel must not spawn a tab — it shows the tab the human left off on.
 * `activeTab` survives the collapse, so prefer it; the home sentinel is never in `tabs`,
 * so fall back to the most recently opened tab. Only an empty panel has nothing to restore.
 */
export function resolveTaskPanelReopenTab<T extends string>(tabs: readonly T[], activeTab: T): T | undefined {
  return tabs.includes(activeTab) ? activeTab : tabs.at(-1);
}

export function removeOpenTaskPanelTab<T extends string>(
  tabs: readonly T[],
  tabId: T,
): { tabs: T[]; fallback?: T } {
  const removedIndex = tabs.indexOf(tabId);
  if (removedIndex < 0) {
    return { tabs: [...tabs] };
  }

  const next = tabs.filter((openTabId) => openTabId !== tabId);
  const fallback = next[Math.max(0, removedIndex - 1)];
  return fallback ? { tabs: next, fallback } : { tabs: next };
}

export type TaskPanelTabCloseAction = "others" | "right" | "all";

/** Use the current visual order, including tabs moved by dragging. */
export function taskPanelTabsToClose<T extends string>(
  tabs: readonly T[],
  target: T,
  action: TaskPanelTabCloseAction,
): T[] {
  const index = tabs.indexOf(target);
  if (index < 0) return [];
  if (action === "all") return [...tabs];
  return action === "others" ? tabs.filter((id) => id !== target) : tabs.slice(index + 1);
}

export function removeOpenTaskPanelTabs<T extends string>(
  tabs: readonly T[],
  closing: readonly T[],
  active: T,
): { tabs: T[]; fallback?: T } {
  const removed = new Set(closing);
  const next = tabs.filter((id) => !removed.has(id));
  // Preserve selection, otherwise prefer the nearest surviving tab on the left.
  const fallback = next.includes(active)
    ? active
    : (tabs
        .slice(0, tabs.indexOf(active))
        .reverse()
        .find((id) => !removed.has(id)) ?? next[0]);
  return fallback ? { tabs: next, fallback } : { tabs: next };
}
