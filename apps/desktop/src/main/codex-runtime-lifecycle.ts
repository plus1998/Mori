import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerNotificationHandler,
  readCodexThreadStatus,
  resolveCodexHomeDir,
} from "@eco/runtime";
import type { OpenAIAccountProxyConfig } from "../shared/openai-account";
import {
  buildCodexProxyEnv,
  type CodexProxyEnvironment,
  parseElectronProxyResolution,
  resolveCodexProxyUrl,
  type SystemProxyResolver,
} from "./codex-proxy";

export { type CodexProxyEnvironment, parseElectronProxyResolution, resolveCodexProxyUrl };

export interface CodexRuntimeLifecycleOptions {
  ecoDataDir: string;
  codexExecutable?: string;
  clientOptions?: Omit<CodexAppServerClientOptions, "onNotification">;
  onNotification?: CodexAppServerNotificationHandler;
  onStderr?: (chunk: string) => void;
}

let nextDiagnosticGeneration = 1;

// Module-level configuration shared by the global and temporary runtimes.
let accountProxyConfigGetter:
  | (() => OpenAIAccountProxyConfig | Promise<OpenAIAccountProxyConfig>)
  | undefined;
export function setCodexAccountProxyConfigGetter(
  getter: (() => OpenAIAccountProxyConfig | Promise<OpenAIAccountProxyConfig>) | undefined,
): void {
  accountProxyConfigGetter = getter;
}

let systemProxyResolver: SystemProxyResolver | undefined;
export function setCodexSystemProxyResolver(resolver: SystemProxyResolver | undefined): void {
  systemProxyResolver = resolver;
}

export class CodexRuntimeLifecycle {
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: CodexAppServerClient | undefined;
  private startPromise: Promise<CodexAppServerClient> | undefined;
  private stopPromise: Promise<void> | undefined;
  private generation = 0;
  private socksBridge: { close: () => void } | undefined;

  constructor(private readonly options: CodexRuntimeLifecycleOptions) {}

  get codexHomeDir(): string {
    return resolveCodexHomeDir(this.options.ecoDataDir);
  }

  isRunning(): boolean {
    return this.child !== undefined && this.client !== undefined;
  }

  getClient(): CodexAppServerClient | undefined {
    return this.client;
  }

  async start(): Promise<CodexAppServerClient> {
    if (this.stopPromise) {
      await this.stopPromise;
      return this.start();
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.client) {
      return this.client;
    }
    if (this.child) {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        throw new Error("Codex app-server cannot restart because the previous process has not exited.");
      }
      this.child = undefined;
    }

    const startPromise = this.spawnAndInitialize(this.generation);
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const stopPromise = this.stopCurrentLifecycle();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = undefined;
      }
    }
  }

  private async stopCurrentLifecycle(): Promise<void> {
    this.generation += 1;
    const pendingStart = this.startPromise;
    const child = this.child;
    const client = this.client;
    this.client = undefined;
    this.startPromise = undefined;

    client?.close();

    if (child) {
      await terminateProcess(child);
      if (this.child === child) {
        this.child = undefined;
      }
    }

    // Clean up SOCKS bridge if active
    if (this.socksBridge) {
      this.socksBridge.close();
      this.socksBridge = undefined;
    }

    if (pendingStart) {
      try {
        await pendingStart;
      } catch {
        // A start interrupted by stop is expected to reject after its client/process closes.
      }
    }
  }

  private async spawnAndInitialize(generation: number): Promise<CodexAppServerClient> {
    const codexHomeDir = this.codexHomeDir;
    await import("node:fs/promises").then((fs) => fs.mkdir(codexHomeDir, { recursive: true }));
    if (generation !== this.generation) {
      throw new Error("Codex app-server start was cancelled before process spawn.");
    }

    const executable =
      this.options.codexExecutable?.trim() || process.env.CODEX_EXECUTABLE?.trim() || "codex";

    // Resolve the explicit account proxy or the current OS proxy before spawning.
    let proxyEnvironment: CodexProxyEnvironment;
    try {
      const proxyConfig = (await accountProxyConfigGetter?.()) ?? { mode: "system" };
      const rawProxy = await resolveCodexProxyUrl(proxyConfig, systemProxyResolver);
      let proxyHttp = rawProxy;
      if (rawProxy) {
        const parsed = new URL(rawProxy);
        if (!["http:", "https:", "socks:", "socks4:", "socks5:", "socks5h:"].includes(parsed.protocol)) {
          throw new Error("Unsupported proxy protocol.");
        }
        const proxyEndpoint = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
        if (parsed.protocol.startsWith("socks")) {
          // Bridge SOCKS → local HTTP for Codex (Rust doesn't support SOCKS natively)
          const { startSocksToHttpBridge } = await import("./openai-account-service");
          const bridge = await startSocksToHttpBridge(rawProxy);
          proxyHttp = `http://127.0.0.1:${bridge.port}`;
          this.socksBridge = { close: bridge.close };
        }
        process.stderr.write(`[eco-codex] ${proxyConfig.mode} proxy configured endpoint=${proxyEndpoint}\n`);
        proxyEnvironment = { mode: "proxy", url: proxyHttp ?? rawProxy };
      } else {
        proxyEnvironment = { mode: "direct" };
      }
    } catch (error) {
      throw new Error("Configured OpenAI account proxy could not be initialized.", { cause: error });
    }

    const env = buildCodexAppServerEnv(process.env, codexHomeDir, proxyEnvironment);
    const child = spawn(executable, ["app-server", "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.options.onStderr?.(chunk);
    });

    const clientOptions = {
      ...this.options.clientOptions,
      diagnosticGeneration: nextDiagnosticGeneration++,
      ...(this.options.onNotification ? { onNotification: this.options.onNotification } : {}),
    };
    const client = CodexAppServerClient.attachToProcess(child, clientOptions);
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
    });
    child.stdin.on("error", () => client.close());

    child.on("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.client = undefined;
      }
    });

    this.child = child;
    this.client = client;
    try {
      await Promise.race([client.initialize(), spawnFailure]);
      if (generation !== this.generation) {
        throw new Error("Codex app-server start was cancelled during initialization.");
      }
      return client;
    } catch (error) {
      if (this.client === client) {
        this.client = undefined;
      }
      client.close();
      try {
        await terminateProcess(child);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Codex app-server initialization failed and its process could not be stopped.",
        );
      }
      if (this.child === child) {
        this.child = undefined;
      }
      throw error;
    }
  }
}

export function resolveEcoDataCodexHome(ecoDataDir: string): string {
  return path.join(ecoDataDir, "codex");
}

export function buildCodexAppServerEnv(
  source: NodeJS.ProcessEnv,
  codexHomeDir: string,
  proxy: CodexProxyEnvironment = { mode: "inherit" },
): NodeJS.ProcessEnv {
  return {
    ...buildCodexProxyEnv(source, proxy),
    CODEX_HOME: codexHomeDir,
  };
}

function waitForProcessExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);

    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };

    child.once("exit", onExit);
  });
}

async function terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  if (await waitForProcessExit(child, 1_000)) {
    return;
  }

  child.kill("SIGKILL");
  if (await waitForProcessExit(child, 500)) {
    return;
  }

  throw new Error(`Codex app-server process ${child.pid ?? "unknown"} did not exit after SIGKILL.`);
}

let globalLifecycle: CodexRuntimeLifecycle | undefined;
let globalStopPromise: Promise<void> | undefined;
let runtimeEpoch = 0;
let replacementTail: Promise<void> = Promise.resolve();
const startingReplacements = new Set<CodexRuntimeLifecycle>();
const retiringLifecycles = new Set<CodexRuntimeLifecycle>();
const threadClients = new Map<string, CodexAppServerClient>();
const clientReservations = new Map<CodexAppServerClient, number>();
let retirementTimer: ReturnType<typeof setTimeout> | undefined;
let retirementSweep: Promise<void> | undefined;

export function getCodexRuntimeClients(): CodexAppServerClient[] {
  return [
    ...new Set(
      [globalLifecycle, ...retiringLifecycles].flatMap((lifecycle) => {
        const client = lifecycle?.getClient();
        return client ? [client] : [];
      }),
    ),
  ];
}

export function getCodexRuntimeClientForThread(
  threadId: string,
  defaultClient = globalLifecycle?.getClient(),
): CodexAppServerClient | undefined {
  const owner = threadClients.get(threadId);
  const clients = getCodexRuntimeClients();
  if (owner && clients.includes(owner)) return owner;
  return defaultClient && clients.includes(defaultClient) ? defaultClient : globalLifecycle?.getClient();
}

/** Unload an idle thread before another generation tries to acquire its disk writer lock. */
export async function handoffCodexRuntimeThread(
  threadId: string,
  target: CodexAppServerClient,
  signal?: AbortSignal,
): Promise<void> {
  const owner = getCodexRuntimeClientForThread(threadId, target);
  if (!owner || owner === target) return;
  const release = retainCodexRuntimeClient(owner);
  try {
    signal?.throwIfAborted();
    const status = await readCodexThreadStatus(owner, threadId);
    if (status === "notLoaded") {
      threadClients.delete(threadId);
      return;
    }
    if (status !== "idle" && status !== "systemError") {
      throw new Error(`Codex thread ${threadId} is still ${status}; cannot move it to the new runtime.`);
    }
    let closed!: () => void;
    let failed!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      closed = resolve;
      failed = reject;
    });
    const remove = owner.addNotificationHandler((method, params) => {
      if (method === "thread/closed" && (params as { threadId?: string })?.threadId === threadId) closed();
    });
    const timeout = setTimeout(
      () => failed(new Error(`Timed out releasing Codex thread ${threadId} from its old runtime.`)),
      15_000,
    );
    const onAbort = () => failed(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Attach rejection handling before awaiting the unsubscribe RPC.
    const completion = done.then(() => undefined);
    void completion.catch(() => {});
    try {
      signal?.throwIfAborted();
      await Promise.race([
        owner.request<{ status: string }>("thread/unsubscribe", { threadId }).then((result) => {
          if (result.status === "notLoaded") closed();
          return completion;
        }),
        completion,
      ]);
      threadClients.delete(threadId);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      remove();
    }
  } finally {
    release();
  }
}

export function recordCodexRuntimeThreadOwner(threadId: string, client: CodexAppServerClient): void {
  threadClients.set(threadId, client);
}

/** Hold a generation across preparation, driver startup and its final event delivery. */
export function retainCodexRuntimeClient(client: CodexAppServerClient): () => void {
  clientReservations.set(client, (clientReservations.get(client) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (clientReservations.get(client) ?? 1) - 1;
    if (count > 0) clientReservations.set(client, count);
    else clientReservations.delete(client);
    scheduleRetirementSweep();
  };
}

function scheduleRetirementSweep(): void {
  if (globalStopPromise || retirementTimer || retirementSweep || retiringLifecycles.size === 0) return;
  retirementTimer = setTimeout(() => {
    retirementTimer = undefined;
    retirementSweep = reapRetiredCodexRuntimes().finally(() => {
      retirementSweep = undefined;
      scheduleRetirementSweep();
    });
  }, 250);
  retirementTimer.unref();
}

async function listRuntimeThreadIds(client: CodexAppServerClient): Promise<string[]> {
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.request<{ data: string[]; nextCursor?: string | null }>("thread/loaded/list", {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page.data) || page.data.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Cannot retire Codex runtime: invalid loaded thread list.");
    }
    ids.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("Cannot retire Codex runtime: repeated thread list cursor.");
      cursors.add(cursor);
    }
  } while (cursor);
  return ids;
}

/** Never stop an old generation while a driver or native child still owns work. */
export async function reapRetiredCodexRuntimes(): Promise<void> {
  for (const lifecycle of retiringLifecycles) {
    const client = lifecycle.getClient();
    if (client && (clientReservations.get(client) ?? 0) > 0) continue;
    try {
      if (client?.isInitialized) {
        const ids = await listRuntimeThreadIds(client);
        const statuses = await Promise.all(ids.map((id) => readCodexThreadStatus(client, id)));
        if (statuses.some((status) => status === "active" || status === "unknown")) continue;
        const terminals = await Promise.all(
          ids.map((threadId) =>
            client.request<{ data: unknown[] }>("thread/backgroundTerminals/list", { threadId, limit: 1 }),
          ),
        );
        if (terminals.some((page) => page.data.length > 0)) continue;
      }
      // A driver may have reserved this generation while the status RPC was in flight.
      if (client && (clientReservations.get(client) ?? 0) > 0) continue;
      await lifecycle.stop();
      retiringLifecycles.delete(lifecycle);
      for (const [id, owner] of threadClients) if (owner === client) threadClients.delete(id);
    } catch (error) {
      process.stderr.write(`[eco-codex] retired runtime cleanup failed: ${String(error)}\n`);
    }
  }
}

/** Publish only an initialized replacement; the old process keeps its existing turns. */
export async function replaceGlobalCodexRuntimeLifecycle(
  options: CodexRuntimeLifecycleOptions,
): Promise<CodexAppServerClient> {
  while (globalStopPromise) await globalStopPromise;
  const epoch = runtimeEpoch;
  const replacement = replacementTail.then(() => replaceCodexRuntime(options, epoch));
  replacementTail = replacement.then(
    () => {},
    () => {},
  );
  return replacement;
}

async function replaceCodexRuntime(
  options: CodexRuntimeLifecycleOptions,
  epoch: number,
): Promise<CodexAppServerClient> {
  if (epoch !== runtimeEpoch) throw new Error("Codex runtime replacement was cancelled by shutdown.");
  while (globalStopPromise) await globalStopPromise;
  if (epoch !== runtimeEpoch) throw new Error("Codex runtime replacement was cancelled by shutdown.");
  const previous = globalLifecycle;
  const replacement = new CodexRuntimeLifecycle(options);
  startingReplacements.add(replacement);
  let client: CodexAppServerClient;
  try {
    client = await replacement.start();
    if (epoch !== runtimeEpoch) {
      await replacement.stop();
      throw new Error("Codex runtime replacement was cancelled by shutdown.");
    }
  } catch (error) {
    await replacement.stop();
    throw error;
  } finally {
    startingReplacements.delete(replacement);
  }
  globalLifecycle = replacement;
  if (previous) retiringLifecycles.add(previous);
  scheduleRetirementSweep();
  return client;
}

export function getGlobalCodexRuntimeLifecycle(): CodexRuntimeLifecycle | undefined {
  return globalLifecycle;
}

export function setGlobalCodexRuntimeLifecycle(lifecycle: CodexRuntimeLifecycle | undefined): void {
  globalLifecycle = lifecycle;
}

export async function ensureGlobalCodexRuntimeLifecycle(
  options: CodexRuntimeLifecycleOptions,
): Promise<CodexAppServerClient> {
  while (globalStopPromise) {
    await globalStopPromise;
  }
  if (!globalLifecycle) {
    globalLifecycle = new CodexRuntimeLifecycle(options);
  }
  return globalLifecycle.start();
}

export async function stopGlobalCodexRuntimeLifecycle(): Promise<void> {
  if (globalStopPromise) {
    return globalStopPromise;
  }
  runtimeEpoch += 1;
  if (retirementTimer) clearTimeout(retirementTimer);
  retirementTimer = undefined;
  const lifecycles = [...new Set([globalLifecycle, ...retiringLifecycles, ...startingReplacements])];
  const stopPromise = (async () => {
    await Promise.all(lifecycles.map((lifecycle) => lifecycle?.stop?.()));
    await replacementTail;
    await retirementSweep;
    retiringLifecycles.clear();
    threadClients.clear();
    clientReservations.clear();
  })();
  globalStopPromise = stopPromise;
  try {
    await stopPromise;
    globalLifecycle = undefined;
  } finally {
    if (globalStopPromise === stopPromise) {
      globalStopPromise = undefined;
    }
  }
}
