import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const supervisorUrl = pathToFileURL(join(import.meta.dir, "../scripts/dev-processes.mjs")).href;
const workers: ChildProcess[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.kill("SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function launch({ ignoreTerm = false, duringBuild = false, grandchild = false, quiet = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "eco-dev-processes-"));
  directories.push(directory);
  const marker = join(directory, "child-exited");
  const childCode = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(join(directory, "child-pid"))}, String(process.pid));
    process.on('uncaughtExceptionMonitor', (error) => {
      fs.writeFileSync(${JSON.stringify(join(directory, "child-error"))}, String(error));
    });
    process.on('SIGHUP', () => {});
    process.on('SIGTERM', () => {
      ${ignoreTerm ? "return;" : `
      console.info('shutdown log after terminal closes');
      process.stderr.write('direct stderr write during shutdown\\n');
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(marker)}, 'clean');
        process.exit(0);
      }, 100);`}
    });
    ${grandchild ? `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(`
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(join(directory, "grandchild-exited"))}, 'clean');
        process.exit(0);
      });
      console.log('READY');
      setInterval(() => {}, 1000);
    `)}]);
    descendant.stdout.pipe(process.stdout);
    ` : "console.log('READY');"}
    setInterval(() => { ${quiet ? "" : "console.log('still running');"} }, 30);
  `;
  const code = `
    import { createDevProcesses } from ${JSON.stringify(supervisorUrl)};
    const { start, run, fail } = createDevProcesses({ shutdownTimeoutMs: 300 });
    ${duringBuild ? "run" : "start"}(process.execPath, ['-e', ${JSON.stringify(childCode)}])${duringBuild ? ".catch(fail)" : ""};
  `;
  const worker = spawn("node", ["--input-type=module", "-e", code], { stdio: "pipe" });
  workers.push(worker);
  let output = "";
  let errors = "";
  worker.stderr!.on("data", (data) => { errors += data; });
  const ready = new Promise<void>((resolve) => {
    worker.stdout!.on("data", (data) => {
      output += data;
      if (output.includes("READY")) resolve();
    });
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("close", (code) => resolve(code));
  });
  return { worker, ready, exited, marker, directory, errors: () => errors, output: () => output };
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  test(`dev forwards ${signal} and waits for child cleanup and final logs`, async () => {
    const instance = launch();
    await instance.ready;
    instance.worker.kill(signal);
    expect(await instance.exited).toBe(0);
    expect(readFileSync(instance.marker, "utf8")).toBe("clean");
    expect(instance.output()).toContain("shutdown log after terminal closes");
    expect(instance.errors()).toBe("direct stderr write during shutdown\n");
  });
}

test("dev handles terminal loss during the initial build", async () => {
  const instance = launch({ duringBuild: true });
  await instance.ready;
  instance.worker.kill("SIGHUP");
  expect(await instance.exited).toBe(0);
  expect(readFileSync(instance.marker, "utf8")).toBe("clean");
  expect(instance.errors()).toBe("direct stderr write during shutdown\n");
});

test("dev stops children when the output reader disappears without a signal", async () => {
  const instance = launch();
  await instance.ready;
  instance.worker.stdout!.destroy();
  expect(await instance.exited).toBe(0);
  expect(readFileSync(instance.marker, "utf8")).toBe("clean");
  expect(instance.errors()).toBe("direct stderr write during shutdown\n");
});

test("dev kills a child that refuses to terminate", async () => {
  const instance = launch({ ignoreTerm: true });
  await instance.ready;
  instance.worker.kill("SIGHUP");
  expect(await instance.exited).toBe(0);
  expect(instance.errors()).toBe("");
});

for (const quiet of [false, true]) {
  test(`dev cleans up after the launcher is SIGKILLed (${quiet ? "idle" : "logging"} child)`, async () => {
    const instance = launch({ quiet });
    await instance.ready;
    instance.worker.kill("SIGKILL");
    await instance.exited;
    const deadline = Date.now() + 3_000;
    while (!existsSync(instance.marker) && Date.now() < deadline) await Bun.sleep(20);
    expect(readFileSync(instance.marker, "utf8")).toBe("clean");
    expect(existsSync(join(instance.directory, "child-error"))).toBe(false);
    const pid = Number(readFileSync(join(instance.directory, "child-pid"), "utf8"));
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        alive = false;
      }
      if (alive) await Bun.sleep(20);
    }
    expect(alive).toBe(false);
  });
}

test.skipIf(process.platform === "win32")("dev stops the build's descendant processes too", async () => {
  const instance = launch({ grandchild: true, duringBuild: true });
  await instance.ready;
  instance.worker.kill("SIGHUP");
  expect(await instance.exited).toBe(0);
  expect(readFileSync(instance.marker, "utf8")).toBe("clean");
  expect(readFileSync(join(instance.directory, "grandchild-exited"), "utf8")).toBe("clean");
  expect(instance.errors()).toBe("direct stderr write during shutdown\n");
});
