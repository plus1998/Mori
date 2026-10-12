import {
  type EcoGatewayServer,
  type GatewayConfig,
  type GatewayProvider,
  type GatewayRequestLifecycleObserver,
  type GatewayToolWriteObserver,
  type GatewayUsageObserver,
  normalizeProvider,
  startEcoGateway,
} from "@eco/gateway";
import {
  type CodexTurnRouteRegistry,
  DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS,
  type GlobalMaxOutputTokens,
  resolveAppliedMaxOutputTokens,
  resolveEcoGatewayPort,
} from "@eco/runtime";
import type { UpstreamApiCompat } from "../shared/api-compat";
import type { UpstreamAgentCore } from "../shared/ipc";
import { normalizeProviderTokenCountMode, type ProviderTokenCountMode } from "../shared/provider-token-count";
import {
  type BridgeRouteResolution,
  type EcoSdkBridgeOptions,
  type EcoSdkBridgeServer,
  startEcoSdkBridge,
} from "./eco-sdk-bridge";

export type GatewayUpstreamKind = "anthropic-messages" | "responses" | "openai-chat" | "gateway-delegated";

export interface EcoProviderForGateway {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  /** Path prefix for upstream API requests, e.g. `/anthropic` or `/zen`. */
  requestPath?: string;
  /** API path version segment (e.g. `v1`). Empty/missing → `v1`. */
  version?: string;
  apiKey: string;
  authMethod?: "api_key" | "oauth" | "auth_json" | "chatgpt_subscription";
  credentialPoolId?: string;
  /** Per-provider upstream proxy; empty/missing = global proxy setting. */
  upstreamProxyUrl?: string;
  apiCompat: UpstreamApiCompat;
  tokenCountMode?: ProviderTokenCountMode;
  defaultModel: string;
  /** Extra model ids that Codex may send (candidates / route models). */
  modelIds?: readonly string[];
  models?: readonly {
    modelId: string;
    maxOutputTokens?: number;
    contextTokens?: number;
  }[];
}

export interface GatewayProviderPayload {
  id: string;
  name: string;
  upstreamKind: GatewayUpstreamKind;
  baseUrl: string;
  requestPath?: string;
  version?: string;
  apiKey: string;
  authMethod?: "api_key" | "oauth" | "auth_json" | "chatgpt_subscription";
  credentialPoolId?: string;
  upstreamProxyUrl?: string;
  upstreamModelId: string;
  models: string[];
  modelMaxOutputTokens?: Record<string, number>;
  modelContextTokens?: Record<string, number>;
  tokenCountMode?: ProviderTokenCountMode;
}

export interface EcoGatewayLifecycleOptions {
  ecoDataDir: string;
  listProviders: () => readonly EcoProviderForGateway[] | Promise<readonly EcoProviderForGateway[]>;
  /** Global Proxy Bridge User-Agent override; undefined = passthrough / Eco default. */
  getUpstreamUserAgent?: () => string | undefined;
  /** Per agent core (codex/claude/pi) User-Agent overrides; empty = SDK UA. */
  getUpstreamUserAgents?: () => Partial<Record<UpstreamAgentCore, string>> | undefined;
  /** Eco fallback UA (`Eco-Coding/<version> (<platform> <release>; <arch>)`). */
  getDefaultUpstreamUserAgent?: () => string | undefined;
  /** Outbound SOCKS/HTTP proxy URL for gateway upstream fetch. */
  getUpstreamProxyUrl?: () => string | undefined;
  getGatewayCredentialResolver?: () =>
    | ((input: {
        provider: GatewayProvider;
        request?: Request;
      }) => Promise<{ accessToken: string; accountId?: string; upstreamProxyUrl?: string }>)
    | undefined;
  getGatewayCredentialReporter?: () =>
    | ((input: {
        provider: GatewayProvider;
        accountId?: string;
        statusCode: number;
        errorCode?: string;
      }) => void | Promise<void>)
    | undefined;
  /** Fixed ceiling or per-request remaining-window budget. */
  getGlobalMaxOutputTokens?: () => GlobalMaxOutputTokens;
  countInputTokens?: GatewayConfig["countInputTokens"];
  gatewayPort?: number;
  onStderr?: (chunk: string) => void;
  onUsage?: GatewayUsageObserver;
  onRequestLifecycle?: GatewayRequestLifecycleObserver;
  /**
   * The model began writing a tool call on the upstream stream. Codex reports a tool only
   * once its arguments are complete, so this is the only signal for the write itself.
   */
  onToolWriteStarted?: GatewayToolWriteObserver;
  getTurnRouteRegistry?: () => CodexTurnRouteRegistry | undefined;
  /** Claude product-layer route resolution (stamp / role registry). */
  resolveMessagesRoute?: (input: {
    model: string | undefined;
    headers: Headers;
  }) => BridgeRouteResolution | undefined;
  /** Claude Messages product prep (aliases, thinking, images, count_tokens). */
  prepareClaudeMessages?: EcoSdkBridgeOptions["prepareClaudeMessages"];
  /** Binding-credential prep for Responses / Chat Completions faces. */
  prepareGatewayBindingForward?: EcoSdkBridgeOptions["prepareGatewayBindingForward"];
  /** Map Codex thread id → Eco thread id for gateway lifecycle identity on Codex routes. */
  resolveEcoThreadIdFromCodex?: (codexThreadId: string) => string | undefined;
}

/**
 * Hosts embedded eco-gateway (no public listen) + public Eco SDK Bridge on :18765.
 * Codex/Claude only talk to the Bridge; Gateway is in-process protocol conversion.
 */
export class EcoGatewayLifecycle {
  private gateway: EcoGatewayServer | undefined;
  private bridge: EcoSdkBridgeServer | undefined;
  private lastIncompleteProviderIds: string[] = [];
  /**
   * Single-flight ensure: concurrent callers (Claude proxy + title/aux + codex prep)
   * used to race `listen(18765)` and the loser raised a false EADDRINUSE even though
   * this process held the port.
   */
  private ensureInFlight: Promise<GatewayProviderPayload[]> | undefined;

  constructor(private readonly options: EcoGatewayLifecycleOptions) {}

  get port(): number {
    return this.bridge?.port ?? this.options.gatewayPort ?? resolveEcoGatewayPort();
  }

  get baseUrl(): string {
    return this.bridge?.baseUrl ?? `http://127.0.0.1:${this.port}`;
  }

  get incompleteProviderIds(): readonly string[] {
    return this.lastIncompleteProviderIds;
  }

  /** In-process Gateway handler (product counters / internal callers; not Bridge face). */
  handleGatewayRequest(request: Request): Promise<Response> {
    if (!this.gateway) {
      throw new Error("eco-gateway is not running. Call ensureRunning() first.");
    }
    return Promise.resolve(this.gateway.handleRequest(request));
  }

  async ensureRunning(): Promise<GatewayProviderPayload[]> {
    if (this.ensureInFlight) {
      return this.ensureInFlight;
    }
    this.ensureInFlight = this.ensureRunningImpl().finally(() => {
      this.ensureInFlight = undefined;
    });
    return this.ensureInFlight;
  }

  private async ensureRunningImpl(): Promise<GatewayProviderPayload[]> {
    const globalMaxOutputTokens =
      this.options.getGlobalMaxOutputTokens?.() ?? DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS;
    const built = buildGatewayProvidersFromEcoProviders(await this.options.listProviders(), {
      globalMaxOutputTokens,
    });
    this.lastIncompleteProviderIds = built.incompleteProviderIds;
    if (built.incompleteProviderIds.length > 0) {
      this.options.onStderr?.(
        `[eco-gateway] skipping incomplete providers (missing baseUrl/defaultModel): ${built.incompleteProviderIds.join(", ")}\n`,
      );
    }
    const gatewayProviders = built.providers.map((provider) =>
      normalizeProvider(provider as GatewayProvider),
    );
    const upstreamUserAgent = this.options.getUpstreamUserAgent?.()?.trim() || undefined;
    const upstreamUserAgents = this.options.getUpstreamUserAgents?.();
    const userAgentDefault = this.options.getDefaultUpstreamUserAgent?.()?.trim() || undefined;
    const upstreamProxyUrl = this.options.getUpstreamProxyUrl?.()?.trim() || undefined;
    const credentialResolver = this.options.getGatewayCredentialResolver?.();
    const credentialReporter = this.options.getGatewayCredentialReporter?.();

    const log = (message: string) => {
      this.options.onStderr?.(`[eco-gateway] ${message}\n`);
    };
    const bridgeLog = (message: string) => {
      this.options.onStderr?.(`[eco-bridge] ${message}\n`);
    };

    if (!this.gateway) {
      this.gateway = await startEcoGateway(
        {
          host: "127.0.0.1",
          port: this.port,
          providers: gatewayProviders,
          countInputTokens:
            this.options.countInputTokens ??
            (async (input) => {
              const { countGatewayInputTokens } = await import("./provider-token-counter");
              return countGatewayInputTokens(input);
            }),
          ...(upstreamUserAgent ? { upstreamUserAgent } : {}),
          ...(upstreamUserAgents && Object.keys(upstreamUserAgents).length > 0 ? { upstreamUserAgents } : {}),
          ...(userAgentDefault ? { userAgentDefault } : {}),
          ...(upstreamProxyUrl ? { upstreamProxyUrl } : {}),
          ...(credentialResolver ? { resolveCredential: credentialResolver } : {}),
          ...(credentialReporter ? { reportCredentialResult: credentialReporter } : {}),
        },
        {
          embedded: true,
          onLog: (message) => log(message),
          ...(this.options.onUsage && { onUsage: this.options.onUsage }),
          ...(this.options.onRequestLifecycle && {
            onRequestLifecycle: this.options.onRequestLifecycle,
          }),
          ...(this.options.resolveEcoThreadIdFromCodex && {
            resolveEcoThreadIdFromCodex: this.options.resolveEcoThreadIdFromCodex,
          }),
          ...(this.options.onToolWriteStarted && {
            onToolWriteStarted: this.options.onToolWriteStarted,
          }),
        },
      );
      log(`embedded gateway ready (no public listen)`);
    } else {
      this.gateway.setProviders(gatewayProviders);
      this.gateway.setUpstreamUserAgent(upstreamUserAgent);
      this.gateway.setUpstreamUserAgents(upstreamUserAgents, userAgentDefault);
      this.gateway.setUpstreamProxyUrl(upstreamProxyUrl);
      this.gateway.setCredentialResolver(credentialResolver);
      this.gateway.setCredentialReporter(credentialReporter);
      log(`providers updated (${gatewayProviders.length})`);
    }

    if (!this.bridge) {
      try {
        this.bridge = await startEcoSdkBridge("127.0.0.1", this.port, {
          gateway: this.gateway,
          onLog: bridgeLog,
          getTurnRouteRegistry: () => this.options.getTurnRouteRegistry?.(),
          getProviders: () =>
            this.gateway?.getProviders().map((p) => ({
              id: p.id,
              upstreamModelId: p.upstreamModelId,
              models: p.models,
            })) ?? [],
          prepareClaudeMessages:
            this.options.prepareClaudeMessages ??
            (async ({ path, body, model, headers }) => {
              const { prepareClaudeBridgeMessagesRequest } = await import("./anthropic-proxy");
              return prepareClaudeBridgeMessagesRequest({
                path,
                body,
                requestedModel: model,
                headers,
              });
            }),
          prepareGatewayBindingForward:
            this.options.prepareGatewayBindingForward ??
            (async ({ face, body, model, headers }) => {
              const { prepareGatewayBindingForwardRequest } = await import("./anthropic-proxy");
              return prepareGatewayBindingForwardRequest({
                face,
                body,
                requestedModel: model,
                headers,
              });
            }),
          resolveRoute: (input) => {
            if (input.face === "messages") {
              return this.options.resolveMessagesRoute?.({
                model: input.model,
                headers: input.headers,
              });
            }
            return undefined;
          },
          ...(this.options.resolveEcoThreadIdFromCodex && {
            resolveEcoThreadIdFromCodex: this.options.resolveEcoThreadIdFromCodex,
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/EADDRINUSE/i.test(message)) {
          const occupant = await describeTcpListener(this.port);
          const healthy = await probeLocalBridgeHealth(this.port);
          throw new Error(formatBridgePortInUseError(this.port, occupant, healthy));
        }
        throw error;
      }
      bridgeLog(`listening on ${this.baseUrl} (Codex+Claude public face)`);
    }

    // Refresh registry pointer each ensure (registry is module-level singleton).
    // Bridge captures registry at call time via options on each resolve — re-create not needed.

    if (upstreamUserAgent) {
      log(`upstreamUserAgent override=${upstreamUserAgent}`);
    }
    if (upstreamProxyUrl) {
      log(`upstreamProxyUrl set`);
    }

    for (const provider of built.providers) {
      log(
        `provider ${provider.id} kind=${provider.upstreamKind} baseUrl=${provider.baseUrl}${provider.requestPath ? ` requestPath=${provider.requestPath}` : ""} models=${provider.models.join(",")}`,
      );
    }

    return built.providers;
  }

  async stop(): Promise<void> {
    const bridge = this.bridge;
    const gateway = this.gateway;
    this.bridge = undefined;
    this.gateway = undefined;
    this.ensureInFlight = undefined;
    bridge?.stop();
    gateway?.stop();
  }
}

/** Visible helpers for tests / diagnostics. */
export function formatBridgePortInUseError(port: number, occupant: string, healthyBridge: boolean): string {
  const base = `eco-bridge port ${port} is already in use by another process. Stop it so Electron main can host the SDK bridge.`;
  const parts = [base];
  if (occupant) {
    parts.push(`Listener: ${occupant}`);
  }
  if (healthyBridge) {
    parts.push(
      `A process on :${port} already answers /health — likely a previous Eco Desktop, smoke test, or standalone gateway. Quit that app or: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    );
  } else if (occupant) {
    parts.push(`Inspect with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  }
  return parts.join(" ");
}

export async function describeTcpListener(port: number): Promise<string> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      timeout: 2000,
      encoding: "utf8",
      maxBuffer: 64_000,
    });
    const lines = stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return "";
    }
    // Drop header when present; keep up to two body lines.
    const body = lines[0]?.startsWith("COMMAND") ? lines.slice(1, 3) : lines.slice(0, 2);
    return body.join(" · ");
  } catch {
    return "";
  }
}

export async function probeLocalBridgeHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(600),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function mapApiCompatToUpstreamKind(apiCompat: UpstreamApiCompat): GatewayUpstreamKind {
  switch (apiCompat) {
    case "system_one":
      throw new Error("SystemOne 供应商仅可用于审批，不能注册到聊天 Gateway。");
    case "anthropic":
      return "anthropic-messages";
    case "openai_responses":
      return "responses";
    case "openai_chat_completions":
      return "openai-chat";
    default: {
      const _exhaustive: never = apiCompat;
      return _exhaustive;
    }
  }
}

/** Strip trailing /{version} (default v1) so gateway can append /{version}/responses|... */
export function normalizeGatewayBaseUrl(baseUrl: string, version?: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const ver = (version?.trim().replace(/^\/+|\/+$/g, "") || "v1").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return trimmed.replace(new RegExp(`/${ver}$`, "i"), "").replace(/\/v1$/i, "");
}

/** Normalize API version path segment. Empty → `v1`. */
export function normalizeGatewayApiVersion(version?: string): string {
  const trimmed = version?.trim() ?? "";
  if (!trimmed) {
    return "v1";
  }
  return trimmed.replace(/^\/+|\/+$/g, "") || "v1";
}

/** Normalize request path prefix (e.g. `/anthropic`). Empty string means API root. */
export function normalizeGatewayRequestPath(path?: string): string {
  const trimmed = path?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

export interface BuildGatewayProvidersResult {
  providers: GatewayProviderPayload[];
  /** Enabled providers skipped because baseUrl / defaultModel is incomplete. */
  incompleteProviderIds: string[];
}

/**
 * Build gateway provider table from Eco ProviderStore.
 * Incomplete enabled providers are skipped (not fatal) so one broken row cannot block all runs.
 * Callers must verify the thread's providerId is present via assertGatewayProvidersCover().
 */
export function buildGatewayProvidersFromEcoProviders(
  providers: readonly EcoProviderForGateway[],
  options?: { globalMaxOutputTokens?: GlobalMaxOutputTokens },
): BuildGatewayProvidersResult {
  const globalMaxOutputTokens = options?.globalMaxOutputTokens ?? DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS;
  const enabled = providers.filter((provider) => provider.enabled);
  if (enabled.length === 0) {
    throw new Error("No enabled Eco providers to sync into eco-gateway.");
  }

  const incompleteProviderIds: string[] = [];
  const out: GatewayProviderPayload[] = [];

  for (const provider of enabled) {
    const id = provider.id.trim();
    const version = normalizeGatewayApiVersion(provider.version);
    const baseUrl = normalizeGatewayBaseUrl(provider.baseUrl, version);
    const requestPath = normalizeGatewayRequestPath(provider.requestPath);
    const defaultModel =
      provider.defaultModel.trim() ||
      (provider.modelIds ?? []).map((modelId) => modelId.trim()).find(Boolean) ||
      "";
    if (!id || !baseUrl || !defaultModel) {
      incompleteProviderIds.push(id || provider.id || "(unknown)");
      continue;
    }
    const upstreamModels = uniqueNonEmpty([
      defaultModel,
      ...(provider.models ?? []).map((model) => model.modelId),
      ...(provider.modelIds ?? []),
    ]);
    // Gateway only sees concrete upstream model ids for listing; eco_ aliases resolve product-side.
    const models = uniqueNonEmpty(upstreamModels);
    const modelMaxOutputTokens = collectModelMaxOutputTokens(
      provider.models,
      upstreamModels,
      globalMaxOutputTokens,
    );
    out.push({
      id,
      name: provider.name.trim() || id,
      upstreamKind: mapApiCompatToUpstreamKind(provider.apiCompat),
      baseUrl,
      ...(requestPath ? { requestPath } : {}),
      version,
      apiKey: provider.apiKey.trim() || "local-unused",
      ...(provider.authMethod ? { authMethod: provider.authMethod } : {}),
      ...(provider.credentialPoolId ? { credentialPoolId: provider.credentialPoolId } : {}),
      ...(provider.upstreamProxyUrl?.trim() ? { upstreamProxyUrl: provider.upstreamProxyUrl.trim() } : {}),
      upstreamModelId: defaultModel,
      models,
      ...(modelMaxOutputTokens ? { modelMaxOutputTokens } : {}),
      ...(globalMaxOutputTokens === "dynamic"
        ? {
            modelContextTokens: Object.fromEntries(
              (provider.models ?? []).map((model) => {
                if (model.contextTokens === undefined) {
                  throw new Error(
                    `Dynamic max output requires a resolved context window for ${model.modelId}.`,
                  );
                }
                return [model.modelId.trim(), model.contextTokens];
              }),
            ),
            tokenCountMode: normalizeProviderTokenCountMode(provider.tokenCountMode),
          }
        : {}),
    });
  }

  if (out.length === 0) {
    throw new Error(
      `No enabled providers have both baseUrl and defaultModel. Incomplete: ${incompleteProviderIds.join(", ")}. Open Settings → Providers and set Base URL, then add candidate models.`,
    );
  }

  return { providers: out, incompleteProviderIds };
}

function collectModelMaxOutputTokens(
  models: EcoProviderForGateway["models"],
  upstreamModelIds: readonly string[],
  globalMaxOutputTokens: GlobalMaxOutputTokens,
): Record<string, number> | undefined {
  const limits: Record<string, number> = {};
  const modelById = new Map(
    (models ?? [])
      .map((model) => [model.modelId.trim(), model] as const)
      .filter(([modelId]) => Boolean(modelId)),
  );
  for (const modelId of uniqueNonEmpty([...modelById.keys(), ...upstreamModelIds])) {
    const model = modelById.get(modelId);
    limits[modelId] = resolveAppliedMaxOutputTokens({
      ...(model?.maxOutputTokens !== undefined && {
        modelMaxOutputTokens: model.maxOutputTokens,
      }),
      globalMaxOutputTokens,
      ...(model?.contextTokens !== undefined && { contextTokens: model.contextTokens }),
    });
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

export function assertGatewayProvidersCover(
  gatewayProviders: readonly GatewayProviderPayload[],
  requiredProviderIds: readonly string[],
  incompleteProviderIds: readonly string[] = [],
): void {
  const available = new Set(gatewayProviders.map((provider) => provider.id));
  const incomplete = new Set(incompleteProviderIds);
  for (const providerId of requiredProviderIds) {
    const id = providerId.trim();
    if (!id || available.has(id)) {
      continue;
    }
    if (incomplete.has(id)) {
      throw new Error(
        `Provider ${id} is missing baseUrl or defaultModel. Open Settings → Providers, edit this provider, set Base URL (http://… or https://…), and add candidate models.`,
      );
    }
    throw new Error(
      `Provider ${id} is not enabled or not synced to eco-gateway. Enable it in Settings → Providers.`,
    );
  }
}

let globalGateway: EcoGatewayLifecycle | undefined;

export function configureEcoGatewayLifecycle(options: EcoGatewayLifecycleOptions): EcoGatewayLifecycle {
  globalGateway = new EcoGatewayLifecycle(options);
  return globalGateway;
}

export async function ensureGlobalEcoGateway(options?: {
  requiredProviderIds?: readonly string[];
}): Promise<GatewayProviderPayload[]> {
  if (!globalGateway) {
    throw new Error(
      "eco-gateway lifecycle is not configured. Call configureEcoGatewayLifecycle() at startup.",
    );
  }
  const providers = await globalGateway.ensureRunning();
  if (options?.requiredProviderIds?.length) {
    assertGatewayProvidersCover(providers, options.requiredProviderIds, globalGateway.incompleteProviderIds);
  }
  return providers;
}

export function getGlobalEcoBridgeBaseUrl(): string {
  if (!globalGateway) {
    throw new Error(
      "eco-gateway lifecycle is not configured. Call configureEcoGatewayLifecycle() at startup.",
    );
  }
  return globalGateway.baseUrl;
}

/** Direct embedded gateway (skips public Bridge face — for count_tokens recursion-safe product path). */
export async function handleGlobalEcoGatewayRequest(request: Request): Promise<Response> {
  if (!globalGateway) {
    throw new Error(
      "eco-gateway lifecycle is not configured. Call configureEcoGatewayLifecycle() at startup.",
    );
  }
  await globalGateway.ensureRunning();
  return globalGateway.handleGatewayRequest(request);
}

/**
 * Stop the running gateway/bridge servers. Keeps the startup lifecycle binding so
 * `ensureGlobalEcoGateway()` can restart after a partial quit / macOS dock revive.
 * Tests that need a fully unset singleton should call `resetGlobalEcoGatewayForTests()`.
 */
export async function stopGlobalEcoGateway(): Promise<void> {
  await globalGateway?.stop();
}

/** Test seam — clear the singleton after stop so the next case must reconfigure. */
export async function resetGlobalEcoGatewayForTests(): Promise<void> {
  await globalGateway?.stop();
  globalGateway = undefined;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
