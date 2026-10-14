import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { buildProviderProxyRoutes, normalizeProvider } from "./provider-config.js";
import { handlePostChatCompletions } from "./routes/chat-completions.js";
import { handleGetModels, handlePostMessages, handlePostMessagesCountTokens } from "./routes/messages.js";
import { handleHealth, handlePostResponses, handlePostResponsesCompact } from "./routes/responses.js";
import type {
  GatewayAgentCore,
  GatewayConfig,
  GatewayProvider,
  GatewayRequestLifecycleObserver,
  GatewayToolWriteObserver,
  GatewayUsageObserver,
} from "./types.js";
import { GATEWAY_AGENT_CORES } from "./upstream/user-agent.js";
import {
  createUpstreamFetchController,
  parseUpstreamProxyUrl,
  type UpstreamFetchController,
} from "./upstream-proxy.js";

export type GatewayLogFn = (message: string) => void;

export interface EcoGatewayServer {
  port: number;
  /** In-process request handler (Bridge / embedded callers). */
  handleRequest: (request: Request) => Response | Promise<Response>;
  stop: () => void;
  getProviders: () => GatewayProvider[];
  setProviders: (providers: GatewayProvider[]) => void;
  setCredentialResolver: (resolver: GatewayConfig["resolveCredential"]) => void;
  setCredentialReporter: (reporter: GatewayConfig["reportCredentialResult"]) => void;
  setUpstreamUserAgent: (upstreamUserAgent: string | undefined) => void;
  /** Per agent core UA overrides + Eco fallback UA (live update). */
  setUpstreamUserAgents: (
    upstreamUserAgents: Partial<Record<GatewayAgentCore, string>> | undefined,
    userAgentDefault: string | undefined,
  ) => void;
  setUpstreamProxyUrl: (proxyUrl: string | undefined) => void;
  getUpstreamProxyUrl: () => string | undefined;
}

export interface StartEcoGatewayOptions {
  fetchImpl?: typeof fetch;
  onLog?: GatewayLogFn;
  onUsage?: GatewayUsageObserver;
  onRequestLifecycle?: GatewayRequestLifecycleObserver;
  /**
   * The model began writing a tool call. Codex's app-server reports a tool only once its
   * arguments are complete, so this is the only signal for the (often minute-long) write.
   */
  onToolWriteStarted?: GatewayToolWriteObserver;
  /**
   * When true, do not bind a public TCP port. Desktop Bridge owns the public
   * listener and calls handleRequest in-process.
   */
  embedded?: boolean;
  /**
   * Map Codex thread id → Eco thread id. Enables the per-thread MCP Hub
   * namespace repair on Responses streams (local models drop `namespace`).
   */
  resolveEcoThreadIdFromCodex?: (codexThreadId: string) => string | undefined;
}

export function createGatewayFetchHandler(
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
  onLog: GatewayLogFn = defaultGatewayLog,
  onUsage?: GatewayUsageObserver,
  onRequestLifecycle?: GatewayRequestLifecycleObserver,
  onProvidersChanged?: (providers: readonly GatewayProvider[]) => void,
  resolveEcoThreadIdFromCodex?: (codexThreadId: string) => string | undefined,
  onToolWriteStarted?: GatewayToolWriteObserver,
): (request: Request) => Response | Promise<Response> {
  return async (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const startedAt = Date.now();

    if (request.method === "GET" && (path === "/health" || path === "/v1/health")) {
      return handleHealth(config);
    }

    if (request.method === "GET" && path === "/v1/models") {
      return handleGetModels(config);
    }

    if (request.method === "PUT" && path === "/v1/providers") {
      const response = await handlePutProviders(request, config, onProvidersChanged);
      onLog(
        `PUT /v1/providers → ${response.status} providers=${config.providers.length} models=${config.providers.flatMap((p) => p.models).join(",")}`,
      );
      return response;
    }

    // Codex may POST `/responses` when base_url ends with `/v1` and the client
    // URL-joins an absolute `/responses` path (same pattern as `/responses/compact`).
    if (request.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
      const response = await handlePostResponses(
        request,
        config,
        fetchImpl,
        onLog,
        onUsage,
        onRequestLifecycle,
        resolveEcoThreadIdFromCodex,
        onToolWriteStarted,
      );
      onLog(`POST ${path} → ${response.status} (${Date.now() - startedAt}ms)`);
      return response;
    }

    if (request.method === "POST" && (path === "/v1/responses/compact" || path === "/responses/compact")) {
      const response = await handlePostResponsesCompact(
        request,
        config,
        fetchImpl,
        onLog,
        onUsage,
        onRequestLifecycle,
      );
      onLog(`POST ${path} → ${response.status} (${Date.now() - startedAt}ms)`);
      return response;
    }

    if (request.method === "POST" && path === "/v1/messages") {
      const response = await handlePostMessages(
        request,
        config,
        fetchImpl,
        onLog,
        onUsage,
        onRequestLifecycle,
      );
      onLog(`POST /v1/messages → ${response.status} (${Date.now() - startedAt}ms)`);
      return response;
    }

    if (request.method === "POST" && path === "/v1/messages/count_tokens") {
      const response = await handlePostMessagesCountTokens(request, config, fetchImpl, onLog);
      onLog(`POST /v1/messages/count_tokens → ${response.status} (${Date.now() - startedAt}ms)`);
      return response;
    }

    if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      const response = await handlePostChatCompletions(
        request,
        config,
        fetchImpl,
        onLog,
        onUsage,
        onRequestLifecycle,
      );
      onLog(`POST /v1/chat/completions → ${response.status} (${Date.now() - startedAt}ms)`);
      return response;
    }

    onLog(`${request.method} ${path} → 404`);
    return Response.json({ error: { message: "Not found" } }, { status: 404 });
  };
}

function defaultGatewayLog(message: string): void {
  process.stderr.write(`[eco-gateway] ${message}\n`);
}

async function handlePutProviders(
  request: Request,
  config: GatewayConfig,
  onProvidersChanged?: (providers: readonly GatewayProvider[]) => void,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }
  if (!Array.isArray(body) || body.length === 0) {
    return Response.json({ error: { message: "Body must be a non-empty provider array" } }, { status: 400 });
  }
  try {
    config.providers = body.map((entry) => normalizeProvider(entry as GatewayProvider));
    onProvidersChanged?.(config.providers);
  } catch (error) {
    return Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 400 },
    );
  }
  return Response.json({
    ok: true,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      upstreamKind: provider.upstreamKind,
      models: provider.models,
    })),
  });
}

function resolveFetchImpl(
  config: GatewayConfig,
  options?: StartEcoGatewayOptions,
): { fetchImpl: typeof fetch; proxyController?: UpstreamFetchController } {
  if (options?.fetchImpl) {
    return { fetchImpl: options.fetchImpl };
  }
  const proxyController = createUpstreamFetchController(config.upstreamProxyUrl);
  return { fetchImpl: proxyController.fetch, proxyController };
}

/** Node http server — runs in Electron main / Node without Bun. */
export async function startEcoGateway(
  config: GatewayConfig,
  options?: StartEcoGatewayOptions,
): Promise<EcoGatewayServer> {
  if (config.upstreamProxyUrl) {
    // Validate early so bad config fails before accept.
    parseUpstreamProxyUrl(config.upstreamProxyUrl);
  }
  // Normalize (and validate) providers, including per-provider proxy URLs.
  config.providers = config.providers.map((provider) => normalizeProvider(provider));
  const { fetchImpl, proxyController } = resolveFetchImpl(config, options);
  const onLog = options?.onLog ?? defaultGatewayLog;
  if (proxyController) {
    proxyController.setProxyRoutes(buildProviderProxyRoutes(config.providers));
  }

  // Mutable fetch slot so setUpstreamProxyUrl can re-point live traffic.
  let activeFetch = fetchImpl;
  const handler = createGatewayFetchHandler(
    config,
    ((input, init) => activeFetch(input, init)) as typeof fetch,
    onLog,
    options?.onUsage,
    options?.onRequestLifecycle,
    proxyController
      ? (providers) => {
          proxyController.setProxyRoutes(buildProviderProxyRoutes(providers));
        }
      : undefined,
    options?.resolveEcoThreadIdFromCodex,
    options?.onToolWriteStarted,
  );

  let server: http.Server | undefined;
  let port = config.port;

  if (!options?.embedded) {
    server = http.createServer((req, res) => {
      void dispatchNodeRequest(req, res, handler).catch((error) => {
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
        server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server?.off("error", onError);
        resolve();
      };
      server!.once("error", onError);
      server!.once("listening", onListening);
      server!.listen(config.port, config.host);
    });

    const address = server.address();
    port =
      address && typeof address === "object" && typeof address.port === "number" ? address.port : config.port;
  }

  return {
    port,
    handleRequest: handler,
    stop: () => {
      server?.close();
      proxyController?.close();
    },
    getProviders: () => config.providers,
    setProviders: (providers) => {
      config.providers = providers.map(normalizeProvider);
      proxyController?.setProxyRoutes(buildProviderProxyRoutes(config.providers));
    },
    setCredentialResolver: (resolver) => {
      if (resolver) config.resolveCredential = resolver;
      else delete config.resolveCredential;
    },
    setCredentialReporter: (reporter) => {
      if (reporter) config.reportCredentialResult = reporter;
      else delete config.reportCredentialResult;
    },
    setUpstreamUserAgent: (upstreamUserAgent) => {
      const trimmed = upstreamUserAgent?.trim();
      if (trimmed) {
        config.upstreamUserAgent = trimmed;
      } else {
        delete config.upstreamUserAgent;
      }
    },
    setUpstreamUserAgents: (upstreamUserAgents, userAgentDefault) => {
      const normalized: Partial<Record<GatewayAgentCore, string>> = {};
      for (const core of GATEWAY_AGENT_CORES) {
        const trimmed = upstreamUserAgents?.[core]?.trim();
        if (trimmed) {
          normalized[core] = trimmed;
        }
      }
      if (Object.keys(normalized).length > 0) {
        config.upstreamUserAgents = normalized;
      } else {
        delete config.upstreamUserAgents;
      }
      const fallback = userAgentDefault?.trim();
      if (fallback) {
        config.userAgentDefault = fallback;
      } else {
        delete config.userAgentDefault;
      }
    },
    setUpstreamProxyUrl: (proxyUrl) => {
      const parsed = parseUpstreamProxyUrl(proxyUrl);
      if (parsed) {
        config.upstreamProxyUrl = parsed;
      } else {
        delete config.upstreamProxyUrl;
      }
      if (proxyController) {
        proxyController.setProxyUrl(parsed);
        activeFetch = proxyController.fetch;
        return;
      }
      // Custom fetchImpl from host — cannot apply proxy internally.
      if (parsed) {
        onLog("setUpstreamProxyUrl ignored because a custom fetchImpl was injected");
      }
    },
    getUpstreamProxyUrl: () => config.upstreamProxyUrl,
  };
}

export async function dispatchNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (request: Request) => Response | Promise<Response>,
): Promise<void> {
  const webRequest = await nodeRequestToWebRequest(req);
  const webResponse = await handler(webRequest);
  await writeWebResponseToNode(webResponse, res);
}

async function nodeRequestToWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  if (!hasBody) {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  if (body.length === 0) {
    return new Request(url, { method, headers });
  }
  return new Request(url, {
    method,
    headers,
    body: new Uint8Array(body),
    // Node fetch requires duplex when a body is present on Request init.
    duplex: "half",
  } as RequestInit);
}

async function writeWebResponseToNode(webResponse: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") {
      return;
    }
    res.setHeader(key, value);
  });

  if (!webResponse.body) {
    res.end();
    return;
  }

  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        const canContinue = res.write(Buffer.from(value));
        if (!canContinue) {
          await onceDrain(res);
        }
      }
    }
    res.end();
  } catch (error) {
    res.destroy(error instanceof Error ? error : undefined);
  } finally {
    reader.releaseLock();
  }
}

function onceDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    res.once("drain", () => resolve());
  });
}
