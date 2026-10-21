import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import {
  getGlobalCodexRuntimeLifecycle,
  stopGlobalCodexRuntimeLifecycle,
} from "../src/main/codex-runtime-lifecycle";
import {
  configureCodexRuntimeRun,
  type EcoProviderForCodexCatalog,
  prepareCodexRuntime,
  scheduleCodexGlobalRuntimeRefresh,
  shutdownCodexGlobalRuntimeRefresh,
} from "../src/main/codex-runtime-run";
import type { CodexThreadMap } from "../src/main/codex-thread-map";

const realAppServerTest = process.env.ECO_CODEX_REAL_APP_SERVER_TEST === "1" ? test : test.skip;

realAppServerTest(
  "no-op saves, candidate capabilities, and MCP reloads never wait for active turns",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-noop-refresh-"));
    const previousExecutable = process.env.CODEX_EXECUTABLE;
    process.env.CODEX_EXECUTABLE = path.resolve(import.meta.dir, "../node_modules/.bin/codex");
    let providers: EcoProviderForCodexCatalog[] = [
      {
        id: "vendor",
        name: "Offline fixture",
        enabled: true,
        apiCompat: "openai_responses",
        models: [{ modelId: "probe" }],
      },
    ];
    let mcpServers: CodexMcpServerForConfigSync[] = [];
    let idleChecks = 0;
    let statusChecks = 0;
    let mcpReloads = 0;
    let contextWindowLimit = 1_048_576;
    const idleReadStarted = Promise.withResolvers<void>();
    const releaseIdleRead = Promise.withResolvers<void>();
    const messages: string[] = [];
    try {
      configureCodexRuntimeRun({
        ecoDataDir: root,
        listProviders: () => providers,
        getGlobalContextWindowLimit: () => contextWindowLimit,
        listGlobalMcpServers: () => mcpServers,
        threadMap: {} as CodexThreadMap,
        appendConversationRuntimeEvent: () => {},
        scheduleThreadRunProjectionUpdated: () => {},
        onStderr: (message) => messages.push(message),
      });
      await prepareCodexRuntime();
      const client = getGlobalCodexRuntimeLifecycle()?.getClient();
      if (!client) throw new Error("Initial preparation did not start the isolated app-server.");
      const nativeRequest = client.request.bind(client);
      // A busy native turn must be irrelevant to a no-op refresh. Intercept MCP
      // reload only so the fixture does not launch an unrelated external server.
      client.request = (async (method: string, params: unknown) => {
        if (method === "thread/loaded/list") {
          idleChecks += 1;
          idleReadStarted.resolve();
          await releaseIdleRead.promise;
          return { data: ["active-other-thread"] };
        }
        if (method === "thread/read") {
          statusChecks += 1;
          return { thread: { status: { type: "active" } } };
        }
        if (method === "config/mcpServer/reload") {
          mcpReloads += 1;
          return {};
        }
        return nativeRequest(method, params);
      }) as typeof client.request;
      const refresh = async () => {
        scheduleCodexGlobalRuntimeRefresh();
        await prepareCodexRuntime({ signal: AbortSignal.timeout(2_000) });
        expect(idleChecks).toBe(0);
        expect(getGlobalCodexRuntimeLifecycle()?.getClient()).toBe(client);
      };
      await refresh();
      providers = providers.map((provider) => ({
        ...provider,
        models: [{ modelId: "probe", displayName: "Renamed display label" }],
      }));
      await refresh();
      providers = providers.map((provider) => ({
        ...provider,
        models: [{ modelId: "probe", manualSpec: { supportsRemoteCompaction: true } }],
      }));
      await refresh();
      mcpServers = [{ name: "reload_probe", transport: "stdio", command: "offline-fixture-not-launched" }];
      await refresh();
      expect(mcpReloads).toBe(1);
      expect(messages.some((message) => /waiting to|cold restart/.test(message))).toBe(false);
      // A real catalog metadata change is on the allowlist. Its idle wait must
      // remain cancellable even if a native status RPC has not returned.
      contextWindowLimit = 65_536;
      scheduleCodexGlobalRuntimeRefresh();
      await idleReadStarted.promise;
      expect(idleChecks).toBe(1);
      await Promise.race([
        shutdownCodexGlobalRuntimeRefresh(),
        Bun.sleep(500).then(() => {
          throw new Error("Catalog restart wait blocked shutdown.");
        }),
      ]);
      releaseIdleRead.resolve();
      await Bun.sleep(0);
      expect(statusChecks).toBe(0);
      expect(getGlobalCodexRuntimeLifecycle()?.getClient()).toBe(client);
    } finally {
      releaseIdleRead.resolve();
      await shutdownCodexGlobalRuntimeRefresh();
      await stopGlobalCodexRuntimeLifecycle();
      if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = previousExecutable;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
