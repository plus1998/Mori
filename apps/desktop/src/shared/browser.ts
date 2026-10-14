import { buildEcoMcpHubToolUsage, mergeEcoMcpHubPromptParts } from "./mcp-hub-tool-usage";

/** Built-in Eco browser MCP server name (must stay sanitizable for MCP tool prefixes). */
export const ECO_AGENT_BROWSER_MCP_SERVER = "eco_agent_browser";

export const ECO_AGENT_BROWSER_ALLOWED_TOOL = `mcp__${ECO_AGENT_BROWSER_MCP_SERVER}__*`;

/** Claude / skill frontmatter name and disk folder under ~/.claude/skills. */
export const ECO_AGENT_BROWSER_SKILL_NAME = "eco-agent-browser";

/** Scope id when the user browses without an active Eco thread (not injectable to Agent). */
export const ECO_BROWSER_PERSONAL_SCOPE_ID = "__personal__";

export const BROWSER_TASK_TAB_PREFIX = "browser:";

/**
 * Short stable agent-browser session id for one Eco thread (stdio env + CLI --session).
 * Must stay tiny: long `thr_…` keys + Application Support paths exceed macOS socket path limits
 * (~104 bytes), which made agents invent short sessions like "web"/"chat" and desync from Eco UI.
 * Pure JS so this shared module stays usable in the Vite renderer (no node:crypto).
 */
export function browserAgentSessionKey(threadId: string): string {
  const input = threadId.trim() || "personal";
  // FNV-1a 32-bit × two seeds → 16 hex chars, take 10.
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  return `e${hex.slice(0, 10)}`;
}

/**
 * Short system append when this *thread* enabled eco_agent_browser MCP.
 * Detailed workflow lives in the bundled skill `eco-agent-browser`.
 * Server name is always `eco_agent_browser`; isolation is auth-token + Eco gateway routing.
 */
export function buildEcoAgentBrowserPromptAppend(_threadId?: string): string {
  return [
    "Built-in browser (Eco): browse and interact with websites, read pages, fill forms, extract data, capture screenshots and verify web UIs.",
    buildEcoMcpHubToolUsage({ server: ECO_AGENT_BROWSER_MCP_SERVER }),
    "Tabs are auth-bound to the current conversation thread; cookies, localStorage and IndexedDB are shared within this workspace. Eco binds the browser session automatically; do not pass a custom `session`.",
    `Use the bundled Skill \`${ECO_AGENT_BROWSER_SKILL_NAME}\` for browser workflows. Discover capabilities through tool search; this server exposes tools only.`,
  ].join("\n");
}

export const ECO_AGENT_BROWSER_PROMPT_APPEND = buildEcoAgentBrowserPromptAppend();

/** @deprecated Multi-name servers removed — always use {@link ECO_AGENT_BROWSER_MCP_SERVER}. */
export function ecoAgentBrowserRuntimeServerName(_threadId: string): string {
  return ECO_AGENT_BROWSER_MCP_SERVER;
}

export function ecoAgentBrowserAllowedToolPatternForThread(_threadId?: string): string {
  return ECO_AGENT_BROWSER_ALLOWED_TOOL;
}

/** True for the logical eco browser MCP server name. */
export function isEcoAgentBrowserRuntimeServerName(name: string): boolean {
  const n = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return n === ECO_AGENT_BROWSER_MCP_SERVER || /^eco_ab_e[a-f0-9]{10}$/.test(n);
}

/** Whether Agent may open/navigate URLs without a human click. */
export type BrowserOpenApprovalMode = "always_allow" | "always_ask";

export const BROWSER_OPEN_APPROVAL_MODES = ["always_allow", "always_ask"] as const;

export function isBrowserOpenApprovalMode(value: unknown): value is BrowserOpenApprovalMode {
  return typeof value === "string" && (BROWSER_OPEN_APPROVAL_MODES as readonly string[]).includes(value);
}

export interface BrowserSettingsSnapshot {
  /**
   * When true, `eco_agent_browser` may appear in Composer/workpanel MCP toggles.
   * Does not inject into sessions; each thread enables via mcpServersEnabled.
   */
  agentIntegrationEnabled: boolean;
  /**
   * When Agent calls agent_browser_open / tab_new (open a site).
   * always_allow auto-approves; always_ask shows the same approval card as tools.
   */
  openApprovalMode: BrowserOpenApprovalMode;
}

export function defaultBrowserSettings(): BrowserSettingsSnapshot {
  return {
    agentIntegrationEnabled: false,
    openApprovalMode: "always_allow",
  };
}

export function normalizeBrowserSettingsSnapshot(value: unknown): BrowserSettingsSnapshot {
  if (!value || typeof value !== "object") {
    return defaultBrowserSettings();
  }
  const record = value as Record<string, unknown>;
  return {
    agentIntegrationEnabled: record.agentIntegrationEnabled === true,
    openApprovalMode: isBrowserOpenApprovalMode(record.openApprovalMode)
      ? record.openApprovalMode
      : "always_allow",
  };
}

export function isBrowserSettingsSnapshot(value: unknown): value is BrowserSettingsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.agentIntegrationEnabled !== "boolean") {
    return false;
  }
  if (record.openApprovalMode !== undefined && !isBrowserOpenApprovalMode(record.openApprovalMode)) {
    return false;
  }
  return true;
}

/** Whether tools from the eco browser MCP may be auto-approved via allowedTools. */
export function shouldAutoApproveEcoAgentBrowserTools(mode: BrowserOpenApprovalMode): boolean {
  return mode === "always_allow";
}

/**
 * Tools that *open or create* a navigation surface — gated by openApprovalMode.
 * Snapshot / click / fill are not included (they do not choose a new site by URL).
 */
export function requiresBrowserOpenApproval(toolName: string): boolean {
  const name = toolName.trim().toLowerCase();
  if (!name) {
    return false;
  }
  const isEcoBrowser =
    name.includes("eco_agent_browser") ||
    name.includes("mcp__eco_agent_browser") ||
    name.includes("mcp__eco_ab_") ||
    name.includes("agent_browser_");
  if (!isEcoBrowser) {
    return false;
  }
  if (name.includes("agent_browser_open")) {
    return true;
  }
  if (name.includes("agent_browser_tab_new") || name.includes("tab_new")) {
    return true;
  }
  // navigate / goto when present in the tool name
  if (name.includes("navigate") || name.includes("goto")) {
    return true;
  }
  return false;
}

/** Custom `<webview>` attribute → main-process guest attach (lowercase in Chromium params). */
export const BROWSER_WEBVIEW_TAB_ID_ATTR = "ecobrowsertabid";

export type BrowserInstanceSource = "human" | "agent";

export interface BrowserLoadError {
  code: number;
  description: string;
  url?: string;
}

export interface BrowserInstanceView {
  id: string;
  threadId: string;
  /** Electron session partition for the renderer `<webview>` tag. */
  partition: string;
  url: string;
  title: string;
  /** Page favicon URL from WebContents (`page-favicon-updated`), when available. */
  faviconUrl?: string;
  isLoading: boolean;
  loadError?: BrowserLoadError;
  canGoBack: boolean;
  canGoForward: boolean;
  focused: boolean;
  source: BrowserInstanceSource;
  createdAt: number;
}

/** Renderer `<webview>` guest for every logical browser (includes hidden CDP warmup shells). */
export interface BrowserGuestInstanceView {
  id: string;
  partition: string;
}

/** First usable favicon from Chromium's page-favicon-updated list. */
export function pickBrowserFaviconUrl(favicons: readonly string[] | undefined): string | undefined {
  if (!favicons?.length) {
    return undefined;
  }
  for (const raw of favicons) {
    const url = raw.trim();
    if (!url) {
      continue;
    }
    if (url.startsWith("data:image/") || url.startsWith("https://") || url.startsWith("http://")) {
      return url;
    }
  }
  return undefined;
}

export interface BrowserViewState {
  /** UI scope currently bound for chrome / tab list (active thread or personal). */
  uiScopeId: string;
  /** Task-panel / human-visible tabs only. */
  instances: BrowserInstanceView[];
  /** All logical browsers in {@link uiScopeId} needing a renderer webview guest. */
  guestInstances: BrowserGuestInstanceView[];
  /** All browsers across every thread scope — persistent webview layer uses this. */
  allGuestInstances: BrowserGuestInstanceView[];
  focusedBrowserId?: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  visible: boolean;
  cdpPort?: number;
  agentIntegrationEnabled: boolean;
  agentBrowserAvailable: boolean;
  agentBrowserUnavailableReason?: string;
  /**
   * When set, renderer should open/select the task tab for this browser id.
   * Cleared once the focused browser panel is shown via setVisible(true).
   */
  revealBrowserId?: string;
  /**
   * When set, renderer should force-switch the task panel to this browser tab
   * (even from non-browser tabs). Set by explicit user-initiated browser opens.
   * One-shot: the renderer switches once per new id, and main stops advertising it
   * as soon as that page closes — a stale id re-opens a tab for a dead browser.
   */
  activateBrowserId?: string;
}

export interface BrowserRegisterGuestRequest {
  browserId: string;
  webContentsId: number;
}

export interface BrowserNavigateRequest {
  url: string;
  browserId?: string;
  threadId?: string;
  /** Open the dock (renderer should show panel). Main still navigates regardless. */
  reveal?: boolean;
  /** Landing navigate: align personal-scope partition with this workspace. */
  workspacePath?: string;
}

export interface BrowserOpenRequest {
  url?: string;
  /** Inline HTML opened as a temp preview page when too large for a data URL. */
  htmlContent?: string;
  threadId?: string;
  browserId?: string;
  reveal?: boolean;
  /** When true, open a new browser even if none focused. */
  newBrowser?: boolean;
  /**
   * Landing (no thread) open: workspace path so personal-scope pages use the
   * same cookie partition as the thread that will be created on first send.
   */
  workspacePath?: string;
  /** When true, always switch the task panel to this browser tab (even from non-browser tabs). */
  activate?: boolean;
}

export interface BrowserFocusRequest {
  browserId: string;
  reveal?: boolean;
}

export interface BrowserCloseRequest {
  browserId: string;
}

export interface BrowserSetVisibleRequest {
  visible: boolean;
  browserId?: string;
}

export interface BrowserSetUiScopeRequest {
  threadId: string | null;
}

export function browserTaskTabId(browserId: string): string {
  return `${BROWSER_TASK_TAB_PREFIX}${browserId}`;
}

export function parseBrowserTaskTabId(tabId: string): string | undefined {
  if (!tabId.startsWith(BROWSER_TASK_TAB_PREFIX)) {
    return undefined;
  }
  const id = tabId.slice(BROWSER_TASK_TAB_PREFIX.length).trim();
  return id || undefined;
}

export function isBrowserTaskTabId(tabId: string): boolean {
  return Boolean(parseBrowserTaskTabId(tabId));
}

/**
 * Electron session partition for site data (cookies, localStorage, IndexedDB).
 * Shared by all Eco threads in the same workspace — Cursor-style workspace persist.
 * Open pages / CDP targets stay per-thread in BrowserHost; only the storage bucket is shared.
 */
export function partitionForBrowserWorkspace(workspaceKey: string): string {
  const input = workspaceKey.trim() || ECO_BROWSER_PERSONAL_SCOPE_ID;
  // Normalize path separators so macOS/Windows of the same folder map to one bag.
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  // Hash: absolute workspace paths are too long / noisy for partition names.
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < normalized.length; i += 1) {
    const c = normalized.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  return `persist:eco-browser-w-${hex.slice(0, 16)}`;
}

/**
 * Partition for a BrowserHost scope. Landing (`__personal__`) uses the current
 * workspace when known so pages can later adopt into a new thread without
 * splitting cookies; otherwise falls back to the personal bucket.
 */
export function resolveBrowserScopePartition(
  scopeId: string,
  options?: { workspacePath?: string | null },
): string {
  const workspacePath = options?.workspacePath?.trim();
  if (scopeId === ECO_BROWSER_PERSONAL_SCOPE_ID) {
    if (workspacePath) {
      return partitionForBrowserWorkspace(workspacePath);
    }
    return partitionForBrowserWorkspace(ECO_BROWSER_PERSONAL_SCOPE_ID);
  }
  if (!workspacePath) {
    throw new Error(`无法解析会话 workspacePath（scope=${scopeId}），无法使用 workspace 级浏览器存储分区。`);
  }
  return partitionForBrowserWorkspace(workspacePath);
}

/** How {@link BrowserHost.adoptPersonalScopeToThread} should move personal pages. */
export type AdoptPersonalBrowsersPlan =
  | { kind: "noop" }
  | { kind: "rename"; partitionForFuture: string }
  | { kind: "merge"; partitionForFuture: string };

export function planAdoptPersonalBrowsersToThread(input: {
  personalBrowserCount: number;
  targetExists: boolean;
  targetWorkspacePath?: string | null;
  personalPartition: string;
}): AdoptPersonalBrowsersPlan {
  if (input.personalBrowserCount <= 0) {
    return { kind: "noop" };
  }
  const workspacePath = input.targetWorkspacePath?.trim();
  const partitionForFuture = workspacePath
    ? partitionForBrowserWorkspace(workspacePath)
    : input.personalPartition;
  if (!input.targetExists) {
    return { kind: "rename", partitionForFuture };
  }
  return { kind: "merge", partitionForFuture };
}

/** @deprecated Use {@link partitionForBrowserWorkspace}. Kept for call-site migration. */
export function partitionForBrowserScope(scopeId: string): string {
  return partitionForBrowserWorkspace(scopeId);
}

export function isEcoAgentBrowserEnabledInSettingsMap(
  mcpServersEnabled: Record<string, boolean> | undefined,
): boolean {
  return mcpServersEnabled?.[ECO_AGENT_BROWSER_MCP_SERVER] === true;
}

export function isBrowserHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Temp HTML preview files written by the main process for large Feed HTML blocks. */
export const ECO_HTML_PREVIEW_FILE_PREFIX = "eco-html-preview-";

/** Chromium data URL length budget for inline HTML preview navigations. */
export const HTML_DATA_URL_MAX_BYTES = 1_500_000;

export function isBrowserHtmlDataUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed.startsWith("data:")) {
    return false;
  }
  const comma = trimmed.indexOf(",");
  const meta = (comma >= 0 ? trimmed.slice(5, comma) : trimmed.slice(5)).toLowerCase();
  return meta.startsWith("text/html");
}

export function isBrowserPreviewFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") {
      return false;
    }
    const decoded = decodeURIComponent(parsed.pathname);
    const base = decoded.split(/[/\\]/u).pop() ?? "";
    return base.startsWith(ECO_HTML_PREVIEW_FILE_PREFIX) && base.endsWith(".html");
  } catch {
    return false;
  }
}

export function buildHtmlDataNavigateUrl(html: string): string | undefined {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  if (new TextEncoder().encode(url).byteLength > HTML_DATA_URL_MAX_BYTES) {
    return undefined;
  }
  return url;
}

/** Convert Windows absolute path to file:// URL, or return null if not a Windows path. */
function windowsPathToFileUrl(input: string): string | null {
  // Match Windows absolute paths like C:\path\to\file.html or C:/path/to/file.html
  const match = /^([a-zA-Z]):[\\\/]/.exec(input);
  if (!match) {
    return null;
  }
  // Normalize backslashes to forward slashes
  const normalized = input.replace(/\\/g, "/");
  // Escape special characters for URL
  const escaped = normalized.replace(/[\s]/g, encodeURIComponent);
  // Windows file URLs use three slashes: file:///C:/path
  return `file:///${escaped}`;
}

/**
 * Convert a POSIX absolute path to a file:// URL, or return null if not one.
 * `//host/share` is protocol-relative rather than a local path, so it is rejected.
 */
function posixPathToFileUrl(input: string): string | null {
  if (!input.startsWith("/") || input.startsWith("//")) {
    return null;
  }
  if (/[\x00-\x1f\x7f]/u.test(input)) {
    return null;
  }
  // Encode per segment so spaces / `#` / `?` inside a name stay path characters.
  const escaped = input.split("/").map(encodeURIComponent).join("/");
  return `file://${escaped}`;
}

export function resolveBrowserNavigateTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return (
    normalizeBrowserNavigateUrl(trimmed) ??
    (isBrowserHtmlDataUrl(trimmed) ? trimmed : undefined) ??
    (isBrowserPreviewFileUrl(trimmed) ? trimmed : undefined) ??
    (windowsPathToFileUrl(trimmed) ?? undefined) ??
    (posixPathToFileUrl(trimmed) ?? undefined) ??
    (trimmed === "about:blank" ? "about:blank" : undefined)
  );
}

/** Empty Chromium shells (`about:blank`) are not a user-facing page. */
export function isBrowserPlaceholderUrl(url: string | undefined | null): boolean {
  const value = url?.trim() ?? "";
  return !value || value === "about:blank";
}

/**
 * Handshake / CDP warmup blanks stay hidden until they navigate somewhere real,
 * unless the creator asked to surface the empty shell (human panel, tab_new).
 */
export function shouldSurfaceBrowserInstance(input: { url: string; surfacePlaceholder?: boolean }): boolean {
  if (!isBrowserPlaceholderUrl(input.url)) {
    return true;
  }
  return input.surfacePlaceholder === true;
}

export function normalizeBrowserNavigateUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isBrowserHttpUrl(trimmed)) {
    return trimmed;
  }
  // Support file:// URLs for opening local HTML files
  if (trimmed.startsWith("file://")) {
    return trimmed;
  }
  // Do not promote Eco event labels / tool status strings into https://hosts
  // e.g. "tool.started", "tool.completed" → would become garbage navigations.
  if (isNonNavigablePseudoHost(trimmed)) {
    return undefined;
  }
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(trimmed) && !/\s/.test(trimmed)) {
    const withScheme = `https://${trimmed}`;
    return isBrowserHttpUrl(withScheme) ? withScheme : undefined;
  }
  return undefined;
}

/** Status / event tokens that look like hostnames but must never open a browser tab. */
export function isNonNavigablePseudoHost(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (!text) {
    return false;
  }
  if (/^tool\.(started|completed|result|error|failed|running|pending)/i.test(text)) {
    return true;
  }
  if (/^(bash|mcp|agent)[_-](approval|elicitation)?\./i.test(text)) {
    return true;
  }
  // Bare event types without path
  if (/^(tool|event|status)\.[a-z0-9_.-]+$/i.test(text)) {
    return true;
  }
  return false;
}

export function appendBrowserPrompt(
  base: string | undefined,
  browserAppend: string | undefined,
): string | undefined {
  const parts = mergeEcoMcpHubPromptParts([base, browserAppend]);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n\n");
}

/**
 * Legacy classifier for CDP methods that used to drive UI reveal.
 * UI focus is no longer tied to CDP navigate/activate — only human clicks and tab_switch move it.
 */
export function shouldRevealBrowserForCdpActivity(detail: {
  kind: "ws-connect" | "cdp-method";
  method?: string;
  url?: string;
}): boolean {
  if (detail.kind !== "cdp-method" || !detail.method) {
    return false;
  }
  if (detail.method === "Target.createTarget" && isBrowserPlaceholderUrl(detail.url)) {
    return false;
  }
  return (
    detail.method === "Page.navigate" ||
    detail.method === "Page.navigateToHistoryEntry" ||
    detail.method === "Page.reload" ||
    detail.method === "Target.createTarget" ||
    detail.method === "Target.activateTarget"
  );
}

/** MCP / SDK tool names that mean agent-browser open / navigate on a session guest. */
export function isEcoAgentBrowserOpenToolName(toolName: string): boolean {
  // Open / tab_new only — snapshot/click must not mint browser tabs from tool.started.
  return requiresBrowserOpenApproval(toolName);
}

/**
 * Any eco built-in agent-browser tool name (open / snapshot / click / …).
 * Accepts full MCP names, short server prefixes, and bare agent_browser_* tools.
 */
export function isEcoAgentBrowserToolName(toolName: string | undefined): boolean {
  const name = toolName?.trim().toLowerCase() ?? "";
  if (!name) {
    return false;
  }
  return (
    name.includes("eco_agent_browser") ||
    name.includes("mcp__eco_agent_browser") ||
    name.includes("mcp__eco_ab_") ||
    name.includes("agent_browser_")
  );
}

/**
 * Browser tool suffixes that have their own label in the i18n catalogs.
 * Everything else (a newly added browser tool, for example) must fall back to the
 * generic browser label: building `activity.named.${suffix}` for a name the catalogs
 * do not know renders the raw key in the Feed. Keep in sync with
 * `activity.named.agent_browser_*`.
 */
export const NAMED_AGENT_BROWSER_TOOL_SUFFIXES = new Set([
  "agent_browser_open",
  "agent_browser_snapshot",
  "agent_browser_click",
  "agent_browser_fill",
  "agent_browser_screenshot",
  "agent_browser_get_url",
  "agent_browser_tab_list",
  "agent_browser_tab_new",
  "agent_browser_tab_switch",
]);

/** Whether the catalogs name this browser tool suffix. */
export function hasNamedAgentBrowserLabel(suffix: string): boolean {
  return NAMED_AGENT_BROWSER_TOOL_SUFFIXES.has(suffix.trim().toLowerCase());
}

/** Bare tool segment after `mcp__server__`, or the original when not MCP-shaped. */
export function ecoAgentBrowserToolSuffix(toolName: string): string | undefined {
  const name = toolName.trim();
  if (!name) {
    return undefined;
  }
  const match = name.match(/^mcp__(?:[^_]+(?:_[^_]+)*)__(.+)$/i);
  let suffix = (match?.[1] ?? name).trim().toLowerCase();
  // Pi proxy form `eco_agent_browser_agent_browser_open` → short tool name.
  if (!suffix.startsWith("agent_browser") && suffix.startsWith(`${ECO_AGENT_BROWSER_MCP_SERVER}_`)) {
    suffix = suffix.slice(ECO_AGENT_BROWSER_MCP_SERVER.length + 1);
  }
  if (!suffix.includes("agent_browser")) {
    return undefined;
  }
  return suffix;
}

/** Resolve tool display name from thread-run / SDK payloads. */
export function resolveToolNameFromActivityPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const root = payload as Record<string, unknown>;
  if (typeof root.tool_name === "string" && root.tool_name.trim()) {
    return root.tool_name.trim();
  }
  if (typeof root.name === "string" && root.name.trim()) {
    return root.name.trim();
  }
  const tool = root.tool;
  if (tool && typeof tool === "object" && !Array.isArray(tool)) {
    const name = (tool as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }
  }
  if (typeof root.message === "string") {
    const match = root.message.match(/Tool:\s*([^\s·]+)/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

/** Best-effort URL from tool.started payload (Claude SDK / Codex varies). */
export function extractUrlFromBrowserOpenToolPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const root = payload as Record<string, unknown>;
  const bags: unknown[] = [
    root.url,
    root.href,
    root.input,
    root.tool_input,
    root.arguments,
    root.toolInput,
    root.mcpInput,
  ];
  if (typeof root.tool === "object" && root.tool && !Array.isArray(root.tool)) {
    const tool = root.tool as Record<string, unknown>;
    bags.push(tool.url, tool.input, tool.arguments, tool.tool_input);
  }
  for (const candidate of bags) {
    if (typeof candidate === "string") {
      // Only accept explicit URLs or host-looking strings that are not event labels.
      const normalized = normalizeBrowserNavigateUrl(candidate);
      if (normalized) {
        return normalized;
      }
      const fromString = extractUrlFromLooseText(candidate);
      if (fromString) {
        return fromString;
      }
      continue;
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const rec = candidate as Record<string, unknown>;
      for (const key of ["url", "href", "uri", "target"] as const) {
        if (typeof rec[key] === "string") {
          const normalized = normalizeBrowserNavigateUrl(String(rec[key]));
          if (normalized) {
            return normalized;
          }
        }
      }
    }
  }
  return undefined;
}

function extractUrlFromLooseText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isNonNavigablePseudoHost(trimmed)) {
    return undefined;
  }
  // Prefer explicit http(s) only when scanning free text — avoid bare host false positives.
  const match = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
  if (match?.[0]) {
    return normalizeBrowserNavigateUrl(match[0]);
  }
  return undefined;
}
