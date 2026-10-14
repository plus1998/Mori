import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { containsImageInput } from "../../shared/src/image-input";
import { buildEcoSdkHooks, createImageReadPreToolHook } from "../src/eco-sdk-hooks";
import { IMAGE_READ_DISABLED_REASON } from "../src/native-image-read";
import { assertPiImageInputAllowed } from "../src/pi-image-input-policy";
import { runScriptedPiSession } from "./pi-session-events-probe";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=",
  "base64",
);

test("Claude Read rejects screenshots and renamed images while preserving text/vision reads", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "eco-image-policy-"));
  try {
    await writeFile(path.join(cwd, "renamed.dat"), png);
    await writeFile(path.join(cwd, "page.svg"), '<svg width="10" height="10"></svg>');
    await writeFile(path.join(cwd, "notes.txt"), "BM25 ranks text documents; this is not a bitmap.");
    let supportsImageInput = false;
    let actor: unknown;
    const hook = buildEcoSdkHooks({
      resolveSupportsImageInput: (input) => {
        actor = input;
        return supportsImageInput;
      },
    }).PreToolUse?.find((entry) => entry.matcher === "Read")?.hooks[0];
    expect(hook).toBeDefined();
    if (!hook) throw new Error("Image read hook is missing");
    const invoke = (filePath: string) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          session_id: "claude-image-policy",
          transcript_path: "/tmp/transcript.jsonl",
          cwd,
          permission_mode: "bypassPermissions",
          tool_name: "Read",
          tool_use_id: "read-image",
          tool_input: { file_path: filePath },
          agent_id: "child-1",
          agent_type: "eco_coder",
        } as PreToolUseHookInput,
        "read-image",
        { signal: new AbortController().signal },
      );
    for (const filePath of ["/tmp/pelican.png", "renamed.dat"]) {
      expect(await invoke(filePath)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: IMAGE_READ_DISABLED_REASON,
        },
      });
    }
    expect(actor).toEqual({ agentId: "child-1", agentType: "eco_coder" });
    expect(await invoke("page.svg")).toEqual({});
    expect(await invoke("notes.txt")).toEqual({});
    supportsImageInput = true;
    expect(await invoke("renamed.dat")).toEqual({});
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("image admission checks nested tool results and avoids interpreting arguments as attachments", () => {
  const image = { type: "image", source: { type: "base64", data: "bytes" } };
  expect(containsImageInput({ messages: [{ content: [{ type: "tool_result", content: [image] }] }] })).toBe(
    true,
  );
  expect(containsImageInput({ tools: [{ input_schema: { type: "image" } }] })).toBe(false);
  expect(containsImageInput({ messages: [{ content: [{ type: "tool_use", input: image }] }] })).toBe(false);
  expect(() =>
    assertPiImageInputAllowed({ input: ["text"] }, [{ role: "toolResult", content: [image] }]),
  ).toThrow(IMAGE_READ_DISABLED_REASON);
});

test("Claude's image hook explicitly denies when the actor's model route is missing", async () => {
  const hook = createImageReadPreToolHook(() => {
    throw new Error("Missing coder route");
  });
  if (!hook) throw new Error("Image read hook is missing");
  expect(
    await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/tmp/pelican.png" },
        tool_use_id: "read",
        cwd: "/tmp",
        session_id: "session",
        transcript_path: "/tmp/transcript",
        agent_id: "child",
      },
      "read",
      { signal: new AbortController().signal },
    ),
  ).toMatchObject({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("Missing coder route"),
    },
  });
});

test("real PI session rejects native image reads and continues without sending image blocks", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "eco-pi-image-policy-"));
  const agentDir = path.join(workspace, "agent");
  await writeFile(path.join(workspace, "renamed.dat"), png);
  await writeFile(path.join(workspace, "page.txt"), "TEXT_READ_OK");
  const result = await runScriptedPiSession({
    workspace,
    agentDir,
    threadId: "thr_pi_image_policy",
    supportsImageInput: false,
    toolsAllowlist: ["read"],
    turns: [
      { tool: "read", id: "image-read", input: { path: "renamed.dat" } },
      { tool: "read", id: "text-read", input: { path: "page.txt" } },
      { text: "done" },
    ],
  });
  try {
    expect(result.requests).toHaveLength(3);
    expect(result.requests.some((request) => containsImageInput(request.messages))).toBe(false);
    expect(JSON.stringify(result.requests[1]?.messages)).toContain(IMAGE_READ_DISABLED_REASON);
    expect(JSON.stringify(result.requests[2]?.messages)).toContain("TEXT_READ_OK");
    expect(result.events.some((event) => event.type === "thread.failed")).toBe(false);
  } finally {
    await result.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
}, 30_000);
