import { afterEach, expect, test } from "bun:test";
import {
  evaluateVisionTest,
  VISION_MODEL_TEST_PROMPT,
  type VisionTestAnswers,
} from "../src/shared/vision-model-test";
import { runVisionModelTest } from "../src/main/vision-model-test";
import type { ImageViewHost } from "../src/main/vision-analysis";
import type { RuntimeRoute } from "../src/main/billing-resolver";

const expected: VisionTestAnswers = {
  code: "K3P7X",
  circleCount: 3,
  rightmostShape: "triangle",
  squareColor: "blue",
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("scores image answers and accepts JSON fences without guessing from prose", () => {
  expect(
    evaluateVisionTest(`\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``, expected)?.every((c) => c.passed),
  ).toBe(true);
  expect(evaluateVisionTest("I can see K3P7X and three circles.", expected)).toBeUndefined();
  expect(evaluateVisionTest("[]", expected)).toBeUndefined();
  expect(evaluateVisionTest("null", expected)).toBeUndefined();
});

test("wrong and missing answers fail independently; numeric strings do not count as numbers", () => {
  const result = evaluateVisionTest(
    JSON.stringify({ code: "k3p7x", circleCount: "3", squareColor: "red" }),
    expected,
  )!;
  expect(result.map((c) => c.passed)).toEqual([true, false, false, false]);
  expect(result[2]?.actual).toBeUndefined();
  expect(VISION_MODEL_TEST_PROMPT).not.toContain(expected.code);
});

const request = {
  requestId: "test-1",
  selection: { providerId: "provider-1", candidateModelId: "candidate-1", modelId: "vision-model" },
  imageData: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=",
};

function createHost(apiCompat: "openai_responses" | "openai_chat_completions" | "anthropic"): ImageViewHost {
  return {
    resolveRoute: () =>
      ({
        role: "vision",
        modelId: "vision-model",
        apiCompat,
        provider: {
          id: "provider-1",
          name: "Provider",
          enabled: true,
          baseUrl: "https://example.test",
          apiCompat,
          apiKey: "secret",
        },
      }) as RuntimeRoute,
    startProxy: async () => ({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "proxy-key",
      aliasModelId: "test-alias",
      close: async () => {},
    }),
    registerBilling() {},
    unregisterBilling() {},
  };
}

for (const apiCompat of ["openai_responses", "openai_chat_completions", "anthropic"] as const) {
  test(`uses the image-view path with actual PNG input for ${apiCompat}`, async () => {
    let body = "";
    let requestPath = "";
    let closed = false;
    const host = createHost(apiCompat);
    host.startProxy = async (route) => {
      expect(route.modelId).toBe("vision-model");
      return {
        baseUrl: "http://127.0.0.1:9",
        apiKey: "proxy-key",
        aliasModelId: "test-alias",
        close: async () => {
          closed = true;
        },
      };
    };
    globalThis.fetch = (async (url, init) => {
      body = String(init?.body);
      requestPath = String(url);
      const text = JSON.stringify(expected);
      return Response.json(
        apiCompat === "anthropic"
          ? { content: [{ type: "text", text }] }
          : apiCompat === "openai_chat_completions"
            ? { choices: [{ message: { content: text } }] }
            : { output: [{ type: "message", content: [{ type: "output_text", text }] }] },
      );
    }) as typeof fetch;
    const result = await runVisionModelTest(request, host);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.text)).toEqual(expected);
    expect(body).toContain(request.imageData);
    expect(body).toContain("test-alias");
    expect(body).toContain("circleCount");
    expect(requestPath).toEndWith(
      apiCompat === "anthropic"
        ? "/v1/messages"
        : apiCompat === "openai_responses"
          ? "/v1/responses"
          : "/v1/chat/completions",
    );
    expect(closed).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
}

test("reports upstream rejection with its status and closes the proxy", async () => {
  let closed = false;
  const host = createHost("openai_responses");
  host.startProxy = async () => ({
    baseUrl: "http://127.0.0.1:9",
    apiKey: "key",
    aliasModelId: "alias",
    close: async () => {
      closed = true;
    },
  });
  globalThis.fetch = (async () => new Response("image input unsupported", { status: 400 })) as typeof fetch;
  const result = await runVisionModelTest(request, host);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("HTTP 400");
    expect(result.error).toContain("image input unsupported");
    expect(result.error).toContain("vision-model");
  }
  expect(closed).toBe(true);
});

test("rejects invalid images before resolving a model", async () => {
  let resolved = false;
  const host = createHost("anthropic");
  host.resolveRoute = () => {
    resolved = true;
    throw new Error("should not resolve");
  };
  const result = await runVisionModelTest({ ...request, imageData: "not-an-image" }, host);
  expect(result.ok).toBe(false);
  expect(resolved).toBe(false);
});

test("cancellation reaches fetch and still closes the proxy", async () => {
  const controller = new AbortController();
  const host = createHost("openai_responses");
  let closed = false;
  host.startProxy = async () => ({
    baseUrl: "http://127.0.0.1:9",
    apiKey: "key",
    aliasModelId: "alias",
    close: async () => {
      closed = true;
    },
  });
  globalThis.fetch = (async (_url, init) => {
    controller.abort();
    init?.signal?.throwIfAborted();
    throw new Error("Expected abort");
  }) as typeof fetch;
  const result = await runVisionModelTest(request, host, controller.signal);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("abort");
  expect(closed).toBe(true);
});
