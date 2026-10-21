import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);

// Windows resolves `flutter` through PATHEXT, which only happens with a shell:
// spawning the bare name raises ENOENT and spawning `flutter.bat` raises EINVAL.
const flutterNeedsShell = process.platform === "win32";

const smokeScripts = {
  "agent-ui": ["apps/desktop/scripts/agent-ui-smoke.mjs", { build: true }],
  "feed-loading": ["apps/desktop/e2e/feed-loading.spec.ts"],
  "subagent-drawer": ["apps/desktop/e2e/subagent-drawer.spec.ts"],
  "codex-approval": ["apps/desktop/e2e/codex-approval.spec.ts"],
  "codex-capabilities": ["apps/desktop/e2e/codex-capabilities.spec.ts"],
  "codex-multi-agent": ["apps/desktop/e2e/codex-multi-agent.spec.ts"],
  "codex-session-modes": ["apps/desktop/e2e/codex-session-modes.spec.ts"],
  "browser-webview": ["apps/desktop/e2e/browser-webview.spec.ts"],
};

const testSuites = {
  "agent-presets": [
    "apps/desktop/test/agent-orchestration.test.ts",
    "packages/runtime/test/agent-orchestration.test.ts",
    "packages/runtime/test/eco-sdk-hooks.test.ts",
  ],
  "agent-security": [
    "packages/runtime/test/agent-permission-redteam.test.ts",
    "packages/runtime/test/eco-sdk-hooks.test.ts",
  ],
  "agent-commercial": [
    "apps/desktop/test/orchestration-readiness.test.ts",
    "apps/desktop/test/agent-template-archive.test.ts",
    "apps/desktop/test/billing-diagnostics.test.ts",
    "apps/desktop/test/billing-projector.test.ts",
    "apps/desktop/test/usage-ledger-coordinator.test.ts",
    "apps/desktop/test/conversation-v2-projection-view.test.ts",
    "apps/desktop/test/usage-breakdown-panel.test.ts",
    "packages/runtime/test/agent-orchestration.test.ts",
    "packages/runtime/test/agent-permission-redteam.test.ts",
    "packages/runtime/test/eco-sdk-hooks.test.ts",
  ],
  "claude-regression": [
    "packages/runtime/test/core-runtime.test.ts",
    "packages/runtime/test/claude-agent-sdk.test.ts",
    "packages/runtime/test/claude-sdk-0289-regression.test.ts",
    "packages/runtime/test/claude-sdk-0301-regression.test.ts",
    "packages/runtime/test/claude-sdk-native-smoke.test.ts",
    "packages/runtime/test/claude-subagent-compaction.test.ts",
    "packages/runtime/test/claude-subagent-compaction-native.test.ts",
    "packages/runtime/test/eco-sdk-hooks.test.ts",
    "packages/runtime/test/sdk-stream-events.test.ts",
    "packages/runtime/test/agent-orchestration.test.ts",
    "packages/runtime/test/agent-permission-redteam.test.ts",
    "packages/runtime/test/tool-confirmation.test.ts",
    "packages/runtime/test/tool-permission-policy.test.ts",
    "packages/runtime/test/filesystem-scope-policy.test.ts",
    "apps/desktop/test/thread-core-routing.test.ts",
    "apps/desktop/test/thread-live-follow-up-v2-sdk-surface.test.ts",
    "apps/desktop/test/claude-mid-turn-port.test.ts",
    "apps/desktop/test/codex-mid-turn-port.test.ts",
    "packages/runtime/test/codex-turn-steer.test.ts",
    "packages/runtime/test/codex-turn-interrupt.test.ts",
    "apps/desktop/test/anthropic-proxy.test.ts",
    "apps/desktop/test/bash-approval-bridge.test.ts",
    "apps/desktop/test/bash-approval-ui.test.ts",
    "apps/desktop/test/sdk-stream-activity.test.ts",
    "apps/desktop/test/sdk-stream-activity-ingestion.test.ts",
    "apps/desktop/test/conversation-v2-legacy-adapter.test.ts",
    "apps/desktop/test/conversation-v2-activity-merge.test.ts",
    "apps/desktop/test/feed-action-kind.test.ts",
    "apps/desktop/test/claude-user-message-rebind.test.ts",
    "apps/desktop/test/claude-resume-decision.test.ts",
    "apps/desktop/test/plan-approval-bridge.test.ts",
    "apps/desktop/test/thread-plan-approval-runtime.test.ts",
    "apps/desktop/test/thread-continue-routing.test.ts",
    "apps/desktop/test/sdk-run-input.test.ts",
    "apps/desktop/test/conversation-store-runtime.test.ts",
    "apps/desktop/test/conversation-v2-runtime-projection.test.ts",
    "apps/desktop/test/legacy-feed-replay-projection.test.ts",
    "apps/desktop/test/conversation-round-replay.test.ts",
    "apps/desktop/test/sdk-round-replay.test.ts",
    "apps/desktop/test/proxy-usage-billing.test.ts",
    "apps/desktop/test/usage-ledger-coordinator.test.ts",
    "apps/desktop/test/sdk-session-usage-ledger.test.ts",
    "apps/desktop/test/context-snapshot-scheduler.test.ts",
  ],
};

const parsed = parseArgs(args);
const command = resolveCommand(parsed);
if (!command) {
  printUsage();
  process.exitCode = 1;
} else {
  process.exitCode = await run(command);
}

function parseArgs(argv) {
  const options = new Set();
  const passthrough = [];
  const controlOptions = new Set([
    "help",
    "h",
    "smoke",
    "sqlite",
    "mobile",
    "no-mobile",
    ...Object.keys(smokeScripts),
    ...Object.keys(testSuites),
  ]);
  for (const arg of argv) {
    const option = arg.startsWith("--") ? arg.slice(2) : "";
    if (controlOptions.has(option)) {
      options.add(option);
    } else {
      passthrough.push(arg);
    }
  }
  for (const option of controlOptions) {
    const envName = `npm_config_${option.replaceAll("-", "_")}`;
    if (process.env[envName] === "true") {
      options.add(option);
    }
  }
  return { options, passthrough };
}

function resolveCommand({ options, passthrough }) {
  if (options.has("help") || options.has("h")) return { kind: "help" };

  const smoke = [...options].find((option) => Object.hasOwn(smokeScripts, option));
  if (options.has("smoke") || smoke) {
    if (!smoke) {
      throwUsageError("缺少 smoke 类型，例如 --smoke --feed-loading。");
    }
    const [script, config] = smokeScripts[smoke];
    const commands = [];
    if (config?.build) {
      commands.push(["bun", "run", "--cwd", "apps/desktop", "build"]);
    }
    if (script.endsWith(".spec.ts")) {
      commands.push([
        "bun",
        "run",
        "--cwd",
        "apps/desktop",
        "test:e2e",
        "--",
        script.replace(/^apps\/desktop\//, ""),
        ...passthrough,
      ]);
    } else {
      commands.push(["node", script, ...passthrough]);
    }
    return { kind: "commands", commands };
  }

  const suite = [...options].find((option) => Object.hasOwn(testSuites, option));
  if (suite) {
    const commands = [
      ["bun", "test", ...bunTestConcurrencyArgs(passthrough), ...testSuites[suite], ...passthrough],
    ];
    if (suite === "claude-regression") {
      commands.push([process.execPath, "scripts/test-node-sqlite.mjs", ...passthrough]);
    }
    return { kind: "commands", commands };
  }

  if (options.has("sqlite")) {
    return { kind: "commands", commands: [["node", "scripts/test-node-sqlite.mjs", ...passthrough]] };
  }

  // Flutter (apps/mobile) is a separate toolchain from bun, so it has its own
  // entry point instead of living inside the `bun test` glob. `--mobile` runs it
  // alone; the default run includes it so the mobile suite cannot rot unseen.
  if (options.has("mobile")) {
    return { kind: "commands", commands: [mobileTestCommand(passthrough)] };
  }
  if (options.has("no-mobile")) {
    const unknownOptions = [...options].filter((option) => option !== "no-mobile");
    if (unknownOptions.length > 0) {
      throwUsageError(`未知参数：${unknownOptions.map((option) => `--${option}`).join(" ")}`);
    }
    return {
      kind: "commands",
      commands: [
        [
          "bun",
          "test",
          ...bunTestConcurrencyArgs(passthrough),
          "--path-ignore-patterns=apps/desktop/e2e/**",
          ...passthrough,
        ],
      ],
    };
  }

  if (options.size > 0) {
    throwUsageError(`未知参数：${[...options].map((option) => `--${option}`).join(" ")}`);
  }
  return {
    kind: "commands",
    commands: [
      [
        "bun",
        "test",
        ...bunTestConcurrencyArgs(passthrough),
        "--path-ignore-patterns=apps/desktop/e2e/**",
        ...passthrough,
      ],
      mobileTestCommand([]),
    ],
  };
}

function bunTestConcurrencyArgs(passthroughArgs) {
  const hasOption = (name) => passthroughArgs.some((arg) => arg === name || arg.startsWith(`${name}=`));
  return [
    ...(hasOption("--parallel") ? [] : ["--parallel=2"]),
    ...(hasOption("--max-concurrency") ? [] : ["--max-concurrency=1"]),
  ];
}

/** `flutter test` for apps/mobile, portable across POSIX and Windows shells. */
function mobileTestCommand(passthroughArgs) {
  return {
    argv: ["flutter", "test", ...passthroughArgs],
    cwd: join(root, "apps", "mobile"),
    shell: flutterNeedsShell,
  };
}

async function run(command) {
  if (command.kind === "help") {
    printUsage();
    return 0;
  }

  // Run every step before reporting: a red bun suite on one platform must not
  // hide whether the Flutter suite (or a later smoke step) is also red.
  let exitCode = 0;
  for (const argv of command.commands) {
    const code = await spawnCommand(argv);
    if (code !== 0 && exitCode === 0) exitCode = code;
  }
  return exitCode;
}

function spawnCommand(command) {
  const { argv, cwd, shell } = Array.isArray(command)
    ? { argv: command, cwd: root, shell: undefined }
    : { argv: command.argv, cwd: command.cwd ?? root, shell: command.shell };
  return new Promise((resolve, reject) => {
    // With shell: true Node concatenates args unescaped (and warns about it), so
    // pass a single pre-quoted command string rather than an argv array.
    const child = shell
      ? spawn(argv.map(quoteShellArg).join(" "), {
          cwd,
          env: process.env,
          stdio: "inherit",
          shell: true,
        })
      : spawn(argv[0], argv.slice(1), { cwd, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  }).catch((error) => {
    console.error(`无法执行 ${argv.join(" ")}：${error.message}`);
    return 1;
  });
}

function quoteShellArg(value) {
  return /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function throwUsageError(message) {
  console.error(message);
  printUsage();
  process.exit(1);
}

function printUsage() {
  console.log(`用法：
  npm run test
  npm run test -- --mobile
  npm run test -- --no-mobile
  npm run test -- --smoke --feed-loading
  npm run test -- --smoke --codex-session-modes
  npm run test -- --agent-presets
  npm run test -- --sqlite

  --sqlite    用系统 Node（node:sqlite）跑 apps/desktop/test-node/*.test.ts
  --mobile    只跑 apps/mobile 的 Flutter 测试（默认全量运行已包含）
  --no-mobile 跳过 Flutter 步骤（仅跑 bun 测试）

smoke 类型：
  ${Object.keys(smokeScripts)
    .map((name) => `--${name}`)
    .join(", ")}

测试套件：
  ${Object.keys(testSuites)
    .map((name) => `--${name}`)
    .join(", ")}`);
}
