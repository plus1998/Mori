import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { dump, load } from "js-yaml";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repository = "example/mori-release";

function script(name: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(repositoryRoot, ".github/scripts", name), ...args], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

for (const channel of ["beta", "latest"] as const) {
  test(`${channel} release assembles valid assets and preserves update channel routing`, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mori-release-assets-"));
    try {
      const version = channel === "beta" ? "0.3.1-beta.1" : "0.3.1";
      const raw = path.join(directory, "raw");
      const output = path.join(directory, "assets");
      const feed = path.join(directory, "feed");
      for (const platform of ["mac-arm64", "mac-x64", "win-x64", "linux-x64"]) {
        const target = path.join(raw, `eco-coding-${platform}`);
        mkdirSync(target, { recursive: true });
        const extensions = platform.startsWith("mac") ? ["dmg", "zip", "zip.blockmap"]
          : platform === "win-x64" ? ["exe", "exe.blockmap"] : ["AppImage"];
        for (const extension of extensions) {
          writeFileSync(path.join(target, `Mori-${version}-${platform}.${extension}`), `fixture ${platform} ${extension}`);
        }
        const updateExtension = platform.startsWith("mac") ? "zip" : platform === "win-x64" ? "exe" : "AppImage";
        const name = `Mori-${version}-${platform}.${updateExtension}`;
        const bytes = readFileSync(path.join(target, name));
        const suffix = platform.startsWith("mac") ? "-mac" : platform === "linux-x64" ? "-linux" : "";
        writeFileSync(path.join(target, `${channel}${suffix}.yml`), dump({
          version,
          path: name,
          sha512: createHash("sha512").update(bytes).digest("base64"),
          files: [{ url: name, sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length }],
        }));
      }
      const prepare = script("prepare-release-assets.mjs", [
        "--channel", channel, "--version", version, "--raw", raw,
        "--output", output, "--feed-output", feed, "--repository", repository,
      ]);
      expect(prepare.stderr).toBe("");
      expect(prepare.status).toBe(0);
      const validate = () => script("validate-release-assets.mjs", [
        "--channel", channel, "--version", version, "--directory", output,
        "--feed-directory", feed, "--repository", repository,
      ]);
      const result = validate();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(readdirSync(output)).toHaveLength(13);
      expect(readdirSync(feed)).toHaveLength(channel === "latest" ? 6 : 3);
      for (const suffix of ["", "-mac", "-linux"]) {
        const content = readFileSync(path.join(feed, `beta${suffix}.yml`), "utf8");
        const metadata = load(content) as { version: string; files: { url: string }[] };
        expect(metadata.version).toBe(version);
        for (const file of metadata.files) {
          expect(file.url.startsWith(`https://github.com/${repository}/releases/download/v${version}/`)).toBe(true);
        }
        if (channel === "latest") {
          expect(content).toBe(readFileSync(path.join(feed, `latest${suffix}.yml`), "utf8"));
        }
      }
      // Check the generated manifest against the actual assembled bytes.
      for (const line of readFileSync(path.join(output, "SHA256SUMS"), "utf8").trim().split("\n")) {
        const [digest, name] = line.split("  ");
        expect(createHash("sha256").update(readFileSync(path.join(output, name!))).digest("hex")).toBe(digest);
      }
      if (channel === "latest") {
        rmSync(path.join(feed, "beta-mac.yml"));
        expect(validate().stderr).toContain("Missing update feed asset: beta-mac.yml");
        const canonical = readFileSync(path.join(feed, "latest-mac.yml"), "utf8");
        writeFileSync(path.join(feed, "beta-mac.yml"), `${canonical}\n`);
        expect(validate().stderr).toContain("must match latest-mac.yml");
        writeFileSync(path.join(feed, "beta-mac.yml"), canonical.replaceAll(`/v${version}/`, "/v0.3.0/"));
        expect(validate().stderr).toContain("URL must start with");
      } else {
        // Publishing a beta must never overwrite stable clients' latest pointers.
        expect(readdirSync(feed).some((name) => name.startsWith("latest"))).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
