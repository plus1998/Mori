import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * One entry point for the PI 1.3.0 upgrade regression.
 *
 * The upgrade spans four things that fail independently: the pinned dependency
 * graph, the deterministic adapter/session contracts, the real PI session against
 * a real MCP Hub, and the version each entry point actually loads at runtime.
 * Running them separately is how a green `bun test` hides a harness that resolves
 * a stale pre-1.3.0 build, so they are reported together and any red one fails the
 * command.
 *
 * Usage:
 *   node scripts/pi-regression.mjs            # all steps
 *   node scripts/pi-regression.mjs --json     # machine-readable report
 *   node scripts/pi-regression.mjs --only=tests
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const runtimeDir = join(root, "packages", "runtime");
const args = new Set(process.argv.slice(2));
const only = [...args].find((arg) => arg.startsWith("--only="))?.slice("--only=".length);

/** Versions the upgrade pins. A mismatch means the workspace resolved something else. */
const EXPECTED_VERSIONS = {
  "@earendil-works/pi-coding-agent": "1.3.0",
  "@earendil-works/pi-ai": "1.3.0",
  "@earendil-works/pi-mcp": "1.3.0",
  typebox: "1.3.27",
  "pi-web-search": "1.6.0",
};

const steps = [];
function record(name, status, detail) {
  steps.push({ name, status, detail });
  if (!args.has("--json")) {
    const mark = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
    console.log(`[${mark}] ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

/**
 * Declared versions come from the runtime manifest, installed ones from the tree
 * that package actually resolves. Checking both is the point: a manifest that says
 * 1.3.0 while the installed copy is older is exactly the state this guards against.
 */
function checkVersions() {
  const declared = JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8")).dependencies;
  const mismatches = [];
  const observed = {};
  for (const [name, expected] of Object.entries(EXPECTED_VERSIONS)) {
    const declaredVersion = declared[name];
    let installed;
    try {
      installed = JSON.parse(
        readFileSync(join(runtimeDir, "node_modules", name, "package.json"), "utf8"),
      ).version;
    } catch {
      installed = undefined;
    }
    observed[name] = { declared: declaredVersion, installed };
    if (declaredVersion !== expected) {
      mismatches.push(`${name}: declared ${declaredVersion}, expected ${expected}`);
    }
    if (installed !== expected) {
      mismatches.push(`${name}: installed ${installed ?? "<missing>"}, expected ${expected}`);
    }
  }
  if (mismatches.length > 0) {
    record("dependency versions", "fail", mismatches.join("\n        "));
    return false;
  }
  record(
    "dependency versions",
    "pass",
    Object.entries(observed)
      .map(([name, value]) => `${name}=${value.installed}`)
      .join(", "),
  );
  return true;
}

/**
 * The version the runtime itself resolves, not the one on disk. `VERSION` is PI's
 * own export, so this catches a duplicated or shadowed copy the manifest check
 * cannot see.
 */
function checkRuntimeVersion() {
  const probe = [
    'import { VERSION } from "@earendil-works/pi-coding-agent";',
    'import { version as aiVersion } from "@earendil-works/pi-ai/package.json";',
    "console.log(JSON.stringify({ pi: VERSION, ai: aiVersion }));",
  ].join("\n");
  const result = spawnSync("bun", ["-e", probe], { cwd: runtimeDir, encoding: "utf8" });
  if (result.status !== 0) {
    record("runtime-resolved version", "fail", (result.stderr || result.stdout).trim());
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").at(-1));
  } catch {
    record("runtime-resolved version", "fail", `unparsable output: ${result.stdout.trim()}`);
    return false;
  }
  const ok =
    parsed.pi === EXPECTED_VERSIONS["@earendil-works/pi-coding-agent"] &&
    parsed.ai === EXPECTED_VERSIONS["@earendil-works/pi-ai"];
  record(
    "runtime-resolved version",
    ok ? "pass" : "fail",
    `pi-coding-agent=${parsed.pi}, pi-ai=${parsed.ai}`,
  );
  return ok;
}

/** The deterministic PI contracts: adapter, session mode, MCP, codemode sandbox. */
function checkDeterministicTests() {
  const result = spawnSync(
    "bun",
    [
      "test",
      ...[
        "pi-core",
        "pi-codemode-sandbox",
        "pi-codemode-capacity",
        "pi-session-mode",
        "pi-session-restore",
        "pi-session-dispose",
        "pi-mcp",
        "pi-mcp-session",
        "pi-subagent",
        "pi-tool-approval",
        "pi-mid-turn",
        "pi-stop-native",
        "pi-finalize-plan",
        "pi-session-settings",
        "pi-web-search-config",
        "pi-skills",
      ].map((name) => `test/${name}.test.ts`),
      "../../apps/desktop/test/conversation-round-cli.test.ts",
    ],
    { cwd: runtimeDir, encoding: "utf8" },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  // Bun omits the `skip` line entirely when nothing was skipped.
  const summary = output.match(/(\d+) pass\n(?:\s*(\d+) skip\n)?\s*(\d+) fail/);
  if (result.status !== 0 || !summary) {
    record(
      "deterministic PI tests",
      "fail",
      `${result.error?.message ?? `exit=${result.status}`}${summary ? `, ${summary[1]} pass, ${summary[3]} fail` : ""}\n        ${output.trim()}`,
    );
    return false;
  }
  record(
    "deterministic PI tests",
    "pass",
    `${summary[1]} pass, ${summary[2] ?? "0"} skip, ${summary[3]} fail`,
  );
  return true;
}

/** Real PI session, official MCP extension, codemode sandbox and a real Hub. */
function checkRealHarness() {
  const result = spawnSync("bun", ["scripts/mcp-hub-probe/pi-real-harness.ts"], {
    cwd: root,
    encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const start = output.indexOf("{");
  let report;
  try {
    report = JSON.parse(output.slice(start, output.lastIndexOf("}") + 1));
  } catch {
    record("real PI + Hub harness", "fail", output.trim().split("\n").slice(-15).join("\n        "));
    return false;
  }
  const ok = result.status === 0 && report.status === "pass";
  record(
    "real PI + Hub harness",
    ok ? "pass" : "fail",
    ok
      ? `threads=${report.concurrentThreads}, nested Hub calls=${(report.codemodeNestedHubCalls ?? []).length}, session restored=${report.restoredSessionFile}`
      : JSON.stringify(report),
  );
  return ok;
}

/**
 * Sessions and gateway rounds recorded before the upgrade, replayed through the
 * current projection. This is what proves the pre-1.0.3 `mcp`/`mcpScript` rows
 * still parse for history while the live path no longer emits them.
 */
function checkLegacyReplay() {
  const runs = [
    ["conversation (pi)", ["scripts/conversation-round/replay.mjs", "--core=pi", "--strict"]],
    ["gateway", ["scripts/gateway-http-round/replay.mjs"]],
  ];
  const failures = [];
  for (const [label, argv] of runs) {
    const result = spawnSync("bun", argv, { cwd: root, encoding: "utf8" });
    const output = `${result.stdout}\n${result.stderr}`;
    const summary = [...output.matchAll(/(\d+) pass\n(?:\s*(\d+) skip\n)?\s*(\d+) fail/g)].pop();
    if (result.status !== 0 || !summary || summary[3] !== "0") {
      let detail = output.trim().split(/\r?\n/).slice(-25).join("\n        ");
      try {
        const report = JSON.parse(result.stdout);
        if (typeof report.error === "string") detail = `${report.error}\n        ${detail}`;
      } catch {
        // Preserve raw child output when it is not a JSON error report.
      }
      const execution =
        result.error?.message ?? (result.signal ? `signal=${result.signal}` : `exit=${result.status}`);
      failures.push(
        `${label}: ${execution}, ${summary ? `${summary[1]} pass, ${summary[3]} fail` : "no test summary"}\n        ${detail || "child process returned no output"}`,
      );
    }
  }
  if (failures.length > 0) {
    record("legacy fixture replay", "fail", failures.join("\n        "));
    return false;
  }
  record("legacy fixture replay", "pass", "conversation(pi) + gateway 回放全绿");
  return true;
}

const selected = [
  ["versions", checkVersions],
  ["runtime-version", checkRuntimeVersion],
  ["tests", checkDeterministicTests],
  ["harness", checkRealHarness],
  ["replay", checkLegacyReplay],
].filter(([name]) => !only || name === only);

let failed = 0;
for (const [, run] of selected) {
  if (!run()) failed += 1;
}

if (args.has("--json")) {
  console.log(JSON.stringify({ steps, failed }, null, 2));
} else {
  console.log(`\nPI 回归：${steps.length - failed} 通过，${failed} 失败${only ? `（--only=${only}）` : ""}`);
}
process.exit(failed > 0 ? 1 : 0);
