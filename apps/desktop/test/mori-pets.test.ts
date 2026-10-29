import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { MoriPets, petImageDimensions, readMoriPetDirectory } from "../src/main/mori-pets";
import {
  MORI_PET_ANIMATIONS,
  missingMoriPetFrame,
  moriPetFrameDuration,
  moriPetHitTest,
  moriPetIndicatorAnchor,
  moriPetLookDirection,
  moriPetVisibleBounds,
  resizeMoriPetBounds,
} from "../src/shared/mori-pet";
import { removeTempDirectory } from "./helpers/temp-directory";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempDirectory));
});
async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-pets-test-"));
  roots.push(root);
  return root;
}
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}
function transparentPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function writePet(dir: string, version: 1 | 2) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "spritesheet.png"), transparentPng(1536, version === 1 ? 1872 : 2288));
  await fs.writeFile(
    path.join(dir, "pet.json"),
    JSON.stringify({
      id: "test",
      displayName: "测试宠物",
      spritesheetPath: "spritesheet.png",
      spriteVersionNumber: version,
    }),
  );
}

test("imports and reads Codex Pets v1 and v2 with their original atlas bytes", async () => {
  const root = await temp();
  const pets = new MoriPets(path.join(root, "data"));
  for (const version of [1, 2] as const) {
    const source = path.join(root, `source-${version}`);
    await writePet(source, version);
    const imported = await pets.import(source);
    expect(imported.version).toBe(version);
    const asset = await pets.asset(imported.key);
    expect(Buffer.from(asset.image.split(",")[1] ?? "", "base64")).toEqual(
      await fs.readFile(path.join(source, "spritesheet.png")),
    );
  }
  const list = await pets.list();
  expect(list.pets.filter((pet) => pet.key.startsWith("mori:"))).toHaveLength(2);
  expect(list.errors.filter((error) => error.startsWith("mori:"))).toEqual([]);
});

test("rejects mismatched versions, invalid dimensions and images outside the pet directory", async () => {
  const root = await temp();
  const dir = path.join(root, "pet");
  await writePet(dir, 1);
  const manifest = { displayName: "测试", spritesheetPath: "spritesheet.png", spriteVersionNumber: 2 };
  await fs.writeFile(path.join(dir, "pet.json"), JSON.stringify(manifest));
  await expect(readMoriPetDirectory(dir, "test")).rejects.toThrow("不一致");
  await fs.writeFile(path.join(dir, "spritesheet.png"), transparentPng(100, 100));
  await expect(readMoriPetDirectory(dir, "test")).rejects.toThrow("尺寸");
  await fs.writeFile(path.join(root, "outside.png"), transparentPng(1536, 1872));
  await fs.writeFile(
    path.join(dir, "pet.json"),
    JSON.stringify({ ...manifest, spritesheetPath: "../outside.png" }),
  );
  await expect(readMoriPetDirectory(dir, "test")).rejects.toThrow("目录内");
});

test("all nine Codex action rows and the sixteen clockwise v2 gaze directions are mapped", () => {
  expect(Object.values(MORI_PET_ANIMATIONS).map((row) => [row.row, row.durations.length])).toEqual([
    [0, 6],
    [1, 8],
    [2, 8],
    [3, 4],
    [4, 5],
    [5, 8],
    [6, 6],
    [7, 6],
    [8, 6],
  ]);
  for (let index = 0; index < 16; index++) {
    const radians = (index * Math.PI) / 8;
    expect(moriPetLookDirection(Math.sin(radians), -Math.cos(radians))).toBe(index);
  }
});

test("reads extended WebP atlas dimensions", () => {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0);
  header.write("WEBP", 8);
  header.write("VP8X", 12);
  header.writeUIntLE(1535, 24, 3);
  header.writeUIntLE(2287, 27, 3);
  expect(petImageDimensions(header)).toEqual({ width: 1536, height: 2288 });
});

test("default Mori blinks less often without changing imported pet timings", () => {
  expect(moriPetFrameDuration("builtin:mori", "idle", 0)).toBe(6500);
  expect(moriPetFrameDuration("codex:doro", "idle", 0)).toBe(280);
  expect(moriPetFrameDuration("builtin:mori", "waving", 0)).toBe(140);
});

test("resizing preserves the center when possible and keeps the pet within its display", () => {
  const area = { x: 100, y: 100, width: 800, height: 600 };
  expect(resizeMoriPetBounds({ x: 300, y: 300, width: 64, height: 64 }, 128, area)).toEqual({
    x: 268,
    y: 268,
    width: 128,
    height: 128,
  });
  expect(resizeMoriPetBounds({ x: 836, y: 636, width: 64, height: 64 }, 192, area)).toEqual({
    x: 708,
    y: 508,
    width: 192,
    height: 192,
  });
});

test("bundled Mori pet uses the Codex Pets v2 atlas dimensions", async () => {
  const pet = await readMoriPetDirectory(
    path.join(import.meta.dir, "../src/renderer/assets/mori-pet"),
    "mori",
  );
  expect(pet.info.version).toBe(2);
  expect(petImageDimensions(pet.image)).toEqual({ width: 1536, height: 2288 });
});

test("reports the first missing action or v2 gaze frame", () => {
  const width = 1536;
  const pixels = new Uint8ClampedArray(width * 2288 * 4);
  expect(missingMoriPetFrame(pixels, width, 1)).toContain("idle");
  for (const animation of Object.values(MORI_PET_ANIMATIONS)) {
    for (let column = 0; column < animation.durations.length; column++)
      pixels[(animation.row * 208 * width + column * 192) * 4 + 3] = 255;
  }
  expect(missingMoriPetFrame(pixels, width, 1)).toBeUndefined();
  expect(missingMoriPetFrame(pixels, width, 2)).toContain("视线方向");
});

test("status bubbles follow the idle head rather than transparent padding, shadows or arms", () => {
  const width = 1536;
  const pixels = new Uint8ClampedArray(width * 208 * 4);
  expect(moriPetIndicatorAnchor(pixels, width)).toBeUndefined();
  for (let y = 40; y <= 180; y++) {
    for (let x = 50; x <= 110; x++) pixels[(y * width + x) * 4 + 3] = 255;
  }
  pixels[(150 * width + 170) * 4 + 3] = 255; // An outstretched arm below the head.
  pixels[(4 * width + 190) * 4 + 3] = 20; // Faint shadow outside the silhouette.
  pixels[(2 * width + 220) * 4 + 3] = 255; // The next atlas cell must not affect the anchor.
  expect(moriPetIndicatorAnchor(pixels, width)).toEqual({ x: 111 / 192, y: 54 / 208 });
});

test("visible bounds include all used action and gaze frames without unused cells or faint shadows", () => {
  const width = 1536;
  const pixels = new Uint8ClampedArray(width * 2288 * 4);
  expect(moriPetVisibleBounds(pixels, width, 2)).toBeUndefined();
  const point = (row: number, col: number, x: number, y: number, alpha = 255) => {
    pixels[((row * 208 + y) * width + col * 192 + x) * 4 + 3] = alpha;
  };
  point(0, 0, 70, 60);
  point(0, 5, 120, 175);
  point(4, 4, 60, 30); // Jumping must not be clipped or change the scale.
  point(0, 7, 0, 0); // Unused idle cell.
  point(0, 0, 10, 10, 8); // Faint shadow.
  expect(moriPetVisibleBounds(pixels, width, 1)).toEqual({ x: 59, y: 29, width: 63, height: 148 });
  point(10, 7, 140, 190);
  expect(moriPetVisibleBounds(pixels, width, 2)).toEqual({ x: 59, y: 29, width: 83, height: 163 });
});

test("pixel hit testing passes through transparent corners and internal holes", () => {
  const map = { width: 5, height: 5, alpha: new Uint8Array(25) };
  for (let i = 0; i < 5; i++) {
    map.alpha[2 * 5 + i] = 255;
    map.alpha[i * 5 + 2] = 255;
  }
  map.alpha[12] = 0;
  expect(moriPetHitTest(map, 2.9, 1.2)).toBe(true);
  expect(moriPetHitTest(map, 0, 0)).toBe(false);
  expect(moriPetHitTest(map, 2, 2)).toBe(false);
  expect(moriPetHitTest(map, -0.1, 2)).toBe(false);
  expect(moriPetHitTest(map, 5, 2)).toBe(false);
  map.alpha[12] = 15;
  expect(moriPetHitTest(map, 2, 2)).toBe(false);
  map.alpha[12] = 16;
  expect(moriPetHitTest(map, 2, 2)).toBe(true);
});
