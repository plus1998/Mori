import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MoriAssistantStore, parseAssistantSettings } from "../src/main/mori-assistant-store";
import { moriAvatarCrop, type MoriAvatarSettings } from "../src/shared/mori-avatar";

const avatar: MoriAvatarSettings = { petKey: "codex:doro", animation: "idle", frame: 0, zoom: 1.3 };

test("legacy settings keep the original avatar and independent pet selection survives save/load", async () => {
  expect(parseAssistantSettings({ petKey: "codex:clawd" }).avatar).toBeNull();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-avatar-test-"));
  try {
    const store = new MoriAssistantStore(path.join(dir, "assistant.json"));
    store.state.settings = parseAssistantSettings({ avatar, petKey: "codex:clawd" });
    await store.save();
    const restored = new MoriAssistantStore(store.filePath);
    await restored.load();
    expect(restored.state.settings.avatar).toEqual(avatar);
    expect(restored.state.settings.petKey).toBe("codex:clawd");
    expect(parseAssistantSettings({ ...restored.state.settings, avatar: null }).avatar).toBeNull();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("invalid avatar sources, poses, frames and zooms fail explicitly", () => {
  for (const value of [[], "doro", {}, { ...avatar, petKey: "file:/tmp/pet" },
    { ...avatar, petKey: "codex:../doro" }, { ...avatar, animation: "__proto__" },
    { ...avatar, frame: 6 }, { ...avatar, frame: -1 }, { ...avatar, frame: 0.5 },
    { ...avatar, zoom: NaN }, { ...avatar, zoom: 0.9 }, { ...avatar, zoom: 2.6 }]) {
    expect(() => parseAssistantSettings({ avatar: value })).toThrow("头像设置");
  }
});

test("portrait crop measures only its selected frame and zoom keeps the head visible", () => {
  const width = 1536;
  const pixels = new Uint8ClampedArray(width * 208 * 4);
  const fill = (column: number, x: number, y: number, w: number, h: number) => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++)
      pixels[(row * width + column * 192 + col) * 4 + 3] = 255;
  };
  fill(0, 60, 20, 70, 160);
  fill(1, 0, 0, 192, 208);
  const full = moriAvatarCrop(pixels, width, { ...avatar, zoom: 1 });
  const head = moriAvatarCrop(pixels, width, { ...avatar, zoom: 2 });
  expect(full.x + full.size / 2).toBeCloseTo(95);
  expect(full.size).toBeCloseTo(179.2);
  expect(head.size).toBeCloseTo(full.size / 2);
  expect(head.y).toBeLessThan(20);
  expect(head.y + head.size).toBeGreaterThan(80);
  expect(() => moriAvatarCrop(pixels, width, { ...avatar, frame: 2 })).toThrow("头像帧为空");
});
