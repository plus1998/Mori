/**
 * Eco SDK Bridge — public HTTP face for Codex (Responses) and Claude (Messages).
 * Product layer: attribution + provider/model resolution, then in-process Gateway.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import {
  CODEX_TURN_METADATA_HEADER,
  dispatchNodeRequest,
  type EcoGatewayServer,
  GATEWAY_AGENT_CORE_HEADER,
  GATEWAY_LOGICAL_REQUEST_ID_HEADER,
  GATEWAY_PROVIDER_ID_HEADER,
  GATEWAY_REQUESTED_MODEL_HEADER,
  GATEWAY_THREAD_ID_HEADER,
  GATEWAY_UPSTREAM_KIND_HEADER,
  mapApiCompatToUpstreamKind,
  parseCodexTurnMetadataHeader,
  readGatewayAgentCore,
  type UpstreamKind,
} from "@eco/gateway";
import type { CodexTurnRouteRegistry } from "@eco/runtime";
import { InvalidCodexGatewayModelAliasError, parseCodexGatewayModelAlias } from "@eco/shared";
import type { UpstreamAgentCore } from "../shared/ipc";
import { isEcoSdkModelAlias } from "../shared/model-id";
import {
  ECO_BRIDGE_BINDING_ID_HEADER,
  ECO_BRIDGE_RUN_ATTEMPT_ID_HEADER,
  extractClaudeBridgeCredential,
  redactClaudeBridgeSecret,
} from "./claude-bridge-binding";

export type BridgeLogFn = (message: string) => void;

export interface BridgeRouteResolution {
  providerId: string;
  upstreamModelId: string;
  upstreamKind?: UpstreamKind;
}

export interface EcoSdkBridgeOptions {
  gateway: EcoGatewayServer;
  /** Codex turn → route (provider + model). */
  turnRouteRegistry?: CodexTurnRouteRegistry;
  getTurnRouteRegistry?: () => CodexTurnRouteRegistry | undefined;
  /**
   * Optional product-layer resolver when headers/registry cannot resolve
   * (e.g. Claude stamp path, eco_{providerId} default model, models[] match).
   * Must not be the only long-term mechanism for unique billing attribution.
   */
  resolveRoute?: (input: {
    face: "responses" | "messages" | "chat_completions";
    model: string | undefined;
    headers: Headers;
  }) => BridgeRouteResolution | undefined;
  /** Provider table for product-layer eco_/models resolution (not used by gateway). */
  getProviders?: () => readonly { id: string; upstreamModelId: string; models: string[] }[];
  /** Product prep for Claude Messages (alias resolve, images, thinking, count_tokens, models list).
   * Return early response or rewritten body + route resolution.
   */
  prepareClaudeMessages?: (input: {
    path: string;
    method: string;
    body: Record<string, unknown>;
    model: string | undefined;
    headers: Headers;
  }) => Promise<
    | { kind: "response"; response: Response }
    | {
        kind: "forward";
        resolution: BridgeRouteResolution;
        clientModel: string;
        role?: string;
        threadId?: string;
        bridgeBindingId?: string;
        runAttemptId?: string;
        logicalRequestId?: string;
        /** Release request lease after the gateway response settles. */
        releaseLease?: () => void;
      }
    | { kind: "miss" }
  >;
  /**
   * Binding-credential prep for Responses / Chat Completions faces (PI + shared control plane).
   * When credential is absent, return miss so Codex/alias resolution can proceed.
   */
  prepareGatewayBindingForward?: (input: {
    face: "responses" | "chat_completions";
    body: Record<string, unknown>;
    model: string | undefined;
    headers: Headers;
  }) => Promise<
    | { kind: "response"; response: Response }
    | {
        kind: "forward";
        resolution: BridgeRouteResolution;
        clientModel: string;
        threadId?: string;
        bridgeBindingId?: string;
        runAttemptId?: string;
        logicalRequestId?: string;
        releaseLease?: () => void;
      }
    | { kind: "miss" }
  >;
  /** Eco owns compact — return a client-safe response without calling gateway. */
  handleCompact?: (request: Request) => Response | Promise<Response>;
  /** Map Codex app-server thread id → Eco desktop thread id for gateway lifecycle / billing join. */
  resolveEcoThreadIdFromCodex?: (codexThreadId: string) => string | undefined;
  onLog?: BridgeLogFn;
}

export interface EcoSdkBridgeServer {
  port: number;
  baseUrl: string;
  stop: () => void;
  handleRequest: (request: Request) => Promise<Response>;
}

function defaultLog(message: string): void {
  process.stderr.write(`[eco-bridge] ${message}\n`);
}

/**
 * Which core issued this request: an explicit stamp wins (PI stamps itself), otherwise
 * the wire face implies it. Chat Completions stays unidentified so it keeps the global
 * UA rules.
 */
function resolveAgentCore(
  headers: Headers,
  face: "responses" | "messages" | "chat_completions",
): UpstreamAgentCore | undefined {
  const stamped = readGatewayAgentCore(headers);
  if (stamped) {
    return stamped;
  }
  if (face === "responses") {
    return "codex";
  }
  if (face === "messages") {
    return "claude";
  }
  return undefined;
}

/**
 * Stamp which agent core issued this request so the gateway can pick a per-core
 * upstream User-Agent (Codex / Claude Code / PI).
 */
function stampAgentCoreHeader(headers: Headers, face: "responses" | "messages" | "chat_completions"): void {
  if (headers.get(GATEWAY_AGENT_CORE_HEADER)?.trim()) {
    return;
  }
  const core = resolveAgentCore(headers, face);
  if (core) {
    headers.set(GATEWAY_AGENT_CORE_HEADER, core);
  }
}

/**
 * Codex may still POST `/v1/responses/compact`.
 * Eco owns compaction out-of-band (scheduler / thread/compact); this endpoint only
 * returns a non-fatal Responses compact wire so the SDK does not hang.
 * Never forwards to Gateway/upstream (plan 2A — no responses-native compact via gateway).
 */
export function buildEcoBridgeCompactInterceptResponse(requestBody?: { model?: unknown }): Response {
  const model =
    typeof requestBody?.model === "string" && requestBody.model.trim()
      ? requestBody.model.trim()
      : "eco-bridge-compact";
  const id = `eco_compact_intercept_${Date.now()}`;
  return Response.json({
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [
      {
        type: "compaction",
        id: `cmp_${id}`,
        encrypted_content: "eco_bridge_compact_intercept",
      },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  });
}

/**
 * Create a Web-fetch handler that resolves provider/model then calls embedded gateway.
 */
export function createEcoSdkBridgeHandler(
  options: EcoSdkBridgeOptions,
): (request: Request) => Promise<Response> {
  const onLog = options.onLog ?? defaultLog;

  return async (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "POST" && (path === "/v1/responses/compact" || path === "/responses/compact")) {
      onLog("POST compact intercepted (Eco Bridge owns compaction; Eco compact runs out-of-band)");
      if (options.handleCompact) {
        return options.handleCompact(request);
      }
      let body: { model?: unknown } | undefined;
      try {
        body = (await request.json()) as { model?: unknown };
      } catch {
        body = undefined;
      }
      return buildEcoBridgeCompactInterceptResponse(body);
    }

    // Claude SDK models catalog: product aliases, not gateway concrete models.
    if (request.method === "GET" && path === "/v1/models" && options.prepareClaudeMessages) {
      const prepared = await options.prepareClaudeMessages({
        path,
        method: request.method,
        body: {},
        model: undefined,
        headers: request.headers,
      });
      if (prepared.kind === "response") {
        return prepared.response;
      }
    }

    // Health/models/providers passthrough without rewriting body.
    if (
      (request.method === "GET" && (path === "/health" || path === "/v1/health" || path === "/v1/models")) ||
      (request.method === "PUT" && path === "/v1/providers")
    ) {
      return options.gateway.handleRequest(request);
    }

    if (
      request.method === "POST" &&
      (path === "/v1/responses" ||
        path === "/responses" ||
        path === "/v1/messages" ||
        path === "/v1/messages/count_tokens" ||
        path === "/v1/chat/completions" ||
        path === "/chat/completions")
    ) {
      const face: "responses" | "messages" | "chat_completions" =
        path === "/v1/responses" || path === "/responses"
          ? "responses"
          : path === "/v1/chat/completions" || path === "/chat/completions"
            ? "chat_completions"
            : "messages";
      return forwardWithResolvedRoute(request, face, path, options, onLog);
    }

    return options.gateway.handleRequest(request);
  };
}

async function forwardWithResolvedRoute(
  request: Request,
  face: "responses" | "messages" | "chat_completions",
  path: string,
  options: EcoSdkBridgeOptions,
  onLog: BridgeLogFn,
): Promise<Response> {
  const bodyText = await request.text();
  let body: Record<string, unknown> = {};
  if (bodyText.trim()) {
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
    }
  }

  const model = typeof body.model === "string" ? body.model : undefined;
  const headers = new Headers(request.headers);
  // Stamp the issuing agent core so the gateway can apply a per-core User-Agent.
  stampAgentCoreHeader(headers, face);
  let clientModel = model?.trim();

  // Explicit product binding (title/auxiliary/provider probe): wins over table/alias.
  // PI also pre-stamps provider id — still run binding prep when a bridge credential is present
  // so eco-{role}-{hash} aliases rewrite to concrete upstream ids (same rule as Responses/Chat).
  const preboundProvider = headers.get(GATEWAY_PROVIDER_ID_HEADER)?.trim();
  const preboundKind = readOptionalUpstreamKind(headers.get(GATEWAY_UPSTREAM_KIND_HEADER));
  const hasBridgeCredential = Boolean(extractClaudeBridgeCredential(headers));

  if (
    face === "messages" &&
    options.prepareClaudeMessages &&
    (hasBridgeCredential || !preboundProvider) &&
    (path === "/v1/messages" || path === "/v1/messages/count_tokens")
  ) {
    const prepared = await options.prepareClaudeMessages({
      path,
      method: request.method,
      body,
      model,
      headers: request.headers,
    });
    if (prepared.kind === "response") {
      return prepared.response;
    }
    if (prepared.kind === "forward") {
      clientModel = prepared.clientModel || clientModel;
      body.model = prepared.resolution.upstreamModelId;
      if (clientModel) {
        headers.set(GATEWAY_REQUESTED_MODEL_HEADER, clientModel);
      }
      headers.set(GATEWAY_PROVIDER_ID_HEADER, prepared.resolution.providerId);
      if (prepared.resolution.upstreamKind) {
        headers.set(GATEWAY_UPSTREAM_KIND_HEADER, prepared.resolution.upstreamKind);
      }
      if (prepared.threadId?.trim()) {
        headers.set(GATEWAY_THREAD_ID_HEADER, prepared.threadId.trim());
      }
      if (prepared.bridgeBindingId?.trim()) {
        headers.set(ECO_BRIDGE_BINDING_ID_HEADER, prepared.bridgeBindingId.trim());
      }
      if (prepared.runAttemptId?.trim()) {
        headers.set(ECO_BRIDGE_RUN_ATTEMPT_ID_HEADER, prepared.runAttemptId.trim());
      }
      if (prepared.logicalRequestId?.trim()) {
        headers.set(GATEWAY_LOGICAL_REQUEST_ID_HEADER, prepared.logicalRequestId.trim());
      }
      stampCodexTurnGatewayIdentity(headers, options);
      headers.delete("content-length");
      onLog(
        `bridge → gateway face=messages provider=${prepared.resolution.providerId} model=${prepared.resolution.upstreamModelId}${prepared.threadId?.trim() ? ` thread=${prepared.threadId.trim()}` : ""}${prepared.bridgeBindingId?.trim() ? ` binding=${redactClaudeBridgeSecret(prepared.bridgeBindingId)}` : ""}`,
      );
      try {
        const response = await options.gateway.handleRequest(
          new Request(request.url, {
            method: request.method,
            headers,
            body: JSON.stringify(body),
            duplex: "half",
          } as RequestInit),
        );
        return wrapResponseReleasingLease(response, prepared.releaseLease);
      } catch (error) {
        prepared.releaseLease?.();
        throw error;
      }
    }
  }

  if ((face === "responses" || face === "chat_completions") && options.prepareGatewayBindingForward) {
    // Always try binding prep first — even when PI pre-sets GATEWAY_PROVIDER_ID_HEADER.
    // Skipping would treat body.model (alias) as upstreamModelId.
    const prepared = await options.prepareGatewayBindingForward({
      face,
      body,
      model,
      headers: request.headers,
    });
    if (prepared.kind === "response") {
      return prepared.response;
    }
    if (prepared.kind === "forward") {
      clientModel = prepared.clientModel || clientModel;
      body.model = prepared.resolution.upstreamModelId;
      if (clientModel) {
        headers.set(GATEWAY_REQUESTED_MODEL_HEADER, clientModel);
      }
      headers.set(GATEWAY_PROVIDER_ID_HEADER, prepared.resolution.providerId);
      if (prepared.resolution.upstreamKind) {
        headers.set(GATEWAY_UPSTREAM_KIND_HEADER, prepared.resolution.upstreamKind);
      }
      if (prepared.threadId?.trim()) {
        headers.set(GATEWAY_THREAD_ID_HEADER, prepared.threadId.trim());
      }
      if (prepared.bridgeBindingId?.trim()) {
        headers.set(ECO_BRIDGE_BINDING_ID_HEADER, prepared.bridgeBindingId.trim());
      }
      if (prepared.runAttemptId?.trim()) {
        headers.set(ECO_BRIDGE_RUN_ATTEMPT_ID_HEADER, prepared.runAttemptId.trim());
      }
      if (prepared.logicalRequestId?.trim()) {
        headers.set(GATEWAY_LOGICAL_REQUEST_ID_HEADER, prepared.logicalRequestId.trim());
      }
      stampCodexTurnGatewayIdentity(headers, options);
      headers.delete("content-length");
      onLog(
        `bridge → gateway face=${face} provider=${prepared.resolution.providerId} model=${prepared.resolution.upstreamModelId}${prepared.bridgeBindingId?.trim() ? ` binding=${redactClaudeBridgeSecret(prepared.bridgeBindingId)}` : ""}`,
      );
      try {
        const response = await options.gateway.handleRequest(
          new Request(request.url, {
            method: request.method,
            headers,
            body: JSON.stringify(body),
            duplex: "half",
          } as RequestInit),
        );
        return wrapResponseReleasingLease(response, prepared.releaseLease);
      } catch (error) {
        prepared.releaseLease?.();
        throw error;
      }
    }
  }

  let resolution: BridgeRouteResolution | undefined;

  // Header-bound provider is final only when binding prep missed (no binding credential).
  // body.model must already be the concrete upstream id for this path (title/aux probes).
  if (preboundProvider && model?.trim()) {
    const requested = model.trim();
    if (isEcoSdkModelAlias(requested)) {
      onLog(`bridge refused prebound SDK alias face=${face} provider=${preboundProvider} model=${requested}`);
      return Response.json(
        {
          error: {
            message:
              `Bridge could not resolve SDK model alias '${requested}' via prebound provider. ` +
              "Register a binding credential so alias routes can be resolved before calling gateway.",
          },
        },
        { status: 400 },
      );
    }
    resolution = {
      providerId: preboundProvider,
      upstreamModelId: requested,
      ...(preboundKind ? { upstreamKind: preboundKind } : {}),
    };
  } else {
    try {
      resolution =
        resolveFromCodexTurn(
          request.headers,
          model,
          options.getTurnRouteRegistry?.() ?? options.turnRouteRegistry,
        ) ??
        resolveFromEcoAlias(model) ??
        resolveFromProviderTable(model, options.getProviders?.()) ??
        options.resolveRoute?.({ face, model, headers: request.headers });
    } catch (error) {
      if (error instanceof InvalidCodexGatewayModelAliasError) {
        onLog(`bridge invalid model alias face=${face} model=${model ?? "(missing)"}`);
        return Response.json(
          {
            error: {
              message: `Invalid gateway route alias for model '${model}': ${error.message}`,
            },
          },
          { status: 400 },
        );
      }
      throw error;
    }
  }

  if (!resolution) {
    onLog(`bridge route miss face=${face} model=${model ?? "(missing)"} — refusing to guess`);
    return Response.json(
      {
        error: {
          message: "Bridge could not resolve provider for request. Register turn/agent route before calling.",
        },
      },
      { status: 400 },
    );
  }

  if (clientModel) {
    headers.set(GATEWAY_REQUESTED_MODEL_HEADER, clientModel);
  }
  body.model = resolution.upstreamModelId;
  headers.set(GATEWAY_PROVIDER_ID_HEADER, resolution.providerId);
  if (resolution.upstreamKind) {
    headers.set(GATEWAY_UPSTREAM_KIND_HEADER, resolution.upstreamKind);
  }
  stampCodexTurnGatewayIdentity(headers, options);
  // Avoid confusing gateway with partial client content-length after rewrite.
  headers.delete("content-length");

  const rewritten = new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
    duplex: "half",
  } as RequestInit);

  onLog(
    `bridge → gateway face=${face} provider=${resolution.providerId} model=${resolution.upstreamModelId}`,
  );
  return options.gateway.handleRequest(rewritten);
}

function wrapResponseReleasingLease(response: Response, releaseLease: (() => void) | undefined): Response {
  if (!releaseLease) {
    return response;
  }
  let released = false;
  const releaseOnce = () => {
    if (released) {
      return;
    }
    released = true;
    releaseLease();
  };
  const body = response.body;
  if (!body) {
    releaseOnce();
    return response;
  }
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          releaseOnce();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        releaseOnce();
        controller.error(error);
      }
    },
    cancel(reason) {
      releaseOnce();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function readOptionalUpstreamKind(raw: string | null | undefined): UpstreamKind | undefined {
  const value = raw?.trim();
  if (
    value === "anthropic-messages" ||
    value === "responses" ||
    value === "openai-chat" ||
    value === "gateway-delegated"
  ) {
    return value;
  }
  return undefined;
}

/** Stamp Codex turn metadata onto gateway headers so lifecycle timing joins billing spans. */
function stampCodexTurnGatewayIdentity(
  headers: Headers,
  options: Pick<EcoSdkBridgeOptions, "resolveEcoThreadIdFromCodex">,
): void {
  const meta = parseCodexTurnMetadataHeader(headers);
  if (!meta?.turnId?.trim()) {
    return;
  }
  headers.set(GATEWAY_LOGICAL_REQUEST_ID_HEADER, meta.turnId.trim());
  const codexThreadId = meta.threadId?.trim();
  if (!codexThreadId) {
    return;
  }
  const ecoThreadId = options.resolveEcoThreadIdFromCodex?.(codexThreadId)?.trim();
  if (ecoThreadId) {
    headers.set(GATEWAY_THREAD_ID_HEADER, ecoThreadId);
  }
}

function resolveFromCodexTurn(
  headers: Headers,
  model: string | undefined,
  registry: CodexTurnRouteRegistry | undefined,
): BridgeRouteResolution | undefined {
  if (!registry) {
    return undefined;
  }
  const meta = parseCodexTurnMetadataHeader(headers);
  if (!meta?.threadId || !meta.turnId) {
    return undefined;
  }
  const record = registry.peek(meta.threadId, meta.turnId);
  if (!record) {
    return undefined;
  }
  return {
    providerId: record.providerId,
    upstreamModelId: record.upstreamModelId || model?.trim() || "",
    ...(record.apiCompat ? { upstreamKind: mapApiCompatToUpstreamKind(record.apiCompat) } : {}),
  };
}

/**
 * Product-layer parsing of legacy eco model aliases.
 * Gateway itself never parses these; Bridge still accepts them so hard-cut
 * can proceed without simultaneous full SDK config rewrite in every call site.
 */
function resolveFromEcoAlias(model: string | undefined): BridgeRouteResolution | undefined {
  if (!model?.trim()) {
    return undefined;
  }
  try {
    const parsed = parseCodexGatewayModelAlias(model);
    if (!parsed) {
      return undefined;
    }
    return {
      providerId: parsed.providerId,
      upstreamModelId: parsed.upstreamModelId,
      ...(parsed.apiCompat ? { upstreamKind: mapApiCompatToUpstreamKind(parsed.apiCompat) } : {}),
    };
  } catch (error) {
    if (error instanceof InvalidCodexGatewayModelAliasError) {
      // Malformed reserved V1 alias — fail closed with explicit error at caller.
      throw error;
    }
    throw error;
  }
}

/**
 * Product-only: eco_{providerId} → default upstream model; models[] exact match.
 * Gateway never does this.
 */
function resolveFromProviderTable(
  model: string | undefined,
  providers: readonly { id: string; upstreamModelId: string; models: string[] }[] | undefined,
): BridgeRouteResolution | undefined {
  if (!model?.trim() || !providers?.length) {
    return undefined;
  }
  const requested = model.trim();
  const ecoMatch = providers.find((p) => requested === `eco_${p.id}`);
  if (ecoMatch) {
    return {
      providerId: ecoMatch.id,
      upstreamModelId: ecoMatch.upstreamModelId,
    };
  }
  const exact = providers.find((p) => p.models.includes(requested));
  if (exact) {
    return {
      providerId: exact.id,
      upstreamModelId: requested,
    };
  }
  return undefined;
}

export async function startEcoSdkBridge(
  host: string,
  port: number,
  options: EcoSdkBridgeOptions,
): Promise<EcoSdkBridgeServer> {
  const handleRequest = createEcoSdkBridgeHandler(options);
  const server = http.createServer((req, res) => {
    void dispatchNodeRequest(req as IncomingMessage, res as ServerResponse, handleRequest).catch((error) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const boundPort =
    address && typeof address === "object" && typeof address.port === "number" ? address.port : port;

  return {
    port: boundPort,
    baseUrl: `http://127.0.0.1:${boundPort}`,
    stop: () => {
      server.close();
    },
    handleRequest,
  };
}

export { CODEX_TURN_METADATA_HEADER };
