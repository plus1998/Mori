import { expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import {
  assertAcpCursorRunnable,
  handshakeAcpCursor,
  intersectCursorAcpModelLists,
  listCursorAcpModels,
  probeAcpCursorAvailability,
  reconcileAcpCursorEnabled,
} from "../src/main/acp-cursor-availability";

test("probe fails when executable missing", async () => {
  const result = await probeAcpCursorAvailability({
    resolveExecutable: () => "/missing/agent",
    executableExists: () => false,
    handshake: async () => {},
  });
  expect(result).toEqual({ available: false, reasonKey: "missingCli" });
});

test("probe fails when handshake throws", async () => {
  const result = await probeAcpCursorAvailability({
    resolveExecutable: () => "/bin/agent",
    executableExists: () => true,
    handshake: async () => {
      throw new Error("initialize timeout");
    },
  });
  expect(result.available).toBe(false);
  if (!result.available) {
    expect(result.reasonKey).toBe("handshakeFailed");
    expect(result.detail).toContain("initialize timeout");
  }
});

test("probe succeeds when handshake completes", async () => {
  let called = false;
  const result = await probeAcpCursorAvailability({
    resolveExecutable: () => "/bin/agent",
    executableExists: () => true,
    handshake: async () => {
      called = true;
    },
  });
  expect(called).toBe(true);
  expect(result).toEqual({ available: true });
});

test("reconcile clears enabled and falls back default core from acp", () => {
  expect(
    reconcileAcpCursorEnabled({
      acpCursorEnabled: true,
      defaultCoreKind: "acp",
      probe: { available: false, reasonKey: "missingCli" },
    }),
  ).toEqual({ acpCursorEnabled: false, defaultCoreKind: "claude" });
});

test("reconcile no-op when healthy", () => {
  expect(
    reconcileAcpCursorEnabled({
      acpCursorEnabled: true,
      defaultCoreKind: "acp",
      probe: { available: true },
    }),
  ).toBeUndefined();
});

test("probe maps spawn ENOENT (Cursor not installed) to missingCli without crashing", async () => {
  const fakeChild = new EventEmitter() as ChildProcess;
  fakeChild.stdin = new PassThrough() as unknown as ChildProcess["stdin"];
  fakeChild.stdout = new PassThrough() as unknown as ChildProcess["stdout"];

  const spawnFn = ((_cmd: string, _args: readonly string[], _opts: SpawnOptions) => {
    // Real child_process delivers ENOENT asynchronously on the `error` event.
    setImmediate(() => {
      fakeChild.emit("error", Object.assign(new Error("spawn agent ENOENT"), { code: "ENOENT" }));
    });
    return fakeChild;
  }) as typeof import("node:child_process").spawn;

  const result = await probeAcpCursorAvailability({
    // Cursor absent: resolver falls back to bare "agent" (not path-like), so
    // the probe must rely on the handshake failing cleanly with ENOENT.
    resolveExecutable: () => "agent",
    executableExists: () => false,
    handshake: () => handshakeAcpCursor({ spawnFn }),
  });

  expect(result).toMatchObject({ available: false, reasonKey: "missingCli" });
  if (!result.available) {
    expect(result.detail).toContain("ENOENT");
  }
});

test("catalog probe reads ACP wire IDs and cleans up without prompting", async () => {
  const methods: string[] = [];
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  child.stdin = stdin as unknown as ChildProcess["stdin"];
  child.stdout = stdout as unknown as ChildProcess["stdout"];
  const rl = createInterface({ input: stdin });
  const modelId = "composer-2.5[fast=true]";
  let probeCwd: string | undefined;
  rl.on("line", (line) => {
    const request = JSON.parse(line);
    methods.push(request.method);
    if (request.id === undefined) return;
    const reply = (result: object) => stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    if (request.method === "initialize") {
      reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: {} } } });
    } else if (request.method === "session/new") {
      probeCwd = request.params.cwd;
      reply({ sessionId: "probe", models: { currentModelId: modelId, availableModels: [
        { modelId: "default[]", name: "Auto" },
        { modelId, name: "Composer" },
      ] } });
    } else if (request.method === "session/delete") {
      reply({});
    }
  });
  try {
    const models = await listCursorAcpModels({
      resolveExecutable: () => "agent",
      env: { CURSOR_API_KEY: "catalog-test" },
      spawnFn: (_command, args, options) => {
        expect(args).toEqual(["acp"]);
        expect(options.env?.CURSOR_API_KEY).toBe("catalog-test");
        return child;
      },
    });
    expect(methods).toEqual(["initialize", "notifications/initialized", "session/new", "session/delete"]);
    expect(probeCwd).toBeDefined();
    expect(existsSync(probeCwd!)).toBe(false);
    expect(models).toEqual([
      { id: "default[]", displayName: "Auto", current: false, default: true },
      { id: modelId, displayName: "Composer", current: true, default: false },
    ]);
    expect(intersectCursorAcpModelLists([models, [{ ...models[0]!, current: true }]])).toEqual([models[0]!]);
  } finally {
    rl.close();
    stdin.destroy();
    stdout.destroy();
  }
});

test("assertAcpCursorRunnable throws when probe unavailable", () => {
  expect(() =>
    assertAcpCursorRunnable({
      probe: { available: false, reasonKey: "missingCli" },
      unavailableMessage: "unavailable",
    }),
  ).toThrow("unavailable");
});

test("assertAcpCursorRunnable allows when probe available (legacy switch ignored)", () => {
  expect(() =>
    assertAcpCursorRunnable({
      probe: { available: true },
      unavailableMessage: "unavailable",
    }),
  ).not.toThrow();
});
