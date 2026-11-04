import type { BrowserSelection } from "./browser-selection";

export const BROWSER_WINDOW_TOOLS = ["review", "terminal", "files", "sshBookmarks", "imageGeneration", "speechGeneration", "startupScripts"] as const;

export type BrowserWindowAction =
  | { kind: "selection"; selection: BrowserSelection }
  | { kind: "screenshot"; artifactId: string; scopeId: string }
  | { kind: "tool"; browserId: string; tool: typeof BROWSER_WINDOW_TOOLS[number] };
