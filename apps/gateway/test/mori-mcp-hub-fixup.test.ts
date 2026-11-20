import { describe, expect, test } from "bun:test";
import {
  ECO_MCP_HUB_TOOL_NAMES,
  ecoMcpHubNamespace,
  ecoMcpHubServerName,
} from "@eco/shared";
import {
  GATEWAY_PROVIDER_ID_HEADER,
  GATEWAY_REQUESTED_MODEL_HEADER,
} from "../src/provider-router.js";
import { createGatewayFetchHandler } from "../src/server.js";
import {
  fixupEcoMcpHubResponsesPayload,
  fixupEcoMcpHubStreamEvent,
  resolveEcoMcpHubNamespace,
} from "../src/mori-mcp-hub-fixup.js";
import type { GatewayConfig, GatewayProvider } from "../src/types.js";

const CODEX_THREAD = "019a4f3f-6b2c-7d00-9f00-000000000000";
const ECO_THREAD = "thr_1790696385743";
// Golden vectors: verified against names actually registered by the shared Codex app-server.
const EXPECTED_HUB = "mori_mcp_81905ae0_thr_1790696385743";
const EXPECTED_NS = `mcp__${EXPECTED_HUB}`;

const provider: GatewayProvider = {
  id: "responses",
  name: "Responses mock",
  upstreamKind: "responses",
  baseUrl: "https://responses.test",
  apiKey: "test-key",
  upstreamModelId: "test-model",
  models: ["test-model"],
};

const config: GatewayConfig = { host: "127.0.0.1", port: 0, providers: [provider] };

const hubCallItem = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "call_tool",
  arguments: '{"name":"mori_image_view:view_image"}',
};

function codexTurnMetadataHeader(): string {
  return JSON.stringify({ thread_id: CODEX_THREAD, turn_id: "turn_1", request_kind: "turn" });
}

function sse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function postResponses(
  handler: (request: Request) => Response | Promise<Response>,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  return handler(
    new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("eco mcp hub name goldens (@eco/shared)", () => {
  test("per-thread server name matches the names registered with Codex", () => {
    expect(ecoMcpHubServerName("thr_1790696385743")).toBe(EXPECTED_HUB);
    expect(ecoMcpHubServerName("thr_1790682175108")).toBe("mori_mcp_37e3bfc7_thr_1790682175108");
    expect(ecoMcpHubNamespace(ECO_THREAD)).toBe(EXPECTED_NS);
    expect([...ECO_MCP_HUB_TOOL_NAMES]).toEqual(["call_tool", "search_tools"]);
  });
});

describe("resolveEcoMcpHubNamespace", () => {
  test("resolves the per-thread namespace from the Codex thread id", () => {
    expect(resolveEcoMcpHubNamespace(() => ECO_THREAD, CODEX_THREAD)).toBe(EXPECTED_NS);
  });

  test("stays undefined when the resolver or thread id is missing", () => {
    expect(resolveEcoMcpHubNamespace(undefined, CODEX_THREAD)).toBeUndefined();
    expect(resolveEcoMcpHubNamespace(() => ECO_THREAD, undefined)).toBeUndefined();
    expect(resolveEcoMcpHubNamespace(() => ECO_THREAD, "   ")).toBeUndefined();
    expect(resolveEcoMcpHubNamespace(() => undefined, CODEX_THREAD)).toBeUndefined();
  });

  test("tolerates a throwing resolver", () => {
    expect(
      resolveEcoMcpHubNamespace(() => {
        throw new Error("boom");
      }, CODEX_THREAD),
    ).toBeUndefined();
  });
});

describe("fixupEcoMcpHubStreamEvent", () => {
  test("injects the namespace on a hub call item that dropped it", () => {
    const event = { type: "response.output_item.done", output_index: 0, item: hubCallItem };
    const fixed = fixupEcoMcpHubStreamEvent(event, EXPECTED_NS) as typeof event;
    expect(fixed).not.toBe(event);
    expect(fixed.item).not.toBe(event.item);
    expect(fixed.item.namespace).toBe(EXPECTED_NS);
    // The upstream item must not be mutated in place.
    expect(event.item).toBe(hubCallItem);
    expect(event.item.namespace).toBeUndefined();
  });

  test("returns the same reference when the namespace is already correct", () => {
    const event = {
      type: "response.output_item.done",
      item: { ...hubCallItem, namespace: EXPECTED_NS },
    };
    expect(fixupEcoMcpHubStreamEvent(event, EXPECTED_NS)).toBe(event);
  });

  test("preserves a non-empty namespace to avoid same-name tool collisions", () => {
    const event = {
      type: "response.output_item.done",
      item: { ...hubCallItem, namespace: "mcp__mori_mcp_deadbeef_other" },
    };
    expect(fixupEcoMcpHubStreamEvent(event, EXPECTED_NS)).toBe(event);
  });

  test("ignores non-hub tools", () => {
    const event = { type: "response.output_item.done", item: { ...hubCallItem, name: "exec_command" } };
    expect(fixupEcoMcpHubStreamEvent(event, EXPECTED_NS)).toBe(event);
  });

  test("repairs items inside response.output (response.completed)", () => {
    const event = { type: "response.completed", response: { id: "resp_1", output: [hubCallItem] } };
    const fixed = fixupEcoMcpHubStreamEvent(event, EXPECTED_NS) as typeof event;
    expect(fixed.response.output[0]).not.toBe(hubCallItem);
    expect((fixed.response.output[0] as typeof hubCallItem).namespace).toBe(EXPECTED_NS);
    expect(event.response.output[0]).toBe(hubCallItem);
  });

  test("repairs top-level name/namespace fields", () => {
    const event = {
      type: "response.function_call_arguments.done",
      name: "search_tools",
      namespace: "mcp__mori_mcp_deadbeef_other",
    };
    const fixed = fixupEcoMcpHubStreamEvent(event, EXPECTED_NS) as typeof event;
    expect(fixed.namespace).toBe(event.namespace);
    expect(fixed).toBe(event);
  });

  test("passes non-record events through untouched", () => {
    expect(fixupEcoMcpHubStreamEvent("ping", EXPECTED_NS)).toBe("ping");
    expect(fixupEcoMcpHubStreamEvent(null, EXPECTED_NS)).toBeNull();
  });
});

describe("fixupEcoMcpHubResponsesPayload", () => {
  test("repairs response.output and root output arrays", () => {
    const payload = {
      response: { id: "resp_1", output: [hubCallItem] },
      output: [{ ...hubCallItem, name: "search_tools" }],
    };
    const fixed = fixupEcoMcpHubResponsesPayload(payload, EXPECTED_NS) as typeof payload;
    expect((fixed.response.output[0] as typeof hubCallItem).namespace).toBe(EXPECTED_NS);
    expect((fixed.output[0] as typeof hubCallItem).namespace).toBe(EXPECTED_NS);
  });

  test("returns the same reference when nothing needs repair", () => {
    const payload = { response: { output: [{ ...hubCallItem, namespace: EXPECTED_NS }] } };
    expect(fixupEcoMcpHubResponsesPayload(payload, EXPECTED_NS)).toBe(payload);
  });
});

describe("responses handler namespace repair", () => {
  test("injects the Hub namespace into streaming function calls that dropped it", async () => {
    const body = [
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: hubCallItem,
      })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", status: "completed", output: [hubCallItem] },
      })}`,
      "",
    ].join("\n");
    const handler = createGatewayFetchHandler(
      config,
      () => Promise.resolve(sse(body)),
      () => undefined,
      undefined,
      undefined,
      undefined,
      () => ECO_THREAD,
    );
    const response = await postResponses(
      handler,
      {
        [GATEWAY_PROVIDER_ID_HEADER]: "responses",
        [GATEWAY_REQUESTED_MODEL_HEADER]: "test-model",
        "x-codex-turn-metadata": codexTurnMetadataHeader(),
      },
      { model: "test-model", input: [], stream: true },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(`"namespace":"${EXPECTED_NS}"`);
    // Both the item event and the completed response carry the repaired namespace.
    expect(text.split(`"namespace":"${EXPECTED_NS}"`)).toHaveLength(3);
  });

  test("leaves an already-corrected stream byte-identical", async () => {
    const doneEvent = {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...hubCallItem, namespace: EXPECTED_NS },
    };
    const body = [
      "event: response.output_item.done",
      `data: ${JSON.stringify(doneEvent)}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [] } })}`,
      "",
    ].join("\n");
    const handler = createGatewayFetchHandler(
      config,
      () => Promise.resolve(sse(body)),
      () => undefined,
      undefined,
      undefined,
      undefined,
      () => ECO_THREAD,
    );
    const response = await postResponses(
      handler,
      {
        [GATEWAY_PROVIDER_ID_HEADER]: "responses",
        [GATEWAY_REQUESTED_MODEL_HEADER]: "test-model",
        "x-codex-turn-metadata": codexTurnMetadataHeader(),
      },
      { model: "test-model", input: [], stream: true },
    );
    const text = await response.text();
    expect(text).toContain(`"namespace":"${EXPECTED_NS}"`);
    // No repair happened: the data line is the original serialization.
    expect(text).toContain(`data: ${JSON.stringify(doneEvent)}`);
  });

  test("does not touch function calls when the Codex thread identity is unavailable", async () => {
    const body = [
      "event: response.output_item.done",
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: hubCallItem })}`,
      "",
    ].join("\n");
    const handler = createGatewayFetchHandler(
      config,
      () => Promise.resolve(sse(body)),
      () => undefined,
      undefined,
      undefined,
      undefined,
      () => ECO_THREAD,
    );
    const response = await postResponses(
      handler,
      {
        [GATEWAY_PROVIDER_ID_HEADER]: "responses",
        [GATEWAY_REQUESTED_MODEL_HEADER]: "test-model",
      },
      { model: "test-model", input: [], stream: true },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('"namespace"');
  });

  test("repairs non-stream Responses payloads", async () => {
    const handler = createGatewayFetchHandler(
      config,
      () =>
        Promise.resolve(
          Response.json({
            id: "resp_1",
            object: "response",
            model: "test-model",
            status: "completed",
            output: [hubCallItem, { ...hubCallItem, name: "exec_command", arguments: '{"cmd":"ls"}' }],
          }),
        ),
      () => undefined,
      undefined,
      undefined,
      undefined,
      () => ECO_THREAD,
    );
    const response = await postResponses(
      handler,
      {
        [GATEWAY_PROVIDER_ID_HEADER]: "responses",
        [GATEWAY_REQUESTED_MODEL_HEADER]: "test-model",
        "x-codex-turn-metadata": codexTurnMetadataHeader(),
      },
      { model: "test-model", input: [] },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      output: { name: string; namespace?: string }[];
    };
    expect(body.output[0]?.namespace).toBe(EXPECTED_NS);
    expect(body.output[1]?.namespace).toBeUndefined();
  });

  test("skips repair when no resolver is wired (SDK runtimes use the fixed Hub name)", async () => {
    const body = [
      "event: response.output_item.done",
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: hubCallItem })}`,
      "",
    ].join("\n");
    const handler = createGatewayFetchHandler(
      config,
      () => Promise.resolve(sse(body)),
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const response = await postResponses(
      handler,
      {
        [GATEWAY_PROVIDER_ID_HEADER]: "responses",
        [GATEWAY_REQUESTED_MODEL_HEADER]: "test-model",
        "x-codex-turn-metadata": codexTurnMetadataHeader(),
      },
      { model: "test-model", input: [], stream: true },
    );
    expect(await response.text()).not.toContain('"namespace"');
  });
});
