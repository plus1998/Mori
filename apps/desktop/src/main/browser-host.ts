import { webChatSitePartition } from "../shared/web-chat-list";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import type { WebContents } from "electron";
import { session, shell, webContents } from "electron";
import {
  appendBrowserPrompt,
  type BrowserInstanceSource,
  type BrowserInstanceView,
  type BrowserLoadError,
  type BrowserViewState,
  browserAgentSessionKey,
  browserPersonalScopeId,
  buildEcoAgentBrowserPromptAppend,
  ECO_AGENT_BROWSER_ALLOWED_TOOL,
  ECO_AGENT_BROWSER_MCP_SERVER,
  ECO_AGENT_BROWSER_PROMPT_APPEND,
  ECO_BROWSER_PERSONAL_SCOPE_ID,
  isBrowserHttpUrl,
  isBrowserPlaceholderUrl,
  isPersonalBrowserScopeId,
  normalizeBrowserNavigateUrl,
  pickBrowserFaviconUrl,
  planAdoptPersonalBrowsersToThread,
  resolveBrowserNavigateTarget,
  resolveBrowserScopePartition,
  shouldAutoApproveEcoAgentBrowserTools,
  shouldSurfaceBrowserInstance,
} from "../shared/browser";
import {
  BROWSER_AGENT_PRESENCE_IDLE_MS,
  BROWSER_AGENT_PRESENCE_MOVE_THROTTLE_MS,
  type BrowserAgentPresenceEvent,
  isBrowserAgentPresencePointerType,
} from "../shared/browser-agent-presence";
import { BROWSER_VIEWPORT_PRESETS, type BrowserViewport, parseBrowserViewport } from "../shared/browser-viewport";
import type { McpSdkConfig } from "../shared/mcp";
import type { AgentBrowserMcpToolResult } from "./agent-browser-cli-bridge";
import { callAgentBrowserToolViaCli, resolveAgentBrowserTabIndex } from "./agent-browser-cli-bridge";
import { resolveAgentBrowserBinary } from "./agent-browser-resolve";
import { type BrowserCdpProxy, type BrowserCdpTarget, assertBrowserGuestWebContents, startMultiBrowserCdpProxy } from "./browser-cdp-proxy";
import { writeBrowserHtmlPreviewTempFile } from "./browser-html-preview";
import { BrowserMcpGateway, mergeEcoBrowserSdkConfig } from "./browser-mcp-gateway";
import {
  agentBrowserTextResult,
  captureGuestScreenshot,
  formatAgentBrowserTabList,
  isFullPageScreenshot,
  resolveAgentBrowserScreenshotPath,
} from "./browser-native-agent-tools";
import { applyBrowserViewport } from "./browser-viewport";
import type { BrowserSettingsStore } from "./browser-settings-store";

export { appendBrowserPrompt };

const HOME_URL = "about:blank";

function resolveAgentBrowserSocketDir(): string {
  try {
    const require = createRequire(import.meta.url);
    const electron = require("electron") as {
      app?: { getPath?: (name: string) => string };
    };
    const userData = electron.app?.getPath?.("userData");
    if (userData?.trim()) {
      return path.join(userData, "ab");
    }
  } catch {
    // fall through
  }
  return path.join(process.cwd(), ".eco-ab");
}

function ensureAgentBrowserRuntimeEnv(cdpPort: number, threadId: string): Record<string, string> {
  const sessionKey = browserAgentSessionKey(threadId);
  const socketDir = path.join(resolveAgentBrowserSocketDir(), sessionKey);
  try {
    fs.mkdirSync(socketDir, { recursive: true });
  } catch {
    // Agent may still fail later; injection keeps trying with the path.
  }
  return {
    AGENT_BROWSER_SOCKET_DIR: socketDir,
    AGENT_BROWSER_SESSION: sessionKey,
    AGENT_BROWSER_CDP: String(cdpPort),
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
    AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
  };
}

export type AgentBrowserMcpInjection = {
  enabled: boolean;
  serverName: string;
  sdkEntry?: Record<string, unknown>;
  codexServer?: CodexMcpServerForConfigSync;
  allowedToolPattern?: string;
  autoApproveTools?: boolean;
  promptAppend?: string;
  unavailableReason?: string;
  cdpPort?: number;
};

export interface SharedBrowserOpenOptions {
  webChatSiteId?: string;
  url?: string;
  htmlContent?: string;
  revealUi?: boolean;
  threadId?: string | null;
  browserId?: string;
  newBrowser?: boolean;
  source?: BrowserInstanceSource;
  workspacePath?: string;
  /** When false, start navigation without awaiting load (agent MCP open). */
  waitForLoad?: boolean;
  /**
   * When false, do not move UI `focusedBrowserId` (agent background tab work).
   * Default: true for human source, false for agent source.
   */
  updateUiFocus?: boolean;
  /** When true, force the renderer to switch the task panel to this browser tab. */
  activate?: boolean;
}

export interface BrowserHostDeps {
  getMainWindow: () => import("electron").BrowserWindow | undefined;
  getSettings: () => BrowserSettingsStore;
  broadcast: (state: BrowserViewState) => void;
  /** Lightweight Agent presence overlays (rainbow edge / synthetic cursor). */
  broadcastAgentPresence?: (event: BrowserAgentPresenceEvent) => void;
  resolveWorkspacePath: (threadId: string) => string | undefined;
}

interface SessionBrowser {
  partition?: string | undefined;
  viewport?: BrowserViewport | undefined;
  viewportError?: string | undefined;
  viewportUpdate?: Promise<unknown> | undefined;
  id: string;
  webContents?: WebContents | undefined;
  pendingUrl?: string | undefined;
  /** Last real URL while guest is detached (panel closed / webview parked). */
  detachedUrl?: string | undefined;
  guestEventsWired?: boolean | undefined;
  /** Last guest webContents.id successfully registered (idempotent dom-ready). */
  registeredGuestWebContentsId?: number | undefined;
  createdAt: number;
  source: BrowserInstanceSource;
  surfacePlaceholder: boolean;
  faviconUrl?: string | undefined;
  loadError?: BrowserLoadError | undefined;
  /** Last URL loaded onto the guest — avoids reload loops on reparent/register. */
  lastLoadedUrl?: string | undefined;
  /** Debounced navigation while guest webContents churns. */
  pendingGuestLoadUrl?: string | undefined;
  guestLoadTimer?: ReturnType<typeof setTimeout> | undefined;
  lastGuestRegisterAt?: number;
}

interface ThreadBrowserScope {
  threadId: string;
  browsers: Map<string, SessionBrowser>;
  /** UI focus: which tab the human sees / user refers to in conversation. */
  focusedBrowserId?: string | undefined;
  cdp?: BrowserCdpProxy | undefined;
  cdpStarting?: Promise<number> | undefined;
  partition: string;
}

/**
 * Per-thread multi-browser host (logical tabs / focus / CDP).
 * Renderer `<webview>` guests supply WebContents; main process owns CDP + agent MCP.
 */
export class BrowserHost {
  private readonly referenceProxies = new Map<string, Promise<BrowserCdpProxy>>();
  private readonly referenceCalls = new Map<string, Promise<unknown>>();
  private readonly scopes = new Map<string, ThreadBrowserScope>();
  private uiScopeId: string = ECO_BROWSER_PERSONAL_SCOPE_ID;
  /** Task panel is presenting a browser tab (used for soft reveal; not native visibility). */
  private panelVisible = false;
  private disposed = false;
  private revealBrowserId: string | undefined;
  /** Browser id that should force task-panel tab switch (user-initiated opens). */
  private activateBrowserId: string | undefined;
  private browserMcpGateway: BrowserMcpGateway | undefined;
  private readonly partitionHandlers = new Set<string>();
  /** will-attach-webview browser id → guest webContents id after did-attach. */
  private readonly pendingGuestByBrowserId = new Map<string, number>();
  private readonly pendingGuestByWebContentsId = new Map<number, string>();
  /** Per-browser idle timers for Agent presence overlay. */
  private readonly agentPresenceIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Browsers currently holding a mouse button (CDP drag). */
  private readonly agentPointerDragging = new Set<string>();
  /** Last mouseMoved IPC emit time per browser (throttle). */
  private readonly agentPointerMoveAt = new Map<string, number>();

  constructor(private readonly deps: BrowserHostDeps) {}

  private gateway(): BrowserMcpGateway {
    if (!this.browserMcpGateway) {
      this.browserMcpGateway = new BrowserMcpGateway({
        ensureCdpPort: (threadId) => this.ensureCdpPort(threadId),
        agentBrowserEnv: (cdpPort, threadId) => ensureAgentBrowserRuntimeEnv(cdpPort, threadId),
        ensureScopeGuestsReady: (threadId) => this.ensureScopeGuestsReady(threadId),
        getFocusedTargetId: (threadId) => this.getFocusedCdpTargetId(threadId),
        afterAgentBrowserClose: (threadId) => this.disposeAllBrowsersInThread(threadId),
        onToolCall: (threadId) => this.noteAgentPresenceForThread(threadId),
        invokeNativeTool: (threadId, toolName, args, signal) =>
          this.invokeNativeAgentBrowserTool(threadId, toolName, args, signal),
      });
    }
    return this.browserMcpGateway;
  }

  noteBrowserToolStarted(threadId: string, toolName?: string): void {
    this.gateway().noteUpcomingTool(threadId, toolName);
    this.noteAgentPresenceForThread(threadId);
  }

  /** Mark Agent operating a browser tab (rainbow edge); resets 15s idle release. */
  noteAgentPresence(
    browserId: string,
    detail?: {
      click?: { x: number; y: number };
      move?: { x: number; y: number; dragging: boolean };
      release?: { x: number; y: number };
    },
  ): void {
    const id = browserId.trim();
    if (!id || this.disposed) {
      return;
    }
    const at = Date.now();
    const moveOnly = Boolean(detail?.move) && !detail?.click && !detail?.release;
    if (!moveOnly) {
      this.emitAgentPresence({ type: "active", browserId: id, at });
    }
    if (detail?.click) {
      this.emitAgentPresence({
        type: "click",
        browserId: id,
        x: detail.click.x,
        y: detail.click.y,
        at,
      });
    }
    if (detail?.move) {
      this.emitAgentPresence({
        type: "move",
        browserId: id,
        x: detail.move.x,
        y: detail.move.y,
        dragging: detail.move.dragging,
        at,
      });
    }
    if (detail?.release) {
      this.emitAgentPresence({
        type: "release",
        browserId: id,
        x: detail.release.x,
        y: detail.release.y,
        at,
      });
    }
    this.scheduleAgentPresenceIdle(id);
  }

  private shouldEmitPointerMove(browserId: string, force: boolean): boolean {
    if (force) {
      this.agentPointerMoveAt.set(browserId, Date.now());
      return true;
    }
    const now = Date.now();
    const prev = this.agentPointerMoveAt.get(browserId) ?? 0;
    if (now - prev < BROWSER_AGENT_PRESENCE_MOVE_THROTTLE_MS) {
      return false;
    }
    this.agentPointerMoveAt.set(browserId, now);
    return true;
  }

  noteAgentPresenceForThread(threadId: string): void {
    const scopeId = threadId.trim();
    if (!scopeId) {
      return;
    }
    const scope = this.scopes.get(scopeId);
    if (!scope || scope.browsers.size === 0) {
      return;
    }
    const browserId =
      scope.focusedBrowserId ?? this.orderedBrowsersInScope(scope)[0]?.id ?? undefined;
    if (!browserId) {
      return;
    }
    this.noteAgentPresence(browserId);
  }

  /**
   * Agent run for this thread has ended (completed / failed / cancelled / app quit) —
   * clear presence overlays immediately instead of waiting out the idle timer.
   */
  clearAgentPresenceForThread(threadId: string): void {
    const scopeId = threadId.trim();
    if (!scopeId || this.disposed) {
      return;
    }
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      return;
    }
    const at = Date.now();
    for (const browser of scope.browsers.values()) {
      this.clearAgentPresenceIdle(browser.id);
      this.agentPointerDragging.delete(browser.id);
      this.agentPointerMoveAt.delete(browser.id);
      this.emitAgentPresence({ type: "idle", browserId: browser.id, at });
    }
  }

  private emitAgentPresence(event: BrowserAgentPresenceEvent): void {
    this.deps.broadcastAgentPresence?.(event);
  }

  private scheduleAgentPresenceIdle(browserId: string): void {
    const existing = this.agentPresenceIdleTimers.get(browserId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.agentPresenceIdleTimers.delete(browserId);
      if (this.disposed) {
        return;
      }
      this.emitAgentPresence({ type: "idle", browserId, at: Date.now() });
    }, BROWSER_AGENT_PRESENCE_IDLE_MS);
    this.agentPresenceIdleTimers.set(browserId, timer);
  }

  private clearAgentPresenceIdle(browserId: string): void {
    const timer = this.agentPresenceIdleTimers.get(browserId);
    if (timer) {
      clearTimeout(timer);
      this.agentPresenceIdleTimers.delete(browserId);
    }
  }

  notePendingGuestAttach(browserId: string): void {
    const id = browserId.trim();
    if (!id) {
      return;
    }
    this.pendingGuestByBrowserId.set(id, -1);
  }

  consumePendingGuestAttach(webContentsId: number): string | undefined {
    const existing = this.pendingGuestByWebContentsId.get(webContentsId);
    if (existing) {
      return existing;
    }
    for (const [browserId, pendingId] of this.pendingGuestByBrowserId) {
      if (pendingId === -1 || pendingId === webContentsId) {
        this.pendingGuestByBrowserId.delete(browserId);
        this.pendingGuestByWebContentsId.set(webContentsId, browserId);
        return browserId;
      }
    }
    return undefined;
  }

  registerGuestWebContents(browserId: string, guest: WebContents): BrowserViewState {
    const found = this.findBrowser(browserId.trim());
    if (!found) {
      throw new Error(`Browser not found: ${browserId}`);
    }
    const { scope, browser } = found;
    if (guest.isDestroyed()) {
      throw new Error("Guest WebContents is destroyed.");
    }
    assertBrowserGuestWebContents(guest);
    const isSameGuest = browser.registeredGuestWebContentsId === guest.id;
    if (isSameGuest) {
      this.emit();
      return this.getState();
    }
    const previousGuestId = browser.registeredGuestWebContentsId;
    const isNewGuest = previousGuestId !== guest.id;
    browser.webContents = guest;
    browser.registeredGuestWebContentsId = guest.id;
    browser.lastGuestRegisterAt = Date.now();
    if (previousGuestId !== undefined && previousGuestId !== guest.id) {
      browser.guestEventsWired = false;
    }
    this.pendingGuestByWebContentsId.set(guest.id, browser.id);
    this.ensurePartitionHandlers(scope.partition);
    this.wireGuestWebContents(scope, browser);
    if (browser.viewport) {
      void this.queueViewportUpdate(browser, async () => {
        try {
          await applyBrowserViewport(guest, browser.viewport ?? null);
          browser.viewportError = undefined;
        } catch (error) {
          browser.viewportError = error instanceof Error ? error.message : String(error);
        }
        this.emit();
      });
    }
    let toLoad = browser.pendingUrl?.trim() || undefined;
    browser.pendingUrl = undefined;
    if (!toLoad) {
      const current = guest.isDestroyed() ? "" : guest.getURL();
      const restore = browser.detachedUrl?.trim() || browser.lastLoadedUrl?.trim();
      if (isBrowserPlaceholderUrl(current) && restore && !isBrowserPlaceholderUrl(restore)) {
        toLoad = restore;
      }
    }
    if (toLoad) {
      const normalizeUrl = (value: string) => value.replace(/\/$/, "") || value;
      const skipRestoreLoad =
        previousGuestId !== undefined &&
        Boolean(browser.lastLoadedUrl?.trim()) &&
        normalizeUrl(browser.lastLoadedUrl!.trim()) === normalizeUrl(toLoad);
      const restoreAfterGuestChurn =
        !skipRestoreLoad &&
        (previousGuestId !== undefined ||
          Boolean(browser.lastLoadedUrl?.trim() || browser.detachedUrl?.trim()));
      if (skipRestoreLoad) {
        browser.detachedUrl = undefined;
      } else if (!restoreAfterGuestChurn) {
        browser.lastLoadedUrl = toLoad;
        void guest.loadURL(toLoad).finally(() => {
          scope.cdp?.notifyTargetInfoChanged(browser.id);
          this.emit();
        });
      } else {
        this.scheduleGuestNavigation(scope, browser, toLoad);
      }
    }
    this.emit();
    return this.getState();
  }

  /** Coalesce loadURL while Electron churns guest webContents ids (destroy/recreate storm). */
  private scheduleGuestNavigation(scope: ThreadBrowserScope, browser: SessionBrowser, target: string): void {
    const url = target.trim();
    if (!url) {
      return;
    }
    browser.pendingGuestLoadUrl = url;
    if (browser.guestLoadTimer) {
      clearTimeout(browser.guestLoadTimer);
    }
    browser.guestLoadTimer = setTimeout(() => {
      browser.guestLoadTimer = undefined;
      const pending = browser.pendingGuestLoadUrl?.trim();
      browser.pendingGuestLoadUrl = undefined;
      const wc = browser.webContents;
      if (!pending || !wc || wc.isDestroyed()) {
        return;
      }
      const current = wc.getURL().trim();
      const guestIsBlank = !current || isBrowserPlaceholderUrl(current);
      const normalize = (value: string) => value.replace(/\/$/, "") || value;
      if (!guestIsBlank && normalize(current) === normalize(pending)) {
        browser.detachedUrl = undefined;
        return;
      }
      browser.lastLoadedUrl = pending;
      void wc.loadURL(pending).finally(() => {
        scope.cdp?.notifyTargetInfoChanged(browser.id);
        this.emit();
      });
    }, 250);
  }

  getState(): BrowserViewState {
    const settings = this.deps.getSettings().get();
    const resolved = resolveAgentBrowserBinary();
    const scope = this.scopes.get(this.uiScopeId);
    const instances = this.listInstancesForScope(this.uiScopeId);
    const guestInstances = this.listGuestInstancesForScope(this.uiScopeId);
    const allGuestInstances = this.listAllGuestInstances();
    const focusedId = scope?.focusedBrowserId;
    const focusedSurfaced = Boolean(focusedId && instances.some((instance) => instance.id === focusedId));
    const focused = focusedSurfaced && focusedId ? scope?.browsers.get(focusedId) : undefined;
    const wc = focused?.webContents;
    const cdpPort = scope?.cdp?.port;
    const revealSurfaced = Boolean(
      this.revealBrowserId && instances.some((instance) => instance.id === this.revealBrowserId),
    );
    // One-shot user "switch to this page" intent: only advertise it while that page exists,
    // otherwise the renderer keeps re-opening a tab (and focusing) a closed browser on every emit.
    const activateSurfaced = Boolean(
      this.activateBrowserId && guestInstances.some((instance) => instance.id === this.activateBrowserId),
    );
    return {
      uiScopeId: this.uiScopeId,
      instances,
      allInstances: [...this.scopes.keys()].flatMap((scopeId) =>
        scopeId === this.uiScopeId ? instances : this.listInstancesForScope(scopeId),
      ),
      guestInstances,
      allGuestInstances,
      ...(focusedSurfaced && focusedId ? { focusedBrowserId: focusedId } : {}),
      url: wc && !wc.isDestroyed() ? wc.getURL() || HOME_URL : HOME_URL,
      title: wc && !wc.isDestroyed() ? wc.getTitle() || "" : "",
      canGoBack: Boolean(
        wc &&
          !wc.isDestroyed() &&
          (wc.navigationHistory?.canGoBack?.() ??
            (typeof wc.canGoBack === "function" ? wc.canGoBack() : false)),
      ),
      canGoForward: Boolean(
        wc &&
          !wc.isDestroyed() &&
          (wc.navigationHistory?.canGoForward?.() ??
            (typeof wc.canGoForward === "function" ? wc.canGoForward() : false)),
      ),
      isLoading: Boolean(wc && !wc.isDestroyed() && wc.isLoading()),
      visible: this.panelVisible,
      ...(typeof cdpPort === "number" ? { cdpPort } : {}),
      agentIntegrationEnabled: settings.agentIntegrationEnabled,
      agentBrowserAvailable: resolved.available,
      ...(resolved.reason ? { agentBrowserUnavailableReason: resolved.reason } : {}),
      ...(revealSurfaced && this.revealBrowserId ? { revealBrowserId: this.revealBrowserId } : {}),
      ...(activateSurfaced && this.activateBrowserId
        ? { activateBrowserId: this.activateBrowserId }
        : {}),
    };
  }

  setUiScope(threadId: string | null, workspacePath?: string): BrowserViewState {
    const next = threadId?.trim() ? threadId.trim() : browserPersonalScopeId(workspacePath);
    if (next !== this.uiScopeId) {
      this.uiScopeId = next;
      this.revealBrowserId = undefined;
    }
    this.emit();
    return this.getState();
  }

  getUiScopeId(): string {
    return this.uiScopeId;
  }

  private emit(): void {
    if (this.disposed) return;
    this.deps.broadcast(this.getState());
  }

  private listInstancesForScope(scopeId: string): BrowserInstanceView[] {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      return [];
    }
    return [...scope.browsers.values()].flatMap((browser) => {
      const wc = browser.webContents;
      const alive = wc && !wc.isDestroyed();
      let url = alive
        ? wc.getURL() || HOME_URL
        : browser.detachedUrl?.trim() || browser.pendingUrl?.trim() || HOME_URL;
      if (
        alive &&
        isBrowserPlaceholderUrl(url) &&
        browser.detachedUrl?.trim() &&
        !isBrowserPlaceholderUrl(browser.detachedUrl)
      ) {
        url = browser.detachedUrl.trim();
      }
      if (
        !shouldSurfaceBrowserInstance({
          url,
          surfacePlaceholder: browser.surfacePlaceholder,
        })
      ) {
        return [];
      }
      const faviconUrl = browser.faviconUrl?.trim();
      return [
        {
          id: browser.id,
          threadId: scope.threadId,
          partition: browser.partition ?? scope.partition,
          url,
          title: alive ? wc.getTitle() || "" : "",
          ...(faviconUrl ? { faviconUrl } : {}),
          isLoading: Boolean(alive && wc.isLoading()),
          ...(browser.loadError ? { loadError: browser.loadError } : {}),
          canGoBack: Boolean(
            alive &&
              (wc.navigationHistory?.canGoBack?.() ??
                (typeof wc.canGoBack === "function" ? wc.canGoBack() : false)),
          ),
          canGoForward: Boolean(
            alive &&
              (wc.navigationHistory?.canGoForward?.() ??
                (typeof wc.canGoForward === "function" ? wc.canGoForward() : false)),
          ),
          focused: scope.focusedBrowserId === browser.id,
          source: browser.source,
          createdAt: browser.createdAt,
          ...(browser.viewport ? { viewport: browser.viewport } : {}),
          ...(browser.viewportError ? { viewportError: browser.viewportError } : {}),
        },
      ];
    });
  }

  private listAllGuestInstances(): Array<{ id: string; partition: string }> {
    const out: Array<{ id: string; partition: string }> = [];
    for (const scope of this.scopes.values()) {
      for (const browser of scope.browsers.values()) {
        out.push({ id: browser.id, partition: browser.partition ?? scope.partition });
      }
    }
    return out;
  }

  private listGuestInstancesForScope(scopeId: string): Array<{ id: string; partition: string }> {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      return [];
    }
    return [...scope.browsers.values()].map((browser) => ({
      id: browser.id,
      partition: browser.partition ?? scope.partition,
    }));
  }

  private resolvePartition(scopeId: string, workspaceHint?: string | null): string {
    if (isPersonalBrowserScopeId(scopeId)) {
      return resolveBrowserScopePartition(scopeId, {
        ...(workspaceHint !== undefined ? { workspacePath: workspaceHint } : {}),
      });
    }
    const workspacePath = workspaceHint?.trim() || this.deps.resolveWorkspacePath(scopeId)?.trim();
    return resolveBrowserScopePartition(scopeId, {
      ...(workspacePath !== undefined ? { workspacePath } : {}),
    });
  }

  private resolveScopeWorkspacePath(scopeId: string): string | undefined {
    return this.deps.resolveWorkspacePath(scopeId)?.trim() || undefined;
  }

  private ensureScope(scopeId: string, workspaceHint?: string | null): ThreadBrowserScope {
    let scope = this.scopes.get(scopeId);
    if (scope) {
      return scope;
    }
    scope = {
      threadId: scopeId,
      browsers: new Map(),
      partition: this.resolvePartition(scopeId, workspaceHint),
    };
    this.scopes.set(scopeId, scope);
    this.ensurePartitionHandlers(scope.partition);
    return scope;
  }

  private ensurePartitionHandlers(partition: string): void {
    if (this.partitionHandlers.has(partition)) {
      return;
    }
    const guestSession = session.fromPartition(partition);
    guestSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    this.partitionHandlers.add(partition);
  }

  private resolveScopeId(threadId?: string | null, workspacePath?: string): string {
    if (typeof threadId === "string" && threadId.trim()) {
      return threadId.trim();
    }
    if (threadId === null || workspacePath?.trim()) {
      return browserPersonalScopeId(workspacePath);
    }
    return this.uiScopeId;
  }

  private createBrowserInScope(
    scope: ThreadBrowserScope,
    source: BrowserInstanceSource,
    options?: { surfacePlaceholder?: boolean },
  ): SessionBrowser {
    const id = randomUUID();
    const browser: SessionBrowser = {
      id,
      createdAt: Date.now(),
      source,
      surfacePlaceholder: options?.surfacePlaceholder !== false,
    };
    scope.browsers.set(id, browser);
    if (!scope.focusedBrowserId && source !== "agent") {
      scope.focusedBrowserId = id;
    }
    scope.cdp?.notifyTargetCreated(id);
    this.notePendingGuestAttach(id);
    return browser;
  }

  private wireGuestWebContents(scope: ThreadBrowserScope, browser: SessionBrowser): void {
    const wc = browser.webContents;
    if (!wc || wc.isDestroyed() || browser.guestEventsWired) {
      return;
    }
    browser.guestEventsWired = true;

    wc.setWindowOpenHandler(({ url }) => {
      if (isBrowserHttpUrl(url)) {
        try {
          const created = this.createBrowserInScope(scope, browser.source);
          created.partition = browser.partition;
          scope.focusedBrowserId = created.id;
          this.requestReveal(created.id);
          created.pendingUrl = url;
          const guest = created.webContents;
          if (guest && !guest.isDestroyed()) {
            void guest.loadURL(url).then(() => {
              scope.cdp?.notifyTargetInfoChanged(created.id);
              this.emit();
            });
          } else {
            this.emit();
          }
        } catch {
          // ignore
        }
      }
      return { action: "deny" };
    });

    const onNav = (_event: unknown, url?: string) => {
      browser.loadError = undefined;
      const target = typeof url === "string" && url.trim() ? url : !wc.isDestroyed() ? wc.getURL() : "";
      if (!isBrowserPlaceholderUrl(target)) {
        browser.detachedUrl = target;
        browser.lastLoadedUrl = target;
      }
      if (isBrowserHttpUrl(target) && scope.focusedBrowserId === browser.id) {
        this.requestReveal(browser.id);
      }
      scope.cdp?.notifyTargetInfoChanged(browser.id);
      this.emit();
    };

    wc.on("did-start-loading", () => {
      browser.loadError = undefined;
      this.emit();
    });
    wc.on("did-stop-loading", () => {
      scope.cdp?.notifyTargetInfoChanged(browser.id);
      this.emit();
    });
    wc.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        if (browser.faviconUrl) {
          browser.faviconUrl = undefined;
          this.emit();
        }
      }
    });
    wc.on("did-navigate", onNav);
    wc.on("did-navigate-in-page", onNav);
    wc.on("page-title-updated", () => {
      scope.cdp?.notifyTargetInfoChanged(browser.id);
      this.emit();
    });
    wc.on("page-favicon-updated", (_event, favicons) => {
      const next = pickBrowserFaviconUrl(favicons);
      if (next === browser.faviconUrl) {
        return;
      }
      browser.faviconUrl = next ?? undefined;
      this.emit();
    });
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // ERR_ABORTED is emitted for normal superseded navigations and should not leave
      // an error card over the next page.
      if (!isMainFrame || errorCode === -3) {
        return;
      }
      browser.loadError = {
        code: errorCode,
        description: errorDescription?.trim() || "未知错误",
        ...(validatedURL?.trim() ? { url: validatedURL.trim() } : {}),
      };
      this.emit();
    });
    wc.on("destroyed", () => {
      if (browser.webContents?.id === wc.id) {
        try {
          const current = wc.getURL();
          if (!isBrowserPlaceholderUrl(current)) {
            browser.detachedUrl = current;
          }
        } catch {
          // ignore
        }
        browser.webContents = undefined;
        browser.guestEventsWired = false;
        browser.registeredGuestWebContentsId = undefined;
        this.notePendingGuestAttach(browser.id);
      }
      this.pendingGuestByWebContentsId.delete(wc.id);
      this.emit();
    });
  }

  private requestReveal(browserId: string): void {
    if (!this.panelVisible) {
      return;
    }
    const found = this.findBrowser(browserId);
    if (!found || found.scope.threadId !== this.uiScopeId) {
      return;
    }
    this.revealBrowserId = browserId;
  }

  private findBrowser(browserId: string): { scope: ThreadBrowserScope; browser: SessionBrowser } | undefined {
    for (const scope of this.scopes.values()) {
      const browser = scope.browsers.get(browserId);
      if (browser) {
        return { scope, browser };
      }
    }
    return undefined;
  }

  private async loadUrlOnBrowser(
    scope: ThreadBrowserScope,
    browser: SessionBrowser,
    url: string,
    options?: { waitForLoad?: boolean },
  ): Promise<void> {
    const wc = browser.webContents;
    const waitForLoad = options?.waitForLoad !== false;
    if (wc && !wc.isDestroyed()) {
      if (waitForLoad) {
        await wc.loadURL(url);
      } else {
        void wc.loadURL(url).finally(() => {
          scope.cdp?.notifyTargetInfoChanged(browser.id);
          this.emit();
        });
      }
      scope.cdp?.notifyTargetInfoChanged(browser.id);
      return;
    }
    browser.pendingUrl = url;
    scope.cdp?.notifyTargetInfoChanged(browser.id);
  }

  async openSharedSession(options: SharedBrowserOpenOptions = {}): Promise<BrowserViewState> {
    const revealUi = options.revealUi !== false;
    const scopeId = this.resolveScopeId(options.threadId, options.workspacePath);
    if (options.browserId && !this.scopes.get(scopeId)?.browsers.has(options.browserId)) {
      throw new Error(`Browser ${options.browserId} does not belong to scope ${scopeId}`);
    }
    const source = options.source ?? "human";
    const updateUiFocus = options.updateUiFocus ?? source === "human";
    if (source !== "agent") {
      if (options.threadId !== undefined) {
        this.uiScopeId = scopeId;
      } else if (scopeId !== this.uiScopeId) {
        this.uiScopeId = scopeId;
      }
    }

    const scope = this.ensureScope(scopeId, options.workspacePath);
    let browser: SessionBrowser | undefined;
    if (options.webChatSiteId) {
      this.ensurePartitionHandlers(webChatSitePartition(options.webChatSiteId));
      browser = this.createBrowserInScope(scope, source);
      browser.partition = webChatSitePartition(options.webChatSiteId);
    }
    if (!browser && options.browserId) {
      browser = scope.browsers.get(options.browserId);
    }
    if (!browser && options.newBrowser) {
      browser = this.createBrowserInScope(scope, source);
    }
    if (!browser && scope.focusedBrowserId) {
      browser = scope.browsers.get(scope.focusedBrowserId);
    }
    if (!browser) {
      const waitingGuest = this.orderedBrowsersInScope(scope).find(
        (candidate) => !candidate.webContents || candidate.webContents.isDestroyed(),
      );
      if (waitingGuest && !options.newBrowser) {
        browser = waitingGuest;
      } else {
        browser = this.createBrowserInScope(scope, source);
      }
    }
    if (updateUiFocus) {
      scope.focusedBrowserId = browser.id;
    }

    if (revealUi && updateUiFocus) {
      this.requestReveal(browser.id);
    }
    if (options.activate) {
      this.activateBrowserId = browser.id;
    }

    const raw = options.url?.trim();
    const htmlContent = options.htmlContent?.trim();
    if (htmlContent) {
      const previewUrl = writeBrowserHtmlPreviewTempFile(htmlContent);
      await this.loadUrlOnBrowser(scope, browser, previewUrl, {
        waitForLoad: options.waitForLoad !== false,
      });
      browser.lastLoadedUrl = previewUrl;
    } else if (raw !== undefined && raw.length > 0) {
      const url = resolveBrowserNavigateTarget(raw);
      if (!url) {
        throw new Error("无效的 URL");
      }
      await this.loadUrlOnBrowser(scope, browser, url, {
        waitForLoad: options.waitForLoad !== false,
      });
      browser.lastLoadedUrl = url;
    }

    this.emit();
    return this.getState();
  }

  focusBrowser(browserId: string, options?: { reveal?: boolean }): BrowserViewState {
    const found = this.findBrowser(browserId);
    if (!found) {
      throw new Error(`Browser not found: ${browserId}`);
    }
    if (found.scope.threadId !== this.uiScopeId) {
      throw new Error(`Browser ${browserId} does not belong to the current UI scope`);
    }
    found.scope.focusedBrowserId = browserId;
    if (options?.reveal !== false) {
      this.requestReveal(browserId);
    }
    this.emit();
    return this.getState();
  }

  closeBrowser(browserId: string): BrowserViewState {
    const found = this.findBrowser(browserId);
    if (!found) {
      return this.getState();
    }
    const { scope, browser } = found;
    this.destroyBrowser(scope, browser);
    scope.cdp?.notifyTargetDestroyed(browserId);
    if (scope.focusedBrowserId === browserId) {
      const next = scope.browsers.keys().next();
      scope.focusedBrowserId = next.done ? undefined : next.value;
    }
    if (this.revealBrowserId === browserId) {
      this.revealBrowserId = scope.focusedBrowserId;
    }
    this.emit();
    return this.getState();
  }

  private destroyBrowser(scope: ThreadBrowserScope, browser: SessionBrowser): void {
    const proxy = this.referenceProxies.get(browser.id);
    this.referenceProxies.delete(browser.id);
    if (proxy) void proxy.then(async value => {
      try {
        const binary = resolveAgentBrowserBinary();
        if (binary.binaryPath) await callAgentBrowserToolViaCli({ binaryPath: binary.binaryPath, cdpPort: value.port,
          sessionKey: browserAgentSessionKey(`reference:${browser.id}`), env: ensureAgentBrowserRuntimeEnv(value.port, `reference:${browser.id}`),
          toolName: "agent_browser_close", args: {}, timeoutMs: 3000 });
      } finally { await value.close(); }
    }).catch(() => {});
    if (browser.guestLoadTimer) {
      clearTimeout(browser.guestLoadTimer);
      browser.guestLoadTimer = undefined;
    }
    browser.pendingGuestLoadUrl = undefined;
    this.clearAgentPresenceIdle(browser.id);
    this.agentPointerDragging.delete(browser.id);
    this.agentPointerMoveAt.delete(browser.id);
    this.emitAgentPresence({ type: "idle", browserId: browser.id, at: Date.now() });
    const wc = browser.webContents;
    try {
      if (wc && !wc.isDestroyed()) {
        this.pendingGuestByWebContentsId.delete(wc.id);
        wc.close();
      }
    } catch {
      // ignore
    }
    browser.webContents = undefined;
    browser.pendingUrl = undefined;
    browser.detachedUrl = undefined;
    this.pendingGuestByBrowserId.delete(browser.id);
    scope.browsers.delete(browser.id);
    if (this.activateBrowserId === browser.id) {
      this.activateBrowserId = undefined;
    }
  }

  setVisible(visible: boolean, browserId?: string): BrowserViewState {
    if (browserId) {
      const found = this.findBrowser(browserId);
      if (!found || found.scope.threadId !== this.uiScopeId) {
        throw new Error(`Browser ${browserId} does not belong to the current UI scope`);
      }
      if (found && visible) {
        this.uiScopeId = found.scope.threadId;
        found.scope.focusedBrowserId = browserId;
      }
    }
    if (visible) {
      this.panelVisible = true;
      if (this.revealBrowserId) {
        const focused = this.scopes.get(this.uiScopeId)?.focusedBrowserId;
        if (focused === this.revealBrowserId || !this.revealBrowserId) {
          this.revealBrowserId = undefined;
        } else if (browserId && browserId === this.revealBrowserId) {
          this.revealBrowserId = undefined;
        } else if (browserId) {
          this.revealBrowserId = undefined;
        }
      }
    } else if (!browserId) {
      this.panelVisible = false;
      this.revealBrowserId = undefined;
    }
    this.emit();
    return this.getState();
  }

  registerGuestByWebContentsId(browserId: string, webContentsId: number): BrowserViewState {
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      throw new Error(`Guest WebContents not found: ${webContentsId}`);
    }
    return this.registerGuestWebContents(browserId, wc);
  }

  async navigate(
    rawUrl: string,
    options?: { reveal?: boolean; browserId?: string; threadId?: string },
  ): Promise<BrowserViewState> {
    return this.openSharedSession({
      url: rawUrl,
      revealUi: options?.reveal !== false,
      ...(options?.browserId ? { browserId: options.browserId } : {}),
      ...(options?.threadId ? { threadId: options.threadId } : {}),
    });
  }

  goBack(browserId?: string): BrowserViewState {
    const browser = this.requireFocusedOrId(browserId);
    const wc = browser.webContents;
    if (!wc || wc.isDestroyed()) {
      throw new Error("Browser guest is not attached.");
    }
    if (wc.navigationHistory?.canGoBack?.()) {
      wc.navigationHistory.goBack();
    } else if (typeof wc.canGoBack === "function" && wc.canGoBack()) {
      wc.goBack();
    }
    this.emit();
    return this.getState();
  }

  goForward(browserId?: string): BrowserViewState {
    const browser = this.requireFocusedOrId(browserId);
    const wc = browser.webContents;
    if (!wc || wc.isDestroyed()) {
      throw new Error("Browser guest is not attached.");
    }
    if (wc.navigationHistory?.canGoForward?.()) {
      wc.navigationHistory.goForward();
    } else if (typeof wc.canGoForward === "function" && wc.canGoForward()) {
      wc.goForward();
    }
    this.emit();
    return this.getState();
  }

  reload(browserId?: string): BrowserViewState {
    const browser = this.requireFocusedOrId(browserId);
    const wc = browser.webContents;
    if (!wc || wc.isDestroyed()) {
      throw new Error("Browser guest is not attached.");
    }
    wc.reload();
    this.emit();
    return this.getState();
  }

  private requireFocusedOrId(browserId?: string): SessionBrowser {
    if (browserId) {
      const found = this.findBrowser(browserId);
      if (!found) {
        throw new Error(`Browser not found: ${browserId}`);
      }
      if (found.scope.threadId !== this.uiScopeId) {
        throw new Error(`Browser ${browserId} does not belong to the current UI scope`);
      }
      return found.browser;
    }
    const scope = this.scopes.get(this.uiScopeId);
    const id = scope?.focusedBrowserId;
    const browser = id ? scope?.browsers.get(id) : undefined;
    if (!browser) {
      throw new Error("No focused browser");
    }
    return browser;
  }

  async openExternalCurrent(browserId?: string): Promise<void> {
    const browser = this.requireFocusedOrId(browserId);
    const wc = browser.webContents;
    const url = wc && !wc.isDestroyed() ? wc.getURL() : (browser.pendingUrl ?? "");
    if (isBrowserHttpUrl(url)) {
      await shell.openExternal(url);
    }
  }

  private async waitForGuestWebContents(browserId: string, timeoutMs = 30_000): Promise<WebContents> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = this.findBrowser(browserId);
      const wc = found?.browser.webContents;
      if (wc && !wc.isDestroyed()) {
        return wc;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Browser guest WebContents not attached within ${timeoutMs}ms (id=${browserId}). Is the task panel browser tab mounted?`,
    );
  }

  private async blurMainRendererForGuestKeyboardInput(): Promise<void> {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    try {
      const composerStillFocused = await win.webContents.executeJavaScript(
        `(function(){
          const a = document.activeElement;
          if (!a || a === document.body || a === document.documentElement) return false;
          try { a.blur(); } catch {}
          const after = document.activeElement;
          return after && after !== document.body && after.closest && after.closest('.composer-skill-input-control');
        })()`,
        true,
      );
      if (composerStillFocused) {
        throw new Error("Composer still holds keyboard focus; refusing guest keyboard input");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Composer still holds")) {
        throw error;
      }
      // ignore blur failures on destroyed/unready renderer
    }
  }

  async ensureCdpPort(threadId: string): Promise<number> {
    const scopeId = threadId.trim() || ECO_BROWSER_PERSONAL_SCOPE_ID;
    if (isPersonalBrowserScopeId(scopeId)) {
      throw new Error("Agent browser CDP requires a conversation thread id");
    }
    const scope = this.ensureScope(scopeId, this.resolveScopeWorkspacePath(scopeId));
    if (scope.cdp) {
      return scope.cdp.port;
    }
    if (scope.cdpStarting) {
      return scope.cdpStarting;
    }
    scope.cdpStarting = (async () => {
      const proxy = await startMultiBrowserCdpProxy({
        getTargets: () => this.cdpTargetsForScope(scope),
        onCreateTarget: async (url) => {
          const placeholder = isBrowserPlaceholderUrl(url);
          if (placeholder && scope.browsers.size === 0) {
            throw new Error(
              "No browser tabs in this session. Use agent_browser_open or agent_browser_tab_new first.",
            );
          }
          const created =
            this.orderedBrowsersInScope(scope).find((b) => {
              const wc = b.webContents;
              if (!wc || wc.isDestroyed()) {
                // Reuse any shell still waiting for guest (even with a pending real URL).
                return true;
              }
              const current = wc.getURL();
              return isBrowserPlaceholderUrl(current);
            }) ??
            this.createBrowserInScope(scope, "agent", {
              surfacePlaceholder: !placeholder,
            });
          if (!placeholder) {
            created.surfacePlaceholder = true;
          }
          if (url && (normalizeBrowserNavigateUrl(url) || url === HOME_URL || url === "about:blank")) {
            const target =
              normalizeBrowserNavigateUrl(url) ??
              (url === HOME_URL || url === "about:blank" ? HOME_URL : undefined);
            if (target) {
              await this.loadUrlOnBrowser(scope, created, target);
            }
          }
          this.emit();
          const wc = await this.waitForGuestWebContents(created.id);
          return { id: created.id, webContents: wc };
        },
        onActivateTarget: (_targetId) => {
          // Agent CDP may activate any target; UI focus stays on the human's tab.
        },
        onCloseTarget: async (targetId) => {
          const browser = scope.browsers.get(targetId);
          if (!browser) {
            return;
          }
          this.destroyBrowser(scope, browser);
          if (scope.focusedBrowserId === targetId) {
            const next = scope.browsers.keys().next();
            scope.focusedBrowserId = next.done ? undefined : next.value;
          }
          if (this.revealBrowserId === targetId) {
            this.revealBrowserId = scope.focusedBrowserId;
          }
          this.emit();
        },
        onClientActivity: (detail) => {
          // CDP navigate/activate must not move UI focus — only tab_switch / human clicks do.
          const targetId = detail.targetId?.trim();
          if (!targetId) {
            return;
          }
          const mouse = detail.mouse;
          if (
            mouse &&
            detail.method === "Input.dispatchMouseEvent" &&
            isBrowserAgentPresencePointerType(mouse.type)
          ) {
            if (mouse.type === "mousePressed") {
              this.agentPointerDragging.add(targetId);
              this.noteAgentPresence(targetId, { click: { x: mouse.x, y: mouse.y } });
              return;
            }
            if (mouse.type === "mouseMoved") {
              const dragging =
                this.agentPointerDragging.has(targetId) || ((mouse.buttons ?? 0) & 1) === 1;
              if (dragging) {
                this.agentPointerDragging.add(targetId);
              }
              if (this.shouldEmitPointerMove(targetId, false)) {
                this.noteAgentPresence(targetId, {
                  move: { x: mouse.x, y: mouse.y, dragging },
                });
              } else {
                this.scheduleAgentPresenceIdle(targetId);
              }
              return;
            }
            if (mouse.type === "mouseReleased") {
              this.agentPointerDragging.delete(targetId);
              this.shouldEmitPointerMove(targetId, true);
              this.noteAgentPresence(targetId, { release: { x: mouse.x, y: mouse.y } });
              return;
            }
          }
          this.noteAgentPresence(targetId);
        },
        onPrepareGuestKeyboardInput: async () => {
          await this.blurMainRendererForGuestKeyboardInput();
        },
        isForbiddenWebContents: (wc) => {
          const win = this.deps.getMainWindow();
          return Boolean(win && !win.isDestroyed() && win.webContents.id === wc.id);
        },
      });
      scope.cdp = proxy;
      this.emit();
      return proxy.port;
    })();
    try {
      return await scope.cdpStarting;
    } finally {
      scope.cdpStarting = undefined;
    }
  }

  private orderedBrowsersInScope(scope: ThreadBrowserScope): SessionBrowser[] {
    return [...scope.browsers.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private cdpTargetsForScope(scope: ThreadBrowserScope): BrowserCdpTarget[] {
    const out: BrowserCdpTarget[] = [];
    for (const browser of this.orderedBrowsersInScope(scope)) {
      if (browser.webContents && !browser.webContents.isDestroyed()) {
        out.push({ id: browser.id, webContents: browser.webContents });
      }
    }
    return out;
  }

  private async queueViewportUpdate<T>(browser: SessionBrowser, update: () => Promise<T>): Promise<T> {
    const previous = browser.viewportUpdate ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(update);
    browser.viewportUpdate = pending;
    try {
      return await pending;
    } finally {
      if (browser.viewportUpdate === pending) browser.viewportUpdate = undefined;
    }
  }

  async setViewport(browserId: string, input: unknown): Promise<BrowserViewState> {
    const viewport = parseBrowserViewport(input);
    const found = this.findBrowser(browserId);
    if (!found) throw new Error(`Browser not found: ${browserId}`);
    const { browser } = found;
    await this.waitForGuestWebContents(browserId);
    return this.queueViewportUpdate(browser, async () => {
      const guest = browser.webContents;
      if (!guest || guest.isDestroyed()) throw new Error("Browser guest is unavailable.");
      try {
        await applyBrowserViewport(guest, viewport);
        browser.viewport = viewport ?? undefined;
        browser.viewportError = undefined;
      } catch (error) {
        browser.viewportError = error instanceof Error ? error.message : String(error);
        this.emit();
        throw error;
      }
      this.emit();
      return this.getState();
    });
  }

  private async invokeNativeAgentBrowserViewport(
    threadId: string,
    args?: Record<string, unknown>,
  ): Promise<AgentBrowserMcpToolResult> {
    const browserId = this.getFocusedCdpTargetId(threadId);
    if (args) await this.setViewport(browserId, args);
    const found = this.findBrowser(browserId);
    if (!found?.browser.webContents || found.scope.threadId !== threadId.trim())
      throw new Error("Browser target is unavailable in this conversation.");
    const browser = found.browser;
    if (browser.viewportUpdate) await browser.viewportUpdate;
    if (browser.viewportError) throw new Error(browser.viewportError);
    const metrics = await browser.webContents!.executeJavaScript(`({
      width: innerWidth, height: innerHeight,
      deviceScaleFactor: devicePixelRatio,
      screenWidth: screen.width, screenHeight: screen.height,
      touchPoints: navigator.maxTouchPoints,
      orientation: screen.orientation.type,
      visualViewport: { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale }
    })`);
    return agentBrowserTextResult(JSON.stringify({ browserId, viewport: browser.viewport ?? null, metrics }));
  }

  /** Resolve a real guest for human-selected content, never the Eco main window. */
  getSelectionTarget(browserId: string): { guest: WebContents; instance: BrowserInstanceView } {
    const found = this.findBrowser(browserId);
    const instance = this.getState().allInstances.find(item => item.id === browserId);
    if (!found?.browser.webContents || !instance || found.browser.webContents.isDestroyed())
      throw new Error("引用的网页已关闭或尚未就绪。");
    assertBrowserGuestWebContents(found.browser.webContents);
    return { guest: found.browser.webContents, instance };
  }

  /** User-selected references have their own single-page CDP target and CLI session. */
  async invokeReferencedBrowserTool(browserId: string, action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentBrowserMcpToolResult> {
    const allowed = new Set(["snapshot", "read", "click", "fill", "type", "press", "check", "uncheck", "select", "scroll", "get_text", "get_url", "get_title", "screenshot", "wait_for_selector", "wait_for_text", "wait_for_load", "reload", "back", "forward"]);
    if (!action.startsWith("agent_browser_") || !allowed.has(action.slice("agent_browser_".length))) throw new Error("该操作不适用于网页引用。");
    if (["url", "href", "session", "cdp", "tabId", "browserId", "targetId", "extraArgs"].some(key => Object.hasOwn(args, key))) throw new Error("网页引用不能改用其他地址、会话或标签页。");
    const previous = this.referenceCalls.get(browserId) ?? Promise.resolve();
    const call = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const found = this.findBrowser(browserId);
      if (!found || !shouldSurfaceBrowserInstance({ url: this.resolveBrowserTabUrl(found.browser), surfacePlaceholder: found.browser.surfacePlaceholder })) throw new Error("引用的网页已关闭。");
      const guest = await this.waitForGuestWebContents(browserId);
      this.noteAgentPresence(browserId);
      if (action === "agent_browser_screenshot") {
        const output = resolveAgentBrowserScreenshotPath(args);
        return agentBrowserTextResult(await captureGuestScreenshot(guest, output, isFullPageScreenshot(args)));
      }
      let pending = this.referenceProxies.get(browserId);
      if (!pending) {
        pending = startMultiBrowserCdpProxy({
          getTargets: () => { const wc = this.findBrowser(browserId)?.browser.webContents; return wc && !wc.isDestroyed() ? [{ id: browserId, webContents: wc }] : []; },
          onPrepareGuestKeyboardInput: () => this.blurMainRendererForGuestKeyboardInput(),
          onClientActivity: () => this.noteAgentPresence(browserId),
          isForbiddenWebContents: wc => wc.id === this.deps.getMainWindow()?.webContents.id,
        });
        this.referenceProxies.set(browserId, pending);
        pending.catch(() => { if (this.referenceProxies.get(browserId) === pending) this.referenceProxies.delete(browserId); });
      }
      const proxy = await pending;
      const binary = resolveAgentBrowserBinary();
      if (!binary.available || !binary.binaryPath) throw new Error(binary.reason ?? "agent-browser 不可用");
      const sessionId = `reference:${browserId}`;
      return callAgentBrowserToolViaCli({ binaryPath: binary.binaryPath, cdpPort: proxy.port, cdpTargetId: browserId,
        sessionKey: browserAgentSessionKey(sessionId), env: ensureAgentBrowserRuntimeEnv(proxy.port, sessionId), toolName: action, args, ...(signal ? { signal } : {}) });
    });
    this.referenceCalls.set(browserId, call);
    try { return await call; } finally { if (this.referenceCalls.get(browserId) === call) this.referenceCalls.delete(browserId); }
  }

  /** Exact guest used by both native tools and the CLI connection. */
  private getFocusedCdpTargetId(threadId: string): string {
    const scope = this.scopes.get(threadId.trim());
    const browserId = scope?.focusedBrowserId ?? scope?.browsers.keys().next().value;
    const browser = browserId ? scope?.browsers.get(browserId) : undefined;
    if (!browser?.webContents || browser.webContents.isDestroyed()) {
      throw new Error("No browser target available in this session");
    }
    return browser.id;
  }

  /** Wait for focused (or first) guest before page-level CDP tools run. */
  async ensureScopeGuestsReady(threadId: string): Promise<void> {
    const scopeId = threadId.trim() || ECO_BROWSER_PERSONAL_SCOPE_ID;
    const scope = this.scopes.get(scopeId);
    if (!scope || scope.browsers.size === 0) {
      return;
    }
    const browserId = scope.focusedBrowserId ?? scope.browsers.keys().next().value ?? undefined;
    if (!browserId) {
      return;
    }
    const browser = scope.browsers.get(browserId);
    if (browser?.webContents && !browser.webContents.isDestroyed()) {
      return;
    }
    this.notePendingGuestAttach(browserId);
    await this.waitForGuestWebContents(browserId);
  }

  /** Eco-native MCP tools that bypass agent-browser CLI (tab list, open, screenshot, …). */
  async invokeNativeAgentBrowserTool(
    threadId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentBrowserMcpToolResult | null> {
    signal?.throwIfAborted();
    this.noteAgentPresenceForThread(threadId);
    switch (toolName) {
      case "agent_browser_list_devices":
        return agentBrowserTextResult(JSON.stringify({ devices: BROWSER_VIEWPORT_PRESETS }));
      case "agent_browser_set_viewport":
        await this.ensureScopeGuestsReady(threadId);
        return this.invokeNativeAgentBrowserViewport(threadId, args);
      case "agent_browser_get_viewport":
        await this.ensureScopeGuestsReady(threadId);
        return this.invokeNativeAgentBrowserViewport(threadId);
      case "agent_browser_tab_list":
        return this.invokeNativeAgentBrowserTabList(threadId);
      case "agent_browser_tab_new":
        return this.invokeNativeAgentBrowserTabNew(threadId, args);
      case "agent_browser_tab_switch":
        return this.invokeNativeAgentBrowserTabSwitch(threadId, args);
      case "agent_browser_tab_close":
        return this.invokeNativeAgentBrowserTabClose(threadId);
      case "agent_browser_screenshot":
        return this.invokeNativeAgentBrowserScreenshot(threadId, args);
      case "agent_browser_open":
        return this.invokeNativeAgentBrowserOpen(threadId, args);
      default:
        return null;
    }
  }

  private resolveBrowserTabUrl(browser: SessionBrowser): string {
    const wc = browser.webContents;
    const alive = wc && !wc.isDestroyed();
    let url = alive
      ? wc.getURL() || HOME_URL
      : browser.detachedUrl?.trim() || browser.pendingUrl?.trim() || HOME_URL;
    if (
      alive &&
      isBrowserPlaceholderUrl(url) &&
      browser.detachedUrl?.trim() &&
      !isBrowserPlaceholderUrl(browser.detachedUrl)
    ) {
      url = browser.detachedUrl.trim();
    }
    return url;
  }

  private listAgentBrowserTabs(threadId: string) {
    const scope = this.scopes.get(threadId.trim());
    if (!scope) {
      return [];
    }
    return this.orderedBrowsersInScope(scope).map((browser) => ({
      id: browser.id,
      url: this.resolveBrowserTabUrl(browser),
    }));
  }

  private invokeNativeAgentBrowserTabList(threadId: string): AgentBrowserMcpToolResult {
    const tabs = this.listAgentBrowserTabs(threadId);
    const text = formatAgentBrowserTabList(tabs);
    return agentBrowserTextResult(text);
  }

  private async invokeNativeAgentBrowserTabSwitch(
    threadId: string,
    args: Record<string, unknown>,
  ): Promise<AgentBrowserMcpToolResult> {
    const scopeId = threadId.trim();
    const scope = this.scopes.get(scopeId);
    if (!scope || scope.browsers.size === 0) {
      throw new Error(
        "No browser tabs in this session. Use agent_browser_open or agent_browser_tab_new first.",
      );
    }
    const ordered = this.orderedBrowsersInScope(scope);
    const index = resolveAgentBrowserTabIndex(args, ordered.length);
    const browser = ordered[index];
    if (!browser) {
      throw new Error(`Tab t${index + 1} not found (${ordered.length} tab(s) open)`);
    }
    scope.focusedBrowserId = browser.id;
    this.requestReveal(browser.id);
    await this.ensureScopeGuestsReady(scopeId);
    this.emit();
    return agentBrowserTextResult(`Switched to t${index + 1}`);
  }

  private invokeNativeAgentBrowserTabClose(threadId: string): AgentBrowserMcpToolResult {
    const scope = this.scopes.get(threadId.trim());
    if (!scope || scope.browsers.size === 0) {
      throw new Error("No tabs to close");
    }
    const browserId = scope.focusedBrowserId ?? this.orderedBrowsersInScope(scope)[0]?.id ?? undefined;
    if (!browserId) {
      throw new Error("No tabs to close");
    }
    this.closeBrowser(browserId);
    return agentBrowserTextResult("Tab closed");
  }

  private async invokeNativeAgentBrowserTabNew(
    threadId: string,
    args: Record<string, unknown>,
  ): Promise<AgentBrowserMcpToolResult> {
    const rawUrl = args.url ?? args.href;
    const urlInput = typeof rawUrl === "string" ? rawUrl.trim() : "";
    const url = urlInput ? normalizeBrowserNavigateUrl(urlInput) : undefined;
    if (urlInput && !url) {
      throw new Error("agent_browser_tab_new url is invalid");
    }
    await this.openSharedSession({
      threadId,
      ...(url ? { url } : {}),
      newBrowser: true,
      revealUi: false,
      updateUiFocus: false,
      source: "agent",
      waitForLoad: false,
    });
    await this.ensureScopeGuestsReady(threadId);
    return agentBrowserTextResult(url ? `Opened new tab: ${url}` : "Opened new tab");
  }

  private async invokeNativeAgentBrowserScreenshot(
    threadId: string,
    args: Record<string, unknown>,
  ): Promise<AgentBrowserMcpToolResult> {
    const outputPath = resolveAgentBrowserScreenshotPath(args);
    const full = isFullPageScreenshot(args);
    await this.ensureScopeGuestsReady(threadId);
    const scope = this.ensureScope(threadId.trim());
    const browserId = scope.focusedBrowserId ?? scope.browsers.keys().next().value ?? undefined;
    if (!browserId) {
      throw new Error("No browser target available in this session");
    }
    const wc = await this.waitForGuestWebContents(browserId);
    const found = this.findBrowser(browserId);
    if (found) {
      this.emit();
    }
    const savedPath = await captureGuestScreenshot(wc, outputPath, full);
    const bytes = fs.statSync(savedPath).size;
    if (bytes < 512) {
      throw new Error(`Screenshot file is empty (${bytes} bytes)`);
    }
    return agentBrowserTextResult(savedPath);
  }

  private async invokeNativeAgentBrowserOpen(
    threadId: string,
    args: Record<string, unknown>,
  ): Promise<AgentBrowserMcpToolResult> {
    const rawUrl = args.url ?? args.href ?? args.target;
    const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!url) {
      throw new Error("agent_browser_open requires url");
    }
    await this.openSharedSession({
      threadId,
      url,
      revealUi: false,
      updateUiFocus: false,
      source: "agent",
      waitForLoad: false,
      // Navigate the UI-focused tab (user context); do not change which tab is shown.
    });
    await this.ensureScopeGuestsReady(threadId);
    this.noteAgentPresenceForThread(threadId);
    return agentBrowserTextResult(`Navigated to ${url}`);
  }

  /** agent_browser_close ends CLI session — also tear down Eco scope pages. */
  async disposeAllBrowsersInThread(threadId: string): Promise<void> {
    const scopeId = threadId.trim();
    if (!scopeId || isPersonalBrowserScopeId(scopeId)) {
      return;
    }
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      return;
    }
    await this.tearDownScopeCdp(scope);
    for (const browser of [...scope.browsers.values()]) {
      this.destroyBrowser(scope, browser);
    }
    scope.focusedBrowserId = undefined;
    if (this.revealBrowserId && !scope.browsers.has(this.revealBrowserId)) {
      this.revealBrowserId = undefined;
    }
    this.emit();
  }

  isFeatureAvailable(): { available: boolean; reason?: string } {
    const settings = this.deps.getSettings().get();
    if (!settings.agentIntegrationEnabled) {
      return { available: false, reason: "内置浏览器 Agent 能力未在设置中开启" };
    }
    const resolved = resolveAgentBrowserBinary();
    if (!resolved.available) {
      return { available: false, reason: resolved.reason ?? "agent-browser 不可用" };
    }
    return { available: true };
  }

  getAgentPromptAppend(sessionEnabled: boolean, threadId?: string): string | undefined {
    if (!sessionEnabled || !this.deps.getSettings().get().agentIntegrationEnabled) {
      return undefined;
    }
    const tid = threadId?.trim();
    if (!tid) {
      return ECO_AGENT_BROWSER_PROMPT_APPEND;
    }
    return buildEcoAgentBrowserPromptAppend(tid);
  }

  async resolveGlobalAgentBrowserMcpServer(): Promise<CodexMcpServerForConfigSync | undefined> {
    const settings = this.deps.getSettings().get();
    if (!settings.agentIntegrationEnabled) {
      return undefined;
    }
    const resolved = resolveAgentBrowserBinary();
    if (!resolved.available || !resolved.binaryPath) {
      throw new Error(resolved.reason ?? "agent-browser unavailable");
    }
    return this.gateway().prepareCodexServer();
  }

  async resolveAgentBrowserMcpInjection(input: {
    threadId: string;
    sessionEnabled: boolean;
  }): Promise<AgentBrowserMcpInjection> {
    const settings = this.deps.getSettings().get();
    if (!settings.agentIntegrationEnabled) {
      return { enabled: false, serverName: ECO_AGENT_BROWSER_MCP_SERVER };
    }
    if (!input.sessionEnabled) {
      return { enabled: false, serverName: ECO_AGENT_BROWSER_MCP_SERVER };
    }
    const resolved = resolveAgentBrowserBinary();
    if (!resolved.available || !resolved.binaryPath) {
      return {
        enabled: false,
        serverName: ECO_AGENT_BROWSER_MCP_SERVER,
        unavailableReason: resolved.reason ?? "agent-browser 不可用",
      };
    }
    try {
      const prepared = await this.gateway().prepareThread(input.threadId);
      const autoApproveTools = shouldAutoApproveEcoAgentBrowserTools(settings.openApprovalMode);
      return {
        enabled: true,
        serverName: ECO_AGENT_BROWSER_MCP_SERVER,
        sdkEntry: prepared.sdkEntry,
        codexServer: prepared.codexServer,
        allowedToolPattern: ECO_AGENT_BROWSER_ALLOWED_TOOL,
        autoApproveTools,
        promptAppend: prepared.promptAppend,
        ...(typeof prepared.cdpPort === "number" ? { cdpPort: prepared.cdpPort } : {}),
      };
    } catch (error) {
      return {
        enabled: false,
        serverName: ECO_AGENT_BROWSER_MCP_SERVER,
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  mergeIntoSdkMcpConfig(base: McpSdkConfig, injection: AgentBrowserMcpInjection): McpSdkConfig {
    return mergeEcoBrowserSdkConfig(base, {
      enabled: injection.enabled,
      ...(injection.sdkEntry ? { sdkEntry: injection.sdkEntry } : {}),
      ...(injection.autoApproveTools !== undefined ? { autoApproveTools: injection.autoApproveTools } : {}),
    });
  }

  async adoptPersonalScopeToThread(threadId: string): Promise<BrowserViewState> {
    const targetId = threadId.trim();
    if (!targetId || isPersonalBrowserScopeId(targetId)) {
      throw new Error("adoptPersonalScopeToThread requires a real conversation thread id");
    }

    const targetWorkspacePath = this.deps.resolveWorkspacePath(targetId);
    if (!targetWorkspacePath?.trim()) {
      throw new Error(`无法解析会话 workspacePath（scope=${targetId}），不能迁移项目浏览器`);
    }
    const personalScopeId = browserPersonalScopeId(targetWorkspacePath);
    const personal = this.scopes.get(personalScopeId);
    const followAdoption = () => this.uiScopeId === personalScopeId || this.uiScopeId === targetId;
    const plan = planAdoptPersonalBrowsersToThread({
      personalBrowserCount: personal?.browsers.size ?? 0,
      targetExists: this.scopes.has(targetId),
      ...(targetWorkspacePath !== undefined ? { targetWorkspacePath } : {}),
      personalPartition: personal?.partition ?? resolveBrowserScopePartition(ECO_BROWSER_PERSONAL_SCOPE_ID),
    });

    if (plan.kind === "noop") {
      return followAdoption() ? this.setUiScope(targetId) : this.getState();
    }

    if (!personal) {
      return followAdoption() ? this.setUiScope(targetId) : this.getState();
    }

    await this.tearDownScopeCdp(personal);

    if (plan.kind === "rename") {
      this.scopes.delete(personalScopeId);
      personal.threadId = targetId;
      personal.partition = plan.partitionForFuture;
      this.scopes.set(targetId, personal);
    } else {
      const target = this.ensureScope(targetId, targetWorkspacePath);
      await this.tearDownScopeCdp(target);
      for (const [id, browser] of personal.browsers) {
        target.browsers.set(id, browser);
      }
      if (personal.focusedBrowserId) {
        target.focusedBrowserId = personal.focusedBrowserId;
      }
      target.partition = plan.partitionForFuture;
      personal.browsers.clear();
      personal.focusedBrowserId = undefined;
      this.scopes.delete(personalScopeId);
    }

    if (followAdoption()) {
      this.uiScopeId = targetId;
      this.revealBrowserId = undefined;
    }
    this.emit();
    return this.getState();
  }

  private async tearDownScopeCdp(scope: ThreadBrowserScope): Promise<void> {
    if (scope.cdpStarting) {
      try {
        await scope.cdpStarting;
      } catch {
        // ignore
      }
      scope.cdpStarting = undefined;
    }
    if (scope.cdp) {
      await scope.cdp.close();
      scope.cdp = undefined;
    }
  }

  async disposeThreadScope(threadId: string): Promise<void> {
    this.gateway().disposeThread(threadId);
    const scope = this.scopes.get(threadId);
    if (!scope) {
      return;
    }
    if (scope.cdp) {
      await scope.cdp.close();
      scope.cdp = undefined;
    }
    for (const browser of [...scope.browsers.values()]) {
      this.destroyBrowser(scope, browser);
    }
    this.scopes.delete(threadId);
    if (this.uiScopeId === threadId) {
      this.uiScopeId = ECO_BROWSER_PERSONAL_SCOPE_ID;
    }
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.revealBrowserId = undefined;
    void this.browserMcpGateway?.close();
    this.browserMcpGateway = undefined;
    for (const scope of this.scopes.values()) {
      void scope.cdp?.close();
      for (const browser of [...scope.browsers.values()]) {
        this.destroyBrowser(scope, browser);
      }
    }
    this.scopes.clear();
  }
}

export function isWebContentsAlive(wc: WebContents | undefined): wc is WebContents {
  return Boolean(wc && !wc.isDestroyed());
}

export function isSessionEcoBrowserEnabled(mcpServersEnabled: Record<string, boolean> | undefined): boolean {
  return mcpServersEnabled?.[ECO_AGENT_BROWSER_MCP_SERVER] === true;
}
