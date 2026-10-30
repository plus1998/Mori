#!/usr/bin/env node
/**
 * Build platform icons from repo-root logo.png into apps/desktop/packaging/.
 * Requires Bun 1.4+ (Bun.Image). macOS .icns still needs iconutil on darwin.
 *
 * Windows bakes transparent rounded corners into the ICO. Opaque white fills are
 * invisible on this logo; 32-bit DIB frames keep Explorer shortcuts reliable.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeIcoFromRgba } from "./encode-ico.mjs";
import { decodePngToRgba, encodeRgbaToPng } from "./png-rgba.mjs";
import {
  applyTransparentRoundedProductIcon,
  bakeTransparentRoundedPng,
  WINDOWS_CORNER_FRACTION,
} from "./rounded-product-icon.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const packagingDir = path.join(desktopRoot, "packaging");
const publicDir = path.join(desktopRoot, "public");
const sourceLogo = path.join(repoRoot, "logo.png");

const WINDOWS_ICO_SIZES = [256, 128, 64, 48, 32, 16];

function assertBunImage() {
  if (typeof Bun === "undefined" || typeof Bun.file !== "function") {
    throw new Error("generate-icons requires Bun 1.4+ (Bun.Image). Run: bun run icons");
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status ?? "unknown"})`);
  }
}

async function resizeSquarePng(inputPath, size, { rounded = false } = {}) {
  const pngBytes = await Bun.file(inputPath).image().resize(size, size, { fit: "fill" }).png().bytes();
  if (!rounded) {
    return pngBytes;
  }
  return bakeTransparentRoundedPng(pngBytes, WINDOWS_CORNER_FRACTION);
}

async function resizeSquareRgba(inputPath, size, { rounded = false } = {}) {
  const pngBytes = await resizeSquarePng(inputPath, size, { rounded });
  return decodePngToRgba(pngBytes);
}

async function writeSquarePng(inputPath, outputPath, size, { rounded = false } = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const pngBytes = await resizeSquarePng(inputPath, size, { rounded });
  fs.writeFileSync(outputPath, pngBytes);
}

async function buildIco(inputPath, outputPath) {
  const frames = await Promise.all(
    WINDOWS_ICO_SIZES.map(async (size) => {
      const { data } = await resizeSquareRgba(inputPath, size, { rounded: true });
      return { size, data };
    }),
  );
  fs.writeFileSync(outputPath, encodeIcoFromRgba(frames));
}

async function buildIcns(inputPng, outputPath) {
  if (process.platform !== "darwin") {
    console.warn(
      "Skipping icon.icns (iconutil is macOS-only). Pack macOS builds on darwin or commit icon.icns.",
    );
    return;
  }

  const iconsetDir = path.join(packagingDir, "Mori.iconset");
  fs.rmSync(iconsetDir, { force: true, recursive: true });
  fs.mkdirSync(iconsetDir, { recursive: true });
  const sizes = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  try {
    for (const [name, px] of sizes) {
      const out = path.join(iconsetDir, name);
      if (px === 1024) {
        fs.copyFileSync(inputPng, out);
        continue;
      }
      await Bun.file(inputPng).image().resize(px, px, { fit: "fill" }).png().write(out);
    }
    run("iconutil", ["-c", "icns", iconsetDir, "-o", outputPath]);
  } finally {
    fs.rmSync(iconsetDir, { force: true, recursive: true });
  }
}

async function main() {
  assertBunImage();
  if (!fs.existsSync(sourceLogo)) {
    console.error(`Source logo not found: ${sourceLogo}`);
    process.exit(1);
  }

  fs.mkdirSync(packagingDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  const pngOut = path.join(packagingDir, "icon.png");
  const icnsOut = path.join(packagingDir, "icon.icns");
  const icoOut = path.join(packagingDir, "icon.ico");
  const publicPng = path.join(publicDir, "icon.png");
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "eco-coding-icons-"));
  const macPng = path.join(temporaryDir, "icon-macos-square.png");

  try {
    await writeSquarePng(sourceLogo, pngOut, 512, { rounded: true });
    fs.copyFileSync(pngOut, publicPng);
    await buildIco(sourceLogo, icoOut);
    await writeSquarePng(sourceLogo, macPng, 1024);
    await buildIcns(macPng, icnsOut);
  } finally {
    fs.rmSync(temporaryDir, { force: true, recursive: true });
  }

  console.log("Generated:");
  for (const file of [pngOut, icnsOut, icoOut, publicPng]) {
    if (fs.existsSync(file)) {
      console.log(`  ${path.relative(desktopRoot, file)}`);
    }
  }
}

await main();
