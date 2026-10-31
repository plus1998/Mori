import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { websiteRoot } from "./assets.mjs";

// Videos live in a versioned Release, outside the source repository's history.
export async function ensureMedia() {
  const manifest = JSON.parse(await readFile(join(websiteRoot, "media.json"), "utf8"));
  const destination = join(websiteRoot, "src/films");
  try {
    await Promise.all(manifest.files.map((file) => access(join(destination, file))));
    return;
  } catch {
    // A fresh clone downloads the small, pinned archive once.
  }
  const temporary = await mkdtemp(join(tmpdir(), "mori-website-media-"));
  try {
    const response = await fetch(manifest.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Video download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== manifest.sha256) throw new Error("Video archive checksum mismatch");
    const archivePath = join(temporary, "films.tar.gz");
    await writeFile(archivePath, archive);
    const entries = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" }).trim().split("\n");
    if (entries.length !== manifest.files.length || entries.some((file) => !manifest.files.includes(file))) {
      throw new Error("Video archive contains unexpected files");
    }
    const extracted = join(temporary, "films");
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", archivePath, "-C", extracted]);
    await mkdir(destination, { recursive: true });
    for (const file of manifest.files) await cp(join(extracted, file), join(destination, file));
    console.log(`Downloaded ${manifest.files.length} video assets from ${manifest.release}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
