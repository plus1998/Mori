import { normalizeBrowserNavigateUrl, partitionForBrowserWorkspace } from "./browser";

export interface WebChatItem {
  id: string;
  title: string;
  url: string;
  builtin: boolean;
  order: number;
}

/** Persisted shape — only user-added entries (builtins always come from code). */
export interface WebChatListSnapshot {
  customs: WebChatItem[];
  proxy?: string | undefined;
  siteProxies?: Record<string, string> | undefined;
}

export interface WebChatListView {
  items: WebChatItem[];
  proxy?: string | undefined;
  siteProxies?: Record<string, string> | undefined;
}

const BUILTIN_WEB_CHATS: ReadonlyArray<Omit<WebChatItem, "builtin" | "order">> = [
  { id: "chatgpt", title: "ChatGPT", url: "https://chatgpt.com" },
  { id: "claude", title: "Claude", url: "https://claude.ai" },
  { id: "gemini", title: "Gemini", url: "https://gemini.google.com/app" },
  { id: "deepseek", title: "DeepSeek", url: "https://chat.deepseek.com" },
  { id: "kimi", title: "Kimi", url: "https://kimi.moonshot.cn" },
  { id: "doubao", title: "豆包", url: "https://www.doubao.com/chat/" },
];

export function builtinWebChatItems(): WebChatItem[] {
  return BUILTIN_WEB_CHATS.map((item, index) => ({
    ...item,
    builtin: true,
    order: index,
  }));
}

export function defaultWebChatListSnapshot(): WebChatListSnapshot {
  return { customs: [] };
}

function normalizeWebChatId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = value.trim();
  if (!id || id.length > 128) {
    return undefined;
  }
  return id;
}

function normalizeWebChatTitle(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const title = value.trim();
  if (!title || title.length > 80) {
    return undefined;
  }
  return title;
}

/** Normalize a user-facing URL for a web chat bookmark. */
export function normalizeWebChatUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  return normalizeBrowserNavigateUrl(raw);
}

export function normalizeCustomWebChatItem(value: unknown, fallbackOrder: number): WebChatItem | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeWebChatId(record.id);
  const title = normalizeWebChatTitle(record.title);
  const url = normalizeWebChatUrl(record.url);
  if (!id || !title || !url) {
    return undefined;
  }
  // Custom entries must not collide with builtin ids.
  if (BUILTIN_WEB_CHATS.some((item) => item.id === id)) {
    return undefined;
  }
  const order =
    typeof record.order === "number" && Number.isFinite(record.order)
      ? Math.floor(record.order)
      : fallbackOrder;
  return {
    id,
    title,
    url,
    builtin: false,
    order,
  };
}

export function normalizeWebChatListSnapshot(value: unknown): WebChatListSnapshot {
  if (!value || typeof value !== "object") {
    return defaultWebChatListSnapshot();
  }
  const record = value as Record<string, unknown>;
  const rawCustoms = Array.isArray(record.customs) ? record.customs : [];
  const seen = new Set<string>();
  const customs: WebChatItem[] = [];
  for (let i = 0; i < rawCustoms.length; i += 1) {
    const item = normalizeCustomWebChatItem(rawCustoms[i], BUILTIN_WEB_CHATS.length + i);
    if (!item || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    customs.push(item);
  }
  customs.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  const proxy = typeof record.proxy === "string" ? record.proxy.trim() : "";
  const sites = [...builtinWebChatItems(), ...customs];
  const siteProxies: Record<string, string> = {};
  if (record.siteProxies && typeof record.siteProxies === "object" && !Array.isArray(record.siteProxies)) {
    for (const item of sites) {
      const value = (record.siteProxies as Record<string, unknown>)[item.id];
      if (typeof value === "string") siteProxies[item.id] = value.trim();
    }
  } else if (proxy) {
    for (const item of sites) siteProxies[item.id] = proxy;
  }
  return { customs, ...(proxy ? { proxy } : {}), ...(record.siteProxies !== undefined || Object.keys(siteProxies).length ? { siteProxies } : {}) };
}

export function isWebChatListSnapshot(value: unknown): value is WebChatListSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.customs)) {
    return false;
  }
  if (record.siteProxies !== undefined && (!record.siteProxies || typeof record.siteProxies !== "object" || Array.isArray(record.siteProxies) || Object.values(record.siteProxies).some((value) => typeof value !== "string"))) return false;
  for (const entry of record.customs) {
    if (!normalizeCustomWebChatItem(entry, 0)) {
      return false;
    }
  }
  return true;
}

/** Merge code builtins + stored customs into the ordered list for the UI. */
export function mergeWebChatList(snapshot: WebChatListSnapshot): WebChatListView {
  const builtins = builtinWebChatItems();
  const customs = normalizeWebChatListSnapshot(snapshot).customs.map((item, index) => ({
    ...item,
    order: builtins.length + index,
  }));
  const normalized = normalizeWebChatListSnapshot(snapshot);
  return { items: [...builtins, ...customs], ...(snapshot.proxy ? { proxy: snapshot.proxy } : {}), ...(normalized.siteProxies ? { siteProxies: normalized.siteProxies } : {}) };
}

export function webChatHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Draft payload when the user adds a custom site. */
export interface WebChatAddInput {
  title: string;
  url: string;
}

export function createCustomWebChatItem(
  input: WebChatAddInput,
  existing: WebChatListSnapshot,
  idFactory: () => string = () => crypto.randomUUID(),
): { ok: true; item: WebChatItem; next: WebChatListSnapshot } | { ok: false; reason: string } {
  const title = normalizeWebChatTitle(input.title);
  const url = normalizeWebChatUrl(input.url);
  if (!title) {
    return { ok: false, reason: "invalid_title" };
  }
  if (!url) {
    return { ok: false, reason: "invalid_url" };
  }
  const snapshot = normalizeWebChatListSnapshot(existing);
  if (snapshot.customs.some((item) => item.url === url)) {
    return { ok: false, reason: "duplicate_url" };
  }
  const order =
    snapshot.customs.reduce((max, item) => Math.max(max, item.order), BUILTIN_WEB_CHATS.length - 1) + 1;
  const item: WebChatItem = {
    id: idFactory(),
    title,
    url,
    builtin: false,
    order,
  };
  return {
    ok: true,
    item,
    next: { ...snapshot, customs: [...snapshot.customs, item] },
  };
}

export function removeCustomWebChatItem(id: string, existing: WebChatListSnapshot): WebChatListSnapshot {
  const snapshot = normalizeWebChatListSnapshot(existing);
  return {
    ...snapshot,
    customs: snapshot.customs.filter((item) => item.id !== id),
  };
}

/** Empty uses system settings; direct explicitly disables proxies. */
export function webChatProxyConfig(proxy?: string): { mode: "system" | "direct" | "fixed_servers"; proxyRules?: string } {
  if (!proxy?.trim()) return { mode: "system" };
  if (proxy === "direct") return { mode: "direct" };
  let url: URL;
  try { url = new URL(proxy); } catch { throw new Error("请输入有效的代理地址"); }
  if (!["http:", "https:", "socks4:", "socks5:"].includes(url.protocol) || !url.hostname || url.pathname !== "" && url.pathname !== "/" || url.search || url.hash) {
    throw new Error("代理须为 http/https/socks4/socks5://主机:端口");
  }
  if (url.protocol === "socks4:" && (url.username || url.password)) {
    throw new Error("SOCKS4 不支持账号密码认证，请使用 SOCKS5 或 HTTP/HTTPS 代理");
  }
  try { decodeURIComponent(url.username); decodeURIComponent(url.password); }
  catch { throw new Error("代理账号密码编码无效"); }
  return { mode: "fixed_servers", proxyRules: `${url.protocol}//${url.host}` };
}

export function splitWebChatProxy(proxy?: string): { address: string; username: string; password: string } {
  if (!proxy || proxy === "direct") return { address: "", username: "", password: "" };
  webChatProxyConfig(proxy);
  const url = new URL(proxy);
  return { address: `${url.protocol}//${url.host}`, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

export function buildWebChatProxy(address: string, username: string, password: string): string {
  webChatProxyConfig(address);
  const url = new URL(address);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  webChatProxyConfig(url.toString());
  return url.toString();
}

/** Each entry shares its login across workspaces, with its own network session. */
export function webChatSitePartition(siteId: string): string {
  if (!siteId.trim()) throw new Error("缺少聊天站点 ID");
  return partitionForBrowserWorkspace(siteId).replace("persist:eco-browser-w-", "persist:eco-web-chat-site-");
}
