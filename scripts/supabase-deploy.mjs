#!/usr/bin/env node
/**
 * Deploy Eco Supabase Center.
 *
 * Interactive (TTY, no --platform):
 *   bun run supabase:deploy
 *
 * Non-interactive:
 *   bun run supabase:deploy -- --platform cloud --project-ref <ref>
 *   bun run supabase:deploy -- --platform self-host --compose-dir <dir>
 *
 * Shared flags: --db-only / --functions-only
 * Docs: docs/supabase-deploy.md | supabase-self-host.md
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supabaseDir = path.join(root, "supabase");
const functionsDir = path.join(supabaseDir, "functions");

const PLATFORM_ALIASES = {
  cloud: "cloud",
  "self-host": "self-host",
  selfhost: "self-host",
  docker: "self-host",
};

function usage() {
  return `Deploy Mori Center.

Interactive:
  bun run supabase:deploy

Scripted (CI / automation):
  bun run supabase:deploy -- --platform cloud --project-ref <supabase.com-ref>
  bun run supabase:deploy -- --platform self-host --compose-dir <supabase-project>

  --db-only / --functions-only
  cloud | self-host   (alias: docker)

Local stack (official CLI, not wrapped): npx supabase start | stop | status | db reset | functions serve
See docs/supabase-deploy.md`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function takeFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return { value: undefined, rest: argv };
  if (!argv[i + 1] || argv[i + 1].startsWith("-")) {
    fail(`${name} requires a value.\n\n${usage()}`);
  }
  return { value: argv[i + 1], rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

function run(command, commandArgs, label) {
  console.log(`\n==> ${label}`);
  console.log(`$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`\nFAILED: ${label} (exit ${result.status ?? "unknown"})`);
    process.exit(result.status ?? 1);
  }
}

function resolveSupabaseCli() {
  if (process.env.SUPABASE_CLI?.trim()) {
    return { command: process.env.SUPABASE_CLI.trim(), prefixArgs: [] };
  }
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["supabase"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (which.status === 0 && String(which.stdout || "").trim()) {
    return { command: "supabase", prefixArgs: [] };
  }
  return { command: "npx", prefixArgs: ["supabase"] };
}

function npxSupabase(supabaseArgs, label) {
  const cli = resolveSupabaseCli();
  run(cli.command, [...cli.prefixArgs, ...supabaseArgs], label);
}

function deployCloud(args) {
  const functionsOnly = args.includes("--functions-only");
  const dbOnly = args.includes("--db-only");
  const projectRefIdx = args.indexOf("--project-ref");
  const projectRef = projectRefIdx >= 0 ? args[projectRefIdx + 1] : undefined;

  if (!existsSync(supabaseDir)) {
    fail("Missing supabase/ directory. Run from repo root.");
  }

  if (projectRef !== undefined) {
    if (!projectRef.trim()) {
      fail("--project-ref requires a value (Dashboard → Settings → General).");
    }
    npxSupabase(["link", "--project-ref", projectRef.trim()], `Link project ${projectRef.trim()}`);
  }

  if (!functionsOnly) {
    npxSupabase(["db", "push"], "Push database migrations (incremental)");
  }

  if (!dbOnly) {
    const entries = existsSync(functionsDir)
      ? readdirSync(functionsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
          .map((d) => d.name)
          .sort()
      : [];
    if (entries.length === 0) {
      console.warn("No Edge Functions found under supabase/functions/ (skipped).");
    } else {
      for (const name of entries) {
        npxSupabase(["functions", "deploy", name], `Deploy function: ${name}`);
      }
    }
  }

  printClientReminder("cloud");
}

function deployViaScript(relPath, rest) {
  const script = path.join(root, relPath);
  const result = spawnSync(process.execPath, [script, ...rest], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function printClientReminder(platform) {
  console.log("\nDone.");
  console.log("Fill Mori Desktop / Mobile with Project URL + anon key only (never service_role).");
  if (platform === "cloud") console.log("Docs: docs/supabase-deploy.md");
  if (platform === "self-host") console.log("Docs: docs/supabase-self-host.md");
}

function createRl() {
  return createInterface({ input, output, terminal: true });
}

function question(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(String(answer ?? "").trim()));
  });
}

async function askChoice(rl, title, choices) {
  console.log(`\n${title}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}) ${choices[i].label}`);
  }
  for (;;) {
    const raw = await question(rl, `选择 [1-${choices.length}]: `);
    const n = Number(raw || "1");
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
      return choices[n - 1].value;
    }
    console.log("无效选项，请重试。");
  }
}

async function askText(rl, label, { required = false, defaultValue = "", secret = false } = {}) {
  const envHint = defaultValue ? ` [已有默认值]` : "";
  const secretHint = secret ? "（输入会显示在终端，勿在共享屏幕上操作）" : "";
  for (;;) {
    const answer = await question(rl, `${label}${envHint}${secretHint}: `);
    const value = answer || defaultValue;
    if (required && !value) {
      console.log("此项必填。");
      continue;
    }
    return value;
  }
}

async function askYesNo(rl, label, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await question(rl, `${label} (${hint}): `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function printChecklist(title, items) {
  console.log(`\n${title}`);
  for (const item of items) {
    console.log(`  - ${item}`);
  }
}

async function runWizard() {
  const rl = createRl();
  try {
    console.log("\nMori Supabase 部署向导");
    console.log("客户端最终只填 Project URL + anon；不要把 service_role 填进 App。");

    const platform = await askChoice(rl, "你的 Supabase 跑在哪里？", [
      {
        value: "cloud",
        label: "官方 Supabase Cloud（supabase.com）",
      },
      {
        value: "self-host",
        label: "自托管 Docker（自己的机器 / VPS）",
      },
    ]);

    const intent = await askChoice(rl, "这次要做什么？", [
      { value: "first", label: "首次部署（schema + 全部 Edge Functions）" },
      { value: "update", label: "增量更新（已部署过，全量再推一次）" },
      { value: "db", label: "只更新数据库 migration" },
      { value: "functions", label: "只更新 Edge Functions" },
    ]);

    const scopeArgs = [];
    if (intent === "db") scopeArgs.push("--db-only");
    if (intent === "functions") scopeArgs.push("--functions-only");

    if (platform === "cloud") {
      return await wizardCloud(rl, intent, scopeArgs);
    }
    return await wizardSelfHost(rl, intent, scopeArgs);
  } finally {
    rl.close();
  }
}

async function wizardCloud(rl, intent, scopeArgs) {
  printChecklist("部署前请确认（官方 Cloud）", [
    "已在 https://supabase.com/dashboard 创建项目",
    "本机已执行：npx supabase login（或 supabase login）",
    "Authentication → Email 已开启；Realtime 关闭 Allow public access",
    "已保存 Project URL + anon（给 Mori 用，不要保存 service_role 到 App）",
    "文档：docs/supabase-deploy.md",
  ]);
  await askYesNo(rl, "以上都准备好了吗？", true);

  const projectRef = await askText(rl, "Project ref（Dashboard → Settings → General）", {
    required: intent === "first",
  });

  const args = [...scopeArgs];
  if (projectRef) {
    args.push("--project-ref", projectRef);
  } else if (intent === "first") {
    fail("首次部署必须提供 project-ref。");
  } else {
    console.log("未填 project-ref：将使用本仓库已 link 的项目（若从未 link 会失败）。");
  }

  return confirmAndReturn(rl, "cloud", args, [
    "平台：官方 Supabase Cloud",
    `范围：${intentLabel(intent)}`,
    projectRef ? `project-ref：${projectRef}` : "project-ref：（使用已有 link）",
  ]);
}

async function wizardSelfHost(rl, intent, scopeArgs) {
  printChecklist("部署前请确认（自托管 Docker）", [
    "已按官方 Docker 栈拉起 db / auth / rest / realtime / api-gw / functions",
    "已生成密钥；无 SMTP 时 ENABLE_EMAIL_AUTOCONFIRM=true",
    "已记下网关 URL（如 http://host:8000 或 https 域名）+ anon",
    "本机/SSH 能访问该 compose 目录的 volumes/functions",
    "文档：docs/supabase-self-host.md",
  ]);
  await askYesNo(rl, "以上都准备好了吗？", true);

  const composeDir = await askText(rl, "supabase-project 绝对路径（含 docker-compose.yml）", {
    required: true,
  });
  if (!existsSync(composeDir)) {
    fail(`路径不存在：${composeDir}`);
  }
  if (
    !existsSync(path.join(composeDir, "docker-compose.yml")) &&
    !existsSync(path.join(composeDir, "docker-compose.yaml"))
  ) {
    fail(`目录内没有 docker-compose.yml：${composeDir}`);
  }

  const args = ["--compose-dir", path.resolve(composeDir), ...scopeArgs];
  return confirmAndReturn(rl, "self-host", args, [
    "平台：自托管 Docker",
    `范围：${intentLabel(intent)}`,
    `compose-dir：${path.resolve(composeDir)}`,
  ]);
}

function intentLabel(intent) {
  if (intent === "first") return "首次全量";
  if (intent === "update") return "增量全量";
  if (intent === "db") return "仅数据库";
  return "仅 Edge Functions";
}

async function confirmAndReturn(rl, platform, args, summaryLines) {
  console.log("\n将执行：");
  for (const line of summaryLines) console.log(`  ${line}`);
  console.log(`  命令：bun run supabase:deploy -- --platform ${platform} ${formatArgs(args)}`);
  const ok = await askYesNo(rl, "确认开始部署？", true);
  if (!ok) fail("已取消。");
  return { platform, args };
}

function formatArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--password" || a === "--db-url") {
      out.push(a, "***");
      i++;
      continue;
    }
    out.push(a);
  }
  return out.join(" ");
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  const taken = takeFlag(rawArgs, "--platform");
  const platformKey = taken.value?.trim().toLowerCase();
  let rest = taken.rest;
  let platform = platformKey ? PLATFORM_ALIASES[platformKey] : undefined;

  if (!platform) {
    if (platformKey) {
      fail(`Unknown --platform ${taken.value}. Use cloud | self-host.\n\n${usage()}`);
    }
    if (!input.isTTY) {
      fail(`--platform is required in non-interactive mode.\n\n${usage()}`);
    }
    const planned = await runWizard();
    platform = planned.platform;
    rest = planned.args;
  }

  console.log(`\nMori Supabase deploy platform: ${platform}`);

  if (platform === "cloud") {
    deployCloud(rest);
  } else if (platform === "self-host") {
    deployViaScript("scripts/supabase-self-host-apply.mjs", rest);
  } else {
    fail(`Unknown platform: ${platform}\n\n${usage()}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
