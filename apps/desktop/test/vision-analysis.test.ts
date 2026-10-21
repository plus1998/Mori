import { afterEach, expect, test } from "bun:test";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import { runVisionAnalysis, type VisionAnalysisHost } from "../src/main/vision-analysis";
import type { PromptImageAttachment } from "../src/shared/ipc";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ATTACHMENT: PromptImageAttachment = {
  mediaType: "image/png",
  data: "aaaa",
};

function fakeRoute(overrides: Partial<RuntimeRoute> = {}): RuntimeRoute {
  return {
    role: "main",
    provider: {
      id: "provider-1",
      name: "Provider",
      enabled: true,
      apiCompat: "openai",
      baseUrl: "https://example.test",
      apiKey: "secret",
    } as RuntimeRoute["provider"],
    modelId: "main-model",
    apiCompat: "openai",
    manualSpec: { supportsImageInput: true },
    ...overrides,
  };
}

function visionResponse(text = "## Overview\nbutton overlap"): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createHost(options?: {
  route?: RuntimeRoute;
  resolveRoute?: VisionAnalysisHost["resolveRoute"];
  startProxy?: VisionAnalysisHost["startProxy"];
}): { host: VisionAnalysisHost; calls: HostCalls } {
  const calls: HostCalls = {
    emitSubagentStart: [],
    emitSubagentStop: [],
    registerBilling: [],
    unregisterBilling: [],
    startProxy: [],
    fetch: [],
  };
  const host: VisionAnalysisHost = {
    resolveRoute: options?.resolveRoute ?? ((_threadId, _routesOverride) => options?.route ?? fakeRoute()),
    startProxy:
      options?.startProxy ??
      (async (route, attachments, stamp) => {
        calls.startProxy.push({ route, attachments, stamp });
        return {
          baseUrl: "http://127.0.0.1:9",
          apiKey: "proxy-key",
          aliasModelId: "eco-alias",
          close: async () => {},
        };
      }),
    registerBilling: (threadId, agentId) => {
      calls.registerBilling.push({ threadId, agentId });
    },
    unregisterBilling: (threadId, agentId) => {
      calls.unregisterBilling.push({ threadId, agentId });
    },
    emitSubagentStart: (input) => {
      calls.emitSubagentStart.push(input);
    },
    emitSubagentStop: (input) => {
      calls.emitSubagentStop.push(input);
    },
  };
  return { host, calls };
}

interface HostCalls {
  emitSubagentStart: Array<{ threadId: string; agentId: string; imageCount: number }>;
  emitSubagentStop: Array<{
    threadId: string;
    agentId: string;
    imageCount: number;
    failed: boolean;
    report?: string;
  }>;
  registerBilling: Array<{ threadId: string; agentId: string }>;
  unregisterBilling: Array<{ threadId: string; agentId: string }>;
  startProxy: Array<{
    route: RuntimeRoute;
    attachments: readonly PromptImageAttachment[];
    stamp: { threadId: string; runAttemptId?: string };
  }>;
  fetch: Array<{ url: string }>;
}

function installFetchSpy(calls: HostCalls, impl?: typeof fetch): void {
  globalThis.fetch = (async (url, init) => {
    calls.fetch.push({ url: String(url) });
    if (impl) return impl(url, init);
    return visionResponse();
  }) as typeof fetch;
}

test("emitSubagentLifecycle false bills vision only and does not start a subagent", async () => {
  const { host, calls } = createHost();
  installFetchSpy(calls);

  const report = await runVisionAnalysis(
    {
      threadId: "thr-1",
      prompt: "检查截图",
      attachments: [ATTACHMENT],
      billingAgentId: "vision:thr-1:abc",
      emitSubagentLifecycle: false,
    },
    host,
  );

  expect(report).toContain("button overlap");
  expect(calls.emitSubagentStart).toEqual([]);
  expect(calls.emitSubagentStop).toEqual([]);
  expect(calls.registerBilling).toEqual([{ threadId: "thr-1", agentId: "vision:thr-1:abc" }]);
  expect(calls.unregisterBilling).toEqual([{ threadId: "thr-1", agentId: "vision:thr-1:abc" }]);
  expect(calls.startProxy).toHaveLength(1);
  expect(calls.fetch).toHaveLength(1);
});

test("supportsImageInput false throws and does not call fetch", async () => {
  const { host, calls } = createHost({
    route: fakeRoute({
      modelId: "text-only-model",
      manualSpec: { supportsImageInput: false },
    }),
  });
  installFetchSpy(calls, async () => {
    throw new Error("fetch must not be called");
  });

  await expect(
    runVisionAnalysis(
      {
        threadId: "thr-2",
        prompt: "看这张图",
        attachments: [ATTACHMENT],
        billingAgentId: "vision:thr-2:abc",
        emitSubagentLifecycle: false,
      },
      host,
    ),
  ).rejects.toThrow("主 Agent 模型 text-only-model 已明确配置为不支持图片输入。");

  expect(calls.fetch).toEqual([]);
  expect(calls.startProxy).toEqual([]);
  expect(calls.emitSubagentStart).toEqual([]);
  expect(calls.registerBilling).toEqual([]);
});

test("missing route throws and does not call fetch", async () => {
  const { host, calls } = createHost({
    resolveRoute: () => {
      throw new Error("看图子代理缺少可用的模型路由。");
    },
  });
  installFetchSpy(calls, async () => {
    throw new Error("fetch must not be called");
  });

  await expect(
    runVisionAnalysis(
      {
        threadId: "thr-3",
        prompt: "看这张图",
        attachments: [ATTACHMENT],
        billingAgentId: "vision:thr-3:abc",
        emitSubagentLifecycle: true,
      },
      host,
    ),
  ).rejects.toThrow("看图子代理缺少可用的模型路由。");

  expect(calls.fetch).toEqual([]);
  expect(calls.startProxy).toEqual([]);
  expect(calls.emitSubagentStart).toEqual([]);
});

test("emitSubagentLifecycle true starts and stops the prompt-images subagent", async () => {
  const { host, calls } = createHost();
  installFetchSpy(calls);

  const report = await runVisionAnalysis(
    {
      threadId: "thr-4",
      prompt: "检查截图",
      attachments: [ATTACHMENT, ATTACHMENT],
      billingAgentId: "vision:thr-4:abc",
      emitSubagentLifecycle: true,
    },
    host,
  );

  expect(report).toContain("button overlap");
  expect(calls.emitSubagentStart).toEqual([
    { threadId: "thr-4", agentId: "vision:thr-4:abc", imageCount: 2 },
  ]);
  expect(calls.emitSubagentStop).toEqual([
    {
      threadId: "thr-4",
      agentId: "vision:thr-4:abc",
      imageCount: 2,
      failed: false,
      report,
    },
  ]);
  expect(calls.startProxy[0]?.route.role).toBe("vision");
  expect(calls.startProxy[0]?.route.manualSpec?.maxOutputTokens).toBe(1600);
});

test("failed analysis still unregisters billing and does not emit a subagent when lifecycle is off", async () => {
  const { host, calls } = createHost();
  installFetchSpy(calls, async () => new Response(JSON.stringify({ error: "upstream" }), { status: 500 }));

  await expect(
    runVisionAnalysis(
      {
        threadId: "thr-5",
        prompt: "检查截图",
        attachments: [ATTACHMENT],
        billingAgentId: "vision:thr-5:abc",
        emitSubagentLifecycle: false,
      },
      host,
    ),
  ).rejects.toThrow("图片理解失败：");

  expect(calls.emitSubagentStart).toEqual([]);
  expect(calls.emitSubagentStop).toEqual([]);
  expect(calls.registerBilling).toHaveLength(1);
  expect(calls.unregisterBilling).toEqual([{ threadId: "thr-5", agentId: "vision:thr-5:abc" }]);
});
