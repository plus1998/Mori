/**
 * Live smoke test for the Doubao (Volcengine) TTS 2.0 speech profile.
 *
 * Requires a Doubao speech API key via ECO_DOUBAO_TTS_API_KEY, DOUBAO_TTS_API_KEY,
 * or apps/desktop/.local/doubao-tts-api-key. The key is the one from
 * 控制台 > 豆包语音 > API Key 管理, not an Ark API key.
 *
 *   bun run scripts/tts-doubao-smoke.ts
 *   ECO_DOUBAO_TTS_SPEAKER=en_male_tim_uranus_bigtts bun run scripts/tts-doubao-smoke.ts
 *
 * Writes the generated MP3 under .smoke-artifacts/ so it can be played back.
 */
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSpeechToWorkspace } from "../src/main/tts-client";

function resolveApiKey(): string | undefined {
  const fromEnv = process.env.ECO_DOUBAO_TTS_API_KEY?.trim() || process.env.DOUBAO_TTS_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const localPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".local",
    "doubao-tts-api-key",
  );
  if (!existsSync(localPath)) return undefined;
  return readFileSync(localPath, "utf8").trim() || undefined;
}

const apiKey = resolveApiKey();
if (!apiKey) {
  console.error(
    "Missing Doubao speech API key. Set ECO_DOUBAO_TTS_API_KEY or write it to apps/desktop/.local/doubao-tts-api-key.",
  );
  process.exit(1);
}

const generationRoot = path.join(process.cwd(), ".smoke-artifacts", "tts-doubao");
await fs.mkdir(generationRoot, { recursive: true });

const config = {
  profileId: "smoke",
  profileName: "Doubao TTS 2.0 smoke",
  provider: "doubao" as const,
  baseUrl: process.env.ECO_DOUBAO_TTS_BASE_URL?.trim() || "https://openspeech.bytedance.com",
  model: process.env.ECO_DOUBAO_TTS_MODEL?.trim() || "seed-tts-2.0",
  apiKey,
};

try {
  const audio = await generateSpeechToWorkspace({
    config,
    toolInput: {
      text: process.env.ECO_DOUBAO_TTS_TEXT?.trim() || "你好，我是豆包。今天天气不错，要不要一起出去走走？",
      voice: process.env.ECO_DOUBAO_TTS_SPEAKER?.trim() || "zh_female_vv_uranus_bigtts",
      style: process.env.ECO_DOUBAO_TTS_STYLE?.trim() || "请用轻快、自然的语气朗读，语速略慢一点。",
      output_name: "doubao-smoke",
    },
    generationRoot,
    threadDirectory: "thread-5b053000",
  });
  console.log("Doubao TTS smoke passed:", JSON.stringify(audio, null, 2));
} catch (error) {
  const failure = error as { code?: string; providerStatus?: number; requestId?: string };
  console.error(
    `Doubao TTS smoke failed: code=${failure.code ?? "unknown"} status=${failure.providerStatus ?? "-"} logid=${failure.requestId ?? "-"}`,
  );
  console.error((error as Error).message);
  process.exit(1);
}
