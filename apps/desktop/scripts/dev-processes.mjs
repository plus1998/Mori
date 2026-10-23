import { spawn } from "node:child_process";

/** Own child output and lifetime; a closed PTY must never reach Electron's console. */
export function createDevProcesses({ cwd = process.cwd(), shutdownTimeoutMs = 3_000 } = {}) {
  const children = new Set();
  let shuttingDown = false;

  // Register before the first build, since the terminal can close during startup.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => shutdown());
  }
  for (const [key, output] of [["stdout", process.stdout], ["stderr", process.stderr]]) {
    output.on("error", (error) => {
      if (error.code !== "EIO" && error.code !== "EPIPE") throw error;
      for (const child of children) {
        child[key].unpipe(output);
        child[key].resume();
      }
      shutdown();
    });
  }

  function start(command, args, options = {}) {
    if (shuttingDown) throw new Error("Dev is shutting down");
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      // A build may spawn its own processes. Own the Unix process group so
      // shutdown reaches those too, without killing the terminal's shell.
      detached: process.platform !== "win32",
      stdio: ["inherit", "pipe", "pipe"],
    });
    children.add(child);
    // Keep draining pipes until children exit, even after the terminal disappears.
    // Inheriting the PTY instead lets Electron throw write EIO during shutdown.
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.on("close", () => children.delete(child));
    child.on("error", fail);
    return child;
  }

  function run(command, args) {
    return new Promise((resolve, reject) => {
      const child = start(command, args);
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}`));
      });
    });
  }

  function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    const active = [...children];
    if (active.length === 0) {
      process.exit(exitCode);
    }
    const timeout = setTimeout(() => {
      for (const child of children) kill(child, "SIGKILL");
    }, shutdownTimeoutMs);
    Promise.all(active.map((child) => new Promise((resolve) => child.once("close", resolve))))
      .then(() => {
        clearTimeout(timeout);
        process.exit(exitCode);
      });
    for (const child of active) kill(child, "SIGTERM");
  }

  function kill(child, signal) {
    if (process.platform === "win32") return child.kill(signal);
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  function fail(error) {
    if (shuttingDown) return;
    console.error(error);
    shutdown(1);
  }

  return { start, run, shutdown, fail };
}
