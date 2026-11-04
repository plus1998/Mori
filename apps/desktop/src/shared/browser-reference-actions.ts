/** Actions confined to the exact user-referenced page; tab creation/switching is excluded. */
export const BROWSER_REFERENCE_ACTIONS = [
  "snapshot", "read", "click", "fill", "type", "press", "check", "uncheck", "select", "scroll",
  "get_text", "get_url", "get_title", "screenshot", "wait_for_selector", "wait_for_text", "wait_for_load",
  "reload", "back", "forward", "eval", "cdp",
] as const;

type BrowserReferenceAction = typeof BROWSER_REFERENCE_ACTIONS[number];
type BrowserReferenceToolName = `agent_browser_${BrowserReferenceAction}`;
const prefix = "agent_browser_";
const allowedActions = new Set<string>(BROWSER_REFERENCE_ACTIONS);

/** Both public spellings map to the same allowlist, never to arbitrary browser tools. */
export const BROWSER_REFERENCE_ACTION_VALUES = BROWSER_REFERENCE_ACTIONS.flatMap((action) => [
  action, `${prefix}${action}`,
]);

export function normalizeBrowserReferenceAction(action: string): BrowserReferenceToolName {
  const name = action.startsWith(prefix) ? action.slice(prefix.length) : action;
  if (!allowedActions.has(name)) {
    throw new Error(`该操作不适用于网页引用：${action}。请使用列出的动作，例如 snapshot、screenshot、eval 或 cdp。`);
  }
  return `${prefix}${name as BrowserReferenceAction}`;
}
