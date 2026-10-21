import type { ComposerReference } from "./composer-references";

export interface BrowserSelectionContent {
  kind: "element" | "text";
  frameUrl: string;
  documentToken: string;
  selectorPath: string[];
  tag: string;
  role: string;
  name: string;
  text: string;
  context: string;
  textTruncated: boolean;
  fingerprint: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface BrowserSelection extends BrowserSelectionContent {
  version: 1;
  id: string;
  browserId: string;
  scopeId: string;
  url: string;
  title: string;
  capturedAt: string;
  screenshotPath: string;
}

export interface BrowserSelectionPreview {
  selection: BrowserSelection;
  screenshotDataUrl: string;
}

export interface BrowserSelectionRequest {
  browserId: string;
  kind: "element" | "text";
}

export function browserSelectionReference(selection: BrowserSelection): ComposerReference {
  const content = selection.kind === "text" ? selection.text : selection.name || selection.text || selection.tag;
  return {
    kind: "web_selection",
    id: selection.id,
    label: Array.from(content.replace(/\s+/g, " ")).slice(0, 60).join("") || selection.tag,
    detail: `${selection.title} · ${selection.url}`,
  };
}
