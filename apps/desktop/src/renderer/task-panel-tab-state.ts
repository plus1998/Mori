export function addOpenTaskPanelTab<T extends string>(tabs: T[], tabId: T): T[] {
  return tabs.includes(tabId) ? tabs : [...tabs, tabId];
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
