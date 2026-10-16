import type { ComposerReference } from "../shared/composer-references";

type IconNode = readonly ["path" | "rect" | "circle", Readonly<Record<string, string>>];
const ICONS = {
  ssh: [["path", { d: "m4 6 6 6-6 6M12 18h8" }]],
  web: [
    ["circle", { cx: "12", cy: "12", r: "9" }],
    ["path", { d: "M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18" }],
  ],
  conversation: [["path", { d: "M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z" }]],
  subagent: [
    [
      "path",
      { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
    ],
    ["circle", { cx: "9", cy: "7", r: "4" }],
  ],
  mcp: [
    ["rect", { x: "3", y: "3", width: "7", height: "7", rx: "1.5" }],
    ["rect", { x: "14", y: "3", width: "7", height: "7", rx: "1.5" }],
    ["rect", { x: "3", y: "14", width: "7", height: "7", rx: "1.5" }],
    ["path", { d: "M14 17.5h7M17.5 14v7" }],
  ],
  imageGeneration: [
    ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "3" }],
    ["circle", { cx: "8.5", cy: "8.5", r: "1.5" }],
    ["path", { d: "m21 15-5-5L5 21" }],
  ],
  tts: [["path", { d: "M2 10v4M6 6v12M10 3v18M14 8v8M18 5v14M22 10v4" }]],
  computerUse: [
    ["rect", { x: "2", y: "3", width: "20", height: "14", rx: "2" }],
    ["path", { d: "M8 21h8M12 17v4" }],
  ],
} as const satisfies Record<string, readonly IconNode[]>;

/** Shared SVG geometry keeps editor DOM chips and React menus visually identical. */
export function composerReferenceIconNodes(reference: ComposerReference): readonly IconNode[] {
  if (reference.kind !== "integration") return ICONS[reference.kind];
  if (reference.id === "browser") return ICONS.web;
  if (reference.id === "imageGeneration") return ICONS.imageGeneration;
  if (reference.id === "tts") return ICONS.tts;
  if (reference.id === "computerUse") return ICONS.computerUse;
  return ICONS.mcp;
}

export function composerReferenceTitle(reference: ComposerReference): string {
  return reference.detail ? `${reference.label} · ${reference.detail}` : reference.label;
}
