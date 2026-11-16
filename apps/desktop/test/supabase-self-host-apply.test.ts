import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mori-selfhost-deploy-"));
  roots.push(root);
  for (const dir of [
    "scripts",
    "supabase/migrations",
    "supabase/functions/_shared",
    "supabase/functions/device-register",
    "compose",
  ])
    mkdirSync(path.join(root, dir), { recursive: true });
  copyFileSync(
    new URL("../../../scripts/supabase-self-host-apply.mjs", import.meta.url),
    path.join(root, "scripts/apply.mjs"),
  );
  writeFileSync(
    path.join(root, "supabase/migrations/20261116120000_example.sql"),
    "create table public.example(id integer);",
  );
  writeFileSync(path.join(root, "supabase/functions/_shared/http.ts"), "new shared code");
  writeFileSync(path.join(root, "supabase/functions/device-register/index.ts"), "new function code");
  writeFileSync(path.join(root, "compose/docker-compose.yml"), "services: {}\n");
  const run = (flags: string[]) =>
    execFileSync(
      process.execPath,
      [path.join(root, "scripts/apply.mjs"), "--compose-dir", path.join(root, "compose"), ...flags],
      { encoding: "utf8" },
    );
  return { root, run };
}

function files(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(root, file), readFileSync(file, "utf8")];
      }),
  );
}

test("self-host dry-run preserves every existing function and marker", () => {
  const f = fixture();
  const dest = path.join(f.root, "compose/volumes/functions");
  mkdirSync(path.join(dest, "device-register"), { recursive: true });
  mkdirSync(path.join(dest, "_shared"), { recursive: true });
  writeFileSync(path.join(dest, "device-register/index.ts"), "live function code");
  writeFileSync(path.join(dest, "_shared/http.ts"), "live shared code");
  writeFileSync(path.join(dest, ".eco-functions-version.txt"), "existing deployment marker");
  const before = files(f.root);
  expect(f.run(["--dry-run"])).toContain("Done.");
  expect(files(f.root)).toEqual(before);
});

test("self-host dry-run never creates a missing function directory", () => {
  const f = fixture();
  expect(f.run(["--functions-only", "--dry-run"])).toContain("Done.");
  expect(existsSync(path.join(f.root, "compose/volumes"))).toBe(false);
});
