import { copyFile, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assets, websiteRoot } from "./assets.mjs";

const output = join(websiteRoot, "dist");
await mkdir(join(output, "assets"), { recursive: true });
await cp(join(websiteRoot, "src"), output, { recursive: true });
for (const [pathname, source] of assets) {
  await copyFile(source, join(output, pathname));
}
console.log(`Mori website built → ${output}`);
