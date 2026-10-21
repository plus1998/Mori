import { randomUUID } from "node:crypto";

import type {
  GatewayCredentialResult,
  GatewayRequestLifecycleEvent,
  GatewayRequestLifecycleObserver,
  GatewayRequestLifecycleSource,
  GatewayUpstreamErrorInfo,
  GatewayUpstreamResultType,
  ResolvedProviderRoute,
} from "./types.js";
import { readUpstreamRequestId } from "./upstream/request-id-headers.js";

type GatewayLogFn = (message: string) => void;

export type LogicalRequestTerminal = "completed" | "failed" | "cancelled";

export class RequestLifecycleTracker {
  private logicalTerminal: LogicalRequestTerminal | null = null;
  private readonly upstreamTerminalByAttempt = new Map<number, GatewayUpstreamResultType>();
  private upstreamStartedAtMs: number | null = null;
  private firstHeadersAtMs: number | null = null;
  private firstChunkAtMs: number | null = null;
  private firstTokenAtMs: number | null = null;

  hasLogicalTerminal(): boolean {
    return this.logicalTerminal !== null;
  }

  hasUpstreamFailed(): boolean {
    return [...this.upstreamTerminalByAttempt.values()].includes("failed");
  }

  tryMarkHttpFailure(): boolean {
    return this.tryMarkUpstreamTerminal(this.currentAttemptIndex(), "failed");
  }

  tryMarkUpstreamFailed(): boolean {
    return this.tryMarkUpstreamTerminal(this.currentAttemptIndex(), "failed");
  }

  upstreamTerminalFor(attemptIndex: number): GatewayUpstreamResultType | undefined {
    return this.upstreamTerminalByAttempt.get(attemptIndex);
  }

  tryMarkUpstreamTerminal(attemptIndex: number, terminal: GatewayUpstreamResultType): boolean {
    if (this.upstreamTerminalByAttempt.has(attemptIndex)) {
      return false;
    }
    this.upstreamTerminalByAttempt.set(attemptIndex, terminal);
    return true;
  }

  trySetLogicalTerminal(terminal: LogicalRequestTerminal): boolean {
    if (this.logicalTerminal) {
      return false;
    }
    this.logicalTerminal = terminal;
    return true;
  }

  upstreamStartedAt(): number | null {
    return this.upstreamStartedAtMs;
  }

  firstHeadersAt(): number | null {
    return this.firstHeadersAtMs;
  }

  noteUpstreamStarted(atMs = Date.now()): void {
    if (this.upstreamStartedAtMs === null) {
      this.upstreamStartedAtMs = atMs;
    }
  }

  noteHeaders(atMs = Date.now()): void {
    if (this.firstHeadersAtMs === null) {
      this.firstHeadersAtMs = atMs;
    }
  }

  /** Record the first SSE data chunk of any kind (thinking, role, content — matches new-api FirstResponseTime). */
  noteFirstChunk(atMs = Date.now()): void {
    if (this.firstChunkAtMs === null) {
      this.firstChunkAtMs = atMs;
    }
  }

  /** Record the first SSE event that carries an actual text token delta (content/thinking). */
  noteFirstToken(atMs = Date.now()): void {
    if (this.firstTokenAtMs === null) {
      this.firstTokenAtMs = atMs;
    }
  }

  /**
   * new-api style: TTFT = upstream start → first response chunk;
   * generationMs = stream end → first response chunk (fallback: total latency when no chunk).
   * Call at stream end / usage settlement with the end timestamp.
   */
  generationTiming(endAtMs = Date.now()): {
    ttftMs?: number;
    generationMs?: number;
    firstHeadersMs?: number;
    firstTokenMs?: number;
  } {
    const startedAtMs = this.upstreamStartedAtMs;
    if (startedAtMs === null) {
      return {};
    }
    const latencyMs = Math.max(0, endAtMs - startedAtMs);
    const firstChunkAtMs = this.firstChunkAtMs;
    const headersAtMs = this.firstHeadersAtMs;
    const tokenAtMs = this.firstTokenAtMs;
    const firstHeadersMs = headersAtMs !== null ? Math.max(0, headersAtMs - startedAtMs) : undefined;
    const firstTokenMs = tokenAtMs !== null ? Math.max(0, tokenAtMs - startedAtMs) : undefined;
    if (firstChunkAtMs === null) {
      return {
        generationMs: latencyMs,
        ...(firstHeadersMs !== undefined && { firstHeadersMs }),
        ...(firstTokenMs !== undefined && { firstTokenMs }),
      };
    }
    const ttftMs = Math.max(0, firstChunkAtMs - startedAtMs);
    const generationMs = Math.max(0, endAtMs - firstChunkAtMs);
    return {
      ttftMs,
      generationMs: generationMs > 0 ? generationMs : latencyMs,
      ...(firstHeadersMs !== undefined && { firstHeadersMs }),
      ...(firstTokenMs !== undefined && { firstTokenMs }),
    };
  }

  private _attemptIndex = 0;

  nextAttemptIndex(): number {
    return this._attemptIndex++;
  }

  currentAttemptIndex(): number {
    return this._attemptIndex - 1;
  }
}

export interface RequestLifecycleContext {
  source: GatewayRequestLifecycleSource;
  route: ResolvedProviderRoute;
  onLog: GatewayLogFn;
  observer?: GatewayRequestLifecycleObserver;
  tracker: RequestLifecycleTracker;
  logicalRequestId: string;
  attemptIndex: number;
  reportCredentialResult?: (result: GatewayCredentialResult) => void | Promise<void>;
}

export function observeLifecycle(
  observer: GatewayRequestLifecycleObserver | undefined,
  event: GatewayRequestLifecycleEvent,
  onLog: GatewayLogFn,
): void {
  try {
    void Promise.resolve(observer?.(event)).catch((error) => {
      onLog(`request lifecycle observer failed: ${formatLifecycleError(error)}`);
    });
  } catch (error) {
    onLog(`request lifecycle observer failed: ${formatLifecycleError(error)}`);
  }
}

function lifecycleIdentity(ctx: RequestLifecycleContext): {
  source: GatewayRequestLifecycleSource;
  providerId: string;
  requestedModel: string;
  upstreamModelId: string;
  logicalRequestId: string;
  attemptIndex: number;
  observedAt: string;
  bridgeBindingId?: string;
  threadId?: string;
  turnId?: string;
  runAttemptId?: string;
} {
  return {
    source: ctx.source,
    providerId: ctx.route.provider.id,
    requestedModel: ctx.route.requestedModel,
    upstreamModelId: ctx.route.upstreamModelId,
    logicalRequestId: ctx.logicalRequestId,
    attemptIndex: ctx.attemptIndex,
    observedAt: new Date().toISOString(),
    ...(ctx.route.bridgeBindingId ? { bridgeBindingId: ctx.route.bridgeBindingId } : {}),
    ...(ctx.route.threadId ? { threadId: ctx.route.threadId } : {}),
    ...(ctx.route.turnId ? { turnId: ctx.route.turnId } : {}),
    ...(ctx.route.runAttemptId ? { runAttemptId: ctx.route.runAttemptId } : {}),
  };
}

function reportCredentialTerminal(
  ctx: RequestLifecycleContext,
  input: {
    resultType: GatewayUpstreamResultType;
    statusCode?: number;
    providerRequestId?: string;
    responseId?: string;
    error?: GatewayUpstreamErrorInfo;
  },
): void {
  if (ctx.route.provider.authMethod !== "chatgpt_subscription" || !ctx.reportCredentialResult) {
    return;
  }
  const identity = lifecycleIdentity(ctx);
  const result: GatewayCredentialResult = {
    provider: ctx.route.provider,
    resultType: input.resultType,
    logicalRequestId: ctx.logicalRequestId,
    attemptIndex: ctx.attemptIndex,
    ...(ctx.route.credentialAccountId ? { accountId: ctx.route.credentialAccountId } : {}),
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    ...(input.responseId ? { responseId: input.responseId } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(identity.bridgeBindingId ? { bridgeBindingId: identity.bridgeBindingId } : {}),
    ...(identity.threadId ? { threadId: identity.threadId } : {}),
    ...(identity.turnId ? { turnId: identity.turnId } : {}),
    ...(identity.runAttemptId ? { runAttemptId: identity.runAttemptId } : {}),
  };
  try {
    void Promise.resolve(ctx.reportCredentialResult(result)).catch((error) => {
      ctx.onLog(`credential result reporter failed: ${formatLifecycleError(error)}`);
    });
  } catch (error) {
    ctx.onLog(`credential result reporter failed: ${formatLifecycleError(error)}`);
  }
}

export function tryEmitUpstreamCompleted(
  ctx: RequestLifecycleContext | undefined,
  input: {
    providerRequestId?: string;
    responseId?: string;
    statusCode?: number;
  } = {},
): boolean {
  if (!ctx || !ctx.tracker.tryMarkUpstreamTerminal(ctx.attemptIndex, "completed")) {
    return false;
  }
  observeLifecycle(
    ctx.observer,
    {
      type: "upstream.completed",
      resultType: "completed",
      ...lifecycleIdentity(ctx),
      ...(ctx.route.credentialAccountId ? { accountId: ctx.route.credentialAccountId } : {}),
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(input.responseId ? { responseId: input.responseId } : {}),
      ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    },
    ctx.onLog,
  );
  reportCredentialTerminal(ctx, {
    resultType: "completed",
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    ...(input.responseId ? { responseId: input.responseId } : {}),
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
  });
  return true;
}

export function tryEmitUpstreamFailed(
  ctx: RequestLifecycleContext | undefined,
  input: {
    stage: "transport" | "http" | "stream" | "protocol";
    error: string;
    statusCode?: number;
    providerRequestId?: string;
    responseId?: string;
    errorInfo?: GatewayUpstreamErrorInfo;
  },
): boolean {
  if (!ctx || !ctx.tracker.tryMarkUpstreamTerminal(ctx.attemptIndex, "failed")) {
    return false;
  }
  const errorInfo = input.errorInfo ?? { message: input.error };
  observeLifecycle(
    ctx.observer,
    {
      type: "upstream.failed",
      resultType: "failed",
      ...lifecycleIdentity(ctx),
      ...(ctx.route.credentialAccountId ? { accountId: ctx.route.credentialAccountId } : {}),
      stage: input.stage,
      error: input.error,
      errorInfo,
      ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(input.responseId ? { responseId: input.responseId } : {}),
    },
    ctx.onLog,
  );
  reportCredentialTerminal(ctx, {
    resultType: "failed",
    error: errorInfo,
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    ...(input.responseId ? { responseId: input.responseId } : {}),
  });
  return true;
}

/** Final HTTP non-2xx after retries — exactly one upstream.failed with stage=http. */
export function tryEmitHttpUpstreamFailure(
  ctx: RequestLifecycleContext | undefined,
  input: {
    error: string;
    statusCode: number;
    providerRequestId?: string;
    responseId?: string;
    errorInfo?: GatewayUpstreamErrorInfo;
  },
): boolean {
  return tryEmitUpstreamFailed(ctx, {
    stage: "http",
    error: input.error,
    statusCode: input.statusCode,
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    ...(input.responseId ? { responseId: input.responseId } : {}),
    ...(input.errorInfo ? { errorInfo: input.errorInfo } : {}),
  });
}

export function tryEmitLogicalCompleted(
  ctx: RequestLifecycleContext | undefined,
  providerRequestId?: string,
  responseId?: string,
  statusCode?: number,
): boolean {
  if (!ctx) {
    return false;
  }
  const terminal = ctx.tracker.upstreamTerminalFor(ctx.attemptIndex);
  if (terminal && terminal !== "completed") {
    return false;
  }
  if (!terminal) {
    tryEmitUpstreamCompleted(ctx, {
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(responseId ? { responseId } : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
    });
  }
  if (!ctx.tracker.trySetLogicalTerminal("completed")) {
    return false;
  }
  const completedAtMs = Date.now();
  const startedAtMs = ctx.tracker.upstreamStartedAt();
  const headersAtMs = ctx.tracker.firstHeadersAt();
  if (startedAtMs !== null) {
    const upstreamMs = completedAtMs - startedAtMs;
    const ttfbMs = headersAtMs !== null ? headersAtMs - startedAtMs : undefined;
    const tokenTiming = ctx.tracker.generationTiming();
    ctx.onLog(
      `request lifecycle complete logical=${ctx.logicalRequestId} upstreamMs=${upstreamMs}` +
        `${ttfbMs !== undefined ? ` ttfbMs=${ttfbMs}` : ""}` +
        `${tokenTiming.firstHeadersMs !== undefined ? ` firstHeadersMs=${tokenTiming.firstHeadersMs}` : ""}` +
        `${tokenTiming.ttftMs !== undefined ? ` ttftMs=${tokenTiming.ttftMs}` : ""}` +
        `${tokenTiming.generationMs !== undefined ? ` generationMs=${tokenTiming.generationMs}` : ""}` +
        `${tokenTiming.firstTokenMs !== undefined ? ` firstTokenMs=${tokenTiming.firstTokenMs}` : ""}` +
        `${providerRequestId ? ` provider=${providerRequestId}` : ""}`,
    );
  }
  observeLifecycle(
    ctx.observer,
    {
      type: "logical.completed",
      resultType: "completed",
      ...lifecycleIdentity(ctx),
      ...(ctx.route.credentialAccountId ? { accountId: ctx.route.credentialAccountId } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(responseId ? { responseId } : {}),
    },
    ctx.onLog,
  );
  return true;
}

export function tryEmitLogicalFailed(
  ctx: RequestLifecycleContext | undefined,
  input: {
    error: string;
    stage?: "transport" | "http" | "stream" | "protocol";
    statusCode?: number;
    providerRequestId?: string;
    responseId?: string;
    errorInfo?: GatewayUpstreamErrorInfo;
  },
): boolean {
  if (!ctx) {
    return false;
  }
  const terminal = ctx.tracker.upstreamTerminalFor(ctx.attemptIndex);
  if (terminal && terminal !== "failed") {
    return false;
  }
  if (!ctx.tracker.trySetLogicalTerminal("failed")) {
    return false;
  }
  const errorInfo = input.errorInfo ?? { message: input.error };
  observeLifecycle(
    ctx.observer,
    {
      type: "logical.failed",
      resultType: "failed",
      ...lifecycleIdentity(ctx),
      ...(ctx.route.credentialAccountId ? { accountId: ctx.route.credentialAccountId } : {}),
      error: input.error,
      errorInfo,
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(input.responseId ? { responseId: input.responseId } : {}),
    },
    ctx.onLog,
  );
  return true;
}

export function tryEmitLogicalCancelled(
  ctx: RequestLifecycleContext | undefined,
  input?: { reason?: string; providerRequestId?: string; responseId?: string; statusCode?: number },
): boolean {
  if (!ctx) {
    return false;
  }
  const terminal = ctx.tracker.upstreamTerminalFor(ctx.attemptIndex);
  if (terminal && terminal !== "cancelled") {
    return false;
  }
  if (!ctx.tracker.trySetLogicalTerminal("cancelled")) {
    return false;
  }
  if (!terminal) {
    tryEmitUpstreamCancelled(ctx, input);
  }
  observeLifecycle(
    ctx.observer,
    {
      type: "logical.cancelled",
      resultType: "cancelled",
      ...lifecycleIdentity(ctx),
      ...(ctx.route.credentialAccountId ? { accountId: ctx.route.credentialAccountId } : {}),
      ...(input?.reason ? { reason: input.reason } : {}),
      ...(input?.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(input?.responseId ? { responseId: input.responseId } : {}),
    },
    ctx.onLog,
  );
  return true;
}

export function tryEmitUpstreamCancelled(
  ctx: RequestLifecycleContext | undefined,
  input?: { reason?: string; providerRequestId?: string; responseId?: string; statusCode?: number },
): boolean {
  if (!ctx || !ctx.tracker.tryMarkUpstreamTerminal(ctx.attemptIndex, "cancelled")) {
    return false;
  }
  observeLifecycle(
    ctx.observer,
    {
      type: "upstream.cancelled",
      resultType: "cancelled",
      ...lifecycleIdentity(ctx),
      ...(ctx.route.credentialAccountId ? { accountId: ctx.route.credentialAccountId } : {}),
      ...(input?.reason ? { reason: input.reason } : {}),
      ...(input?.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(input?.responseId ? { responseId: input.responseId } : {}),
      ...(input?.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    },
    ctx.onLog,
  );
  reportCredentialTerminal(ctx, {
    resultType: "cancelled",
    ...(input?.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    ...(input?.responseId ? { responseId: input.responseId } : {}),
    ...(input?.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
  });
  return true;
}

/** Report a terminal upstream failure (upstream.failed + logical.failed), each exactly once. */
export function reportLogicalUpstreamFailure(
  ctx: RequestLifecycleContext | undefined,
  input: {
    stage: "transport" | "http" | "stream" | "protocol";
    error: string;
    statusCode?: number;
    providerRequestId?: string;
    responseId?: string;
    errorInfo?: GatewayUpstreamErrorInfo;
  },
): void {
  if (input.stage === "http" && input.statusCode !== undefined) {
    tryEmitHttpUpstreamFailure(ctx, {
      error: input.error,
      statusCode: input.statusCode,
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(input.responseId ? { responseId: input.responseId } : {}),
      ...(input.errorInfo ? { errorInfo: input.errorInfo } : {}),
    });
  } else {
    tryEmitUpstreamFailed(ctx, input);
  }
  tryEmitLogicalFailed(ctx, {
    error: input.error,
    stage: input.stage,
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    ...(input.responseId ? { responseId: input.responseId } : {}),
    ...(input.errorInfo ? { errorInfo: input.errorInfo } : {}),
  });
}

/** Real upstream fetch: started/headers only; transport errors are terminal failures. */
export async function fetchWithRequestLifecycle(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  ctx: RequestLifecycleContext,
): Promise<Response> {
  ctx.attemptIndex = ctx.tracker.nextAttemptIndex();
  ctx.tracker.noteUpstreamStarted();
  observeLifecycle(
    ctx.observer,
    {
      type: "upstream.started",
      ...lifecycleIdentity(ctx),
    },
    ctx.onLog,
  );
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    // Do not mark logical failure here — callers / fetchUpstreamWithRetry may retry.
    const message = formatLifecycleError(error);
    tryEmitUpstreamFailed(ctx, { stage: "transport", error: message });
    throw error;
  }
  const providerRequestId = readUpstreamRequestId(response.headers);
  ctx.tracker.noteHeaders();
  observeLifecycle(
    ctx.observer,
    {
      type: "upstream.headers",
      ...lifecycleIdentity(ctx),
      statusCode: response.status,
      ...(providerRequestId ? { providerRequestId } : {}),
    },
    ctx.onLog,
  );
  return response;
}

function formatLifecycleError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildRequestLifecycleContext(
  route: ResolvedProviderRoute,
  source: GatewayRequestLifecycleSource,
  onLog: GatewayLogFn,
  observer?: GatewayRequestLifecycleObserver,
  reportCredentialResult?: (result: GatewayCredentialResult) => void | Promise<void>,
): RequestLifecycleContext | undefined {
  if (!observer && !reportCredentialResult) {
    return undefined;
  }
  const logicalRequestId = route.logicalRequestId || `glr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  return {
    source,
    route,
    onLog,
    ...(observer ? { observer } : {}),
    tracker: new RequestLifecycleTracker(),
    logicalRequestId,
    attemptIndex: 0,
    ...(reportCredentialResult ? { reportCredentialResult } : {}),
  };
}
