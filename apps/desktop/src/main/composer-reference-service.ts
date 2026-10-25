import type { ConversationMessage } from "@eco/shared";
import type { BrowserInstanceView } from "../shared/browser";
import type { ComposerCapabilityReference } from "../shared/composer-capability-references";
import {
  COMPOSER_REFERENCE_KINDS,
  COMPOSER_REFERENCE_PATTERN,
  composerReferences,
  parseComposerReference,
  type ComposerReference,
  type ComposerReferenceSearchRequest,
  type ComposerReferenceSearchResult,
} from "../shared/composer-references";
import type { ThreadSummary } from "../shared/ipc";
import type { SshBookmarkPublic } from "../shared/ssh-bookmarks";
import type { BrowserSelectionService } from "./browser-selection-service";
import type { ProjectTodoAgentService } from "./project-todo-agent-service";

export interface ReferenceHistoryPage {
  messages: Array<{
    messageId: string;
    role: string;
    channel: string;
    body: string;
    status: string;
    occurredAt?: string;
    truncated: boolean;
    totalCharacters: number;
  }>;
  hasMore: boolean;
  nextCursor?: string;
  historyRevision: number;
}
export interface ComposerReferenceDeps {
  todos: Pick<ProjectTodoAgentService, "references" | "resolveReference" | "invoke" | "disposeThread">;
  selections?: Pick<BrowserSelectionService, "read" | "validate" | "screenshot">;
  listThreads(
    query: string,
    limit: number,
  ): Array<Pick<ThreadSummary, "id" | "title" | "workspacePath" | "updatedAt">>;
  getThread(id: string): ThreadSummary | undefined;
  listSsh(): SshBookmarkPublic[];
  listBrowsers(): BrowserInstanceView[];
  listCapabilities(threadId: string): Promise<ComposerCapabilityReference[]>;
  readHistory(
    id: string,
    before: string | undefined,
    limit: number,
    includeTools: boolean,
  ): ReferenceHistoryPage;
  readMessage(id: string, messageId: string): ConversationMessage | undefined;
  readTools(id: string, runId: string, cursor: string | undefined, limit: number): unknown;
  browserTool(
    id: string,
    action: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
function endpoint(bookmark: SshBookmarkPublic): string {
  return `${bookmark.username}@${bookmark.host}${bookmark.port === 22 ? "" : `:${bookmark.port}`}`;
}
export class ComposerReferenceService {
  private readonly browserGrants = new Map<string, Set<string>>();
  private readonly selectionGrants = new Map<string, Set<string>>();
  constructor(private readonly deps: ComposerReferenceDeps) {}
  search(request: ComposerReferenceSearchRequest): ComposerReferenceSearchResult {
    if (!request || typeof request.query !== "string") throw new Error("引用搜索需要 query。");
    if (request.kind !== undefined && !COMPOSER_REFERENCE_KINDS.includes(request.kind))
      throw new Error("未知引用类型。");
    const limit = request.limit ?? 12;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new Error("引用搜索 limit 必须在 1–50 之间。");
    const query = request.query.trim().toLocaleLowerCase();
    const groups: ComposerReference[][] = [];
    if (!request.kind || request.kind === "todo") groups.push(this.deps.todos.references());
    if (!request.kind || request.kind === "ssh")
      groups.push(
        this.deps
          .listSsh()
          .map((item) => ({ kind: "ssh", id: item.id, label: item.name, detail: endpoint(item) })),
      );
    if (!request.kind || request.kind === "web")
      groups.push(
        this.deps
          .listBrowsers()
          .map((item) => ({ kind: "web", id: item.id, label: item.title || item.url, detail: item.url })),
      );
    if (!request.kind || request.kind === "conversation")
      groups.push(
        this.deps
          .listThreads(query, limit + 1)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((item) => ({
            kind: "conversation",
            id: item.id,
            label: item.title,
            detail: item.workspacePath,
          })),
      );
    let hasMore = false;
    const items = groups.flatMap((group) => {
      const matches = group.filter((item) =>
        `${item.label} ${item.detail}`.toLocaleLowerCase().includes(query),
      );
      hasMore ||= matches.length > limit;
      return matches.slice(0, limit);
    });
    return { items, hasMore };
  }
  async resolvePrompt(threadId: string, prompt: string): Promise<string> {
    const needsCapabilities = composerReferences(prompt).some((ref) =>
      ["integration", "subagent", "mcp"].includes(ref.kind),
    );
    const capabilities = needsCapabilities ? await this.deps.listCapabilities(threadId) : [];
    const details: unknown[] = [];
    const replaced = prompt.replace(COMPOSER_REFERENCE_PATTERN, (token, kind: string, encoded: string) => {
      const ref = parseComposerReference(kind, encoded);
      if (!ref) throw new Error("引用格式无效，请删除后重新选择。");
      if (ref.kind === "todo") {
        details.push(this.deps.todos.resolveReference(threadId, ref.id));
      } else if (ref.kind === "ssh") {
        const ssh = this.deps.listSsh().find((item) => item.id === ref.id);
        if (!ssh) throw new Error(`SSH 标签已删除：${ref.label}`);
        details.push({
          type: "ssh",
          bookmarkId: ssh.id,
          name: ssh.name,
          endpoint: endpoint(ssh),
          username: ssh.username,
          host: ssh.host,
          port: ssh.port,
          authType: ssh.authType,
          ...(ssh.keySource === "path" && ssh.keyPath ? { keyPath: ssh.keyPath } : {}),
        });
      } else if (ref.kind === "web_selection") {
        const selection = this.requireSelections().read(ref.id);
        const grants = this.selectionGrants.get(threadId) ?? new Set<string>();
        grants.add(selection.id);
        this.selectionGrants.set(threadId, grants);
        details.push({
          type: "web_selection", selectionId: selection.id, browserId: selection.browserId,
          title: selection.title, url: selection.url, capturedAt: selection.capturedAt,
          kind: selection.kind, tag: selection.tag, role: selection.role, name: selection.name,
          text: selection.text, context: selection.context, textTruncated: selection.textTruncated,
          frameUrl: selection.frameUrl, selectorPath: selection.selectorPath,
          screenshot: "read_browser_selection(includeScreenshot=true)",
          tool: "eco_context.read_browser_selection",
          liveTool: "eco_context.browser_reference (selectionId required; validates original document and element)",
        });
      } else if (ref.kind === "web") {
        const browser = this.deps.listBrowsers().find((item) => item.id === ref.id);
        if (!browser) throw new Error(`引用的网页已关闭：${ref.label}`);
        const grants = this.browserGrants.get(threadId) ?? new Set<string>();
        grants.add(browser.id);
        this.browserGrants.set(threadId, grants);
        details.push({
          type: "web",
          browserId: browser.id,
          title: browser.title,
          url: browser.url,
          tool: "eco_context.browser_reference",
        });
      } else if (ref.kind === "conversation") {
        const thread = this.requireThread(ref.id);
        details.push({
          type: "conversation",
          conversationId: thread.id,
          title: thread.title,
          workspacePath: thread.workspacePath,
          tool: "eco_context.read_conversation",
        });
      } else {
        const capability = capabilities.find((item) => item.kind === ref.kind && item.id === ref.id);
        if (!capability)
          throw new Error(`引用的能力已关闭、移除或不可用：${ref.label}，请重新启用或删除引用。`);
        details.push({
          type: capability.kind,
          name: capability.label,
          ...(capability.server
            ? {
                server: capability.server,
                discovery:
                  "Search this exact server through the MCP hub and read the matching tool schema before calling.",
              }
            : {}),
          ...(capability.agentKey
            ? {
                agentKey: capability.agentKey,
                delegation:
                  "Use the runtime delegation tool with the declared agent type matching this configured agentKey.",
              }
            : {}),
        });
      }
      return `[${ref.kind}: ${ref.label}]`;
    });
    return details.length
      ? `${replaced}\n\n<eco_references>\n${JSON.stringify(details)}\n</eco_references>`
      : prompt;
  }
  private requireThread(id: unknown): ThreadSummary {
    if (typeof id !== "string" || !id.trim()) throw new Error("conversationId 必须是非空字符串。");
    const thread = this.deps.getThread(id);
    if (!thread) throw new Error(`会话不存在或已删除：${id}`);
    return thread;
  }
  todoTool(threadId: string, name: string, args: Record<string, unknown>) {
    return this.deps.todos.invoke(threadId, name, args);
  }
  readConversation(args: Record<string, unknown>) {
    const thread = this.requireThread(args.conversationId);
    const limit = args.limit ?? 20;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50)
      throw new Error("limit 必须在 1–50 之间。");
    if (args.beforeCursor !== undefined && typeof args.beforeCursor !== "string")
      throw new Error("beforeCursor 必须是字符串。");
    if (args.includeTools !== undefined && typeof args.includeTools !== "boolean")
      throw new Error("includeTools 必须是布尔值。");
    const page = this.deps.readHistory(
      thread.id,
      args.beforeCursor as string | undefined,
      Number(limit),
      args.includeTools === true,
    );
    return {
      conversationId: thread.id,
      title: thread.title,
      workspacePath: thread.workspacePath,
      ...page,
      order: "oldest_to_newest_within_page",
      omitted: ["thinking", "system_messages", "inline_attachment_data"],
      truncated: page.messages.some((item) => item.truncated),
    };
  }
  readTools(args: Record<string, unknown>) {
    const thread = this.requireThread(args.conversationId);
    if (typeof args.runId !== "string" || !args.runId) throw new Error("runId 必须是非空字符串。");
    if (args.cursor !== undefined && typeof args.cursor !== "string")
      throw new Error("cursor 必须是字符串。");
    const limit = args.limit ?? 20;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50)
      throw new Error("limit 必须在 1–50 之间。");
    return this.deps.readTools(thread.id, args.runId, args.cursor as string | undefined, Number(limit));
  }
  readMessage(args: Record<string, unknown>) {
    const thread = this.requireThread(args.conversationId);
    if (typeof args.messageId !== "string") throw new Error("messageId 必须是字符串。");
    const message = this.deps.readMessage(thread.id, args.messageId);
    if (
      !message ||
      message.isDeleted ||
      !["user", "assistant"].includes(message.role) ||
      ["thinking", "system", "tool"].includes(message.channel)
    )
      throw new Error("消息不存在或不是可引用的对话正文。");
    const offset = args.offset ?? 0,
      limit = args.limit ?? 8000;
    if (
      !Number.isSafeInteger(offset) ||
      Number(offset) < 0 ||
      !Number.isSafeInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 16000
    )
      throw new Error("offset 必须非负，limit 必须在 1–16000 之间。");
    const characters = Array.from(message.body);
    const end = Math.min(characters.length, Number(offset) + Number(limit));
    return {
      conversationId: thread.id,
      messageId: message.messageId,
      role: message.role,
      body: characters.slice(Number(offset), end).join(""),
      totalCharacters: characters.length,
      hasMore: end < characters.length,
      ...(end < characters.length ? { nextOffset: end } : {}),
    };
  }
  async browserTool(threadId: string, args: Record<string, unknown>, signal?: AbortSignal) {
    if (typeof args.browserId !== "string") throw new Error("browserId 必须是字符串。");
    if (args.selectionId !== undefined) {
      const selection = this.requireGrantedSelection(threadId, args.selectionId);
      if (selection.browserId !== args.browserId) throw new Error("网页内容引用与 browserId 不匹配。");
      await this.requireSelections().validate(selection.id);
    } else if (!this.browserGrants.get(threadId)?.has(args.browserId)) {
      throw new Error("只能操作用户在当前会话中明确引用的网页；元素引用还需要 selectionId。");
    }
    if (typeof args.action !== "string") throw new Error("action 必须是浏览器工具名称。");
    if (
      args.arguments !== undefined &&
      (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments))
    )
      throw new Error("arguments 必须是对象。");
    return this.deps.browserTool(
      args.browserId,
      args.action,
      (args.arguments ?? {}) as Record<string, unknown>,
      signal,
    );
  }
  disposeThread(id: string) {
    this.deps.todos.disposeThread(id);
    this.browserGrants.delete(id);
    this.selectionGrants.delete(id);
  }
  private requireSelections() {
    if (!this.deps.selections) throw new Error("网页内容引用服务尚未连接。");
    return this.deps.selections;
  }
  private requireGrantedSelection(threadId: string, id: unknown) {
    if (typeof id !== "string" || !this.selectionGrants.get(threadId)?.has(id))
      throw new Error("只能读取用户在当前会话中明确引用的网页内容。");
    return this.requireSelections().read(id);
  }
  async readBrowserSelection(threadId: string, args: Record<string, unknown>) {
    if (args.includeScreenshot !== undefined && typeof args.includeScreenshot !== "boolean")
      throw new Error("includeScreenshot 必须是布尔值。");
    const selection = this.requireGrantedSelection(threadId, args.selectionId);
    let live: { available: boolean; reason?: string } = { available: true };
    try { await this.requireSelections().validate(selection.id); }
    catch (error) { live = { available: false, reason: error instanceof Error ? error.message : String(error) }; }
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text: JSON.stringify({ ...selection, screenshotScope: "page viewport at capture time", boundsCoordinateSpace: "selected frame viewport", live }) },
    ];
    if (args.includeScreenshot === true) content.push({ type: "image", data: this.requireSelections().screenshot(selection.id), mimeType: "image/png" });
    return { content };
  }
}
