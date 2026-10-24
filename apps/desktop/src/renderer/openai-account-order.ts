export const OPENAI_ACCOUNT_ORDER_STORAGE_KEY = "eco.settings.openai-account-order";

export function readOpenAIAccountOrder(storage: Pick<Storage, "getItem">): string[] {
  const raw = storage.getItem(OPENAI_ACCOUNT_ORDER_STORAGE_KEY);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) {
    throw new Error("Invalid account order data");
  }
  return [...new Set(value)];
}

export function sortOpenAIAccounts<T extends { id: string }>(
  accounts: readonly T[],
  order: readonly string[],
  activeAccountId: string | null,
): T[] {
  if (!order.length) {
    return [...accounts].sort((a, b) => Number(b.id === activeAccountId) - Number(a.id === activeAccountId));
  }
  const ranks = new Map(order.map((id, index) => [id, index]));
  return [...accounts].sort((a, b) => (ranks.get(a.id) ?? order.length) - (ranks.get(b.id) ?? order.length));
}

export function moveOpenAIAccount(
  order: readonly string[],
  draggedId: string,
  targetId: string,
  position: "before" | "after",
): string[] {
  if (draggedId === targetId || !order.includes(draggedId) || !order.includes(targetId)) return [...order];
  const next = order.filter((id) => id !== draggedId);
  const index = next.indexOf(targetId) + (position === "after" ? 1 : 0);
  next.splice(index, 0, draggedId);
  return next;
}
