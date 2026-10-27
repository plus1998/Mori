import {
  type AcpGenerateImageHandler,
  type AcpGenerateImageOutcome,
  type AcpTaskHandler,
  type AcpTaskOutcome,
  type AcpUpdateTodosHandler,
  type AcpUpdateTodosOutcome,
  isCursorMethod,
  parseAcpGenerateImageRequest,
  parseAcpTaskRequest,
  parseAcpUpdateTodosRequest,
} from "./acp-cursor-extensions.js";
import {
  type AcpFsHandler,
  type AcpFsReadRequest,
  type AcpFsWriteRequest,
  PathEscapesWorkspaceError,
  parseAcpFsReadRequest,
  parseAcpFsWriteRequest,
} from "./acp-fs.js";
import type { AcpJsonRpcPeer } from "./acp-jsonrpc.js";
import type { AcpMcpServer } from "./acp-mcp.js";
import {
  parseAcpPermissionRequest,
  resolveAcpPermissionAutoAllow,
  resolveAcpPermissionReject,
} from "./acp-permission.js";
import { agentSupportsSessionDelete } from "./acp-session-delete.js";
import {
  ACP_IDLE_TIMEOUT_MS,
  ACP_LOAD_SESSION_UNSUPPORTED,
  ACP_PROTOCOL,
  ACP_SESSION_DELETE_UNSUPPORTED,
  type AcpAskQuestionHandler,
  type AcpAskQuestionOutcome,
  type AcpAskQuestionRequest,
  type AcpClientInfo,
  type AcpClientOptions,
  type AcpCreatePlanHandler,
  type AcpCreatePlanOutcome,
  type AcpCreatePlanRequest,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPermissionHandler,
  type AcpPermissionOutcome,
  type AcpSessionModeId,
} from "./acp-types.js";

const DEFAULT_CLIENT_INFO: AcpClientInfo = {
  name: "eco",
  version: "0.0.0",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AcpClient {
  private readonly peer: AcpJsonRpcPeer;
  private readonly clientInfo: AcpClientInfo;
  private readonly onCreatePlan: AcpCreatePlanHandler | undefined;
  private readonly onAskQuestion: AcpAskQuestionHandler | undefined;
  private readonly onRequestPermission: AcpPermissionHandler | undefined;
  private readonly fsHandler: import("./acp-fs.js").AcpFsHandler | undefined;
  private readonly onTask: AcpTaskHandler | undefined;
  private readonly onUpdateTodos: AcpUpdateTodosHandler | undefined;
  private readonly onGenerateImage: AcpGenerateImageHandler | undefined;
  private initializeResult: AcpInitializeResult | undefined;

  constructor(options: AcpClientOptions) {
    this.peer = options.peer;
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.onCreatePlan = options.onCreatePlan;
    this.onAskQuestion = options.onAskQuestion;
    this.onRequestPermission = options.onRequestPermission;
    this.fsHandler = options.fsHandler;
    this.onTask = options.onTask;
    this.onUpdateTodos = options.onUpdateTodos;
    this.onGenerateImage = options.onGenerateImage;
    this.peer.onRequest((request) => this.handleIncomingRequest(request));
    this.bindCursorExtensionNotifications();
  }

  async initialize(): Promise<AcpInitializeResult> {
    const result = await this.peer.request(ACP_PROTOCOL.methods.initialize, {
      protocolVersion: ACP_PROTOCOL.protocolVersion,
      // Empty fs/terminal capabilities: Cursor uses its own FS.
      // session/request_permission is answered by Eco (or auto-allow when no handler).
      clientCapabilities: {},
      clientInfo: this.clientInfo,
    });
    if (!isRecord(result) || typeof result.protocolVersion !== "number") {
      throw new Error("ACP initialize returned invalid result");
    }
    this.initializeResult = result as AcpInitializeResult;
    return this.initializeResult;
  }

  /** Send notifications/initialized */
  confInitialized(): void {
    this.peer.notify(ACP_PROTOCOL.notifications.initialized);
  }

  async newSession(input: {
    cwd: string;
    mcpServers?: readonly AcpMcpServer[];
  }): Promise<{ sessionId: string } & Record<string, unknown>> {
    const result = await this.peer.request(ACP_PROTOCOL.methods.sessionNew, {
      cwd: input.cwd,
      mcpServers: input.mcpServers ?? [],
    });
    if (!isRecord(result) || typeof result.sessionId !== "string") {
      throw new Error("ACP session/new returned no sessionId");
    }
    return { ...(result as AcpNewSessionResult) };
  }

  /**
   * Load an existing session.
   * Measured Cursor shape requires `mcpServers` (array); defaults to [].
   * Result includes `models` / `modes` (same shape as session/new) when the agent returns them.
   */
  async loadSession(input: {
    sessionId: string;
    cwd: string;
    mcpServers?: readonly AcpMcpServer[];
  }): Promise<Record<string, unknown>> {
    const caps = this.initializeResult?.agentCapabilities;
    if (!caps || caps.loadSession !== true) {
      throw new Error(`${ACP_LOAD_SESSION_UNSUPPORTED}: agent did not advertise loadSession: true`);
    }
    try {
      const result = await this.peer.request(
        ACP_PROTOCOL.methods.sessionLoad,
        {
          sessionId: input.sessionId,
          cwd: input.cwd,
          mcpServers: input.mcpServers ?? [],
        },
        { idleTimeoutMs: ACP_IDLE_TIMEOUT_MS },
      );
      return isRecord(result) ? result : {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/method not found/i.test(message)) {
        throw new Error(`${ACP_LOAD_SESSION_UNSUPPORTED}: session/load not available (${message})`);
      }
      throw error;
    }
  }

  async setMode(input: { sessionId: string; modeId: AcpSessionModeId }): Promise<void> {
    try {
      await this.peer.request(ACP_PROTOCOL.methods.sessionSetMode, {
        sessionId: input.sessionId,
        modeId: input.modeId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`session/set_mode modeId=${JSON.stringify(input.modeId)}: ${message}`);
    }
  }

  async setModel(input: { sessionId: string; modelId: string }): Promise<void> {
    try {
      await this.peer.request(ACP_PROTOCOL.methods.sessionSetModel, {
        sessionId: input.sessionId,
        modelId: input.modelId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`session/set_model modelId=${JSON.stringify(input.modelId)}: ${message}`);
    }
  }

  async prompt(input: { sessionId: string; prompt: unknown }): Promise<unknown> {
    return this.peer.request(
      ACP_PROTOCOL.methods.sessionPrompt,
      {
        sessionId: input.sessionId,
        prompt: input.prompt,
      },
      { idleTimeoutMs: ACP_IDLE_TIMEOUT_MS },
    );
  }

  /**
   * Cancel in-flight prompt work.
   * Measured: `session/cancel` is a JSON-RPC **notification** (request → -32601).
   */
  async cancel(input: { sessionId: string }): Promise<void> {
    this.peer.notify(ACP_PROTOCOL.notifications.sessionCancel, {
      sessionId: input.sessionId,
    });
  }

  async deleteSession(input: { sessionId: string }): Promise<void> {
    if (!agentSupportsSessionDelete(this.initializeResult ?? {})) {
      throw new Error(
        `${ACP_SESSION_DELETE_UNSUPPORTED}: agent did not advertise sessionCapabilities.delete`,
      );
    }
    await this.peer.request(ACP_PROTOCOL.methods.sessionDelete, {
      sessionId: input.sessionId,
    });
  }

  onSessionUpdate(handler: (params: unknown) => void): () => void {
    return this.peer.onNotification(ACP_PROTOCOL.notifications.sessionUpdate, handler);
  }

  private bindCursorExtensionNotifications(): void {
    const bind = (canonical: string, handler: (params: unknown) => void) => {
      this.peer.onNotification(canonical, handler);
      this.peer.onNotification(`_${canonical}`, handler);
    };
    bind(ACP_PROTOCOL.clientMethods.cursorUpdateTodos, (params) => {
      void this.resolveUpdateTodos(params);
    });
    bind(ACP_PROTOCOL.clientMethods.cursorTask, (params) => {
      void this.resolveTask(params);
    });
    bind(ACP_PROTOCOL.clientMethods.cursorGenerateImage, (params) => {
      void this.resolveGenerateImage(params);
    });
  }

  private async handleIncomingRequest(request: { method: string; params?: unknown }): Promise<unknown> {
    if (request.method === ACP_PROTOCOL.clientMethods.sessionRequestPermission) {
      return this.resolvePermission(request.params);
    }
    if (isCursorMethod(request.method, ACP_PROTOCOL.clientMethods.cursorCreatePlan)) {
      return {
        outcome: await this.resolveCreatePlan(request.params),
      };
    }
    if (isCursorMethod(request.method, ACP_PROTOCOL.clientMethods.cursorAskQuestion)) {
      return {
        outcome: await this.resolveAskQuestion(request.params),
      };
    }
    if (isCursorMethod(request.method, ACP_PROTOCOL.clientMethods.cursorTask)) {
      return {
        outcome: await this.resolveTask(request.params),
      };
    }
    if (isCursorMethod(request.method, ACP_PROTOCOL.clientMethods.cursorUpdateTodos)) {
      return {
        outcome: await this.resolveUpdateTodos(request.params),
      };
    }
    if (isCursorMethod(request.method, ACP_PROTOCOL.clientMethods.cursorGenerateImage)) {
      return {
        outcome: await this.resolveGenerateImage(request.params),
      };
    }
    if (request.method === ACP_PROTOCOL.clientMethods.fsReadTextFile) {
      return this.resolveFsRead(request.params);
    }
    if (request.method === ACP_PROTOCOL.clientMethods.fsWriteTextFile) {
      return this.resolveFsWrite(request.params);
    }
    throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
  }

  private async resolveFsRead(params: unknown): Promise<Record<string, unknown>> {
    const parsed = parseAcpFsReadRequest(params);
    if (!parsed) {
      throw Object.assign(new Error("ACP fs/read_text_file missing path"), { code: -32000 });
    }
    if (!this.fsHandler) {
      throw Object.assign(
        new Error("Mori ACP host has no fs handler; install fs handler to allow agent file reads"),
        { code: -32000 },
      );
    }
    try {
      return await this.fsHandler.read(parsed);
    } catch (error) {
      if (error instanceof PathEscapesWorkspaceError) {
        throw Object.assign(new Error(error.message), { code: -32000 });
      }
      throw error;
    }
  }

  private async resolveFsWrite(params: unknown): Promise<Record<string, unknown>> {
    const parsed = parseAcpFsWriteRequest(params);
    if (!parsed) {
      throw Object.assign(new Error("ACP fs/write_text_file missing path or content"), { code: -32000 });
    }
    if (!this.fsHandler) {
      throw Object.assign(
        new Error("Mori ACP host has no fs handler; install fs handler to allow agent file writes"),
        { code: -32000 },
      );
    }
    try {
      return await this.fsHandler.write(parsed);
    } catch (error) {
      if (error instanceof PathEscapesWorkspaceError) {
        throw Object.assign(new Error(error.message), { code: -32000 });
      }
      throw error;
    }
  }

  private async resolvePermission(params: unknown): Promise<AcpPermissionOutcome> {
    if (!this.onRequestPermission) {
      return resolveAcpPermissionAutoAllow(params);
    }
    const parsed = parseAcpPermissionRequest(params);
    if (!parsed) {
      const rejected = resolveAcpPermissionReject(params);
      if (rejected) return rejected;
      throw new Error(
        "ACP session/request_permission missing toolCallId/options; Mori cannot take over approval",
      );
    }
    return this.onRequestPermission(parsed);
  }

  private async resolveCreatePlan(params: unknown): Promise<AcpCreatePlanOutcome> {
    const request = parseAcpCreatePlanRequest(params);
    if (!request) {
      return { outcome: "rejected", reason: "ACP cursor/create_plan missing toolCallId or plan" };
    }
    if (!this.onCreatePlan) {
      return {
        outcome: "rejected",
        reason: "Mori ACP host has no create_plan handler (plan approval not wired)",
      };
    }
    return this.onCreatePlan(request);
  }

  private async resolveAskQuestion(params: unknown): Promise<AcpAskQuestionOutcome> {
    const request = parseAcpAskQuestionRequest(params);
    if (!request) {
      return { outcome: "skipped", reason: "ACP cursor/ask_question missing toolCallId" };
    }
    if (!this.onAskQuestion) {
      return { outcome: "skipped", reason: "Mori ACP host has no ask_question handler" };
    }
    return this.onAskQuestion(request);
  }

  private async resolveTask(params: unknown): Promise<AcpTaskOutcome> {
    const request = parseAcpTaskRequest(params);
    if (!request) {
      return { outcome: "rejected", reason: "ACP cursor/task missing toolCallId" };
    }
    if (!this.onTask) {
      // Default: ACK completed so Cursor does not treat the host as unsupported / hang.
      return {
        outcome: "completed",
        ...(request.agentId ? { agentId: request.agentId } : {}),
        ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
      };
    }
    return this.onTask(request);
  }

  private async resolveUpdateTodos(params: unknown): Promise<AcpUpdateTodosOutcome> {
    const request = parseAcpUpdateTodosRequest(params);
    if (!request) {
      // Do not wipe the list on a malformed payload; still accept so a request does not hang.
      return { outcome: "accepted", todos: [] };
    }
    if (!this.onUpdateTodos) {
      return { outcome: "accepted", todos: request.todos };
    }
    return this.onUpdateTodos(request);
  }

  private async resolveGenerateImage(params: unknown): Promise<AcpGenerateImageOutcome> {
    const request = parseAcpGenerateImageRequest(params);
    if (!request) {
      return { outcome: "rejected", reason: "ACP cursor/generate_image missing toolCallId" };
    }
    if (!this.onGenerateImage) {
      return {
        outcome: "rejected",
        reason: "Mori ACP host has no generate_image handler",
      };
    }
    return this.onGenerateImage(request);
  }
}

export function parseAcpCreatePlanRequest(params: unknown): AcpCreatePlanRequest | undefined {
  if (!isRecord(params) || typeof params.toolCallId !== "string" || !params.toolCallId.trim()) {
    return undefined;
  }
  if (typeof params.plan !== "string") {
    return undefined;
  }
  return {
    ...params,
    toolCallId: params.toolCallId.trim(),
    plan: params.plan,
    ...(typeof params.name === "string" ? { name: params.name } : {}),
    ...(typeof params.overview === "string" ? { overview: params.overview } : {}),
  };
}

export function parseAcpAskQuestionRequest(params: unknown): AcpAskQuestionRequest | undefined {
  if (!isRecord(params) || typeof params.toolCallId !== "string" || !params.toolCallId.trim()) {
    return undefined;
  }
  return {
    ...params,
    toolCallId: params.toolCallId.trim(),
    questions: Array.isArray(params.questions) ? params.questions : [],
    ...(typeof params.title === "string" ? { title: params.title } : {}),
  };
}

export type { AcpClientOptions } from "./acp-types.js";
