#!/usr/bin/env node
/**
 * Credential-free smoke of the PI runtime *as it ships inside a packed app*.
 *
 * `verify-main-bundle.mjs` only inspects `dist/main/index.js` before packing: it proves
 * the PI SDK stayed external, not that the packed app can load it. Two failure modes are
 * invisible from the repo tree, because both depend on the shipped layout:
 *
 *   1. `@earendil-works/pi-codemode` starts a worker with
 *      `new Worker(new URL("./worker.js", import.meta.url))` — a real file path, so the
 *      worker entry has to be unpacked out of `app.asar`.
 *   2. The sandbox resolves QuickJS with
 *      `createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")` and hands the
 *      bytes to `WebAssembly.compile()` — again a real path, unpacked.
 *
 * So this loads the closure through the `app.asar` path (the same base the app's main
 * process imports from) and runs one real codemode script through it. A green run means
 * the packaged Worker + wasm + tool-call round trip works on this platform.
 *
 * Run it with Electron's Node, not plain Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 <electron> scripts/verify-packaged-pi-runtime.mjs --search <dir>
 *
 * Plain Node cannot resolve this: `chalk` and the rest of the PI closure's own
 * dependencies are *inside* `app.asar`, and only Electron's loader reads the archive.
 * Importing from `app.asar.unpacked` instead does not work either — that directory is a
 * real tree with no parent archive, so its transitive dependencies are unreachable. The
 * `app.asar` base is what makes this the shipped configuration rather than a mock of it.
 *
 * Not covered: this is not the running app. It proves the shipped files load and execute
 * under Electron's Node; it does not prove the main process wires them into a session
 * (that is what the desktop E2E suite would have to do, and today does not).
 */

import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_PI_VERSION = "1.3.0";
const MAX_SEARCH_DEPTH = 8;

const args = process.argv.slice(2);
function argValue(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const searchRoot = path.resolve(
  argValue("--resources") ?? argValue("--search") ?? path.join(scriptDirectory, "..", "release"),
);

if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
  console.error(
    "Run this with Electron's Node so app.asar resolves:\n" +
      "  ELECTRON_RUN_AS_NODE=1 <electron> scripts/verify-packaged-pi-runtime.mjs --search <dir>",
  );
  process.exit(1);
}

/** Walk down to the directory holding `app.asar`, then locate its unpacked sibling. */
async function findResources(root) {
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.name === "app.asar")) {
      const unpacked = path.join(directory, "app.asar.unpacked", "node_modules");
      try {
        if ((await stat(unpacked)).isDirectory()) return { resources: directory, unpacked };
      } catch {
        /* fall through: report below */
      }
      throw new Error(
        `Found app.asar at ${directory} but no app.asar.unpacked/node_modules beside it; ` +
          "the PI closure would not load from inside the archive.",
      );
    }
    if (depth >= MAX_SEARCH_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "app.asar.unpacked" || entry.name === "node_modules") continue;
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }
  return undefined;
}

const checks = [];
function check(name, detail) {
  checks.push({ name, detail });
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function requireFile(file, label) {
  try {
    await access(file);
  } catch {
    throw new Error(`${label} is missing from the packed app: ${file}`);
  }
  return file;
}

const found = await findResources(searchRoot);
if (!found) {
  throw new Error(
    `No packed app.asar found under ${searchRoot}. Build one first (bun run --cwd apps/desktop pack).`,
  );
}
const { resources, unpacked } = found;
const asarModules = path.join(resources, "app.asar", "node_modules");
const asarImport = (segments) => pathToFileURL(path.join(asarModules, ...segments)).href;
console.log(`Inspecting ${resources}\n`);

// 1. The PI closure ships unpacked, at the pinned version. Version is read from the real
// files on disk: a closure that only exists inside the archive is the bug this catches.
const piPackages = [
  "pi-coding-agent",
  "pi-codemode",
  "pi-mcp",
  "pi-ai",
  "pi-agent-core",
  "pi-tui",
  "pi-telemetry",
];
const piVersions = {};
for (const name of piPackages) {
  const manifest = JSON.parse(
    await readFile(path.join(unpacked, "@earendil-works", name, "package.json"), "utf8"),
  );
  piVersions[name] = manifest.version;
  if (manifest.version !== EXPECTED_PI_VERSION) {
    throw new Error(`@earendil-works/${name} is ${manifest.version}, expected ${EXPECTED_PI_VERSION}`);
  }
}
check(
  "packed PI closure present",
  Object.entries(piVersions)
    .map(([n, v]) => `${n}=${v}`)
    .join(", "),
);

// 2. The wasm files the asarUnpack rules exist for are real files, and compile.
const quickjsWasm = await requireFile(path.join(unpacked, "quickjs-wasi", "quickjs.wasm"), "QuickJS wasm");
const quickjsBytes = await readFile(quickjsWasm);
await WebAssembly.compile(quickjsBytes);
check(
  "quickjs.wasm compiles",
  `${quickjsBytes.byteLength} bytes at ${path.basename(path.dirname(quickjsWasm))}/quickjs.wasm`,
);

const photonWasm = await requireFile(
  path.join(unpacked, "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"),
  "photon wasm",
);
await WebAssembly.compile(await readFile(photonWasm));
check("photon_rs_bg.wasm compiles");

// 3. The official extensions really are exported by the shipped build. This is the MCP
// half: `createMcpExtension` is what names Hub tools `mcp__<server>__<tool>`.
const piSdk = await import(asarImport(["@earendil-works", "pi-coding-agent", "dist", "index.js"]));
const missingExports = ["createAgentSession", "createMcpExtension", "createCodemodeExtension"].filter(
  (name) => typeof piSdk[name] !== "function",
);
if (missingExports.length > 0) {
  throw new Error(`Shipped PI SDK is missing exports: ${missingExports.join(", ")}`);
}
check("shipped PI SDK exports the official extensions", "createMcpExtension + createCodemodeExtension");

// 4. One real codemode script through the shipped worker + wasm. Nothing here passes a
// path explicitly: the sandbox has to derive both from its own location, inside app.asar.
const codemode = await import(asarImport(["@earendil-works", "pi-codemode", "dist", "index.js"]));
const seen = [];
const workerExits = [];
const sandbox = new codemode.CodemodeSandbox({
  wasm: codemode.loadQuickJSWasm(),
  onWorkerStarted: (exited) => {
    workerExits.push(exited);
  },
  timeoutMs: 60_000,
  tools: [
    {
      name: "record",
      description: "Record a value and echo it back in upper case.",
      execute: async (input) => {
        const value = String(input?.value ?? "");
        seen.push(value);
        return value.toUpperCase();
      },
    },
  ],
});
let result;
try {
  result = await sandbox.execute(`
    const first = await tools.record({ value: "worker-ok" });
    const second = await tools.record({ value: "wasm-ok" });
    return [first, second].join("+");
  `);
} finally {
  await sandbox.close();
}
if (!result.ok) {
  throw new Error(`Codemode script failed in the packed app: ${JSON.stringify(result.error)}`);
}
if (result.value !== "WORKER-OK+WASM-OK") {
  throw new Error(`Codemode script returned ${JSON.stringify(result.value)}`);
}
if (seen.join(",") !== "worker-ok,wasm-ok") {
  throw new Error(`Codemode tool calls did not round-trip: ${JSON.stringify(seen)}`);
}
check("packaged codemode runs a real script", `value=${result.value}, tool calls=${result.calls.length}`);

// 1.3 results and close() settle before actual worker exit; observe that lifecycle too.
const cancellation = new codemode.CodemodeSandbox({
  wasm: codemode.loadQuickJSWasm(),
  timeoutMs: 100,
  onWorkerStarted: (exited) => {
    workerExits.push(exited);
  },
});
try {
  const timedOut = await cancellation.execute("while (true) {}");
  if (timedOut.ok || timedOut.error.kind !== "timeout")
    throw new Error(`Packaged codemode failed to enforce its deadline: ${JSON.stringify(timedOut.error)}`);
} finally {
  await cancellation.close();
}
let workerExitTimer;
try {
  await Promise.race([
    Promise.all(workerExits),
    new Promise((_, reject) => {
      workerExitTimer = setTimeout(
        () => reject(new Error("Packaged codemode workers did not exit after shutdown")),
        5_000,
      );
    }),
  ]);
} finally {
  clearTimeout(workerExitTimer);
}
if (workerExits.length !== 2)
  throw new Error(`Expected two packaged workers, observed ${workerExits.length}`);
check("packaged codemode timeout and actual worker exit", `${workerExits.length} workers exited`);

console.log(`\n打包产物 PI 冒烟：${checks.length} 项通过`);
