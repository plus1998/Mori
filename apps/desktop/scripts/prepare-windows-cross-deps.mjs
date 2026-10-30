// Ensure Windows optional packages are present without replacing/removing the
// Mac packages used by the running dev app. Only manifest-pinned packages are prepared.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageNodeModulesDirectory, windowsX64OptionalPackages } from "./windows-cross-dependencies.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const readJson = filename => JSON.parse(readFileSync(filename, "utf8"));
const targets = [{ manifest: readJson(path.join(root, "package.json")), modules: path.join(root, "node_modules") }];
const pdfRequire = createRequire(require.resolve("pdfjs-dist/package.json"));
for (const [name, resolver] of [["koffi", require], ["@napi-rs/keyring", require], ["@napi-rs/canvas", pdfRequire]]) {
  // Some packages export the entry point but intentionally hide package.json.
  let directory = path.dirname(resolver.resolve(name));
  while (!existsSync(path.join(directory, "package.json")) && path.dirname(directory) !== directory) directory = path.dirname(directory);
  const filename = path.join(directory, "package.json");
  if (readJson(filename).name !== name) throw new Error(`Cannot locate installed package metadata for ${name}`);
  targets.push({ manifest: readJson(filename), modules: packageNodeModulesDirectory(path.dirname(filename), name) });
}

for (const { manifest, modules } of targets) {
  for (const pkg of windowsX64OptionalPackages(manifest)) {
    const destination = path.join(modules, ...pkg.name.split("/"));
    const metadata = path.join(destination, "package.json");
    if (existsSync(metadata) && readJson(metadata).version === pkg.version) continue;
    if (process.platform === "win32") throw new Error(`Missing Windows dependency ${pkg.name}@${pkg.version}; run bun install with optional dependencies enabled.`);
    const cache = path.join(os.homedir(), ".cache/mori-native/npm", createHash("sha256").update(pkg.spec).digest("hex"));
    mkdirSync(cache, { recursive: true });
    // npm verifies the registry's tarball integrity. --ignore-scripts ensures no
    // lifecycle code from a Windows package executes on the build host.
    const packed = JSON.parse(execFileSync("npm", ["pack", pkg.spec, "--ignore-scripts", "--json", "--pack-destination", cache], { cwd: cache, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
    const filename = packed[0]?.filename;
    if (typeof filename !== "string" || path.basename(filename) !== filename) throw new Error(`Invalid npm pack result for ${pkg.spec}`);
    mkdirSync(path.dirname(destination), { recursive: true });
    const staging = `${destination}.mori-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging);
    try {
      execFileSync("tar", ["-xzf", path.join(cache, filename), "--strip-components=1", "-C", staging]);
      if (readJson(path.join(staging, "package.json")).version !== pkg.version) throw new Error(`Windows package version mismatch: ${pkg.spec}`);
      rmSync(destination, { recursive: true, force: true });
      renameSync(staging, destination);
    } finally { rmSync(staging, { recursive: true, force: true }); }
    console.log(`[windows-cross] Prepared ${pkg.name}@${pkg.version}`);
  }
}
