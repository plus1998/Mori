import type { SidebarAttentionItem } from "./sidebar-attention-items";

export const SIDEBAR_ATTENTION_DISMISSALS_STORAGE_KEY = "eco.sidebar.ignored-notifications.v1";

// Keep only notification identities; never store plan contents or change pending requests.
export type SidebarAttentionDismissals = Readonly<Record<string, string>>;

export function dismissSidebarAttentionItems(
  current: SidebarAttentionDismissals,
  items: readonly SidebarAttentionItem[],
): SidebarAttentionDismissals {
  const next = { ...current };
  for (const item of items) next[item.id] = item.revision ?? "";
  return next;
}

export function revealSidebarAttentionItem(
  current: SidebarAttentionDismissals,
  id: string,
): SidebarAttentionDismissals {
  if (!Object.hasOwn(current, id)) return current;
  const next = { ...current };
  delete next[id];
  return next;
}

export function visibleSidebarAttentionItems(
  items: readonly SidebarAttentionItem[],
  dismissed: SidebarAttentionDismissals,
): SidebarAttentionItem[] {
  return items.filter((item) => {
    if (!Object.hasOwn(dismissed, item.id)) return true;
    // A summary can arrive before the plan body. Keep the ignored notification
    // hidden during hydration; a new approval event explicitly reveals it again.
    return Boolean(item.revision && dismissed[item.id] && item.revision !== dismissed[item.id]);
  });
}

export function readSidebarAttentionDismissals(
  storage: Pick<Storage, "getItem">,
): SidebarAttentionDismissals {
  const raw = storage.getItem(SIDEBAR_ATTENTION_DISMISSALS_STORAGE_KEY);
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Object.entries(parsed).every(
      ([id, revision]) => /^(question|plan|bash|completed):.+/.test(id) && typeof revision === "string",
    )
  ) {
    throw new Error("Invalid ignored notification data");
  }
  return parsed as SidebarAttentionDismissals;
}

export function saveSidebarAttentionDismissals(
  storage: Pick<Storage, "setItem">,
  dismissed: SidebarAttentionDismissals,
): void {
  storage.setItem(SIDEBAR_ATTENTION_DISMISSALS_STORAGE_KEY, JSON.stringify(dismissed));
}
