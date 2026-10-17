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

test("native session abort cancels the run even when the outer signal stays live", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "eco-pi-native-abort-"));
  const controller = new AbortController();
  let abortWork: Promise<void> | undefined;
  try {
    const result = await runScriptedPiSession({
      workspace,
      agentDir: path.join(workspace, "agent"),
      threadId: "thr_pi_native_abort",
      signal: controller.signal,
      toolsAllowlist: ["bash"],
      turns: [
        { tool: "bash", id: "native-stop", input: { command: "node -e 'setTimeout(() => {}, 20000)'" } },
        { text: "done" },
      ],
      onEvent: (event, abort) => {
        if (
          event.type === "tool.started" &&
          (event.payload as { input_complete?: boolean }).input_complete === true &&
          !abortWork
        )
          abortWork = abort();
      },
    });
    try {
      await abortWork;
      expect(abortWork).toBeDefined();
      expect(controller.signal.aborted).toBe(false);
      expect(result.turnCount).toBe(1);
      expect(result.events.find((event) => event.type === "agent.settled")?.payload).toMatchObject({
        aborted: true,
      });
      expect(
        result.events.filter((event) => event.type === "run.terminal").map((event) => event.payload),
      ).toEqual([{ status: "cancelled", reason: "cancelled by user" }]);
    } finally {
      await result.dispose();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}, 30_000);

test("malformed final tool arguments fail without executing their partially parsed command", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "eco-pi-invalid-arguments-"));
  const target = path.join(workspace, "must-not-exist");
  try {
    const result = await runScriptedPiSession({
      workspace,
      agentDir: path.join(workspace, "agent"),
      threadId: "thr_pi_invalid_arguments",
      toolsAllowlist: ["bash"],
      turns: [
        {
          tool: "bash",
          id: "invalid-json",
          rawArguments: `{"command":${JSON.stringify(`node -e 'require("fs").writeFileSync(${JSON.stringify(target)}, "unexpected")'`)},"extra":`,
        },
        { text: "done" },
      ],
    });
    try {
      expect(existsSync(target)).toBe(false);
      expect(
        result.events.find(
          (event) =>
            event.type === "tool.failed" &&
            (event.payload as { tool_use_id?: string }).tool_use_id === "invalid-json",
        ),
      ).toBeDefined();
      expect(
        result.events.some(
          (event) =>
            event.type === "tool.completed" &&
            (event.payload as { tool_use_id?: string }).tool_use_id === "invalid-json",
        ),
      ).toBe(false);
      expect(result.turnCount).toBe(2);
    } finally {
      await result.dispose();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}, 30_000);
