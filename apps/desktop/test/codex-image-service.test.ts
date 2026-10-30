import { expect, test } from "bun:test";
import {
  type CodexImageAccountPort,
  CodexImageBatchError,
  CodexImageService,
  readCodexImageResponse,
} from "../src/main/codex-image-service";
import type {
  OpenAIAccount,
  OpenAIAccountDetails,
  OpenAIAccountImageQuota,
} from "../src/shared/openai-account";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=",
  "base64",
);
function account(id: string, plan = "plus", enabled = true): OpenAIAccountDetails {
  const claims = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_plan_type: plan },
    }),
  ).toString("base64url");
  return {
    id,
    name: id,
    createdAt: "2026-10-14",
    updatedAt: "2026-10-14",
    imageGenerationEnabled: enabled,
    authJson: JSON.stringify({ tokens: { access_token: `header.${claims}.signature`, account_id: id } }),
  };
}
function imageResponse(): Response {
  const raw =
    [
      {
        type: "response.output_item.done",
        item: { type: "image_generation_call", result: png.toString("base64") },
      },
      {
        type: "response.completed",
        response: { output: [{ type: "image_generation_call", result: png.toString("base64") }] },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join("") + "data: [DONE]\r\n\r\n";
  const bytes = new TextEncoder().encode(raw);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7)
          controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function harness(
  items = [account("A"), account("B"), account("disabled", "plus", false), account("free", "free")],
) {
  const saved = new Map<string, OpenAIAccountImageQuota>();
  const selected: string[] = [];
  const bodies: Record<string, any>[] = [];
  const port: CodexImageAccountPort = {
    ensureAccountCredentials: async () => {},
    listAccounts: async () =>
      items.map((item) => ({ ...item, isLoggedIn: true }) as unknown as OpenAIAccount),
    getAccountDetails: async (id) => items.find((item) => item.id === id)!,
    saveImageQuota: (id, _auth, quota) => {
      saved.set(id, quota);
    },
  };
  let respond = async (_path: string): Promise<Response> => imageResponse();
  const service = new CodexImageService(port, async (item) => ({
    close: () => {},
    fetch: async (path, init) => {
      selected.push(item.id);
      bodies.push(JSON.parse(init.body as string));
      return respond(path);
    },
  }));
  return {
    items,
    saved,
    selected,
    bodies,
    service,
    setResponse: (handler: typeof respond) => {
      respond = handler;
    },
  };
}

test("SSE split across chunks and CRLF is parsed without duplicate images", async () => {
  expect(await readCodexImageResponse(imageResponse())).toEqual(png);
});
test("image bytes without response.completed never count as success", async () => {
  const response = new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: png.toString("base64") } })}\n\n`,
  );
  await expect(readCodexImageResponse(response)).rejects.toMatchObject({ code: "incomplete_response" });
});
test("upstream SSE failure is surfaced instead of returning an empty success", async () => {
  await expect(
    readCodexImageResponse(
      new Response(
        'data: {"type":"response.failed","response":{"error":{"code":"rate_limit","message":"limited"}}}\n\n',
      ),
    ),
  ).rejects.toMatchObject({ code: "rate_limit", message: "limited" });
});
test("each image rotates enabled paid accounts and disabling an account takes effect", async () => {
  const h = harness();
  expect(await h.service.generate({ prompt: "leaf", count: 4 }, [])).toHaveLength(4);
  expect(h.selected).toEqual(["A", "B", "A", "B"]);
  h.items[0]!.imageGenerationEnabled = false;
  await h.service.generate({ prompt: "leaf" }, []);
  expect(h.selected.at(-1)).toBe("B");
  expect(h.bodies[0]).toMatchObject({
    model: "gpt-6.1-sol",
    store: false,
    stream: true,
    tools: [{ type: "image_generation", model: "gpt-image-2", action: "generate" }],
  });
});
test("concurrent callers retain deterministic account rotation", async () => {
  const h = harness();
  await Promise.all([
    h.service.generate({ prompt: "1" }, []),
    h.service.generate({ prompt: "2" }, []),
    h.service.generate({ prompt: "3" }, []),
  ]);
  expect(h.selected).toEqual(["A", "B", "A"]);
});
test("no enabled paid account gives a specific error before any request", async () => {
  const h = harness([account("free", "free"), account("disabled", "plus", false)]);
  await expect(h.service.generate({ prompt: "leaf" }, [])).rejects.toMatchObject({
    code: "no_enabled_accounts",
  });
  expect(h.selected).toEqual([]);
});

test("Codex route rejects Free while the web route accepts its image quota, without consuming the rotation cursor", async () => {
  const free = account("free", "free");
  free.imageQuota = { source: "chatgpt_image_gen", status: "available", fetchedAt: Date.now(), remaining: 5 };
  const h = harness([free]);
  expect(await h.service.getAvailability()).toMatchObject({ available: false });
  expect((await h.service.getAvailability()).reason).toContain("free");
  expect(await h.service.getAvailability("chatgpt_web")).toEqual({ available: true });
  expect(h.selected).toEqual([]);
  const paid = harness();
  expect(await paid.service.getAvailability()).toEqual({ available: true });
  await paid.service.generate({ prompt: "leaf" }, []);
  expect(paid.selected).toEqual(["A"]);
});
test("image edits pass local reference bytes to Codex with edit action", async () => {
  const h = harness();
  await h.service.generate({ prompt: "change color" }, [
    { bytes: png, mimeType: "image/png", fileName: "reference.png" },
  ]);
  expect(h.bodies[0]?.tools[0].action).toBe("edit");
  expect(h.bodies[0]?.input[0].content[1]).toEqual({
    type: "input_image",
    image_url: `data:image/png;base64,${png.toString("base64")}`,
  });
});
test("missing image quota remains a failed query, never a fabricated zero", async () => {
  const h = harness();
  h.setResponse(async () => Response.json({ limits_progress: [] }));
  const result = await h.service.queryQuota("A");
  expect(result.status).toBe("error");
  expect(result.remaining).toBeUndefined();
  expect(h.saved.get("A")).toEqual(result);
});
test("quota refresh is independent per account and failure replaces old success", async () => {
  const h = harness();
  h.setResponse(async () =>
    Response.json({
      limits_progress: [{ feature_name: "image_gen", remaining: 120, reset_after: "2026-10-15T14:00:00Z" }],
    }),
  );
  expect(await h.service.queryQuota("B")).toMatchObject({
    status: "available",
    remaining: 120,
    source: "chatgpt_image_gen",
  });
  expect(h.saved.has("A")).toBe(false);
  h.setResponse(async () => Response.json({ error: { message: "expired" } }, { status: 401 }));
  expect(await h.service.queryQuota("B")).toMatchObject({ status: "error" });
  expect(h.saved.get("B")?.remaining).toBeUndefined();
});
test("a failed second image preserves the first payload for artifact storage", async () => {
  const h = harness();
  let count = 0;
  h.setResponse(async () =>
    ++count === 1
      ? imageResponse()
      : Response.json({ error: { type: "usage_limit_reached", message: "limited" } }, { status: 429 }),
  );
  try {
    await h.service.generate({ prompt: "leaf", count: 2 }, []);
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(CodexImageBatchError);
    expect((error as CodexImageBatchError).payloads).toHaveLength(1);
    expect(error).toMatchObject({ code: "usage_limit_reached", providerStatus: 429 });
  }
});
test("a cancelled queued caller does not release another caller ahead of the running job", async () => {
  const h = harness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  h.setResponse(async () => {
    if (++count === 1) await pending;
    return imageResponse();
  });
  const first = h.service.generate({ prompt: "first" }, []);
  const controller = new AbortController();
  const cancelled = h.service.generate({ prompt: "cancelled" }, [], controller.signal);
  void cancelled.catch(() => {});
  controller.abort();
  await expect(cancelled).rejects.toThrow();
  const third = h.service.generate({ prompt: "third" }, []);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(h.selected).toEqual(["A"]);
  release();
  await Promise.all([first, third]);
  expect(h.selected).toEqual(["A", "B"]);
});

test("renewable image accounts stay available and refresh only before a real image request", async () => {
  const fresh = account("renewable");
  const oldClaims = Buffer.from(JSON.stringify({ exp: 1, "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString("base64url");
  let current = { ...fresh, authJson: JSON.stringify({ tokens: { access_token: `header.${oldClaims}.signature`, refresh_token: "refresh", account_id: fresh.id } }) };
  let refreshes = 0;
  let connections = 0;
  const service = new CodexImageService({
    listAccounts: async () => [{ ...fresh, isLoggedIn: false, authState: "refreshable" } as unknown as OpenAIAccount],
    getAccountDetails: async () => current,
    ensureAccountCredentials: async () => { refreshes++; current = fresh; },
    saveImageQuota: () => {},
  }, async (selected) => {
    connections++;
    expect(selected.authJson).toBe(fresh.authJson);
    return { close() {}, fetch: async () => imageResponse() };
  });
  expect(await service.getAvailability()).toEqual({ available: true });
  expect(refreshes).toBe(0);
  expect(connections).toBe(0);
  expect(await service.generate({ prompt: "one image" }, [])).toHaveLength(1);
  expect(refreshes).toBe(1);
  expect(connections).toBe(1);
});
