/**
 * Pack Mori's approved painted artwork into the Codex Pets v2 atlas and UI icons.
 * Run with Node/Bun; requires rsvg-convert for raster resampling/compositing.
 * SVG is only a temporary bitmap layout, never a redrawing of the character.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePngToRgba, encodeRgbaToPng } from "./png-rgba.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetDir = path.join(desktopDir, "src/renderer/assets/mori-pet");
const cellWidth = 192;
const cellHeight = 208;
const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];

function readFrames(filename, columns, rows) {
  const image = decodePngToRgba(readFileSync(path.join(assetDir, filename)));
  const frames = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x0 = Math.floor((column * image.width) / columns);
      const x1 = Math.floor(((column + 1) * image.width) / columns);
      const y0 = Math.floor((row * image.height) / rows);
      const y1 = Math.floor(((row + 1) * image.height) / rows);
      if (image.data[(y0 * image.width + x0) * 4 + 3] >= 16) {
        throw new Error(`${filename}, frame ${frames.length}: expected a transparent background.`);
      }
      let left = x1;
      let top = y1;
      let right = -1;
      let bottom = -1;
      let area = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (image.data[(y * image.width + x) * 4 + 3] < 32) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
          area++;
        }
      }
      if (area < 1000) throw new Error(`${filename}, frame ${frames.length}: artwork is missing.`);
      // Register the resting foot, preserving the painted lean above it.
      let footWeight = 0;
      let footX = 0;
      const footTop = bottom - Math.ceil((bottom - top + 1) * 0.1);
      for (let y = footTop; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const alpha = image.data[(y * image.width + x) * 4 + 3];
          if (alpha < 32) continue;
          footX += x * alpha;
          footWeight += alpha;
        }
      }
      left = Math.max(x0, left - 1);
      top = Math.max(y0, top - 1);
      right = Math.min(x1 - 1, right + 1);
      bottom = Math.min(y1 - 1, bottom + 1);
      const width = right - left + 1;
      const height = bottom - top + 1;
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        const start = ((top + y) * image.width + left) * 4;
        data.set(image.data.subarray(start, start + width * 4), y * width * 4);
      }
      frames.push({
        uri: `data:image/png;base64,${encodeRgbaToPng({ data, width, height }).toString("base64")}`,
        width,
        height,
        anchorX: footX / footWeight - left,
        anchorY: height - 1,
        // Match visual mass across the two painted sheets without flattening poses.
        scale: Math.sqrt(14400 / area),
      });
    }
  }
  return frames;
}

const actions = readFrames("actions.png", 4, 3);
const looks = readFrames("poses.png", 4, 4);
const wave = (frame, count) => Math.sin((frame * Math.PI * 2) / count);

function pose(row, frame) {
  const count = counts[row];
  const oscillation = wave(frame, count);
  const p = { art: actions[0], x: 0, y: 0, tilt: 0, sx: 1, sy: 1 };
  if (row === 0) {
    p.art = actions[[0, 0, 1, 0, 1, 0][frame]];
    p.sx = 1 + oscillation * 0.006;
    p.sy = 1 - oscillation * 0.009;
  } else if (row === 1 || row === 2) {
    const direction = row === 1 ? 1 : -1;
    const hop = Math.abs(oscillation);
    p.art = actions[row === 1 ? 4 : 5];
    p.tilt = direction * (3 + oscillation * 2);
    p.y = -hop * 10;
    p.sx = 1.035 - hop * 0.065;
    p.sy = 0.965 + hop * 0.065;
  } else if (row === 3) {
    p.art = actions[frame === 3 ? 0 : 2];
    p.tilt = [-4, 5, -3, 0][frame];
    p.y = [0, -6, -4, 0][frame];
  } else if (row === 4) {
    p.art = actions[[2, 2, 3, 3, 2][frame]];
    p.y = [0, -13, -27, -11, 0][frame];
    p.tilt = [-2, -2, 1, 2, 0][frame];
    p.sx = [1.1, 0.97, 0.96, 1.02, 1][frame];
    p.sy = [0.88, 1.05, 1.06, 0.98, 1][frame];
  } else if (row === 5) {
    p.art = actions[8];
    p.tilt = [-3, 3, -2, 2, -1, 0, 0, 0][frame];
    p.sx = 1.015;
    p.sy = 0.98;
  } else if (row === 6) {
    p.art = actions[7];
    p.tilt = [-4, -3, -1, -2, -4, -4][frame];
    p.sy = 1 + oscillation * 0.008;
  } else if (row === 7) {
    p.art = actions[6];
    p.tilt = oscillation * 1.5;
    p.sy = 0.99 - oscillation * 0.012;
  } else if (row === 8) {
    p.art = actions[[10, 10, 9, 11, 11, 9][frame]];
    p.tilt = [-3, -1, 1, 3, 1, -1][frame];
  } else {
    p.art = looks[(row - 9) * 8 + frame];
  }
  return p;
}

function bitmap(art, scale = art.scale) {
  return `<image href="${art.uri}" x="${-art.anchorX * scale}" y="${-art.anchorY * scale}" width="${art.width * scale}" height="${art.height * scale}"/>`;
}

const cells = counts.flatMap((count, row) =>
  Array.from({ length: count }, (_, column) => {
    const p = pose(row, column);
    return `<svg x="${column * cellWidth}" y="${row * cellHeight}" width="${cellWidth}" height="${cellHeight}" viewBox="0 0 ${cellWidth} ${cellHeight}"><g transform="translate(${96 + p.x} ${190 + p.y}) rotate(${p.tilt}) scale(${p.sx} ${p.sy})">${bitmap(p.art)}</g></svg>`;
  }),
);

// Four painted UI moods, kept separate from the much larger desktop pet atlas.
const icons = [2, 6, 7, 8].map((index, column) => {
  const art = actions[index];
  const scale = 230 / Math.max(...[2, 6, 7, 8].map((i) => actions[i].width));
  return `<svg x="${column * 256}" width="256" height="256"><g transform="translate(128 246)">${bitmap(art, scale)}</g></svg>`;
});
const tempDir = mkdtempSync(path.join(os.tmpdir(), "mori-pet-atlas-"));
try {
  for (const [filename, width, height, content] of [
    ["spritesheet.png", 1536, 2288, cells.join("")],
    ["icons.png", 1024, 256, icons.join("")],
  ]) {
    const source = path.join(tempDir, `${filename}.svg`);
    writeFileSync(
      source,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${content}</svg>`,
    );
    execFileSync("rsvg-convert", ["-o", path.join(assetDir, filename), source], { stdio: "inherit" });
    console.log(`Generated ${path.relative(desktopDir, path.join(assetDir, filename))}`);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
