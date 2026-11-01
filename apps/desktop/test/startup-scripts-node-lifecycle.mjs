import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.versions.bun) {
  throw new Error("Run this PTY lifecycle check with Node, the desktop app runtime.");
}

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const buildDirectory = await mkdtemp(path.join(tmpdir(), "mori-startup-script-node-build-"));
const workDirectory = await mkdtemp(path.join(tmpdir(), "mori-startup-script-node-test-"));
const workspace = path.join(workDirectory, "workspace");
await mkdir(workspace);

try {
  const entryPath = path.join(buildDirectory, "entry.ts");
  const bundlePath = path.join(buildDirectory, "startup-scripts.cjs");
  await writeFile(
    entryPath,
    [
      `export { StartupScriptService } from ${JSON.stringify(path.join(appRoot, "src/main/startup-script-service.ts"))};`,
      `export { createStartupScriptStore } from ${JSON.stringify(path.join(appRoot, "src/main/startup-script-store.ts"))};`,
      `export { BackgroundTerminalTaskRegistry } from ${JSON.stringify(path.join(appRoot, "src/main/background-terminal-tasks.ts"))};`,
      `export { InteractiveTerminalManager } from ${JSON.stringify(path.join(appRoot, "src/main/interactive-terminal-manager.ts"))};`,
    ].join("\n"),
  );
  execFileSync(
    "bun",
    ["build", entryPath, "--target=node", "--format=cjs", "--external", "node-pty", "--outfile", bundlePath],
    { cwd: appRoot, stdio: "ignore" },
  );

  process.env.NODE_PATH = path.join(appRoot, "node_modules");
  Module._initPaths();
  const { BackgroundTerminalTaskRegistry, InteractiveTerminalManager, StartupScriptService, createStartupScriptStore } =
    Module.createRequire(import.meta.url)(bundlePath);
  const store = await createStartupScriptStore(path.join(workDirectory, "eco-coding.sqlite"));
  let registry;
  const terminalManager = new InteractiveTerminalManager(
    (event) => registry?.handleTerminalEvent(event),
    { outputCoalesceMs: 8 },
  );
  registry = new BackgroundTerminalTaskRegistry(terminalManager);
  const service = new StartupScriptService(store, registry);

  const createServerScript = async (fileName, responseBody) => {
    const filePath = path.join(workspace, fileName);
    await writeFile(
      filePath,
      `const http = require("node:http");\nprocess.on("SIGTERM", () => {});\nprocess.on("SIGHUP", () => {});\nconst server = http.createServer((_req, res) => res.end(${JSON.stringify(responseBody)}));\nserver.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port + ";PID=" + process.pid));\n`,
    );
    return store.save({
      name: fileName,
      workspacePath: workspace,
      command: `${quoteShellArg(process.execPath)} ${quoteShellArg(filePath)}${
        process.platform === "win32" ? " & " : "; "
      }echo finished`,
    });
  };

  const waitForServerOutput = async (taskId) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const task = registry.get(taskId);
      const match = task?.output?.match(/PORT=(\d+);PID=(\d+)/);
      if (match) return { port: Number(match[1]), pid: Number(match[2]) };
      if (task?.status === "failed" || task?.status === "exited") {
        throw new Error(`Startup script exited before listening: ${JSON.stringify(task)}`);
      }
      await delay(40);
    }
    throw new Error(`Startup script did not report its port: ${JSON.stringify(registry.get(taskId))}`);
  };

  const originalShell = process.env.SHELL;
  try {
    const scriptA = await createServerScript("service-a.cjs", "service-a");
    const scriptB = await createServerScript("service-b.cjs", "service-b");
    const availablePosixShells = ["/bin/bash", "/bin/zsh"].filter(existsSync);
    const shellA = process.platform === "win32" ? undefined : availablePosixShells[0];
    const shellB = process.platform === "win32" ? undefined : availablePosixShells.at(-1);
    if (shellA) process.env.SHELL = shellA;
    const taskA = await service.start(scriptA.id);
    const serverA = await waitForServerOutput(taskA.taskId);
    if (shellB) process.env.SHELL = shellB;
    const taskB = await service.start(scriptB.id);
    const serverB = await waitForServerOutput(taskB.taskId);

    if (process.platform !== "win32") {
      assert.equal(processGroupId(serverA.pid), terminalManager.get(taskA.sessionId).pty.pid);
      assert.equal(processGroupId(serverB.pid), terminalManager.get(taskB.sessionId).pty.pid);
    }
    assert.equal(await (await fetch(`http://127.0.0.1:${serverA.port}`)).text(), "service-a");
    assert.equal(await (await fetch(`http://127.0.0.1:${serverB.port}`)).text(), "service-b");
    assert.equal(registry.list({ startupScriptId: scriptA.id }).length, 1);
    assert.equal(registry.list({ startupScriptId: scriptB.id }).length, 1);

    assert.equal((await registry.stop(taskA.taskId)).stopped, true);
    await expectServerAndProcessClosed(serverA.port, serverA.pid);
    assert.equal(await (await fetch(`http://127.0.0.1:${serverB.port}`)).text(), "service-b");

    await registry.stopAllRunning();
    await expectServerAndProcessClosed(serverB.port, serverB.pid);
    console.log(
      `Node PTY lifecycle passed: concurrent services, ignored SIGTERM/SIGHUP, process-group stop, and shutdown cleanup${
        shellA && shellB ? ` (${shellA}, ${shellB})` : ""
      }.`,
    );
  } finally {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    await registry.stopAllRunning();
    terminalManager.killAll();
    store.close();
  }
} finally {
  await rm(buildDirectory, { recursive: true, force: true });
  await rm(workDirectory, { recursive: true, force: true });
}

function quoteShellArg(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function expectServerAndProcessClosed(port, pid) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    let portOpen = false;
    try {
      await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(350) });
      portOpen = true;
    } catch {}

    let processAlive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") processAlive = false;
      else throw error;
    }

    if (!portOpen && !processAlive) return;
    await delay(50);
  }
  throw new Error(`Startup script process or port stayed alive: port=${port}, pid=${pid}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupId(pid) {
  return Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
}
