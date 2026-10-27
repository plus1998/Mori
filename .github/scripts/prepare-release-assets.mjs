#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dump, load } from "js-yaml";
import {
  absolutizeUpdateMetadata,
  resolveGitHubRepository,
  resolveVersionedAssetBaseUrl,
} from "../../apps/desktop/scripts/release-repository.mjs";

const args = parseArgs(process.argv.slice(2));
const channel = args.channel;
const version = args.version;
const rawDirectory = path.resolve(args.raw);
const outputDirectory = path.resolve(args.output);
const feedDirectory = path.resolve(args.feedOutput);
const repository = resolveGitHubRepository({
  ...(args.repository ? { ECO_RELEASE_REPOSITORY: args.repository } : {}),
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
});
const assetBaseUrl = resolveVersionedAssetBaseUrl(repository, version);
const channelMacFile = channel === "beta" ? "beta-mac.yml" : "latest-mac.yml";
const channelFile = channel === "beta" ? "beta.yml" : "latest.yml";
const channelLinuxFile = channel === "beta" ? "beta-linux.yml" : "latest-linux.yml";
const updateMetadataNames = new Set([
  "beta.yml",
  "latest.yml",
  "beta-mac.yml",
  "latest-mac.yml",
  "beta-linux.yml",
  "latest-linux.yml",
]);
const artifactNames = new Set([
  `Mori-${version}-mac-arm64.dmg`,
  `Mori-${version}-mac-arm64.zip`,
  `Mori-${version}-mac-arm64.zip.blockmap`,
  `Mori-${version}-mac-x64.dmg`,
  `Mori-${version}-mac-x64.zip`,
  `Mori-${version}-mac-x64.zip.blockmap`,
  `Mori-${version}-win-x64.exe`,
  `Mori-${version}-win-x64.exe.blockmap`,
  `Mori-${version}-linux-x64.AppImage`,
]);

if (channel !== "beta" && channel !== "latest") {
  throw new Error(`Invalid channel: ${channel}`);
}

const directories = {
  macArm64: path.join(rawDirectory, "eco-coding-mac-arm64"),
  macX64: path.join(rawDirectory, "eco-coding-mac-x64"),
  winX64: path.join(rawDirectory, "eco-coding-win-x64"),
  linuxX64: path.join(rawDirectory, "eco-coding-linux-x64"),
};
for (const [name, directory] of Object.entries(directories)) {
  await assertDirectory(directory, name);
}

await rm(outputDirectory, { recursive: true, force: true });
await rm(feedDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await mkdir(feedDirectory, { recursive: true });

const copiedNames = new Set();
await copyAssets(directories.macArm64, outputDirectory, updateMetadataNames);
await copyAssets(directories.macX64, outputDirectory, updateMetadataNames);
await copyAssets(directories.winX64, outputDirectory, updateMetadataNames);
await copyAssets(directories.linuxX64, outputDirectory, updateMetadataNames);

const winMetadata = await readMetadata(path.join(directories.winX64, channelFile));
const linuxMetadata = await readMetadata(path.join(directories.linuxX64, channelLinuxFile));
const mergedMacMetadata = await mergeMacMetadata(
  path.join(directories.macArm64, channelMacFile),
  path.join(directories.macX64, channelMacFile),
);

// Versioned Release keeps relative yml next to binaries (manual inspection / mirrors).
await writeChannelMetadata(outputDirectory, channelFile, winMetadata);
await writeChannelMetadata(outputDirectory, channelLinuxFile, linuxMetadata);
await writeChannelMetadata(outputDirectory, channelMacFile, mergedMacMetadata);
copiedNames.add(channelFile);
copiedNames.add(channelLinuxFile);
copiedNames.add(channelMacFile);

// Feed Release pointers use absolute binary URLs under the versioned tag.
await writeChannelMetadata(feedDirectory, channelFile, absolutizeUpdateMetadata(winMetadata, assetBaseUrl));
await writeChannelMetadata(
  feedDirectory,
  channelLinuxFile,
  absolutizeUpdateMetadata(linuxMetadata, assetBaseUrl),
);
await writeChannelMetadata(
  feedDirectory,
  channelMacFile,
  absolutizeUpdateMetadata(mergedMacMetadata, assetBaseUrl),
);

const allowedGeneratedNames = new Set([channelMacFile, channelFile, channelLinuxFile]);
for (const name of await readdir(outputDirectory)) {
  if (name === "SHA256SUMS") {
    continue;
  }
  if (copiedNames.has(name) || allowedGeneratedNames.has(name)) {
    continue;
  }
  throw new Error(`Unexpected release asset in output: ${name}`);
}

const names = await readdir(outputDirectory);
const checksumLines = [];
for (const name of names.sort()) {
  if (name === "SHA256SUMS") {
    continue;
  }
  const digest = createHash("sha256")
    .update(await readFile(path.join(outputDirectory, name)))
    .digest("hex");
  checksumLines.push(`${digest}  ${name}`);
}
await writeFile(path.join(outputDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");
console.log(
  `Prepared ${checksumLines.length} versioned assets in ${outputDirectory}; feed pointers in ${feedDirectory} (${assetBaseUrl})`,
);

async function writeChannelMetadata(directory, name, metadata) {
  await writeFile(path.join(directory, name), dump(metadata, { noRefs: true }), "utf8");
}

async function copyAssets(sourceDirectory, destinationDirectory, skippedNames = new Set()) {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || skippedNames.has(entry.name) || !artifactNames.has(entry.name)) {
      continue;
    }
    if (copiedNames.has(entry.name)) {
      throw new Error(`Duplicate release asset name: ${entry.name}`);
    }
    await copyFile(path.join(sourceDirectory, entry.name), path.join(destinationDirectory, entry.name));
    copiedNames.add(entry.name);
  }
}

async function mergeMacMetadata(arm64Path, x64Path) {
  const [arm64, x64] = await Promise.all([readMetadata(arm64Path), readMetadata(x64Path)]);
  if (arm64.version !== x64.version || arm64.version !== version) {
    throw new Error(
      `macOS metadata version mismatch: expected ${version}, got ${arm64.version} and ${x64.version}`,
    );
  }
  const files = [...(arm64.files ?? []), ...(x64.files ?? [])].filter(
    (file) => typeof file?.url === "string" && file.url.endsWith(".zip"),
  );
  if (files.length === 0) {
    throw new Error("macOS metadata contains no files.");
  }
  const seen = new Set();
  for (const file of files) {
    if (!file || typeof file !== "object" || typeof file.url !== "string") {
      throw new Error("macOS metadata contains an invalid file entry.");
    }
    if (!file.url.endsWith(".zip") || typeof file.sha512 !== "string" || !Number.isFinite(file.size)) {
      throw new Error(`Invalid macOS update file entry: ${file.url}`);
    }
    if (seen.has(file.url)) {
      throw new Error(`Duplicate macOS update file: ${file.url}`);
    }
    seen.add(file.url);
  }
  const hasArm64 = files.some((file) => file.url.includes("arm64"));
  const hasX64 = files.some((file) => file.url.includes("x64") && !file.url.includes("arm64"));
  if (!hasArm64 || !hasX64) {
    throw new Error("Merged macOS metadata must contain both arm64 and x64 ZIP entries.");
  }
  const { path: _path, sha512: _sha512, sha2: _sha2, size: _size, ...shared } = arm64;
  return { ...shared, files };
}

async function readMetadata(filePath) {
  const value = load(await readFile(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid YAML metadata: ${filePath}`);
  }
  return value;
}

async function assertDirectory(directory, label) {
  try {
    const entries = await readdir(directory);
    if (entries.length === 0) {
      throw new Error(`${label} artifact directory is empty: ${directory}`);
    }
  } catch (error) {
    throw new Error(`Missing ${label} artifact directory: ${directory}`, { cause: error });
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        "Usage: prepare-release-assets.mjs --channel beta|latest --version VERSION --raw DIR --output DIR --feed-output DIR [--repository owner/repo]",
      );
    }
    result[key.slice(2)] = value;
  }
  if (!result.channel || !result.version || !result.raw || !result.output || !result["feed-output"]) {
    throw new Error("Missing required release asset arguments.");
  }
  return {
    channel: result.channel,
    version: result.version,
    raw: result.raw,
    output: result.output,
    feedOutput: result["feed-output"],
    repository: result.repository,
  };
}
