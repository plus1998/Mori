import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openWorkspaceFileForStreaming } from "../src/main/workspace-file-browser";
import { parseByteRange, WorkspaceFileStreams } from "../src/main/workspace-file-stream";

let root = "";
let streams: WorkspaceFileStreams;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-file-stream-"));
  streams = new WorkspaceFileStreams(openWorkspaceFileForStreaming);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("single byte ranges support bounded, open-ended, suffix, and invalid requests", () => {
  expect(parseByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
  expect(parseByteRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
  expect(parseByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  expect(parseByteRange("bytes=1-100", 10)).toEqual({ start: 1, end: 9 });
  for (const range of [
    "bytes=10-",
    "bytes=5-2",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,3-4",
    "bytes=99999999999999999999-",
    "items=0-1",
  ])
    expect(parseByteRange(range, 10)).toBeUndefined();
  expect(parseByteRange("bytes=0-0", 0)).toBeUndefined();
});

test("serves exact ranges, HEAD and empty files with correct response metadata", async () => {
  const file = path.join(root, "a file#.mp4");
  await fs.writeFile(file, "0123456789");
  const url = streams.urlForFile(root, file);
  const response = await streams.respond(new Request(url, { headers: { Range: "bytes=2-5" } }));
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
  expect(response.headers.get("Content-Length")).toBe("4");
  expect(response.headers.get("Content-Type")).toBe("video/mp4");
  expect(await response.text()).toBe("2345");
  const head = await streams.respond(new Request(url, { method: "HEAD" }));
  expect(head.headers.get("Content-Length")).toBe("10");
  expect(await head.text()).toBe("");
  const invalid = await streams.respond(new Request(url, { headers: { Range: "bytes=10-" } }));
  expect(invalid.status).toBe(416);
  expect(invalid.headers.get("Content-Range")).toBe("bytes */10");
  await fs.writeFile(file, "");
  expect(await (await streams.respond(new Request(url))).text()).toBe("");
});

test("workspace capability rejects guessed tokens, traversal and a path changed into an escaping symlink", async () => {
  const file = path.join(root, "hello.txt");
  await fs.writeFile(file, "local");
  const url = streams.urlForFile(root, file);
  const host = new URL(url).host;
  expect((await streams.respond(new Request("eco-workspace://unknown/hello.txt"))).status).toBe(403);
  expect((await streams.respond(new Request(`eco-workspace://${host}/%2e%2e%2foutside`))).status).toBe(403);
  await fs.unlink(file);
  await fs.symlink(path.join(root, ".."), file);
  expect((await streams.respond(new Request(`${url}/outside`))).status).toBe(404);
  expect((await streams.respond(new Request(url))).status).toBe(403);
});

test("cancelling a large response closes the descriptor without buffering the file", async () => {
  const file = path.join(root, "large.bin");
  const writer = await fs.open(file, "w");
  await writer.truncate(256 * 1024 * 1024);
  await writer.close();
  let closed: Promise<unknown> | undefined;
  const local = new WorkspaceFileStreams(async (request) => {
    const result = await openWorkspaceFileForStreaming(request);
    closed = new Promise((resolve) => result.handle.once("close", resolve));
    return result;
  });
  const response = await local.respond(new Request(local.urlForFile(root, file)));
  await response.body!.cancel();
  await closed;
});

test("names beginning with two dots are ordinary files, not parent traversal", async () => {
  const file = path.join(root, "..notes.txt");
  await fs.writeFile(file, "local notes");
  const response = await streams.respond(new Request(streams.urlForFile(root, file)));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("local notes");
});

test("HTML and relative stylesheets retain the workspace scope with scripts and network disabled", async () => {
  const file = path.join(root, "page.html");
  await fs.writeFile(file, "<h1>Hello</h1>");
  const style = path.join(root, "page.css");
  await fs.writeFile(style, "h1 {color: red}");
  const url = streams.urlForFile(root, file);
  const page = await streams.respond(new Request(url));
  expect(page.headers.get("Content-Security-Policy")).toContain("sandbox;");
  expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  expect(
    (await streams.respond(new Request(new URL("./page.css", url)))).headers.get("Content-Type"),
  ).toStartWith("text/css");
  await page.body!.cancel();
});
