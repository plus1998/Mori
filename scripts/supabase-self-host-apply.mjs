#!/usr/bin/env node
/**
 * Apply Eco Center migrations + Edge Functions onto a self-hosted Supabase Docker stack.
 *
 * Usage (from eco-coding repo root):
 *   bun run supabase:deploy -- --platform self-host --compose-dir /path/to/supabase-project
 *   bun run supabase:deploy -- --platform self-host --compose-dir ./supabase-project --db-only
 *   bun run supabase:deploy -- --platform self-host --database-url "postgres://..." --db-only
 *
 * Docs: docs/supabase-self-host.md
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const functionsSrc = path.join(root, "supabase", "functions");

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const composeDir = flagValue("--compose-dir");
const databaseUrl = flagValue("--database-url");
const dbOnly = args.includes("--db-only");
const functionsOnly = args.includes("--functions-only");
const dryRun = args.includes("--dry-run");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  console.log(`$ ${command} ${commandArgs.join(" ")}`);
  if (dryRun) return { status: 0, stdout: "" };
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: process.env,
    input: options.input,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`Command failed (${result.status}): ${command}`);
  }
  return result;
}

function listMigrationFiles() {
  if (!existsSync(migrationsDir)) fail(`Missing ${migrationsDir}`);
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

function composeFileArgs(abs) {
  const ecoOverride = path.join(abs, "docker-compose.eco.yml");
  if (existsSync(ecoOverride)) {
    return ["-f", "docker-compose.yml", "-f", "docker-compose.eco.yml"];
  }
  return [];
}

function applyViaDockerCompose(sql) {
  if (!composeDir) fail("--compose-dir required for docker apply");
  const abs = path.resolve(composeDir);
  if (
    !existsSync(path.join(abs, "docker-compose.yml")) &&
    !existsSync(path.join(abs, "docker-compose.yaml"))
  ) {
    fail(`No docker-compose.yml in ${abs}`);
  }
  // Prefer service name "db" (official self-host stack).
  return run(
    "docker",
    [
      "compose",
      ...composeFileArgs(abs),
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { cwd: abs, input: sql },
  );
}

function applyViaDatabaseUrl(sql) {
  if (!databaseUrl) fail("--database-url required");
  return run("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1"], { input: sql });
}

function applySql(sql) {
  if (composeDir) return applyViaDockerCompose(sql);
  return applyViaDatabaseUrl(sql);
}

function ensureMigrationTable() {
  applySql(`
CREATE TABLE IF NOT EXISTS public.eco_schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`);
}

function alreadyApplied(filename) {
  const sql = `SELECT 1 FROM public.eco_schema_migrations WHERE filename = '${filename.replace(/'/g, "''")}' LIMIT 1;`;
  if (dryRun) return false;
  let result;
  if (composeDir) {
    const abs = path.resolve(composeDir);
    // Pass SQL on stdin — putting it in -c argv breaks under Windows `shell: true` (quotes stripped).
    result = spawnSync(
      "docker",
      [
        "compose",
        ...composeFileArgs(abs),
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-tA",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { cwd: abs, encoding: "utf8", shell: process.platform === "win32", input: sql },
    );
  } else {
    result = spawnSync("psql", [databaseUrl, "-tA", "-v", "ON_ERROR_STOP=1"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      input: sql,
    });
  }
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`Failed checking migration history for ${filename}`);
  }
  return String(result.stdout || "").trim() === "1";
}

function applyMigrations() {
  console.log("\n==> Applying Mori migrations (incremental via eco_schema_migrations)");
  ensureMigrationTable();
  for (const filename of listMigrationFiles()) {
    if (alreadyApplied(filename)) {
      console.log(`skip (already applied): ${filename}`);
      continue;
    }
    console.log(`apply: ${filename}`);
    const body = readFileSync(path.join(migrationsDir, filename), "utf8");
    applySql(body);
    applySql(
      `INSERT INTO public.eco_schema_migrations (filename) VALUES ('${filename.replace(/'/g, "''")}') ON CONFLICT DO NOTHING;`,
    );
  }
}

function deployFunctions() {
  if (!composeDir) {
    fail("--compose-dir is required to copy Edge Functions into volumes/functions");
  }
  const abs = path.resolve(composeDir);
  const destRoot = path.join(abs, "volumes", "functions");
  if (!existsSync(functionsSrc)) fail(`Missing ${functionsSrc}`);
  console.log(`\n==> Copying Edge Functions → ${destRoot}`);
  mkdirSync(destRoot, { recursive: true });

  // Keep hello if present; sync Eco functions + _shared.
  for (const entry of readdirSync(functionsSrc, { withFileTypes: true })) {
    const from = path.join(functionsSrc, entry.name);
    const to = path.join(destRoot, entry.name);
    if (!entry.isDirectory()) continue;
    if (existsSync(to)) {
      console.log(`replace: ${entry.name}`);
      rmSync(to, { recursive: true, force: true });
    } else {
      console.log(`add: ${entry.name}`);
    }
    if (!dryRun) copyDir(from, to);
  }

  // Drop a marker for operators/agents.
  const marker = path.join(destRoot, ".eco-functions-version.txt");
  const names = readdirSync(functionsSrc, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .join("\n");
  if (!dryRun) {
    writeFileSync(marker, `synced_from=${root}\n${new Date().toISOString()}\n${names}\n`);
  }

  console.log("\n==> Restarting functions container");
  // Prefer docker compose directly: Windows hosts often lack `sh` / Git Bash in PATH.
  // Pass the same compose files operators use (COMPOSE_FILE or explicit eco override).
  const composeArgs = ["compose"];
  const ecoOverride = path.join(abs, "docker-compose.eco.yml");
  if (existsSync(ecoOverride)) {
    composeArgs.push("-f", "docker-compose.yml", "-f", "docker-compose.eco.yml");
  }
  composeArgs.push("restart", "functions");
  run("docker", composeArgs, { cwd: abs });
}

if (!composeDir && !databaseUrl) {
  fail("Provide --compose-dir <supabase-project> and/or --database-url <postgres-url>");
}
if (!functionsOnly && !composeDir && !databaseUrl) {
  fail("DB apply needs --compose-dir or --database-url");
}
if (!dbOnly && !composeDir) {
  console.warn("Warning: functions deploy skipped without --compose-dir");
}

if (!functionsOnly) applyMigrations();
if (!dbOnly && composeDir) deployFunctions();

console.log("\nDone.");
console.log("Client needs API gateway URL + anon key from self-host secrets (never service_role).");
console.log("See docs/supabase-self-host.md");
