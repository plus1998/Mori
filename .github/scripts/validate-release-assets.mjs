#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";

const args = parseArgs(process.argv.slice(2));
const directory = path.resolve(args.directory);
const feedDirectory = path.resolve(args.feedDirectory);
const version = args.version;
const channel = args.channel;
const repository = args.repository || process.env.GITHUB_REPOSITORY || "plus1998/Mori";
const names = new Set(await readdir(directory));
const feedNames = new Set(await readdir(feedDirectory));
const macChannelFile = channel === "beta" ? "beta-mac.yml" : "latest-mac.yml";
const winChannelFile = channel === "beta" ? "beta.yml" : "latest.yml";
const linuxChannelFile = channel === "beta" ? "beta-linux.yml" : "latest-linux.yml";
const tag = version.startsWith("v") ? version : `v${version}`;
const assetBaseUrl = `https://github.com/${repository}/releases/download/${tag}`;

if (channel !== "beta" && channel !== "latest") {
  throw new Error(`Invalid channel: ${channel}`);
}

const required = [
  `Mori-${version}-mac-arm64.dmg`,
  `Mori-${version}-mac-arm64.zip`,
  `Mori-${version}-mac-arm64.zip.blockmap`,
  `Mori-${version}-mac-x64.dmg`,
  `Mori-${version}-mac-x64.zip`,
  `Mori-${version}-mac-x64.zip.blockmap`,
  `Mori-${version}-win-x64.exe`,
  `Mori-${version}-win-x64.exe.blockmap`,
  `Mori-${version}-linux-x64.AppImage`,
  macChannelFile,
  winChannelFile,
  linuxChannelFile,
  "SHA256SUMS",
];
for (const name of required) {
  if (!names.has(name)) {
    throw new Error(`Missing release asset: ${name}`);
  }
}

const unexpectedAssets = [...names].filter((name) => !required.includes(name));
if (unexpectedAssets.length > 0) {
  throw new Error(`Unexpected release assets: ${unexpectedAssets.join(", ")}`);
}

const wrongChannelFiles = [
  "beta.yml",
  "latest.yml",
  "beta-mac.yml",
  "latest-mac.yml",
  "beta-linux.yml",
  "latest-linux.yml",
].filter((name) => names.has(name) && ![macChannelFile, winChannelFile, linuxChannelFile].includes(name));
if (wrongChannelFiles.length > 0) {
  throw new Error(`Unexpected channel metadata: ${wrongChannelFiles.join(", ")}`);
}

const requiredFeed = [macChannelFile, winChannelFile, linuxChannelFile];
for (const name of requiredFeed) {
  if (!feedNames.has(name)) {
    throw new Error(`Missing update feed asset: ${name}`);
  }
}
const unexpectedFeed = [...feedNames].filter((name) => !requiredFeed.includes(name));
if (unexpectedFeed.length > 0) {
  throw new Error(`Unexpected update feed assets: ${unexpectedFeed.join(", ")}`);
}

for (const fileName of [macChannelFile, winChannelFile, linuxChannelFile]) {
  await validateRelativeMetadata(path.join(directory, fileName), fileName, names);
  await validateAbsoluteFeedMetadata(path.join(feedDirectory, fileName), fileName, names);
}

const macMetadata = load(await readFile(path.join(directory, macChannelFile), "utf8"));
const macUrls = macMetadata.files.map((file) => file.url);
if (
  !macUrls.some((url) => url.includes("arm64")) ||
  !macUrls.some((url) => url.includes("x64") && !url.includes("arm64"))
) {
  throw new Error(`${macChannelFile} does not contain both macOS architectures.`);
}

console.log(
  `Validated ${names.size} versioned assets and ${feedNames.size} feed pointers for ${version} (${channel}).`,
);

async function validateRelativeMetadata(filePath, fileName, assetNames) {
  const metadata = load(await readFile(filePath, "utf8"));
  if (!metadata || typeof metadata !== "object" || metadata.version !== version) {
    throw new Error(`Invalid metadata version in ${fileName}.`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error(`No files listed in ${fileName}.`);
  }
  for (const file of metadata.files) {
    if (typeof file?.url !== "string" || typeof file.sha512 !== "string" || !Number.isFinite(file.size)) {
      throw new Error(`Invalid file entry in ${fileName}.`);
    }
    if (fileName === macChannelFile && !file.url.endsWith(".zip")) {
      throw new Error(`${fileName} must reference ZIP update files: ${file.url}`);
    }
    if (file.url.includes("://") || !assetNames.has(file.url)) {
      throw new Error(`${fileName} must reference relative assets in the versioned release: ${file.url}`);
    }
  }
}

async function validateAbsoluteFeedMetadata(filePath, fileName, assetNames) {
  const metadata = load(await readFile(filePath, "utf8"));
  if (!metadata || typeof metadata !== "object" || metadata.version !== version) {
    throw new Error(`Invalid feed metadata version in ${fileName}.`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error(`No files listed in feed ${fileName}.`);
  }
  for (const file of metadata.files) {
    if (typeof file?.url !== "string" || typeof file.sha512 !== "string" || !Number.isFinite(file.size)) {
      throw new Error(`Invalid file entry in feed ${fileName}.`);
    }
    if (!file.url.startsWith(`${assetBaseUrl}/`)) {
      throw new Error(`Feed ${fileName} URL must start with ${assetBaseUrl}/: ${file.url}`);
    }
    const artifactName = file.url.slice(assetBaseUrl.length + 1);
    if (!assetNames.has(artifactName)) {
      throw new Error(`Feed ${fileName} references missing asset ${artifactName}.`);
    }
    if (fileName === macChannelFile && !artifactName.endsWith(".zip")) {
      throw new Error(`Feed ${fileName} must reference ZIP update files: ${artifactName}`);
    }
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        "Usage: validate-release-assets.mjs --directory DIR --feed-directory DIR --version VERSION --channel beta|latest [--repository owner/repo]",
      );
    }
    result[key.slice(2)] = value;
  }
  if (!result.directory || !result["feed-directory"] || !result.version || !result.channel) {
    throw new Error("Missing required release asset arguments.");
  }
  return {
    directory: result.directory,
    feedDirectory: result["feed-directory"],
    version: result.version,
    channel: result.channel,
    repository: result.repository,
  };
}
