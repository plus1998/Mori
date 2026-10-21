import { expect, test } from "bun:test";
import { generateChatGptWebImage, solveWebImageProof } from "../src/main/chatgpt-web-image-client";
import { solveWebImageVerification } from "../src/main/chatgpt-web-verification";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=",
  "base64",
);

test.each([
  ["https://files.oaiusercontent.com/image", "https://files.oaiusercontent.com/image", false],
  ["https://chatgpt.com/backend-api/estuary/content?id=image", "/backend-api/estuary/content?id=image", true],
] as const)("web image download scopes login credentials to its origin: %s", async (downloadUrl, requestPath, needsAuth) => {
  const requests: string[] = [];
  const result = await generateChatGptWebImage(
    {
      close: () => {},
      fetch: async (path, init) => {
        requests.push(path);
        if (path === "/") return new Response('<script src="/c/build123/_/app.js"></script>');
        if (path.endsWith("chat-requirements/prepare")) return Response.json({ prepare_token: "prepared" });
        if (path.endsWith("chat-requirements/finalize")) return Response.json({ token: "requirements" });
        if (path.endsWith("conversation/prepare")) return Response.json({ conduit_token: "conduit" });
        if (path.endsWith("/f/conversation")) {
          const body = JSON.parse(init.body as string);
          expect(body.model).toBe("gpt-5-5");
          expect(body.thinking_effort).toBeUndefined();
          expect(body.system_hints).toEqual(["picture_v2"]);
          return new Response(
            'data: {"conversation_id":"conversation","message":{"author":{"role":"tool"},"content":{"parts":[{"asset_pointer":"file-service://file_123"}]}}}\n\ndata: [DONE]\n\n',
          );
        }
        if (path.endsWith("file_123/download")) return Response.json({ download_url: downloadUrl });
        expect(new Headers(init.headers).has("authorization")).toBe(needsAuth);
        if (needsAuth) expect(new Headers(init.headers).get("authorization")).toBe("Bearer test");
        return new Response(png);
      },
    },
    { Authorization: "Bearer test", "User-Agent": "test" },
    { prompt: "leaf" },
    AbortSignal.timeout(5000),
  );
  expect(result.bytes).toEqual(png);
  expect(requests.at(-1)).toBe(requestPath);
});

test("web edits upload all references, attach their metadata and ignore echoed input images", async () => {
  const paths: string[] = [];
  let uploadIndex = 0;
  const result = await generateChatGptWebImage(
    {
      close: () => {},
      fetch: async (path, init) => {
        paths.push(path);
        if (path === "/backend-api/files") {
          uploadIndex++;
          expect(JSON.parse(init.body as string)).toEqual({
            file_name: `ref${uploadIndex}.png`,
            file_size: png.length,
            use_case: "multimodal",
            width: 1,
            height: 1,
          });
          return Response.json({
            file_id: `file_input${uploadIndex}`,
            upload_url: `https://files.oaiusercontent.com/upload${uploadIndex}`,
          });
        }
        if (path.startsWith("https://files.oaiusercontent.com/upload")) {
          expect(init.method).toBe("PUT");
          expect(Buffer.from(init.body as Uint8Array)).toEqual(png);
          expect(new Headers(init.headers).get("content-type")).toBe("image/png");
          expect(new Headers(init.headers).has("authorization")).toBe(false);
          return new Response("", { status: 201 });
        }
        if (path.endsWith("/uploaded")) {
          expect(new Headers(init.headers).get("authorization")).toBe("Bearer test");
          return Response.json({ status: "success" });
        }
        if (path === "/") return new Response('<script src="/c/build123/_/app.js"></script>');
        if (path.endsWith("chat-requirements/prepare")) return Response.json({ prepare_token: "prepared" });
        if (path.endsWith("chat-requirements/finalize")) return Response.json({ token: "requirements" });
        if (path.endsWith("conversation/prepare")) return Response.json({ conduit_token: "conduit" });
        if (path.endsWith("/f/conversation")) {
          const message = JSON.parse(init.body as string).messages[0];
          expect(message.content).toEqual({
            content_type: "multimodal_text",
            parts: [
              {
                content_type: "image_asset_pointer",
                asset_pointer: "file-service://file_input1",
                width: 1,
                height: 1,
                size_bytes: png.length,
              },
              {
                content_type: "image_asset_pointer",
                asset_pointer: "file-service://file_input2",
                width: 1,
                height: 1,
                size_bytes: png.length,
              },
              "change to red",
            ],
          });
          expect(message.metadata.attachments).toEqual(
            [1, 2].map((i) => ({
              id: `file_input${i}`,
              mimeType: "image/png",
              name: `ref${i}.png`,
              size: png.length,
              width: 1,
              height: 1,
            })),
          );
          return new Response(
            'data: {"conversation_id":"edit","o":"append","v":"file-service://file_input1 file-service://file_input2"}\n\ndata: [DONE]\n\n',
          );
        }
        if (path === "/backend-api/conversation/edit")
          return Response.json({
            mapping: {
              user: {
                message: {
                  author: { role: "user" },
                  content: { parts: [{ asset_pointer: "file-service://file_input1" }] },
                },
              },
              tool: {
                message: {
                  author: { role: "tool" },
                  content: { parts: [{ asset_pointer: "file-service://file_output" }] },
                },
              },
            },
          });
        if (path === "/backend-api/files/file_output/download")
          return Response.json({ download_url: "https://files.oaiusercontent.com/output" });
        if (path === "https://files.oaiusercontent.com/output") return new Response(png);
        throw new Error(`Unexpected request: ${path}`);
      },
    },
    { Authorization: "Bearer test", "User-Agent": "test" },
    { prompt: "change to red" },
    AbortSignal.timeout(1000),
    [1, 2].map((i) => ({ bytes: png, mimeType: "image/png", fileName: `ref${i}.png` })),
  );
  expect(result.bytes).toEqual(png);
  expect(paths.filter((p) => p.includes("/download"))).toEqual(["/backend-api/files/file_output/download"]);
  expect(paths.indexOf("/backend-api/files/file_input2/uploaded")).toBeLessThan(paths.indexOf("/"));
});

test("a failed reference upload stops before generation with its upstream status", async () => {
  const paths: string[] = [];
  await expect(
    generateChatGptWebImage(
      {
        close: () => {},
        fetch: async (path) => {
          paths.push(path);
          return path === "/backend-api/files"
            ? Response.json({ file_id: "file_input", upload_url: "https://files.oaiusercontent.com/upload" })
            : new Response("Denied", { status: 403 });
        },
      },
      { "User-Agent": "test" },
      { prompt: "edit" },
      AbortSignal.timeout(1000),
      [{ bytes: png, mimeType: "image/png", fileName: "ref.png" }],
    ),
  ).rejects.toMatchObject({ code: "image_upload_failed", providerStatus: 403 });
  expect(paths).toEqual(["/backend-api/files", "https://files.oaiusercontent.com/upload"]);
});

test("proof challenge computes a verifiable sha3 result and respects cancellation", async () => {
  const solved = await solveWebImageProof(
    "seed",
    "ff",
    Array.from({ length: 25 }, () => 0),
    AbortSignal.timeout(1000),
  );
  expect(solved.startsWith("gAAAAAB")).toBe(true);
  await expect(solveWebImageProof("seed", "00", [], AbortSignal.abort())).rejects.toThrow();
});

test("restricted verification VM decodes challenge and cannot run arbitrary JavaScript", () => {
  const p = "key";
  const raw = JSON.stringify([
    [2, 100, "result"],
    [7, 3, 100],
  ]);
  const xor = [...raw]
    .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ p.charCodeAt(i % p.length)))
    .join("");
  const token = solveWebImageVerification(Buffer.from(xor).toString("base64"), p);
  expect(Buffer.from(token, "base64").toString()).toBe("result");
  expect(() => solveWebImageVerification("invalid", p)).toThrow();
});

test("verification VM executes nested instruction queues used by Chromium challenges", () => {
  const p = "key";
  const raw = JSON.stringify([
    [
      2,
      100,
      JSON.stringify([
        [2, 101, "nested"],
        [7, 3, 101],
      ]),
    ],
    [14, 9, 100],
  ]);
  const xor = [...raw]
    .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ p.charCodeAt(i % p.length)))
    .join("");
  expect(
    Buffer.from(solveWebImageVerification(Buffer.from(xor).toString("base64"), p), "base64").toString(),
  ).toBe("nested");
});
