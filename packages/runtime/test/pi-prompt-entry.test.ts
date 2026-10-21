import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runScriptedPiSession } from "./pi-session-events-probe";

test("real Pi driver binds identical successive prompts to their own persisted entry IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eco-pi-prompt-entry-"));
  const result = await runScriptedPiSession({
    workspace: root,
    agentDir: path.join(root, "agent"),
    threadId: "pi-prompt-entry",
    promptActivityLineId: "local-prompt-1",
    turns: [{ text: "answer" }],
  });
  try {
    const first = result.events.find((event) => event.type === "file.checkpoint");
    expect(first?.payload).toMatchObject({ source: "pi", activityLineId: "local-prompt-1" });
    const next = await result.runAgain(undefined, "local-prompt-2");
    const second = next.find((event) => event.type === "file.checkpoint");
    expect(second?.payload).toMatchObject({ source: "pi", activityLineId: "local-prompt-2" });
    const one = first?.payload as { userMessageId: string };
    const two = second?.payload as { userMessageId: string };
    expect(one.userMessageId).not.toBe(two.userMessageId);
    const captured = result.events.find((event) => event.type === "session.captured")?.payload as {
      sessionFile: string;
    };
    const rows = (await readFile(captured.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.find((row) => row.id === one.userMessageId)?.message.role).toBe("user");
    expect(rows.find((row) => row.id === two.userMessageId)?.message.role).toBe("user");
  } finally {
    await result.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("missing Pi resume history fails before contacting the model instead of starting an empty session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eco-pi-missing-resume-"));
  try {
    await expect(
      runScriptedPiSession({
        workspace: root,
        agentDir: path.join(root, "agent"),
        threadId: "pi-missing-resume",
        sessionFile: path.join(root, "agent", "sessions", "missing.jsonl"),
        turns: [{ text: "must not run" }],
      }),
    ).rejects.toThrow("无法恢复指定的会话文件");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
