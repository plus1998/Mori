#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(scriptDirectory, "../dist/main/index.js");
const bundle = await readFile(bundlePath, "utf8");

if (/import\s*\{[^}]*\bautoUpdater\b[^}]*\}\s*from\s*["']electron-updater["']/.test(bundle)) {
  throw new Error(
    "Main bundle uses a named electron-updater import, which fails when Electron loads its CommonJS entrypoint.",
  );
}

if (!/import\s+\w+\s+from\s+["']electron-updater["']/.test(bundle)) {
  throw new Error("Main bundle is missing the CommonJS-compatible electron-updater default import.");
}

// The PI SDK ships as an official compiled artifact next to the app (a production
// dependency, unpacked out of app.asar) instead of being inlined here. Inlining it
// would move `import.meta.url` for pi-codemode's host module into this bundle, so the
// codemode worker and the QuickJS wasm would no longer resolve to the shipped files.
// Keep `--external @earendil-works/pi-coding-agent` in `build:main`.
if (!/["']@earendil-works\/pi-coding-agent["']/.test(bundle)) {
  throw new Error(
    "Main bundle no longer references @earendil-works/pi-coding-agent as an external specifier. " +
      "The PI SDK must stay external so the packaged app loads the shipped 1.3.0 build.",
  );
}
// Native MCP checks transport class identity. Eco and the SDK must import the
// same shipped client rather than an inlined second copy of those classes.
if (!/["']@earendil-works\/pi-mcp["']/.test(bundle)) {
  throw new Error("Main bundle must keep @earendil-works/pi-mcp external alongside the PI SDK.");
}
// Markers below were checked against a build made without the --external flag:
// each appears in an inlined bundle and in none of the external ones.
if (/CodemodeSandbox|getCodemodeWorkerSpecifier|MCP_TYPESCRIPT_PREAMBLE/.test(bundle)) {
  throw new Error(
    "Main bundle contains inlined PI SDK internals; the PI closure must stay external and ship unpacked.",
  );
}

console.log("Verified main bundle CommonJS interoperability and the external PI SDK boundary.");
