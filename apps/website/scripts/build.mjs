import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assets, websiteRoot } from "./assets.mjs";
import { ensureMedia } from "./media.mjs";

await ensureMedia();
const output = join(websiteRoot, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });
await cp(join(websiteRoot, "src"), output, { recursive: true });
for (const [pathname, source] of assets) {
  await copyFile(source, join(output, pathname));
}
console.log(`Mori website built → ${output}`);
