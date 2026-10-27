import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import {
  type McpServerCheckResult,
  type McpServerConfigInput,
  parseMcpArgsList,
  parseMcpEnvEntries,
  validateMcpServerInput,
} from "../shared/mcp";
import { resolveCommandExecutable, toSpawnEnv } from "./resolve-command-executable";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
const MAX_CAPTURED_TEXT = 4_000;
const JSON_RPC_VERSION = "2.0";

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface ToolSummary {
  name: string;
}

interface InitializeSummary {
  protocolVersion?: string;
  capabilities: string[];
  serverInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
}

interface CheckSuccessInput extends InitializeSummary {
  tools?: ToolSummary[];
}

interface CheckOptions {
  timeoutMs?: number;
}

interface SseEvent {
  event: string;
  data: string;
}

export async function checkMcpServerConnection(
  input: McpServerConfigInput,
  options: CheckOptions = {},
): Promise<McpServerCheckResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  try {
    validateMcpServerInput(input);
    if (input.transport === "stdio") {
      return await checkStdioServer(input, startedAt, timeoutMs);
    }
    if (input.transport === "http") {
      return await checkStreamableHttpServer(input, startedAt, timeoutMs);
    }
    return await checkLegacySseServer(input, startedAt, timeoutMs);
  } catch (caught) {
    return failureResult(input, startedAt, errorMessage(caught));
  }
}

async function checkStdioServer(
  input: McpServerConfigInput,
  startedAt: number,
  timeoutMs: number,
): Promise<McpServerCheckResult> {
  const command = input.command?.trim();
  if (!command) {
    throw new Error("stdio transport requires a command.");
  }

  const args = parseMcpArgsList(input.argsJson ?? "[]");
  const envEntries = Object.fromEntries(
    parseMcpEnvEntries(input.envJson ?? "{}").map((entry) => [entry.key, entry.value]),
  );
  const processEnv = { ...toSpawnEnv(), ...envEntries };
  const child = spawn(resolveCommandExecutable(command), args, {
    env: processEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const client = new StdioMcpClient(child, timeoutMs);
  try {
    const initialized = await initializeMcpClient(client);
    const tools = await maybeListTools(client, initialized.capabilities);
    return successResult(input, startedAt, { ...initialized, ...(tools ? { tools } : {}) });
  } finally {
    await client.close();
  }
}

async function checkStreamableHttpServer(
  input: McpServerConfigInput,
  startedAt: number,
  timeoutMs: number,
): Promise<McpServerCheckResult> {
  const url = input.url?.trim();
  if (!url) {
    throw new Error(`${input.transport} transport requires a URL.`);
  }

  const headers = parsedHeaderEntries(input.headersJson ?? "{}");
  const client = new StreamableHttpMcpClient(url, headers, timeoutMs);
  const initialized = await initializeMcpClient(client);
  const tools = await maybeListTools(client, initialized.capabilities);
  return successResult(input, startedAt, { ...initialized, ...(tools ? { tools } : {}) });
}

async function checkLegacySseServer(
  input: McpServerConfigInput,
  startedAt: number,
  timeoutMs: number,
): Promise<McpServerCheckResult> {
  const url = input.url?.trim();
  if (!url) {
    throw new Error(`${input.transport} transport requires a URL.`);
  }

  const headers = parsedHeaderEntries(input.headersJson ?? "{}");
  const client = await LegacySseMcpClient.connect(url, headers, timeoutMs);
  try {
    const initialized = await initializeMcpClient(client);
    const tools = await maybeListTools(client, initialized.capabilities);
    return successResult(input, startedAt, { ...initialized, ...(tools ? { tools } : {}) });
  } finally {
    await client.close();
  }
}

interface McpClientLike {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
}

async function initializeMcpClient(client: McpClientLike): Promise<InitializeSummary> {
  const result = await client.request("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: "Mori",
      version: "0.0.1",
    },
  });
  const initialized = parseInitializeResult(result);
  await client.notify("notifications/initialized");
  return initialized;
}

async function maybeListTools(
  client: McpClientLike,
  capabilities: readonly string[],
): Promise<ToolSummary[] | undefined> {
  if (!capabilities.includes("tools")) {
    return undefined;
  }
  const result = await client.request("tools/list", {});
  return parseToolsListResult(result);
}

class StdioMcpClient implements McpClientLike {
  private nextId = 1;
  private stdout = "";
  private stderr = "";
  private closed = false;
  private readonly pending = new Map<
    JsonRpcId,
    {
      method: string;
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr = truncateTail(this.stderr + chunk, MAX_CAPTURED_TEXT);
    });
    child.on("error", (error) => this.rejectAll(new Error(`MCP 进程启动失败: ${error.message}`)));
    child.on("exit", (code, signal) => {
      this.closed = true;
      if (this.pending.size === 0) {
        return;
      }
      const suffix = this.stderr ? `\nstderr: ${this.stderr.trim()}` : "";
      this.rejectAll(
        new Error(`MCP 进程提前退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。${suffix}`),
      );
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    this.writeMessage(request);

    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const suffix = this.stderr ? ` stderr: ${this.stderr.trim()}` : "";
        reject(new Error(`等待 ${method} 响应超时。${suffix}`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
    });
    return unwrapJsonRpcResponse(response, method);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: JSON_RPC_VERSION,
      method,
      ...(params === undefined ? {} : { params }),
    };
    this.writeMessage(notification);
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
    }
    this.pending.clear();
    try {
      this.child.stdin.end();
    } catch {
      // Ignore cleanup failures; a successful health check should not depend on graceful shutdown.
    }

    if (this.closed || this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    const exitedAfterStdin = await waitForProcessExit(this.child, 500);
    if (exitedAfterStdin) {
      return;
    }
    this.child.kill("SIGTERM");
    const exitedAfterTerm = await waitForProcessExit(this.child, 500);
    if (!exitedAfterTerm) {
      this.child.kill("SIGKILL");
      await waitForProcessExit(this.child, 500);
    }
  }

  private writeMessage(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (this.closed || !this.child.stdin.writable) {
      throw new Error("MCP 进程 stdin 不可写。");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const newlineIndex = this.stdout.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = this.stdout.slice(0, newlineIndex).trim();
      this.stdout = this.stdout.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.rejectAll(new Error(`MCP stdout 输出不是合法 JSON-RPC 消息: ${truncateMiddle(line, 500)}`));
        this.child.kill("SIGTERM");
        return;
      }
      this.handleJsonRpcMessage(parsed);
    }
  }

  private handleJsonRpcMessage(message: unknown): void {
    if (isJsonRpcResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }

    if (isJsonRpcServerRequest(message)) {
      this.respondToServerRequest(message);
    }
  }

  private respondToServerRequest(request: JsonRpcRequest): void {
    if (request.method === "ping") {
      this.writeMessage({ jsonrpc: JSON_RPC_VERSION, id: request.id, result: {} });
      return;
    }
    if (request.method === "roots/list") {
      this.writeMessage({ jsonrpc: JSON_RPC_VERSION, id: request.id, result: { roots: [] } });
      return;
    }
    this.writeMessage({
      jsonrpc: JSON_RPC_VERSION,
      id: request.id,
      error: {
        code: -32601,
        message: `Mori MCP 检测未实现客户端方法 ${request.method}。`,
      },
    });
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

class StreamableHttpMcpClient implements McpClientLike {
  private nextId = 1;
  private sessionId: string | undefined;
  private protocolVersion = MCP_PROTOCOL_VERSION;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly timeoutMs: number,
  ) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.postJsonRpc({
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    const result = unwrapJsonRpcResponse(response.message, method);
    if (method === "initialize") {
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) {
        this.sessionId = sessionId;
      }
      const initialized = parseInitializeResult(result);
      if (initialized.protocolVersion) {
        this.protocolVersion = initialized.protocolVersion;
      }
    }
    return result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.postJsonRpc({
      jsonrpc: JSON_RPC_VERSION,
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private async postJsonRpc(
    message: JsonRpcRequest | JsonRpcNotification,
  ): Promise<{ message: JsonRpcResponse; headers: Headers }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const includeProtocolHeaders = message.method !== "initialize";
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.buildHeaders(includeProtocolHeaders),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 202) {
        throw new Error(await httpErrorMessage(response));
      }
      if (!("id" in message)) {
        return { message: { jsonrpc: JSON_RPC_VERSION, id: 0, result: {} }, headers: response.headers };
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("application/json")) {
        return { message: parseJsonRpcResponse(await response.text()), headers: response.headers };
      }
      if (contentType.includes("text/event-stream")) {
        return {
          message: parseJsonRpcResponseFromSse(await response.text(), message.id),
          headers: response.headers,
        };
      }
      throw new Error(
        `HTTP 响应 Content-Type 不是 MCP 支持的 application/json 或 text/event-stream: ${contentType || "空"}`,
      );
    } catch (caught) {
      if (isAbortError(caught)) {
        throw new Error(`HTTP MCP 请求超时（${this.timeoutMs}ms）。`);
      }
      throw caught;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildHeaders(includeProtocolHeaders: boolean): Record<string, string> {
    return {
      ...this.headers,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(includeProtocolHeaders && this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(includeProtocolHeaders ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
    };
  }
}

class LegacySseMcpClient implements McpClientLike {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    JsonRpcId,
    {
      method: string;
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  private constructor(
    private readonly endpoint: string,
    private readonly headers: Record<string, string>,
    private readonly controller: AbortController,
    private readonly timeoutMs: number,
  ) {}

  static async connect(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<LegacySseMcpClient> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { ...headers, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await httpErrorMessage(response));
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/event-stream")) {
        throw new Error(`SSE MCP 响应 Content-Type 不是 text/event-stream: ${contentType || "空"}`);
      }
      if (!response.body) {
        throw new Error("SSE MCP 响应没有可读取的 body。");
      }

      const reader = response.body.getReader();
      const endpoint = await readLegacyEndpoint(reader, url, timeoutMs);
      const client = new LegacySseMcpClient(endpoint, headers, controller, timeoutMs);
      client.readMessages(reader);
      return client;
    } catch (caught) {
      controller.abort();
      if (isAbortError(caught)) {
        throw new Error(`SSE MCP 连接超时（${timeoutMs}ms）。`);
      }
      throw caught;
    } finally {
      clearTimeout(timeout);
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`等待 ${method} SSE 响应超时。`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
    });

    await this.post({
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    return unwrapJsonRpcResponse(await responsePromise, method);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({
      jsonrpc: JSON_RPC_VERSION,
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
    }
    this.pending.clear();
    this.controller.abort();
  }

  private async post(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 202) {
        throw new Error(await httpErrorMessage(response));
      }
    } catch (caught) {
      if (isAbortError(caught)) {
        throw new Error(`SSE MCP POST 请求超时（${this.timeoutMs}ms）。`);
      }
      throw caught;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readMessages(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          if (event.event !== "message" || !event.data.trim()) {
            continue;
          }
          const message = parseJsonRpcResponse(event.data);
          const pending = this.pending.get(message.id);
          if (!pending) {
            continue;
          }
          clearTimeout(pending.timeout);
          this.pending.delete(message.id);
          pending.resolve(message);
        }
      }
      if (!this.closed) {
        this.rejectAll(new Error("SSE MCP 连接在检测完成前关闭。"));
      }
    } catch (caught) {
      if (!this.closed && !isAbortError(caught)) {
        this.rejectAll(new Error(`读取 SSE MCP 消息失败: ${errorMessage(caught)}`));
      }
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

async function readLegacyEndpoint(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  baseUrl: string,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    const { value, done } = await withTimeout(reader.read(), remaining, "等待 SSE endpoint 事件超时。");
    if (done) {
      throw new Error("SSE MCP 连接在 endpoint 事件前关闭。");
    }
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      if (event.event === "endpoint" && event.data.trim()) {
        return new URL(event.data.trim(), baseUrl).toString();
      }
    }
  }
}

class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: SseEvent[] = [];
    for (;;) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator < 0) {
        break;
      }
      const block = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      const event = parseSseBlock(block);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }
}

function parseSseBlock(block: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "event") {
      event = value || "message";
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  return { event, data: data.join("\n") };
}

function parseInitializeResult(result: unknown): InitializeSummary {
  if (!isRecord(result)) {
    throw new Error("initialize 响应缺少 result 对象。");
  }
  const capabilitiesRecord = isRecord(result.capabilities) ? result.capabilities : {};
  const capabilities = Object.entries(capabilitiesRecord)
    .filter(([, value]) => value !== false && value !== null && value !== undefined)
    .map(([key]) => key)
    .sort();
  const serverInfo = parseServerInfo(result.serverInfo);
  const protocolVersion = typeof result.protocolVersion === "string" ? result.protocolVersion : undefined;
  return {
    ...(protocolVersion ? { protocolVersion } : {}),
    capabilities,
    ...(serverInfo ? { serverInfo } : {}),
  };
}

function parseServerInfo(value: unknown): InitializeSummary["serverInfo"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const info: NonNullable<InitializeSummary["serverInfo"]> = {};
  if (typeof value.name === "string") info.name = value.name;
  if (typeof value.title === "string") info.title = value.title;
  if (typeof value.version === "string") info.version = value.version;
  return Object.keys(info).length > 0 ? info : undefined;
}

function parseToolsListResult(result: unknown): ToolSummary[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new Error("tools/list 响应缺少 tools 数组。");
  }
  return result.tools
    .map((tool): ToolSummary | undefined => {
      if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name.trim()) {
        return undefined;
      }
      return { name: tool.name };
    })
    .filter((tool): tool is ToolSummary => Boolean(tool));
}

function successResult(
  input: McpServerConfigInput,
  startedAt: number,
  success: CheckSuccessInput,
): McpServerCheckResult {
  const toolsCount = success.tools?.length;
  const toolNames = success.tools?.slice(0, 20).map((tool) => tool.name);
  const capabilityText = success.capabilities.length > 0 ? success.capabilities.join(", ") : "未声明能力";
  const message =
    toolsCount === undefined
      ? `握手成功；服务能力：${capabilityText}。`
      : `握手成功；发现 ${toolsCount} 个工具。`;
  return {
    ok: true,
    serverName: input.name.trim(),
    transport: input.transport,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    message,
    capabilities: success.capabilities,
    ...(success.protocolVersion ? { protocolVersion: success.protocolVersion } : {}),
    ...(success.serverInfo ? { serverInfo: success.serverInfo } : {}),
    ...(toolsCount !== undefined ? { toolsCount } : {}),
    ...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
  };
}

function failureResult(
  input: McpServerConfigInput,
  startedAt: number,
  message: string,
  details?: string,
): McpServerCheckResult {
  return {
    ok: false,
    serverName: input.name.trim() || "未命名 MCP",
    transport: input.transport,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    message,
    ...(details ? { details } : {}),
    capabilities: [],
  };
}

function unwrapJsonRpcResponse(response: JsonRpcResponse, method: string): unknown {
  if (response.error) {
    const errorMessage = response.error.message || JSON.stringify(response.error);
    throw new Error(`${method} 返回 JSON-RPC 错误: ${errorMessage}`);
  }
  if (!("result" in response)) {
    throw new Error(`${method} 响应缺少 result。`);
  }
  return response.result;
}

function parseJsonRpcResponse(raw: string): JsonRpcResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`响应不是合法 JSON: ${truncateMiddle(raw.trim(), 500)}`);
  }
  if (!isJsonRpcResponse(parsed)) {
    throw new Error(`响应不是合法 JSON-RPC response: ${truncateMiddle(raw.trim(), 500)}`);
  }
  return parsed;
}

function parseJsonRpcResponseFromSse(raw: string, expectedId: JsonRpcId): JsonRpcResponse {
  for (const event of parseSseText(raw)) {
    if (event.event !== "message" || !event.data.trim()) {
      continue;
    }
    const response = parseJsonRpcResponse(event.data);
    if (response.id === expectedId) {
      return response;
    }
  }
  throw new Error(`SSE 响应中没有找到 id=${String(expectedId)} 的 JSON-RPC response。`);
}

function parseSseText(raw: string): SseEvent[] {
  const parser = new SseParser();
  return parser.push(`${raw}\n\n`);
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    isRecord(value) &&
    value.jsonrpc === JSON_RPC_VERSION &&
    (typeof value.id === "number" || typeof value.id === "string") &&
    ("result" in value || "error" in value)
  );
}

function isJsonRpcServerRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    value.jsonrpc === JSON_RPC_VERSION &&
    (typeof value.id === "number" || typeof value.id === "string") &&
    typeof value.method === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedHeaderEntries(raw: string): Record<string, string> {
  return Object.fromEntries(parseMcpEnvEntries(raw).map((entry) => [entry.key, entry.value]));
}

async function httpErrorMessage(response: Response): Promise<string> {
  const body = truncateMiddle((await response.text()).trim(), 800);
  return `HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateTail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const half = Math.floor((max - 3) / 2);
  return `${value.slice(0, half)}...${value.slice(value.length - half)}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return Promise.race([
    once(child, "exit").then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
