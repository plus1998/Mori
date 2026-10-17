import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentEvent } from "../src";
import { runScriptedPiSession } from "./pi-session-events-probe";

function nodeChildCommand(workspace: string, script: string): string {
  const target = path.join(workspace, "stop-child.cjs");
  writeFileSync(target, script);
  // Keep JavaScript out of the shell argument parser, including Git Bash on Windows.
  return `node '${target.replace(/\\/g, "/")}'`;
}

function windowsProcessDiagnostics(): string {
  if (process.platform !== "win32") return "";
  const probe = spawnSync(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*eco-pi-*' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  return `Windows child processes: ${probe.stdout || probe.stderr || probe.error?.message || "none"}`;
}

/** Call after session disposal; Windows can briefly retain a terminated child's cwd handle. */
async function removeWorkspace(workspace: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await rm(workspace, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "") ||
        Date.now() >= deadline
      )
        throw new Error(`${String(error)}\n${windowsProcessDiagnostics()}`, { cause: error });
      // Do not swallow persistent locks: a child that outlives disposal must still fail CI.
      await Bun.sleep(50);
    }
  }
}

test("cancelling during the cwd check never spawns a shell", async () => {
  const { createLocalShellOperations } = await import(
    new URL("./core/tools/bash.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
  );
  let spawnAttempted = false;
  const operations = createLocalShellOperations("bash", () => ({
    get shell() {
      spawnAttempted = true;
      throw new Error("cancelled operation attempted to spawn a shell");
    },
    args: ["-c"],
  }));
  const controller = new AbortController();
  const running = operations.exec("must not execute", tmpdir(), {
    signal: controller.signal,
    onData: () => {},
  });
  // exec has entered fs.access but has not yet resumed to spawn the shell.
  controller.abort("cancelled during cwd check");
  await expect(running).rejects.toThrow("aborted");
  expect(spawnAttempted).toBe(false);
});

test("PI Stop terminates a quiet Bash child before it can write again", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "eco-pi-stop-"));
  const agentDir = path.join(workspace, "agent");
  const startedFile = path.join(workspace, "started");
  const finishedFile = path.join(workspace, "finished");
  const controller = new AbortController();
  const events: AgentEvent[] = [];
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
          command: nodeChildCommand(
            workspace,
            `require("fs").writeFileSync(${JSON.stringify(startedFile)}, "started"); setTimeout(() => require("fs").writeFileSync(${JSON.stringify(finishedFile)}, "finished"), 2500);`,
          ),
        },
      },
      { text: "done" },
    ],
    onEvent: (event) => events.push(event),
  });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(startedFile) && Date.now() < deadline) await Bun.sleep(25);
    expect(
      existsSync(startedFile),
      existsSync(startedFile)
        ? undefined
        : `PI Bash child did not start. Events: ${JSON.stringify(events.filter((event) => event.type.startsWith("tool.") || event.type === "run.terminal"))}\n${windowsProcessDiagnostics()}`,
    ).toBe(true);
    const stoppedAt = Date.now();
    controller.abort("cancelled by user");
    const result = await run;
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
    controller.abort("test cleanup");
    try {
      // Also settle and dispose when the startup or Stop assertions fail.
      await (await run).dispose();
    } finally {
      await removeWorkspace(workspace);
    }
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
        {
          tool: "bash",
          id: "native-stop",
          input: { command: nodeChildCommand(workspace, "setTimeout(() => {}, 20000);") },
        },
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
    await removeWorkspace(workspace);
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
    await removeWorkspace(workspace);
  }
}, 30_000);
