import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { globalPiBashTaskRegistry, PiBashTaskRegistry } from "../src/pi-bash-tasks";
import { runScriptedPiSession } from "./pi-session-events-probe";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(get: () => T | Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await get();
    if (value) return value as NonNullable<T>;
    await sleep(20);
  }
  throw new Error("PI Bash test timed out");
}

test("PI cancels only the selected execution and rejects cross-thread task IDs", async () => {
  const registry = new PiBashTaskRegistry();
  const run = (threadId: string) =>
    registry.execute(
      { threadId, workspacePath: "/tmp", label: threadId },
      (signal) =>
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    );
  const first = run("first");
  const second = run("second");
  const [firstTask, secondTask] = registry.list();
  if (!firstTask || !secondTask) throw new Error("Both PI tasks must be registered.");
  try {
    expect(await registry.stop("second", firstTask.taskId)).toEqual({ stopped: false });
    expect(await registry.stop("first", firstTask.taskId)).toEqual({ stopped: true });
    await first;
    expect(registry.list().map((t) => t.threadId)).toEqual(["second"]);
  } finally {
    await registry.stop("second", secondTask.taskId);
    await second;
  }
});

test("real PI session lists Bash, kills its process tree, then executes the next tool", async () => {
  const root = await mkdtemp("/tmp/mori-pi-bash-test-");
  const pidFile = path.join(root, "pids");
  const marker = path.join(root, "continued");
  const threadId = path.basename(root);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const running = runScriptedPiSession({
    workspace: root,
    agentDir: path.join(root, "agent"),
    threadId,
    signal: controller.signal,
    toolsAllowlist: ["bash"],
    turns: [
      {
        tool: "bash",
        id: "first_bash",
        input: {
          command: `printf 'shell=%s\\n' "$$" > '${pidFile}'; sleep 60 & child=$!; printf 'child=%s\\n' "$child" >> '${pidFile}'; wait "$child"`,
        },
      },
      { tool: "bash", id: "second_bash", input: { command: `printf continued > '${marker}'` } },
      { text: "done after single Bash stop" },
    ],
  });
  let result: Awaited<typeof running> | undefined;
  // Attach an error handler immediately while polling the real running tool.
  void running.catch(() => {});
  try {
    const task = await until(() => globalPiBashTaskRegistry.list().find((t) => t.threadId === threadId));
    const pids = await until(async () => {
      try {
        const text = await readFile(pidFile, "utf8");
        const ids = [...text.matchAll(/=(\d+)/g)].map((m) => Number(m[1]));
        return ids.length === 2 ? ids : undefined;
      } catch {
        return undefined;
      }
    });
    expect(await globalPiBashTaskRegistry.stop(threadId, task.taskId)).toEqual({ stopped: true });
    await until(() =>
      pids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw error;
        }
      }),
    );
    result = await running;
    expect(await readFile(marker, "utf8")).toBe("continued");
    expect(result.turnCount).toBe(3);
    expect(controller.signal.aborted).toBe(false);
    expect(globalPiBashTaskRegistry.list().filter((t) => t.threadId === threadId)).toEqual([]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    result ??= await running.catch(() => undefined);
    await result?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
