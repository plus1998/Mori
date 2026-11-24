import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  CODEX_MODEL_LIST_METHOD,
  listCodexModelCatalog,
  parseCodexModelListPage,
} from "../src/codex-model-list";

function catalogEntry(model: string, efforts: readonly string[]): Record<string, unknown> {
  return {
    id: model,
    model,
    displayName: model.toUpperCase(),
    defaultReasoningEffort: efforts[0] ?? "medium",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} description`,
    })),
  };
}

describe("listCodexModelCatalog", () => {
  test("paginates model/list and preserves server effort order and open string values", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const responses = [
      {
        data: [catalogEntry("gpt-first", ["max", "low", "focused"])],
        nextCursor: "cursor-2",
      },
      {
        data: [catalogEntry("gpt-second", ["none", "ultra"])],
        nextCursor: null,
      },
    ];
    const client = {
      async request<T>(method: string, params?: unknown): Promise<T> {
        requests.push({ method, params });
        return responses.shift() as T;
      },
    };

    await expect(listCodexModelCatalog(client, { pageSize: 1, modelProvider: " custom-gateway " })).resolves.toEqual([
      {
        id: "gpt-first",
        model: "gpt-first",
        displayName: "GPT-FIRST",
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: ["max", "low", "focused"],
      },
      {
        id: "gpt-second",
        model: "gpt-second",
        displayName: "GPT-SECOND",
        defaultReasoningEffort: "none",
        supportedReasoningEfforts: ["none", "ultra"],
      },
    ]);
    expect(requests).toEqual([
      {
        method: CODEX_MODEL_LIST_METHOD,
        params: { limit: 1, includeHidden: false, modelProvider: "custom-gateway" },
      },
      {
        method: CODEX_MODEL_LIST_METHOD,
        params: { limit: 1, includeHidden: false, cursor: "cursor-2", modelProvider: "custom-gateway" },
      },
    ]);
  });

  test("rejects a repeated pagination cursor", async () => {
    const client = {
      async request<T>(): Promise<T> {
        return { data: [], nextCursor: "same-cursor" } as T;
      },
    };

    await expect(listCodexModelCatalog(client)).rejects.toThrow("repeated nextCursor");
  });
});

describe("parseCodexModelListPage", () => {
  test("keeps every catalog model and its reasoning efforts from a real 0.160.1 app-server", () => {
    // Captured from the pinned 0.160.1 binary (`model/list`, includeHidden: false).
    // 0.160 added upgrade/serviceTiers/multiAgentVersion/availabilityNux/isDefault
    // and the `ultra` effort; the parser must keep passing models + efforts through.
    const raw = JSON.parse(
      fs.readFileSync(path.join(import.meta.dir, "fixtures/codex-0.160.1-model-list.json"), "utf8"),
    );
    const page = parseCodexModelListPage(raw);
    expect(page.nextCursor).toBeNull();
    expect(page.data.map((entry) => entry.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    const sol = page.data[0];
    expect(sol?.displayName).toBe("GPT-6.1-Sol");
    expect(sol?.defaultReasoningEffort).toBe("low");
    expect(sol?.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    // A model with fewer tiers keeps its own list instead of inheriting another's.
    expect(page.data.find((entry) => entry.id === "gpt-6-luna")?.supportedReasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(page.data.find((entry) => entry.id === "gpt-5.5")?.supportedReasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("accepts a valid empty page", () => {
    expect(parseCodexModelListPage({ data: [], nextCursor: null })).toEqual({
      data: [],
      nextCursor: null,
    });
  });

  for (const [name, payload, expected] of [
    ["non-object response", null, "response must be an object"],
    ["missing data", { nextCursor: null }, "response.data must be an array"],
    ["missing next cursor", { data: [] }, "response.nextCursor"],
    [
      "blank effort",
      {
        data: [
          {
            ...catalogEntry("gpt-test", ["low"]),
            supportedReasoningEfforts: [{ reasoningEffort: " ", description: "blank" }],
          },
        ],
        nextCursor: null,
      },
      "reasoningEffort must be a non-empty string",
    ],
    [
      "missing effort description",
      {
        data: [
          {
            ...catalogEntry("gpt-test", ["low"]),
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          },
        ],
        nextCursor: null,
      },
      "description must be a string",
    ],
  ] as const) {
    test(`rejects ${name}`, () => {
      expect(() => parseCodexModelListPage(payload)).toThrow(expected);
    });
  }
});
