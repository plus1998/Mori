import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type CodexJsonRpcId = string | number;

export interface CodexAppServerClientInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface CodexAppServerInitializeParams {
  clientInfo: CodexAppServerClientInfo;
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  };
}

export interface CodexAppServerInitializeResult {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

export type CodexAppServerNotificationHandler = (method: string, params: unknown) => void;

export type CodexAppServerServerRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown> | unknown;

export const CODEX_JSON_RPC_METHOD_NOT_FOUND = -32601;
export const CODEX_JSON_RPC_INVALID_PARAMS = -32602;
export const CODEX_JSON_RPC_INTERNAL_ERROR = -32603;

/** Lets a server-request handler return a protocol-level JSON-RPC error. */
export class CodexAppServerRequestError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRequestError";
  }
}

export interface CodexAppServerClientOptions {
  /**
   * Default JSON-RPC request timeout.
   * Local / slow models often need several minutes before the first token.
   * Override with `ECO_CODEX_RPC_TIMEOUT_MS` or per-request `timeoutMs`.
   */
  timeoutMs?: number;
  onNotification?: CodexAppServerNotificationHandler;
  onServerRequest?: CodexAppServerServerRequestHandler;
  /** Monotonic lifecycle generation supplied by the app-server owner. */
  diagnosticGeneration?: number;
}

export interface CodexAppServerRequestOptions<T = unknown> {
  timeoutMs?: number;
  /** Runs before later JSON-RPC lines from the same stdout chunk are dispatched. */
  onResult?: (result: T) => void;
}

interface JsonRpcResponse {
  id?: CodexJsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcRequestMessage {
  id: CodexJsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationMessage {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  onResult?: (result: unknown) => void;
}

/** Default RPC timeout: 15 minutes (local 35B TTFT can exceed 2 minutes). */
export const DEFAULT_CODEX_RPC_TIMEOUT_MS = 900_000;
/** turn/start may wait on provider connect / first stream activity. */
export const DEFAULT_CODEX_TURN_START_TIMEOUT_MS = 900_000;

export function resolveCodexRpcTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(env.ECO_CODEX_RPC_TIMEOUT_MS, DEFAULT_CODEX_RPC_TIMEOUT_MS);
}

export function resolveCodexTurnStartTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(env.ECO_CODEX_TURN_START_TIMEOUT_MS, DEFAULT_CODEX_TURN_START_TIMEOUT_MS);
}

function readPositiveIntEnv(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeout ms: ${trimmed}`);
  }
  return parsed;
}

export class CodexAppServerClient {
  private static nextDiagnosticInstanceId = 1;
  private nextId = 1;
  private initialized = false;
  private closed = false;
  private stdoutBuffer = "";
  private readonly pending = new Map<CodexJsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<CodexAppServerNotificationHandler>();
  private readonly timeoutMs: number;
  private readonly onServerRequest: CodexAppServerServerRequestHandler | undefined;
  readonly diagnosticInstanceId = CodexAppServerClient.nextDiagnosticInstanceId++;
  readonly diagnosticGeneration: number;

  constructor(
    private readonly writable: NodeJS.WritableStream,
    readable: NodeJS.ReadableStream,
    options: CodexAppServerClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? resolveCodexRpcTimeoutMs();
    this.onServerRequest = options.onServerRequest;
    this.diagnosticGeneration = options.diagnosticGeneration ?? 0;
    if (options.onNotification) {
      this.notificationHandlers.add(options.onNotification);
    }
    readable.setEncoding("utf8");
    readable.on("data", (chunk: string) => this.handleStdout(chunk));
    readable.on("error", (error) =>
      this.rejectAll(new Error(`Codex app-server stdout error: ${error.message}`)),
    );
    readable.on("end", () => {
      this.closed = true;
      if (this.pending.size > 0) {
        this.rejectAll(new Error("Codex app-server stdout closed with pending requests"));
      }
    });
  }

  static attachToProcess(
    child: ChildProcessWithoutNullStreams,
    options: CodexAppServerClientOptions = {},
  ): CodexAppServerClient {
    return new CodexAppServerClient(child.stdin, child.stdout, options);
  }

  addNotificationHandler(handler: CodexAppServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async initialize(
    params: CodexAppServerInitializeParams = {
      clientInfo: {
        name: "eco_coding",
        title: "Mori",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
      },
    },
  ): Promise<CodexAppServerInitializeResult> {
    if (this.initialized) {
      throw new Error("Codex app-server client is already initialized");
    }
    const result = await this.request<CodexAppServerInitializeResult>("initialize", params);
    await this.notify("initialized");
    this.initialized = true;
    return result;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: CodexAppServerRequestOptions<T> = {},
  ): Promise<T> {
    const id = this.nextId++;
    const message: JsonRpcRequestMessage = {
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out waiting for ${method} response after ${timeoutMs}ms (set ECO_CODEX_RPC_TIMEOUT_MS / ECO_CODEX_TURN_START_TIMEOUT_MS for slow local models)`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timeout,
        ...(options.onResult ? { onResult: (result: unknown) => options.onResult?.(result as T) } : {}),
      });
      try {
        // Register pending before write: a synchronous test transport (or any
        // transport that responds re-entrantly) may deliver the response in write().
        this.writeMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return unwrapJsonRpcResponse<T>(response, method);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const message: JsonRpcNotificationMessage = {
      method,
      ...(params === undefined ? {} : { params }),
    };
    this.writeMessage(message);
  }

  close(): void {
    this.closed = true;
    this.rejectAll(new Error("Codex app-server client closed"));
    if (this.writable.writable) {
      this.writable.end();
    }
  }

  private writeMessage(message: JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponse): void {
    if (this.closed || !this.writable.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.writable.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.rejectAll(new Error(`Codex app-server stdout is not valid JSON: ${line.slice(0, 200)}`));
        return;
      }
      this.handleJsonRpcMessage(parsed);
    }
  }

  private handleJsonRpcMessage(message: unknown): void {
    if (isJsonRpcResponse(message)) {
      if (message.id === undefined) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (!message.error && pending.onResult) {
        try {
          pending.onResult(message.result);
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      pending.resolve(message);
      return;
    }

    if (isJsonRpcServerRequest(message)) {
      void this.respondToServerRequest(message);
      return;
    }

    if (isJsonRpcNotification(message)) {
      this.dispatchNotification(message.method, message.params);
    }
  }

  private async respondToServerRequest(request: JsonRpcRequestMessage): Promise<void> {
    try {
      if (!this.onServerRequest) {
        throw serverRequestMethodNotFound(request.method);
      }
      const result = await this.onServerRequest(request.method, request.params);
      if (result === undefined) {
        throw serverRequestMethodNotFound(request.method);
      }
      this.writeMessage({ id: request.id, result });
    } catch (error) {
      const rpcError =
        error instanceof CodexAppServerRequestError
          ? error
          : new CodexAppServerRequestError(
              CODEX_JSON_RPC_INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
            );
      this.writeMessage({
        id: request.id,
        error: {
          code: rpcError.code,
          message: rpcError.message,
          ...(rpcError.data === undefined ? {} : { data: rpcError.data }),
        },
      });
    }
  }

  private dispatchNotification(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers) {
      handler(method, params);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function serverRequestMethodNotFound(method: string): CodexAppServerRequestError {
  return new CodexAppServerRequestError(
    CODEX_JSON_RPC_METHOD_NOT_FOUND,
    `Mori does not implement Codex app-server request method ${method}.`,
  );
}

function unwrapJsonRpcResponse<T>(response: JsonRpcResponse, method: string): T {
  if (response.error) {
    throw new CodexAppServerRequestError(response.error.code, `${method} failed: ${response.error.message}`, response.error.data);
  }
  return response.result as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value) && "id" in value && ("result" in value || "error" in value);
}

function isJsonRpcServerRequest(value: unknown): value is JsonRpcRequestMessage {
  return (
    isRecord(value) &&
    typeof value.method === "string" &&
    "id" in value &&
    !("result" in value) &&
    !("error" in value)
  );
}

function isJsonRpcNotification(value: unknown): value is JsonRpcNotificationMessage {
  return isRecord(value) && typeof value.method === "string" && !("id" in value);
}
