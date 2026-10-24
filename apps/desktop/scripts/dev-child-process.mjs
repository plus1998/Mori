import { createDevProcesses } from "./dev-processes.mjs";

const [rawTimeout, command, ...args] = process.argv.slice(2);
if (!process.channel || !command) {
  throw new Error("Dev child supervisor requires a parent IPC channel and a command");
}

const { start, shutdown, fail } = createDevProcesses({
  shutdownTimeoutMs: Number(rawTimeout),
  superviseChildren: false,
});

// IPC disconnects even if the launcher is killed without receiving a signal.
// Keep the child's stdout/stderr readers alive until its cleanup finishes.
process.on("disconnect", () => shutdown());
if (!process.connected) {
  shutdown();
} else {
  try {
    const child = start(command, args);
    child.once("close", (code, signal) => shutdown(code ?? (signal ? 1 : 0)));
  } catch (error) {
    fail(error);
  }
}
