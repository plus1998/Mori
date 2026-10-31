import { fileURLToPath } from "node:url";

export const websiteRoot = fileURLToPath(new URL("../", import.meta.url));

// Reuse the product's maintained assets; the build copies them into a standalone site.
export const assets = new Map([
  ["/assets/mori.png", new URL("../../desktop/public/splash-icon.png", import.meta.url)],
  ["/assets/codex.ico", new URL("../../desktop/public/agent-icons/codex.ico", import.meta.url)],
  ["/assets/claude-code.ico", new URL("../../desktop/public/agent-icons/claude-code.ico", import.meta.url)],
  ["/assets/pi.svg", new URL("../../desktop/public/agent-icons/pi.svg", import.meta.url)],
]);
