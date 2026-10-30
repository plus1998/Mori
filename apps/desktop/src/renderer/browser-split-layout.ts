import { browserTaskTabId } from "../shared/browser";

export type BrowserSplitLayout = {
  browserIds: [string, string];
  ratio: number;
};

export function clampBrowserSplitRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(0.75, Math.max(0.25, ratio)) : 0.5;
}

/** Discard stale pairs rather than displaying a page outside this session's tabs. */
export function normalizeBrowserSplitLayout(
  value: unknown,
  openTabIds: readonly string[],
): BrowserSplitLayout | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { browserIds, ratio } = value as Partial<BrowserSplitLayout>;
  if (
    !Array.isArray(browserIds) || browserIds.length !== 2 ||
    browserIds.some(id => typeof id !== "string" || !id.trim() || !openTabIds.includes(browserTaskTabId(id))) ||
    browserIds[0] === browserIds[1]
  ) return undefined;
  return {
    browserIds: [browserIds[0]!, browserIds[1]!],
    ratio: clampBrowserSplitRatio(typeof ratio === "number" ? ratio : 0.5),
  };
}
