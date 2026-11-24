import { execFileSync } from "node:child_process";
import path from "node:path";

const DEFAULT_CLI_PROBE_TIMEOUT_MS = 5_000;

/** Probe a native CLI with `--version`. Avoid `shell: true` on Windows — it breaks spaced paths like `Eco Coding`. */
export function probeCliVersionExecutable(
  executable: string,
  timeoutMs = DEFAULT_CLI_PROBE_TIMEOUT_MS,
): boolean {
  try {
    execFileSync(executable, ["--version"], {
      stdio: "ignore",
      timeout: timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

export function readCliVersionOutput(
  executable: string,
  timeoutMs = DEFAULT_CLI_PROBE_TIMEOUT_MS,
): string | undefined {
  try {
    const output = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
    });
    return (
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || undefined
    );
  } catch {
    return undefined;
  }
}

const CODEX_TARGETS: Readonly<Record<string, { packageName: string; triple: string }>> = {
  "darwin:arm64": {
    packageName: "@openai/codex-darwin-arm64",
    triple: "aarch64-apple-darwin",
  },
  "darwin:x64": {
    packageName: "@openai/codex-darwin-x64",
    triple: "x86_64-apple-darwin",
  },
  "linux:arm64": {
    packageName: "@openai/codex-linux-arm64",
    triple: "aarch64-unknown-linux-musl",
  },
  "linux:x64": {
    packageName: "@openai/codex-linux-x64",
    triple: "x86_64-unknown-linux-musl",
  },
  "win32:arm64": {
    packageName: "@openai/codex-win32-arm64",
    triple: "aarch64-pc-windows-msvc",
  },
  "win32:x64": {
    packageName: "@openai/codex-win32-x64",
    triple: "x86_64-pc-windows-msvc",
  },
};

const CLAUDE_TARGET_PACKAGES: Readonly<Record<string, string>> = {
  "darwin:arm64": "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  "darwin:x64": "@anthropic-ai/claude-agent-sdk-darwin-x64",
  "linux:arm64": "@anthropic-ai/claude-agent-sdk-linux-arm64",
  "linux:x64": "@anthropic-ai/claude-agent-sdk-linux-x64",
  "win32:arm64": "@anthropic-ai/claude-agent-sdk-win32-arm64",
  "win32:x64": "@anthropic-ai/claude-agent-sdk-win32-x64",
};

export function resolveDevClaudeExecutable(appPath: string): string | undefined {
  const packageName = CLAUDE_TARGET_PACKAGES[`${process.platform}:${process.arch}`];
  if (!packageName) return;
  return path.join(appPath, "node_modules", packageName, process.platform === "win32" ? "claude.exe" : "claude");
}

interface PackagedExecutableInput {
  resourcesPath: string | undefined;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function resolvePackagedCodexExecutableCandidate(input: PackagedExecutableInput): string | undefined {
  const resourcesPath = input.resourcesPath?.trim();
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const target = CODEX_TARGETS[`${platform}:${arch}`];
  if (!resourcesPath || !target) {
    return undefined;
  }
  return path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    target.packageName,
    "vendor",
    target.triple,
    "bin",
    platform === "win32" ? "codex.exe" : "codex",
  );
}

export function resolvePackagedClaudeExecutableCandidate(input: PackagedExecutableInput): string | undefined {
  const resourcesPath = input.resourcesPath?.trim();
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const packageName = CLAUDE_TARGET_PACKAGES[`${platform}:${arch}`];
  if (!resourcesPath || !packageName) {
    return undefined;
  }
  return path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    packageName,
    platform === "win32" ? "claude.exe" : "claude",
  );
}

export function readElectronResourcesPath(): string | undefined {
  const value = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof value === "string" ? value : undefined;
}
