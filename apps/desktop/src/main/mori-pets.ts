import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MoriPetAsset, MoriPetInfo, MoriPetList } from "../shared/mori-pet";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Read PNG/WebP dimensions without relying on Electron's platform image decoders. */
export function petImageDimensions(data: Buffer): { width: number; height: number } {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length < 30 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP")
    throw new Error("精灵图必须是 PNG 或 WebP。");
  const type = data.toString("ascii", 12, 16);
  if (type === "VP8X") return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  if (type === "VP8L" && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (type === "VP8 " && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a)
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  throw new Error("无法读取 WebP 精灵图尺寸。");
}

interface ReadPet {
  info: MoriPetInfo;
  image: Buffer;
  extension: ".png" | ".webp";
}

export async function readMoriPetDirectory(dir: string, key: string): Promise<ReadPet> {
  const manifestPath = path.join(dir, "pet.json");
  const stat = await fs.stat(manifestPath);
  if (stat.size > 64 * 1024) throw new Error("pet.json 过大。");
  const manifest: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("pet.json 无效。");
  const value = manifest as Record<string, unknown>;
  if (typeof value.displayName !== "string" || !value.displayName.trim())
    throw new Error("pet.json 缺少 displayName。");
  if (typeof value.spritesheetPath !== "string" || !value.spritesheetPath.trim())
    throw new Error("pet.json 缺少 spritesheetPath。");
  if (path.isAbsolute(value.spritesheetPath)) throw new Error("精灵图路径必须位于宠物目录内。");
  const root = await fs.realpath(dir);
  const imagePath = await fs.realpath(path.resolve(root, value.spritesheetPath));
  const relative = path.relative(root, imagePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
    throw new Error("精灵图路径必须位于宠物目录内。");
  const extension = path.extname(imagePath).toLowerCase();
  if (extension !== ".png" && extension !== ".webp") throw new Error("精灵图必须是 PNG 或 WebP。");
  const imageStat = await fs.stat(imagePath);
  if (!imageStat.isFile() || imageStat.size === 0 || imageStat.size > MAX_IMAGE_BYTES)
    throw new Error("精灵图必须是小于 20 MiB 的文件。");
  const image = await fs.readFile(imagePath);
  const dimensions = petImageDimensions(image);
  const version =
    dimensions.width === 1536 && dimensions.height === 1872
      ? 1
      : dimensions.width === 1536 && dimensions.height === 2288
        ? 2
        : undefined;
  if (!version)
    throw new Error(
      `精灵图尺寸为 ${dimensions.width}×${dimensions.height}；需要 1536×1872（v1）或 1536×2288（v2）。`,
    );
  if (value.spriteVersionNumber !== undefined && value.spriteVersionNumber !== version)
    throw new Error(`pet.json 的 spriteVersionNumber 与 v${version} 精灵图尺寸不一致。`);
  const expectedPng = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if ((extension === ".png") !== expectedPng) throw new Error("精灵图扩展名与文件格式不一致。");
  return {
    info: {
      key,
      name: value.displayName.trim(),
      description: typeof value.description === "string" ? value.description : "",
      version,
    },
    image,
    extension,
  };
}

export class MoriPets {
  private readonly codexDir = path.join(os.homedir(), ".codex", "pets");
  private readonly configuredCodexDir = process.env.CODEX_HOME
    ? path.join(path.resolve(process.env.CODEX_HOME), "pets")
    : undefined;
  private readonly ownDir: string;
  constructor(dataDir: string) {
    this.ownDir = path.join(dataDir, "mori-pets");
  }
  private directory(key: string): string {
    const match = /^(codex|codex-home|mori):([^/\\]+)$/.exec(key);
    if (!match?.[2] || match[2] === "." || match[2] === "..") throw new Error("宠物标识无效。");
    const root =
      match[1] === "codex"
        ? this.codexDir
        : match[1] === "codex-home"
          ? this.configuredCodexDir
          : this.ownDir;
    if (!root) throw new Error("CODEX_HOME 宠物目录不可用。");
    return path.join(root, match[2]);
  }
  async list(): Promise<MoriPetList> {
    const pets: MoriPetInfo[] = [];
    const errors: string[] = [];
    const roots: Array<[string, string]> = [
      ["codex", this.codexDir],
      ["mori", this.ownDir],
    ];
    if (this.configuredCodexDir && this.configuredCodexDir !== this.codexDir)
      roots.push(["codex-home", this.configuredCodexDir]);
    for (const [source, root] of roots) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const key = `${source}:${entry.name}`;
        try {
          pets.push((await readMoriPetDirectory(path.join(root, entry.name), key)).info);
        } catch (error) {
          errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return { pets: pets.sort((a, b) => a.name.localeCompare(b.name)), errors };
  }
  async asset(key: string): Promise<MoriPetAsset> {
    const pet = await readMoriPetDirectory(this.directory(key), key);
    return {
      ...pet.info,
      image: `data:image/${pet.extension === ".png" ? "png" : "webp"};base64,${pet.image.toString("base64")}`,
    };
  }
  async import(dir: string): Promise<MoriPetInfo> {
    const pet = await readMoriPetDirectory(dir, "import");
    const id = randomUUID();
    const target = path.join(this.ownDir, id);
    await fs.mkdir(target, { recursive: true });
    try {
      const filename = `spritesheet${pet.extension}`;
      await fs.writeFile(path.join(target, filename), pet.image);
      await fs.writeFile(
        path.join(target, "pet.json"),
        JSON.stringify(
          {
            id,
            displayName: pet.info.name,
            description: pet.info.description,
            spritesheetPath: filename,
            spriteVersionNumber: pet.info.version,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true });
      throw error;
    }
    return { ...pet.info, key: `mori:${id}` };
  }
}
