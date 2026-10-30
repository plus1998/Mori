import fs from "node:fs/promises";
import path from "node:path";
import {
  ECO_SPAWN_AGENT_PRETOOL_SCRIPT,
  SPAWN_AGENT_HOOK_MATCHER,
  SPAWN_AGENT_HOOK_STATUS,
} from "./codex-spawn-agent-hook.js";

export interface SyncEcoCodexHooksInput {
  codexHomeDir: string;
  enableSpawnAgent?: boolean;
}

export interface SyncEcoCodexHooksResult {
  hooksPath: string;
  trustTomlBlock: string;
  spawn?: {
    scriptPath: string;
    trustKey: string;
    trustHash: string;
  };
}

/**
 * Merge Eco-managed Codex hooks into hooks.json and trust blocks.
 */
export async function syncEcoCodexHooks(input: SyncEcoCodexHooksInput): Promise<SyncEcoCodexHooksResult> {
  const enableSpawnAgent = input.enableSpawnAgent === true;
  if (!enableSpawnAgent) {
    throw new Error("syncEcoCodexHooks requires enableSpawnAgent.");
  }

  const hooksDir = path.join(input.codexHomeDir, "hooks");
  const hooksPath = path.join(input.codexHomeDir, "hooks.json");
  await fs.mkdir(hooksDir, { recursive: true });

  const hooksJson: {
    hooks: {
      PreToolUse?: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>;
    };
  } = { hooks: {} };

  const trustBlocks: string[] = [];
  let spawn: SyncEcoCodexHooksResult["spawn"];
  const preToolUseGroupIndex = 0;

  const scriptPath = path.join(hooksDir, "eco-spawn-agent-pretool.mjs");
  const command = `node ${JSON.stringify(scriptPath)}`;
  await writeUtf8FileIfChanged(scriptPath, ECO_SPAWN_AGENT_PRETOOL_SCRIPT);
  hooksJson.hooks.PreToolUse = [
    {
      matcher: SPAWN_AGENT_HOOK_MATCHER,
      hooks: [
        {
          type: "command",
          command,
          statusMessage: SPAWN_AGENT_HOOK_STATUS,
        },
      ],
    },
  ];
  const trustHash = await computeCodexCommandHookHash({
    eventName: "pre_tool_use",
    matcher: SPAWN_AGENT_HOOK_MATCHER,
    command,
    statusMessage: SPAWN_AGENT_HOOK_STATUS,
  });
  const trustKey = `${hooksPath}:pre_tool_use:${preToolUseGroupIndex}:0`;
  trustBlocks.push(
    "",
    `# Mori-managed trust for spawn_agent PreToolUse (fork_turns=none injection).`,
    `[hooks.state.${tomlKey(trustKey)}]`,
    `trusted_hash = ${JSON.stringify(trustHash)}`,
    "",
  );
  spawn = { scriptPath, trustKey, trustHash };

  await writeUtf8FileIfChanged(hooksPath, `${JSON.stringify(hooksJson, null, 2)}\n`);

  return {
    hooksPath,
    trustTomlBlock: trustBlocks.join("\n"),
    ...(spawn ? { spawn } : {}),
  };
}

export async function writeUtf8FileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if ((await fs.readFile(filePath, "utf8")) === content) {
      return;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  await fs.writeFile(filePath, content, "utf8");
}

/** Mirror codex-rs/config fingerprint::version_for_toml + hooks discovery::command_hook_hash. */
export async function computeCodexCommandHookHash(input: {
  eventName: "pre_tool_use" | "post_tool_use";
  matcher: string;
  command: string;
  statusMessage: string;
}): Promise<string> {
  const identity = {
    event_name: input.eventName,
    matcher: input.matcher,
    hooks: [
      {
        type: "command",
        command: input.command,
        timeout: 600,
        async: false,
        statusMessage: input.statusMessage,
      },
    ],
  };
  const canonical = canonicalJson(identity);
  const serialized = Buffer.from(JSON.stringify(canonical));
  const { createHash } = await import("node:crypto");
  const hex = createHash("sha256").update(serialized).digest("hex");
  return `sha256:${hex}`;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalJson(record[key]);
    }
    return sorted;
  }
  return value;
}

function tomlKey(key: string): string {
  return JSON.stringify(key);
}
