#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDesktopUpdateFeedUrl, resolveGitHubRepository } from "./release-repository.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(desktopRoot, "package.json");
const distPath = path.join(desktopRoot, "dist");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const version = process.env.ECO_RELEASE_VERSION?.trim() || packageJson.version;
const channel = process.env.ECO_RELEASE_CHANNEL?.trim() || resolveChannel(version);
const isReleaseBuild = Boolean(process.env.ECO_RELEASE_CHANNEL?.trim());
const unsigned = process.env.ECO_RELEASE_UNSIGNED !== "false";
const repository = resolveGitHubRepository();
const releaseUrl = process.env.ECO_RELEASE_URL?.trim() || `https://github.com/${repository.slug}/releases`;
const updateFeedUrl = process.env.ECO_UPDATE_FEED_URL?.trim() || resolveDesktopUpdateFeedUrl(repository);

if (channel !== "beta" && channel !== "latest") {
  throw new Error(`Invalid ECO_RELEASE_CHANNEL: ${channel}`);
}

// Fixed self-signing supports Squirrel updates without Developer ID notarization.
// Keep the explicit override for releases that intentionally require manual installation.
const macMode = process.env.ECO_MAC_UPDATE_MODE?.trim() || "auto";
const updateModes = isReleaseBuild
  ? {
      darwin: macMode,
      win32: process.env.ECO_WINDOWS_UPDATE_MODE?.trim() || "auto",
      linux: process.env.ECO_LINUX_UPDATE_MODE?.trim() || "auto",
    }
  : {
      darwin: "disabled",
      win32: "disabled",
      linux: "disabled",
    };

for (const [platform, mode] of Object.entries(updateModes)) {
  if (mode !== "auto" && mode !== "manual" && mode !== "disabled") {
    throw new Error(`Invalid update mode for ${platform}: ${mode}`);
  }
}

await mkdir(distPath, { recursive: true });
await writeFile(
  path.join(distPath, "release-manifest.json"),
  `${JSON.stringify({ version, channel, unsigned, releaseUrl, updateFeedUrl, updateModes }, null, 2)}\n`,
  "utf8",
);

console.log(
  `Wrote release manifest: ${version} (${channel}), feed=${updateFeedUrl}, unsigned=${unsigned}, modes=${JSON.stringify(updateModes)}`,
);

function resolveChannel(value) {
  return /^\d+\.\d+\.\d+-beta\.\d+$/.test(value) ? "beta" : "latest";
}
