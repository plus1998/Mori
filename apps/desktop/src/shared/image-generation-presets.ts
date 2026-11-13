import type { ImageGenerationProvider } from "./image-generation";

export const IMAGE_ASPECT_PRESETS = [
  { ratio: "3:4", label: "portrait" },
  { ratio: "4:3", label: "landscape" },
  { ratio: "9:16", label: "phone" },
  { ratio: "16:9", label: "desktop" },
  { ratio: "1:1", label: "square" },
  { ratio: "2:3", label: "portrait" },
  { ratio: "3:2", label: "landscape" },
  { ratio: "4:5", label: "portrait" },
  { ratio: "5:4", label: "landscape" },
  { ratio: "21:9", label: "wide" },
] as const;
export type ImageResolutionPreset = "1080P" | "2K" | "4K";
export const IMAGE_RESOLUTION_PRESETS: ImageResolutionPreset[] = ["1080P", "2K", "4K"];

export function supportsCustomImageDimensions(model: string): boolean {
  return /^gpt-image-2(?:[.-]|$)/.test(model);
}

/** GPT Image custom sizes follow the documented 16 px, edge, ratio and pixel limits. */
export function isValidCustomImageSize(size: string): boolean {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return (
    width > 0 &&
    height > 0 &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    Math.max(width, height) <= 3840 &&
    Math.max(width, height) / Math.min(width, height) <= 3 &&
    width * height >= 655360 &&
    width * height <= 8294400
  );
}

/** Resolution tiers use the short edge (1080 / 1440 / 2160); show the actual aligned size in UI. */
export function imagePresetParameters(
  provider: ImageGenerationProvider,
  ratio: string,
  resolution: ImageResolutionPreset,
): { size: string; aspect_ratio?: string } {
  if (provider === "gemini") {
    return { size: resolution === "1080P" ? "1K" : resolution, aspect_ratio: ratio };
  }
  const [width = 1, height = 1] = ratio.split(":").map(Number);
  const shortEdge = { "1080P": 1080, "2K": 1440, "4K": 2160 }[resolution];
  const scale = shortEdge / Math.min(width, height);
  const alignment = provider === "openai" || provider === "codex" ? 16 : 1;
  const align = (value: number) => Math.round(value / alignment) * alignment;
  return { size: `${align(width * scale)}x${align(height * scale)}` };
}
