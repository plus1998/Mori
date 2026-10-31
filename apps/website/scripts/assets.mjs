import { fileURLToPath } from "node:url";

export const websiteRoot = fileURLToPath(new URL("../", import.meta.url));

// Reuse the product's maintained assets; the build copies them into a standalone site.
export const assets = new Map([
  ["/assets/mori.png", new URL("../../desktop/public/splash-icon.png", import.meta.url)],
  ["/assets/workspace.jpg", new URL("../../../docs/assets/eco-product-overview-dark.jpg", import.meta.url)],
  ["/assets/team.jpg", new URL("../../../docs/assets/eco-agent-team-dark.jpg", import.meta.url)],
  ["/assets/cost.jpg", new URL("../../../docs/assets/eco-cost-cache-dark.jpg", import.meta.url)],
]);
