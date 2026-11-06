import { expect, test } from "bun:test";
import type { AnthropicProxyRoute } from "../src/main/anthropic-proxy";
import { resolveAuxiliaryModelRoute } from "../src/main/auxiliary-model-route";
import { buildStatelessModelRequest, readStatelessModelText } from "../src/main/bridge-auxiliary-request";
import type { ProviderStore } from "../src/main/provider-store";
import { resolveVisionModelRoute } from "../src/main/vision-model-route";
import { normalizeApprovalModelSelection } from "../src/shared/approval-model";
import { normalizeAuxiliaryModelSelection } from "../src/shared/auxiliary-model";
import { normalizeVisionModelSelection } from "../src/shared/vision-model";

const provider: AnthropicProxyRoute["provider"] = {
  id: "oauth",
  name: "OAuth",
  enabled: true,
  authMethod: "chatgpt_subscription",
  apiKey: "",
  hasApiKey: false,
  baseUrl: "https://api.openai.com",
  requestPath: "",
  version: "v1",
  defaultModel: "gpt-test",
  apiCompat: "openai_responses",
  createdAt: "",
  updatedAt: "",
};
const selection = {
  providerId: "oauth",
  candidateModelId: "account:oauth:gpt-test",
  modelId: "gpt-test",
  accountId: "account-a",
};
const prompt = {
  system: "Describe images",
  messages: [{ role: "user" as const, content: "What is visible?" }],
  images: [{ mediaType: "image/png" as const, data: "YWJj" }],
  temperature: 0,
  disableThinking: true,
  maxTokens: 128,
};

test("OAuth account binding survives selection normalization for all stateless roles", () => {
  for (const normalize of [
    normalizeAuxiliaryModelSelection,
    normalizeVisionModelSelection,
    normalizeApprovalModelSelection,
  ]) {
    expect(normalize({ ...selection, accountId: " account-a " })).toEqual(selection);
    expect(normalize({ ...selection, accountId: 123 })).toBeUndefined();
    expect(normalize({ ...selection, accountId: "  " })).toBeUndefined();
  }
});

test("auxiliary and vision routes preserve the explicit account and reject missing bindings", () => {
  const store = {
    listProvidersWithSecrets: () => [provider],
    listStatelessModelCandidates: () => [
      {
        id: selection.candidateModelId,
        modelId: selection.modelId,
        baseUrl: provider.baseUrl,
        apiCompat: "openai_responses",
      },
    ],
  } as unknown as ProviderStore;
  for (const resolve of [resolveAuxiliaryModelRoute, resolveVisionModelRoute]) {
    expect(resolve(selection, store).accountId).toBe("account-a");
    const accountCatalogueStore = {
      ...store,
      listStatelessModelCandidates: () => [],
    } as unknown as ProviderStore;
    expect(resolve(selection, accountCatalogueStore).modelId).toBe("gpt-test");
    expect(() =>
      resolve({ ...selection, candidateModelId: "account:another:gpt-test" }, accountCatalogueStore),
    ).toThrow("标识不匹配");
    const { accountId: _, ...unbound } = selection;
    expect(() => resolve(unbound, store)).toThrow("尚未选择账号");
    expect(
      resolve(unbound, {
        ...store,
        listProvidersWithSecrets: () => [{ ...provider, authMethod: "api_key" }],
      } as unknown as ProviderStore).accountId,
    ).toBeUndefined();
  }
});

test("ChatGPT OAuth builds native Responses text and images with no Messages fields", () => {
  const request = buildStatelessModelRequest(
    { role: "vision", provider, modelId: "gpt-test", accountId: "account-a" },
    prompt,
  );
  expect(request.path).toBe("/v1/responses");
  expect(request.body).toMatchObject({
    instructions: "Describe images",
    stream: true,
    store: false,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is visible?" },
          { type: "input_image", image_url: "data:image/png;base64,YWJj" },
        ],
      },
    ],
  });
  for (const key of ["messages", "system", "thinking", "temperature", "max_tokens", "max_output_tokens"]) {
    expect(request.body).not.toHaveProperty(key);
  }
});

test("API-key models build their selected native protocol directly", () => {
  for (const protocol of ["anthropic", "openai_responses", "openai_chat_completions"] as const) {
    const route = {
      role: "auxiliary" as const,
      provider: { ...provider, authMethod: "api_key" as const, apiCompat: protocol },
      modelId: "model",
    };
    const request = buildStatelessModelRequest(route, prompt);
    expect(request.path).toBe(
      protocol === "anthropic"
        ? "/v1/messages"
        : protocol === "openai_responses"
          ? "/v1/responses"
          : "/v1/chat/completions",
    );
    if (protocol === "anthropic")
      expect(request.body).toMatchObject({
        system: "Describe images",
        thinking: { type: "disabled" },
        messages: [
          { content: [{ type: "image", source: { type: "base64", data: "YWJj" } }, { type: "text" }] },
        ],
      });
    if (protocol === "openai_chat_completions")
      expect(request.body).toMatchObject({
        messages: [{ role: "system" }, { content: [{ type: "text" }, { type: "image_url" }] }],
      });
  }
});

function stream(events: unknown[]) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        // One byte per chunk verifies framing across UTF-8 and CRLF boundaries.
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("native Responses streaming handles split Unicode and does not duplicate final text", async () => {
  const deltas: string[] = [];
  const text = await readStatelessModelText(
    stream([
      { type: "response.output_text.delta", delta: "红色" },
      { type: "response.output_text.delta", delta: "圆形" },
      { type: "response.completed", response: { status: "completed", output_text: "红色圆形" } },
    ]),
    "openai_responses",
    (delta) => deltas.push(delta),
  );
  expect(text).toBe("红色圆形");
  expect(deltas).toEqual(["红色", "圆形"]);
});

test("stream failures and interrupted streams are reported even after partial output", async () => {
  for (const ending of [
    [],
    [{ type: "response.failed", response: { error: { message: "account unavailable" } } }],
  ]) {
    await expect(
      readStatelessModelText(
        stream([{ type: "response.output_text.delta", delta: "partial" }, ...ending]),
        "openai_responses",
      ),
    ).rejects.toThrow();
  }
});
