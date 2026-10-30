/**
 * Generate Mori's default Codex Pets v2 atlas from the existing Mori vector.
 * Requires rsvg-convert. The SVG intermediate is written outside the repository.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const original = readFileSync(path.join(desktopDir, "src/renderer/assets/mori.svg"), "utf8");
const body = original.match(/<g class="mori-icon-head">([\s\S]*?)<g class="mori-icon-gaze">/)?.[1];
if (!body) throw new Error("Cannot find Mori's original vector body.");

const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
const oscillate = (frame, count) => Math.sin((frame * Math.PI * 2) / count);
function sprite(row, frame) {
  const count = counts[row];
  const wave = oscillate(frame, count);
  let tilt = 0;
  let lift = 0;
  let gazeX = 0;
  let gazeY = 0;
  let mouthX = 0;
  let blink = 1;
  let smile = "M22.4 33.4Q24.6 35.4 26.8 33.1";
  let arm = "";
  let working = "";
  if (row === 0) {
    lift = -0.25 * wave;
    blink = frame === 2 ? 0.18 : 1;
  } else if (row === 1 || row === 2) {
    const direction = row === 1 ? 1 : -1;
    tilt = direction * (4 + wave * 5);
    lift = -Math.abs(wave) * 0.9;
    gazeX = direction * 2.2;
    mouthX = direction * 1.4;
  } else if (row === 3) {
    tilt = [-3, 2, -2, 0][frame];
    const tip = [18, 14, 19, 15][frame];
    arm = `<path d="M37.5 29 Q43 27 43 ${tip}" fill="none" stroke="#527B65" stroke-width="3.6" stroke-linecap="round"/><circle cx="43" cy="${tip}" r="2" fill="#8CAF95"/>`;
  } else if (row === 4) {
    lift = [0, -2.5, -5, -2.5, 0][frame];
  } else if (row === 5) {
    tilt = wave * 4;
    gazeY = 0.8;
    blink = frame === 3 || frame === 4 ? 0.32 : 0.72;
    smile = "M22.4 34Q24.6 32.4 26.8 34";
  } else if (row === 6) {
    tilt = -3 + wave * 2;
    gazeY = -1;
    blink = frame === 3 ? 0.25 : 1;
    smile = "M23 33.2Q24.6 34 26.2 33.2";
  } else if (row === 7) {
    tilt = wave * 2;
    gazeX = 0.7;
    gazeY = 0.7;
    working = `<g transform="translate(0 ${wave * 0.4})"><rect x="30.5" y="31.5" width="12" height="10" rx="2.2" fill="#F5F1D9" stroke="#527B65" stroke-width="1"/><path d="M33 34.5h7M33 37h5" stroke="#89A98D" stroke-width="1" stroke-linecap="round"/><path d="M37.5 29.5l3-3 1.6 1.6-3 3-1.9.3z" fill="#D9AE6B" stroke="#527B65" stroke-width=".65" stroke-linejoin="round"/></g>`;
  } else if (row === 8) {
    tilt = [-3, -1, 2, 3, 1, -1][frame];
    gazeX = [-1.1, -0.6, 0.5, 1.1, 0.4, -0.5][frame];
    gazeY = -0.6;
    blink = frame === 4 ? 0.3 : 1;
  } else {
    const direction = (row - 9) * 8 + frame;
    const radians = (direction * Math.PI) / 8;
    gazeX = Math.sin(radians) * 1.6;
    gazeY = -Math.cos(radians) * 1.2;
  }
  return `<g transform="translate(0 ${2 + lift})"><g transform="rotate(${tilt} 24 30)">${arm}${body}
    <g transform="translate(${gazeX} ${gazeY})"><g transform="translate(0 27.15) scale(1 ${blink}) translate(0 -27.15)" fill="#F1F5DC"><rect x="16.8" y="24" width="4.2" height="6.3" rx="2.1"/><rect x="28.2" y="24" width="4.2" height="6.3" rx="2.1"/></g></g>
    <path d="${smile}" transform="translate(${mouthX} 0)" stroke="#F1F5DC" stroke-width="1.5" stroke-linecap="round" fill="none"/>${working}</g></g>`;
}

const cells = counts.flatMap((count, row) =>
  Array.from(
    { length: count },
    (_, column) =>
      `<svg x="${column * 192}" y="${row * 208}" width="192" height="208" viewBox="0 0 48 52">${sprite(row, column)}</svg>`,
  ),
);
const atlas = `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="2288">${cells.join("")}</svg>`;
const tempDir = mkdtempSync(path.join(os.tmpdir(), "mori-pet-atlas-"));
try {
  const source = path.join(tempDir, "atlas.svg");
  writeFileSync(source, atlas);
  execFileSync(
    "rsvg-convert",
    ["-o", path.join(desktopDir, "src/renderer/assets/mori-pet/spritesheet.png"), source],
    { stdio: "inherit" },
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
