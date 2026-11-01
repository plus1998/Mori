import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TerminalStreamEvent } from "../src/shared/ipc";
import { BackgroundTerminalTaskRegistry } from "../src/main/background-terminal-tasks";
import type { InteractiveTerminalManager } from "../src/main/interactive-terminal-manager";
import { StartupScriptService } from "../src/main/startup-script-service";
import { createStartupScriptStore, type StartupScriptStore } from "../src/main/startup-script-store";
import {
  isStartupScriptChooseDirectoryRequest,
  isStartupScriptIdRequest,
  isStartupScriptSaveInput,
} from "../src/shared/ipc";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "mori-startup-scripts-"));
}

function createFakeTerminalManager() {
  let nextSession = 1;
  const starts: Array<{ workspacePath: string; command: string[] }> = [];
  const groupKills: string[] = [];
  const manager = {
    spawnCommand(
      workspacePath: string,
      command: readonly string[],
      _descriptor: unknown,
      _size: unknown,
      onSessionCreated?: (sessionId: string) => void,
    ) {
      starts.push({ workspacePath, command: [...command] });
      const sessionId = `session-${nextSession++}`;
      onSessionCreated?.(sessionId);
      return { sessionId };
    },
    killProcessGroup(sessionId: string) {
      groupKills.push(sessionId);
      return true;
    },
    kill() {
      return true;
    },
  } as unknown as InteractiveTerminalManager;
  return { manager, starts, groupKills };
}

async function openStore(directory: string): Promise<StartupScriptStore> {
  return createStartupScriptStore(path.join(directory, "eco-coding.sqlite"));
}

test("startup scripts keep stable IDs and creation order across edits and database reopen", async () => {
  const directory = await makeTempDir();
  let store = await openStore(directory);
  try {
    const first = store.save({
      name: "API",
      workspacePath: directory,
      command: "export PORT=5100\nbun run dev",
    });
    const second = store.save({ name: "Docs", workspacePath: directory, command: "bun run docs" });
    const updated = store.save({
      id: first.id,
      name: "API local",
      workspacePath: directory,
      command: "PORT=5101 bun run dev",
    });

    expect(updated.id).toBe(first.id);
    expect(updated.creationOrder).toBe(first.creationOrder);
    expect(store.list().map((script) => script.id)).toEqual([first.id, second.id]);
    expect(updated.command).toBe("PORT=5101 bun run dev");

    store.close();
    store = await openStore(directory);
    expect(store.list()).toEqual([updated, second]);
    store.delete(first.id);
    expect(store.list()).toEqual([second]);
    expect(() => store.delete(first.id)).toThrow("not found");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup script input guards reject invalid and non-ID start requests", () => {
  expect(
    isStartupScriptSaveInput({ name: "API", workspacePath: "/tmp", command: "bun run dev" }),
  ).toBe(true);
  expect(isStartupScriptSaveInput({ name: "API", command: "bun run dev" })).toBe(false);
  expect(isStartupScriptIdRequest({ id: "script-1" })).toBe(true);
  expect(isStartupScriptIdRequest({ id: "script-1", command: "echo unwanted payload" })).toBe(false);
  expect(isStartupScriptChooseDirectoryRequest({ defaultPath: "/tmp" })).toBe(true);
  expect(isStartupScriptChooseDirectoryRequest({ defaultPath: "/tmp", workspacePath: "/tmp" })).toBe(false);
});

test("startup script service validates IDs and directories, rejects duplicate runs, and preserves logs", async () => {
  const directory = await makeTempDir();
  const validDirectory = path.join(directory, "workspace");
  await mkdir(validDirectory);
  const store = await openStore(directory);
  const fakeTerminal = createFakeTerminalManager();
  const registry = new BackgroundTerminalTaskRegistry(fakeTerminal.manager);
  const service = new StartupScriptService(store, registry);

  try {
    await expect(service.start("missing-id")).rejects.toThrow("not found");

    const invalidDirectoryScript = store.save({
      name: "Missing folder",
      workspacePath: path.join(directory, "does-not-exist"),
      command: "echo should not run",
    });
    await expect(service.start(invalidDirectoryScript.id)).rejects.toThrow("ENOENT");
    expect(store.get(invalidDirectoryScript.id)).toEqual(invalidDirectoryScript);

    const multilineCommand = "export STARTUP_TEST=ready\nprintf '%s\\n' \"$STARTUP_TEST\"";
    const first = store.save({ name: "API", workspacePath: validDirectory, command: multilineCommand });
    const second = store.save({ name: "Worker", workspacePath: validDirectory, command: "bun run worker" });
    const firstTask = await service.start(first.id);
    expect(firstTask.startupScriptId).toBe(first.id);
    expect(fakeTerminal.starts[0]?.workspacePath).toBe(validDirectory);
    expect(fakeTerminal.starts[0]?.command.at(-1)).toContain(multilineCommand);
    await expect(service.start(first.id)).rejects.toThrow("already running");
    expect(service.list()).toEqual([invalidDirectoryScript, first, second]);
    expect(() => service.save({ ...first, name: "Changed" })).toThrow("Stop the startup script");
    expect(() => service.delete(first.id)).toThrow("Stop the startup script");

    const secondTask = await service.start(second.id);
    expect(secondTask.startupScriptId).toBe(second.id);
    expect(registry.list({ startupScriptId: first.id })).toHaveLength(1);
    expect(registry.list({ startupScriptId: second.id })).toHaveLength(1);

    const output: TerminalStreamEvent = { type: "output", sessionId: firstTask.sessionId, data: "ready\n" };
    registry.handleTerminalEvent(output);
    registry.handleTerminalEvent({ type: "exit", sessionId: secondTask.sessionId, exitCode: 7 });
    expect(registry.get(firstTask.taskId)?.output).toBe("ready\n");
    expect(registry.get(secondTask.taskId)).toMatchObject({ status: "failed", exitCode: 7 });

    const stopped = await registry.stop(firstTask.taskId);
    expect(stopped.stopped).toBe(true);
    expect(fakeTerminal.groupKills).toEqual([firstTask.sessionId]);
    expect(registry.get(firstTask.taskId)).toMatchObject({ status: "stopped", output: "ready\n" });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
