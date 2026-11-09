import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScriptedPiSession } from "./pi-session-events-probe";

test("/compact uses real Pi compaction, persists its summary and never submits the command as user text", async () => {
  const workspace = await mkdtemp(
    path.join(process.platform === "win32" ? tmpdir() : "/tmp", "eco-pi-compact-"),
  );
  const result = await runScriptedPiSession({
    workspace,
    agentDir: path.join(workspace, "agent"),
    threadId: "pi_manual_compact",
    // Leave an older turn large enough for Pi's default retained tail to have a cut point.
    turns: [
      { text: "Earlier work details. ".repeat(8000) },
      { text: "Latest work." },
      { text: "Native compact summary." },
    ],
  });
  try {
    await result.runAgain();
    const events = await result.compact();
    expect(events.find((event) => event.type === "context.compaction.started")?.payload).toMatchObject({
      reason: "manual",
    });
    expect(events.find((event) => event.type === "context.compaction.completed")?.payload).toMatchObject({
      reason: "manual",
    });
    expect(events.find((event) => event.type === "run.terminal")?.payload).toEqual({ status: "completed" });
    expect(events.some((event) => event.type === "agent.settled")).toBe(false);
    expect(result.requests.length).toBe(3);
    expect(JSON.stringify(result.requests)).not.toContain("/compact");
    const captured = result.events.find((event) => event.type === "session.captured")?.payload as {
      sessionFile: string;
    };
    const entries = (await readFile(captured.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.find((entry) => entry.type === "compaction")?.summary).toContain(
      "Native compact summary.",
    );
    expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(
      2,
    );
  } finally {
    await result.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
}, 30_000);

test("Pi reports a short-session compaction failure without starting a conversation turn", async () => {
  const workspace = await mkdtemp(
    path.join(process.platform === "win32" ? tmpdir() : "/tmp", "eco-pi-compact-small-"),
  );
  const result = await runScriptedPiSession({
    workspace,
    agentDir: path.join(workspace, "agent"),
    threadId: "pi_compact_small",
    turns: [{ text: "Short response." }],
  });
  try {
    const events = await result.compact();
    expect(events.find((event) => event.type === "context.compaction.failed")?.payload).toMatchObject({
      reason: "manual",
    });
    expect(events.find((event) => event.type === "run.terminal")?.payload).toMatchObject({
      status: "failed",
    });
    expect(result.requests.length).toBe(1);
  } finally {
    await result.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
}, 30_000);
