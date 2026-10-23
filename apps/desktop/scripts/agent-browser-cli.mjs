/**
 * Spawn agent-browser native CLI (bypasses MCP stdio — reliable on Windows).
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.join(scriptsDir, "..");

function isMuslLinux() {
  if (platform() !== "linux") {
    return false;
  }
  try {
    const result = execSync("ldd --version 2>&1 || true", { encoding: "utf8" });
    return result.toLowerCase().includes("musl");
  } catch {
    return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1");
  }
}

function nativeBinaryName() {
  const os = platform();
  const cpu = arch();
  let osKey;
  switch (os) {
    case "darwin":
      osKey = "darwin";
      break;
    case "linux":
      osKey = isMuslLinux() ? "linux-musl" : "linux";
      break;
    case "win32":
      osKey = "win32";
      break;
    default:
      return null;
  }
  let archKey;
  switch (cpu) {
    case "x64":
    case "x86_64":
      archKey = "x64";
      break;
    case "arm64":
    case "aarch64":
      archKey = "arm64";
      break;
    default:
      return null;
  }
  const ext = os === "win32" ? ".exe" : "";
  return `agent-browser-${osKey}-${archKey}${ext}`;
}

export function resolveAgentBrowserCliPath(cwd = desktopRoot) {
  const wrapper = path.join(cwd, "node_modules", "agent-browser", "bin", "agent-browser.js");
  if (existsSync(wrapper)) {
    return { kind: "node-wrapper", path: wrapper };
  }
  const name = nativeBinaryName();
  if (!name) {
    return { kind: "missing", path: null, reason: `unsupported platform ${platform()}-${arch()}` };
  }
  const native = path.join(cwd, "node_modules", "agent-browser", "bin", name);
  if (existsSync(native)) {
    return { kind: "native", path: native };
  }
  return { kind: "missing", path: null, reason: `agent-browser binary not found (${name})` };
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @param {{ cwd?: string; timeoutMs?: number }} [options]
 */
export function runAgentBrowser(args, extraEnv = {}, options = {}) {
  const cwd = options.cwd ?? desktopRoot;
  const resolved = resolveAgentBrowserCliPath(cwd);
  if (resolved.kind === "missing") {
    return {
      ok: false,
      status: 127,
      stdout: "",
      stderr: resolved.reason ?? "agent-browser not found",
    };
  }

  const env = {
    ...process.env,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "300000",
    ...extraEnv,
  };

  const spawnArgs = resolved.kind === "node-wrapper" ? [resolved.path, ...args] : args;
  const command = resolved.kind === "node-wrapper" ? process.execPath : resolved.path;

  const run = spawnSync(command, spawnArgs, {
    cwd,
    env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });

  return {
    ok: run.status === 0,
    status: run.status ?? 1,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
  };
}
