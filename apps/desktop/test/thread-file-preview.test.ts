import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readThreadFilePreview } from "../src/main/thread-file-preview";

let workspace = "";

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "eco-thread-file-preview-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.writeFile(path.join(workspace, "src", "main.ts"), "export const answer = 42;\n");
});

afterEach(async () => fs.rm(workspace, { recursive: true, force: true }));

test("reads bounded original bytes with stable revision and chunks", async () => {
  const first = await readThreadFilePreview(
    { threadId: "thr_1", filePath: "src/main.ts", offset: 0 },
    { workspacePath: workspace },
  );
  expect(first.path).toBe(await fs.realpath(path.join(workspace, "src", "main.ts")));
  expect(first.nextOffset).toBe(first.size);
  expect(Buffer.from(first.data, "base64").toString("utf8")).toContain("answer = 42");
  const second = await readThreadFilePreview(
    { threadId: "thr_1", filePath: first.path, offset: first.nextOffset, revision: first.revision },
    { workspacePath: workspace },
  );
  expect(second.data).toBe("");
});

test("rejects files outside the conversation workspace", async () => {
  const outside = path.join(path.dirname(workspace), "outside.ts");
  await fs.writeFile(outside, "secret");
  try {
    await expect(
      readThreadFilePreview(
        { threadId: "thr_1", filePath: outside },
        { workspacePath: workspace },
      ),
    ).rejects.toThrow("inside the conversation workspace");
  } finally {
    await fs.rm(outside, { force: true });
  }
});

test("resolves links relative to the source file", async () => {
  await fs.writeFile(path.join(workspace, "src", "util.ts"), "export {};\n");
  const result = await readThreadFilePreview(
    { threadId: "thr_1", filePath: "util.ts", relativeTo: path.join(workspace, "src", "main.ts") },
    { workspacePath: workspace },
  );
  expect(result.path).toBe(await fs.realpath(path.join(workspace, "src", "util.ts")));
});
