import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexMcpServerForConfigSync, EcoAgentRuntimeConfig } from "@eco/runtime";
import {
  getCodexRuntimeClients,
  getGlobalCodexRuntimeLifecycle,
  retainCodexRuntimeClient,
  stopGlobalCodexRuntimeLifecycle,
} from "../src/main/codex-runtime-lifecycle";
import {
  configureCodexRuntimeRun,
  type EcoProviderForCodexCatalog,
  prepareCodexRuntime,
  requestCodexAccountRuntimeRestart,
  scheduleCodexGlobalRuntimeRefresh,
  shutdownCodexGlobalRuntimeRefresh,
} from "../src/main/codex-runtime-run";
import type { CodexThreadMap } from "../src/main/codex-thread-map";
import { resolveCodexThreadWebSearchPlan } from "../src/main/resolve-thread-web-search";

const realAppServerTest = process.env.ECO_CODEX_REAL_APP_SERVER_TEST === "1" ? test : test.skip;

realAppServerTest(
  "Codex account search policy reaches native thread start and resume config",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-native-search-"));
    const previousExecutable = process.env.CODEX_EXECUTABLE;
    process.env.CODEX_EXECUTABLE = path.resolve(import.meta.dir, "../node_modules/.bin/codex");
    const agentRegistry: EcoAgentRuntimeConfig = {
      templates: [],
      orchestration: {
        mainAgent: {
          agentKey: "main",
          name: "Main",
          systemPromptPreset: "core_native",
          prompt: "",
          modelRef: { providerId: "openai", modelId: "gpt-6.1-sol" },
          tools: { allowed: [], disallowed: [], network: { webSearch: true, webFetch: true } },
          skills: [],
        },
        agents: [],
        strategy: { kind: "autonomous" },
      },
    };
    try {
      configureCodexRuntimeRun({
        ecoDataDir: root,
        listProviders: () => [],
        threadMap: {
          getCodexThreadId: () => undefined,
          getEcoThreadId: () => undefined,
          setMapping: () => {},
          deleteMapping: () => {},
          getThreadAttribution: () => undefined,
          setThreadAttribution: () => {},
        },
        appendConversationRuntimeEvent: () => {},
        scheduleThreadRunProjectionUpdated: () => {},
      });
      let threadId: string | undefined;
      for (const enabled of [true, false, true]) {
        agentRegistry.orchestration.mainAgent.tools.network = { webSearch: enabled, webFetch: true };
        const plan = resolveCodexThreadWebSearchPlan({
          mainProviderId: "openai",
          networkWebSearch: enabled,
          integratedSettings: {
            enabled: true,
            provider: "doubao",
            hasApiKey: true,
            approvalMode: "always_allow",
          },
          integratedApiKey: "test-search-key",
        });
        const prepared = await prepareCodexRuntime({
          agentRegistry,
          mainProviderId: "openai",
          mainModelId: "gpt-6.1-sol",
          ...(plan.backend === "native" ? {} : { webSearchOverride: "disabled" as const }),
        });
        expect(prepared.threadConfig?.web_search).toBe(enabled ? "live" : "disabled");
        const client = getGlobalCodexRuntimeLifecycle()?.getClient();
        if (!client) throw new Error("Missing native app-server");
        const result = await client.request<{ thread: { id: string } }>(
          threadId ? "thread/resume" : "thread/start",
          {
            ...(threadId ? { threadId } : {}),
            cwd: root,
            modelProvider: "openai",
            model: "gpt-6.1-sol",
            config: prepared.threadConfig,
          },
        );
        if (!threadId) {
          await client.request("thread/inject_items", {
            threadId: result.thread.id,
            items: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "offline search config test" }],
              },
            ],
          });
        }
        threadId = result.thread.id;
      }
    } finally {
      await shutdownCodexGlobalRuntimeRefresh();
      await stopGlobalCodexRuntimeLifecycle();
      if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = previousExecutable;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

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
      // A real catalog change publishes a new process without waiting for the old turn.
      const releaseOld = retainCodexRuntimeClient(client);
      try {
        contextWindowLimit = 65_536;
        scheduleCodexGlobalRuntimeRefresh();
        await prepareCodexRuntime({ signal: AbortSignal.timeout(10_000) });
        expect(getGlobalCodexRuntimeLifecycle()?.getClient()).not.toBe(client);
        expect(getCodexRuntimeClients()).toContain(client);
        expect(idleChecks).toBe(0);
        expect(statusChecks).toBe(0);
      } finally {
        releaseOld();
      }
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

realAppServerTest(
  "unchanged gateway prepares during account publication and after its failure",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-account-gateway-"));
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
    const publication = Promise.withResolvers<void>();
    try {
      configureCodexRuntimeRun({
        ecoDataDir: root,
        listProviders: () => providers,
        threadMap: {} as CodexThreadMap,
        appendConversationRuntimeEvent: () => {},
        scheduleThreadRunProjectionUpdated: () => {},
      });
      await prepareCodexRuntime();
      const client = getGlobalCodexRuntimeLifecycle()?.getClient();
      requestCodexAccountRuntimeRestart("account");
      scheduleCodexGlobalRuntimeRefresh({
        beforePrepare: async () => {
          await publication.promise;
          throw new Error("account publication failed");
        },
      });
      const gatewayInput = {
        mainProviderId: "vendor",
        mainModelId: "probe",
        signal: AbortSignal.timeout(2_000),
      };
      const during = await prepareCodexRuntime(gatewayInput);
      expect(during.runtimeClient).toBe(client);
      const login = prepareCodexRuntime({ requiredProviderIds: ["openai"] });
      publication.resolve();
      await expect(login).rejects.toThrow("account publication failed");
      expect((await prepareCodexRuntime(gatewayInput)).runtimeClient).toBe(client);
      providers = providers.map((provider) => ({ ...provider, enabled: false }));
      await expect(prepareCodexRuntime(gatewayInput)).rejects.toThrow("account publication failed");
    } finally {
      publication.resolve();
      await shutdownCodexGlobalRuntimeRefresh();
      await stopGlobalCodexRuntimeLifecycle();
      if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = previousExecutable;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);

realAppServerTest(
  "native idle thread releases its writer and resumes on a replacement",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-native-handoff-"));
    const previousExecutable = process.env.CODEX_EXECUTABLE;
    process.env.CODEX_EXECUTABLE = path.resolve(import.meta.dir, "../node_modules/.bin/codex");
    let contextWindowLimit = 65_536;
    let releaseOld: (() => void) | undefined;
    try {
      configureCodexRuntimeRun({
        ecoDataDir: root,
        listProviders: () => [
          {
            id: "vendor",
            name: "Offline fixture",
            enabled: true,
            apiCompat: "openai_responses",
            models: [{ modelId: "probe" }],
          },
        ],
        getGlobalContextWindowLimit: () => contextWindowLimit,
        threadMap: {
          getCodexThreadId: () => undefined,
          getEcoThreadId: () => undefined,
          setMapping: () => {},
          deleteMapping: () => {},
          getThreadAttribution: () => undefined,
          setThreadAttribution: () => {},
        },
        appendConversationRuntimeEvent: () => {},
        scheduleThreadRunProjectionUpdated: () => {},
      });
      await prepareCodexRuntime();
      const old = getGlobalCodexRuntimeLifecycle()?.getClient();
      if (!old) throw new Error("Missing native app-server");
      releaseOld = retainCodexRuntimeClient(old);
      const started = await old.request<{ thread: { id: string } }>("thread/start", {
        cwd: root,
        modelProvider: "eco_vendor",
        model: "probe",
      });
      await old.request("thread/inject_items", {
        threadId: started.thread.id,
        items: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "offline history" }] },
        ],
      });
      contextWindowLimit = 131_072;
      scheduleCodexGlobalRuntimeRefresh();
      await prepareCodexRuntime();
      const current = getGlobalCodexRuntimeLifecycle()?.getClient();
      if (!current || current === old) throw new Error("Missing replacement app-server");
      const { handoffCodexRuntimeThread } = await import("../src/main/codex-runtime-lifecycle");
      await handoffCodexRuntimeThread(started.thread.id, current, AbortSignal.timeout(5_000));
      const resumed = await current.request<{ thread: { id: string } }>("thread/resume", {
        threadId: started.thread.id,
      });
      expect(resumed.thread.id).toBe(started.thread.id);
    } finally {
      releaseOld?.();
      await shutdownCodexGlobalRuntimeRefresh();
      await stopGlobalCodexRuntimeLifecycle();
      if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE;
      else process.env.CODEX_EXECUTABLE = previousExecutable;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
