import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScriptedPiSession } from "./pi-session-events-probe";

test("PI Stop terminates a quiet Bash child before it can write again", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "eco-pi-stop-"));
  const agentDir = path.join(workspace, "agent");
  const startedFile = path.join(workspace, "started");
  const finishedFile = path.join(workspace, "finished");
  const controller = new AbortController();
  const run = runScriptedPiSession({
    workspace,
    agentDir,
    threadId: "thr_pi_stop",
    signal: controller.signal,
    toolsAllowlist: ["bash"],
    turns: [
      {
        tool: "bash",
        id: "stop-bash",
        input: {
          command: `node -e 'require("fs").writeFileSync("${startedFile}", "started"); setTimeout(() => require("fs").writeFileSync("${finishedFile}", "finished"), 2500)'`,
        },
      },
      { text: "done" },
    ],
  });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(startedFile) && Date.now() < deadline) await Bun.sleep(25);
    expect(existsSync(startedFile)).toBe(true);
    const stoppedAt = Date.now();
    controller.abort("cancelled by user");
    const result = await run;
    try {
      const elapsedMs = Date.now() - stoppedAt;
      console.log(`Native PI Bash Stop settled in ${elapsedMs}ms`);
      expect(elapsedMs).toBeLessThan(1500);
      await Bun.sleep(2700);
      expect(existsSync(finishedFile)).toBe(false);
      expect(result.turnCount).toBe(1);
      expect(
        result.events.some(
          (event) =>
            event.type === "run.terminal" && (event.payload as { status?: string }).status === "cancelled",
        ),
      ).toBe(true);
    } finally {
      await result.dispose();
    }
  } finally {
    controller.abort("test cleanup");
    rmSync(workspace, { recursive: true, force: true });
  }
}, 30_000);
