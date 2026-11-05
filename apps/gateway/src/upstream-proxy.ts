/**
 * Outbound HTTP/HTTPS/SOCKS5 proxy for gateway upstream fetch.
 * Host injects this fetch; does not use process-global dispatcher.
 */

export const GATEWAY_SUPPORTED_PROXY_PROTOCOLS = ["http:", "https:", "socks5:", "socks:"] as const;

/** Internal request metadata used to select an account-level proxy without
 * mutating the shared provider proxy table. Symbol metadata is removed before
 * the request reaches the underlying fetch implementation. */
export const UPSTREAM_PROXY_URL = Symbol.for("eco.gateway.upstreamProxyUrl");

export function parseUpstreamProxyUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("\r") || trimmed.includes("\n")) {
    throw new Error("Upstream proxy URL must not contain newlines.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid upstream proxy URL: ${trimmed}`);
  }
  const protocol = url.protocol.toLowerCase();
  if (
    !GATEWAY_SUPPORTED_PROXY_PROTOCOLS.includes(
      protocol as (typeof GATEWAY_SUPPORTED_PROXY_PROTOCOLS)[number],
    )
  ) {
    throw new Error(
      `Unsupported proxy protocol '${protocol}'. Use http://, https://, socks5://, or socks://`,
    );
  }
  if (!url.hostname) {
    throw new Error(`Upstream proxy URL missing host: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Per-provider outbound proxy route: requests whose target origin matches
 * `origin` use `proxyUrl` instead of the global upstream proxy.
 */
export interface UpstreamProxyRoute {
  /** Origin of the upstream service, e.g. `https://api.deepseek.com`. */
  origin: string;
  proxyUrl: string;
}

export interface UpstreamFetchController {
  fetch: typeof fetch;
  /** Global fallback proxy applied when no per-origin route matches. */
  setProxyUrl: (proxyUrl: string | undefined) => void;
  /**
   * Per-provider proxy overrides. Replaces the previous route table;
   * dispatchers for no-longer-referenced proxy URLs are closed.
   */
  setProxyRoutes: (routes: readonly UpstreamProxyRoute[]) => void;
  getProxyUrl: () => string | undefined;
  /** Close all cached proxy dispatchers. */
  close: () => void;
}

type ProxiedFetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<Response>;

function targetOrigin(input: RequestInfo | URL): string | undefined {
  try {
    const url =
      typeof input === "string" ? new URL(input) : input instanceof URL ? new URL(input) : new URL(input.url);
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Mutable outbound fetch that optionally routes through undici ProxyAgent.
 * Each distinct proxy URL gets its own cached dispatcher; the per-request
 * proxy is resolved from the request target origin (per-provider overrides)
 * with the global proxy URL as fallback.
 * Lazy-loads undici so pure unit tests without undici still import the module.
 */
export function createUpstreamFetchController(initialProxyUrl?: string): UpstreamFetchController {
  let globalProxyUrl = parseUpstreamProxyUrl(initialProxyUrl);
  let proxyRoutes = new Map<string, string>();
  const dispatchers = new Map<string, { close?: () => void }>();
  let undiciFetch: ProxiedFetchFn | undefined;
  let ProxyAgentCtor: (new (url: string) => { close?: () => void }) | undefined;

  async function ensureUndici(): Promise<void> {
    if (undiciFetch && ProxyAgentCtor) {
      return;
    }
    const undici = await import("undici");
    undiciFetch = undici.fetch as unknown as ProxiedFetchFn;
    ProxyAgentCtor = undici.ProxyAgent as unknown as new (url: string) => { close?: () => void };
  }

  function referencedProxyUrls(): Set<string> {
    const referenced = new Set<string>(proxyRoutes.values());
    if (globalProxyUrl) {
      referenced.add(globalProxyUrl);
    }
    return referenced;
  }

  function pruneDispatchers(): void {
    const referenced = referencedProxyUrls();
    for (const [proxyUrl, dispatcher] of dispatchers) {
      if (referenced.has(proxyUrl)) {
        continue;
      }
      dispatchers.delete(proxyUrl);
      try {
        dispatcher.close?.();
      } catch {
        // ignore close races
      }
    }
  }

  function getDispatcher(proxyUrl: string): { close?: () => void } | undefined {
    const cached = dispatchers.get(proxyUrl);
    if (cached) {
      return cached;
    }
    if (!ProxyAgentCtor) {
      return undefined;
    }
    const dispatcher = new ProxyAgentCtor(proxyUrl);
    dispatchers.set(proxyUrl, dispatcher);
    return dispatcher;
  }

  function resolveProxyForInput(input: RequestInfo | URL): string | undefined {
    const origin = targetOrigin(input);
    if (origin) {
      const routed = proxyRoutes.get(origin);
      if (routed) {
        return routed;
      }
    }
    return globalProxyUrl;
  }

  const controlledFetch: typeof fetch = async (input, init) => {
    const requestInit = init as (RequestInit & { [UPSTREAM_PROXY_URL]?: string }) | undefined;
    const explicitProxy = requestInit?.[UPSTREAM_PROXY_URL];
    const activeProxy =
      requestInit && UPSTREAM_PROXY_URL in requestInit
        ? parseUpstreamProxyUrl(explicitProxy)
        : resolveProxyForInput(input);
    if (requestInit && UPSTREAM_PROXY_URL in requestInit) {
      const sanitized = { ...requestInit } as RequestInit & { [UPSTREAM_PROXY_URL]?: string };
      delete sanitized[UPSTREAM_PROXY_URL];
      init = sanitized;
    }
    if (!activeProxy) {
      return fetch(input, init);
    }
    await ensureUndici();
    const dispatcher = getDispatcher(activeProxy);
    if (!undiciFetch || !dispatcher) {
      throw new Error("Failed to initialize undici proxy fetch.");
    }
    return undiciFetch(input, {
      ...(init as RequestInit),
      dispatcher,
    });
  };

  return {
    fetch: controlledFetch,
    setProxyUrl: (next) => {
      const parsed = parseUpstreamProxyUrl(next);
      if (parsed === globalProxyUrl) {
        return;
      }
      globalProxyUrl = parsed;
      pruneDispatchers();
      if (parsed && ProxyAgentCtor) {
        getDispatcher(parsed);
      }
    },
    setProxyRoutes: (routes) => {
      const next = new Map<string, string>();
      for (const route of routes) {
        const origin = route?.origin?.trim();
        if (!origin) {
          continue;
        }
        const proxyUrl = parseUpstreamProxyUrl(route.proxyUrl);
        if (proxyUrl) {
          next.set(origin, proxyUrl);
        }
      }
      proxyRoutes = next;
      pruneDispatchers();
      if (ProxyAgentCtor) {
        for (const proxyUrl of next.values()) {
          getDispatcher(proxyUrl);
        }
      }
    },
    getProxyUrl: () => globalProxyUrl,
    close: () => {
      for (const dispatcher of dispatchers.values()) {
        try {
          dispatcher.close?.();
        } catch {
          // ignore close races
        }
      }
      dispatchers.clear();
    },
  };
}
