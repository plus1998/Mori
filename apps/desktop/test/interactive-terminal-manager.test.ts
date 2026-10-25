import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type PtyHandler = (data: string) => void;
type ExitHandler = (event: { exitCode: number; signal?: number }) => void;

interface MockPty {
  onData: ReturnType<typeof mock<(handler: PtyHandler) => void>>;
  onExit: ReturnType<typeof mock<(handler: ExitHandler) => void>>;
  write: ReturnType<typeof mock<(data: string) => void>>;
  resize: ReturnType<typeof mock<(cols: number, rows: number) => void>>;
  kill: ReturnType<typeof mock<() => void>>;
  emitData: (data: string) => void;
  emitExit: (exitCode: number, signal?: number) => void;
}

const spawned: MockPty[] = [];
const spawnRequests: Array<{ executable: string; args: string[]; cwd: string }> = [];
let dataHandler: PtyHandler | undefined;
let exitHandler: ExitHandler | undefined;

function createMockPty(): MockPty {
  const mockPty: MockPty = {
    onData: mock((handler: PtyHandler) => {
      dataHandler = handler;
    }),
    onExit: mock((handler: ExitHandler) => {
      exitHandler = handler;
    }),
    write: mock(() => undefined),
    resize: mock(() => undefined),
    kill: mock(() => undefined),
    emitData(data: string) {
      dataHandler?.(data);
    },
    emitExit(exitCode: number, signal?: number) {
      exitHandler?.({ exitCode, ...(signal !== undefined && { signal }) });
    },
  };
  spawned.push(mockPty);
  return mockPty;
}

function requireSpawned(index: number): MockPty {
  const value = spawned[index];
  if (!value) {
    throw new Error(`spawned pty ${index} missing`);
  }
  return value;
}

mock.module("node-pty", () => ({
  spawn: mock((executable: string, args: string[], options: { cwd: string }) => {
    spawnRequests.push({ executable, args, cwd: options.cwd });
    return createMockPty();
  }),
}));

const { InteractiveTerminalManager } = await import("../src/main/interactive-terminal-manager");

describe("InteractiveTerminalManager", () => {
  const workspaceRoot = join(tmpdir(), `eco-terminal-test-${Date.now()}`);
  const events: Array<{ type: string; sessionId: string; [key: string]: unknown }> = [];

  beforeEach(() => {
    events.length = 0;
    spawned.length = 0;
    spawnRequests.length = 0;
    dataHandler = undefined;
    exitHandler = undefined;
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("spawns a session in the workspace directory", () => {
    const manager = new InteractiveTerminalManager((event) => {
      events.push(event as { type: string; sessionId: string });
    }, { outputCoalesceMs: 0 });

    const result = manager.spawn(workspaceRoot, { cols: 100, rows: 24 });

    expect(result.sessionId).toBeTruthy();
    expect(spawned).toHaveLength(1);
    expect(manager.get(result.sessionId)?.workspacePath).toBe(workspaceRoot);
    expect(events).toEqual([{ type: "started", sessionId: result.sessionId, workspacePath: workspaceRoot }]);
  });

  test("rejects missing workspace directories", () => {
    const manager = new InteractiveTerminalManager(() => undefined, { outputCoalesceMs: 0 });
    const missingPath = join(workspaceRoot, "missing");

    expect(() => manager.spawn(missingPath)).toThrow(/does not exist/);
    expect(existsSync(missingPath)).toBe(false);
  });

  test("runs startup commands once in each new local shell and preserves the session", () => {
    const manager = new InteractiveTerminalManager(() => undefined, { outputCoalesceMs: 0 });
    const { sessionId } = manager.spawn(workspaceRoot, undefined, "nvm use 18\nexport APP_ENV=dev");
    const shell = requireSpawned(0);
    expect(shell.write.mock.calls).toEqual([["nvm use 18\rexport APP_ENV=dev\r"]]);
    expect(manager.get(sessionId)?.kind).toBe("local");
    manager.list(workspaceRoot);
    manager.resize(sessionId, 100, 24);
    expect(shell.write).toHaveBeenCalledTimes(1);
    manager.write(sessionId, "node -v\r");
    expect(shell.write).toHaveBeenLastCalledWith("node -v\r");
    manager.spawn(workspaceRoot, undefined, "nvm use 18");
    expect(requireSpawned(1).write).toHaveBeenCalledWith("nvm use 18\r");
  });

  test("empty startup commands and direct command/SSH sessions receive no injected input", () => {
    const manager = new InteractiveTerminalManager(() => undefined, { outputCoalesceMs: 0 });
    manager.spawn(workspaceRoot, undefined, " \n");
    manager.spawnCommand(workspaceRoot, ["ssh", "example.com"], { kind: "ssh" });
    manager.spawnCommand(workspaceRoot, ["npm", "run", "dev"]);
    for (const shell of spawned) expect(shell.write).not.toHaveBeenCalled();
  });

  test("invalid startup commands fail before spawning a PTY", () => {
    const manager = new InteractiveTerminalManager(() => undefined, { outputCoalesceMs: 0 });
    expect(() => manager.spawn(workspaceRoot, undefined, "echo ok\u0000")).toThrow(/control characters/);
    expect(spawned).toHaveLength(0);
  });

  test("spawns a command directly so its exit completes the session", () => {
    const manager = new InteractiveTerminalManager((event) => {
      events.push(event as { type: string; sessionId: string });
    }, { outputCoalesceMs: 0 });

    const { sessionId } = manager.spawnCommand(workspaceRoot, ["npm", "run", "build"]);
    requireSpawned(0).emitExit(0);

    if (process.platform === "win32") {
      expect(spawnRequests[0]?.executable.toLowerCase()).toContain("cmd.exe");
      expect(spawnRequests[0]?.args).toEqual(["/d", "/s", "/c", "npm run build"]);
    } else {
      expect(spawnRequests).toEqual([{ executable: "npm", args: ["run", "build"], cwd: workspaceRoot }]);
    }
    expect(events.at(-1)).toEqual({ type: "exit", sessionId, exitCode: 0 });
    expect(manager.get(sessionId)).toBeUndefined();
  });

  test("supports multiple concurrent sessions", () => {
    const manager = new InteractiveTerminalManager(() => undefined, { outputCoalesceMs: 0 });
    const first = manager.spawn(workspaceRoot);
    const second = manager.spawn(workspaceRoot);

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(spawned).toHaveLength(2);
    expect(manager.get(first.sessionId)?.sessionId).toBe(first.sessionId);
    expect(manager.get(second.sessionId)?.sessionId).toBe(second.sessionId);
    expect(manager.list(workspaceRoot)).toEqual([
      { sessionId: first.sessionId, workspacePath: workspaceRoot, kind: "local" },
      { sessionId: second.sessionId, workspacePath: workspaceRoot, kind: "local" },
    ]);
  });

  test("carries the SSH identity so a listed session can be re-labelled", () => {
    const manager = new InteractiveTerminalManager(() => undefined, { outputCoalesceMs: 0 });
    const { sessionId } = manager.spawnCommand(
      workspaceRoot,
      ["ssh", "prod.example.com"],
      { kind: "ssh", label: "Prod", endpoint: "root@prod.example.com" },
    );

    expect(manager.list(workspaceRoot)).toEqual([
      {
        sessionId,
        workspacePath: workspaceRoot,
        kind: "ssh",
        label: "Prod",
        endpoint: "root@prod.example.com",
      },
    ]);
  });

  test("writes input and resizes the active session", () => {
    const manager = new InteractiveTerminalManager(() => undefined, { outputCoalesceMs: 0 });
    const { sessionId } = manager.spawn(workspaceRoot);
    const activePty = requireSpawned(0);

    manager.write(sessionId, "ls\n");
    manager.resize(sessionId, 132, 40);

    expect(activePty.write).toHaveBeenCalledWith("ls\n");
    expect(activePty.resize).toHaveBeenCalledWith(132, 40);
  });

  test("emits output and exit events", () => {
    const manager = new InteractiveTerminalManager((event) => {
      events.push(event as { type: string; sessionId: string });
    }, { outputCoalesceMs: 0 });
    const { sessionId } = manager.spawn(workspaceRoot);
    const activePty = requireSpawned(0);

    activePty.emitData("hello");
    activePty.emitExit(0);

    expect(events).toEqual([
      { type: "started", sessionId, workspacePath: workspaceRoot },
      { type: "output", sessionId, data: "hello" },
      { type: "exit", sessionId, exitCode: 0 },
    ]);
    expect(manager.get(sessionId)).toBeUndefined();
  });

  test("coalesces rapid output chunks before emitting", async () => {
    const manager = new InteractiveTerminalManager((event) => {
      events.push(event as { type: string; sessionId: string });
    }, { outputCoalesceMs: 20 });
    const { sessionId } = manager.spawn(workspaceRoot);
    const activePty = requireSpawned(0);

    activePty.emitData("hel");
    activePty.emitData("lo");
    expect(events).toEqual([{ type: "started", sessionId, workspacePath: workspaceRoot }]);

    await Bun.sleep(40);

    expect(events).toEqual([
      { type: "started", sessionId, workspacePath: workspaceRoot },
      { type: "output", sessionId, data: "hello" },
    ]);
  });

  test("flushes pending coalesced output before exit", () => {
    const manager = new InteractiveTerminalManager((event) => {
      events.push(event as { type: string; sessionId: string });
    }, { outputCoalesceMs: 500 });
    const { sessionId } = manager.spawn(workspaceRoot);
    const activePty = requireSpawned(0);

    activePty.emitData("bye");
    activePty.emitExit(0);

    expect(events).toEqual([
      { type: "started", sessionId, workspacePath: workspaceRoot },
      { type: "output", sessionId, data: "bye" },
      { type: "exit", sessionId, exitCode: 0 },
    ]);
  });

  test("kill removes the active session", () => {
    const manager = new InteractiveTerminalManager(() => undefined, { outputCoalesceMs: 0 });
    const { sessionId } = manager.spawn(workspaceRoot);
    const activePty = requireSpawned(0);

    expect(manager.kill(sessionId)).toBe(true);
    expect(activePty.kill).toHaveBeenCalled();
    expect(manager.get(sessionId)).toBeUndefined();
    expect(manager.kill(sessionId)).toBe(false);
  });
});
