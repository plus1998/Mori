import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export const ECO_TTS_MCP_SERVER = "eco_tts";
export const ECO_TTS_TOOL = "create_speech";
export const ECO_TTS_FULL_TOOL = `mcp__${ECO_TTS_MCP_SERVER}__${ECO_TTS_TOOL}`;
export const TTS_REQUEST_TIMEOUT_MS = 600_000;
export const TTS_MCP_TOOL_TIMEOUT_MS = 600_000;
export const TTS_CODEX_TOOL_TIMEOUT_SEC = 600;
export const TTS_TASK_TAB_PREFIX = "speech:";
export const TTS_PROVIDERS = ["gemini", "openai_compatible", "doubao"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export function ttsTaskTabId(id: string): string {
  return `${TTS_TASK_TAB_PREFIX}${id}`;
}
export function parseTtsTaskTabId(id: string): string | undefined {
  return id.startsWith(TTS_TASK_TAB_PREFIX) ? id.slice(TTS_TASK_TAB_PREFIX.length) || undefined : undefined;
}
export function isTtsProvider(value: unknown): value is TtsProvider {
  return typeof value === "string" && (TTS_PROVIDERS as readonly string[]).includes(value);
}
export function defaultTtsEndpoint(provider: TtsProvider): string {
  if (provider === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  if (provider === "doubao") return "https://openspeech.bytedance.com";
  return "https://openrouter.ai/api/v1";
}
export function defaultTtsModel(provider: TtsProvider): string {
  if (provider === "gemini") return "gemini-3.8-flash-tts";
  if (provider === "doubao") return "seed-tts-2.0";
  return "google/gemini-3.8-flash-tts";
}

export function defaultReadAloudVoice(provider: TtsProvider): string {
  if (provider === "gemini") return "Kore";
  if (provider === "doubao") return "zh_female_vv_uranus_bigtts";
  return "";
}
export const DEFAULT_READ_ALOUD_STYLE =
  "请像和熟悉的朋友面对面聊天一样说话。声音放松、温暖，带一点慵懒和随意感，音量适中偏轻，语速略慢但流畅；随语义自然起伏，短句和段落间留出自然停顿，句尾轻轻收住。避免播音腔、朗诵腔和夸张表演。逐字读出原文，不增删、改写内容，不额外添加语气词或笑声。";
export const CLEAR_READ_ALOUD_STYLE = "请用自然、清晰、平稳的语气朗读，语速适中，忠实朗读原文，不增删内容。";
export type ReadAloudEngine = "online" | "system";
export interface ReadAloudSettingsInput {
  profileId: string;
  voice: string;
  style: string;
}
export interface ReadAloudSettingsSnapshot extends ReadAloudSettingsInput {
  profiles: Pick<TtsProfileSnapshot, "id" | "name" | "provider" | "model" | "hasApiKey">[];
}
export interface ReadAloudStatus {
  available: boolean;
  reason?: string;
  profileId?: string;
  profileName?: string;
  voice?: string;
  style?: string;
}
export interface ReadAloudStartInput {
  requestId: string;
  threadId: string;
  entryId: string;
  sourceText: string;
}
export interface ReadAloudStartResult {
  requestId: string;
  segmentCount: number;
}
export interface ReadAloudSegmentInput {
  requestId: string;
  index: number;
}
export interface ReadAloudSegmentResult {
  mimeType: string;
  totalBytes: number;
}
export interface ReadAloudReadInput extends ReadAloudSegmentInput {
  offset: number;
  length: number;
}
export interface ReadAloudReadResult extends ReadAloudSegmentResult {
  offset: number;
  chunkBytes: number;
  dataBase64: string;
}

export interface TtsProfileSaveInput {
  id?: string;
  name: string;
  provider: TtsProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
}
export interface TtsProfileSnapshot extends Omit<TtsProfileSaveInput, "id" | "apiKey"> {
  id: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface TtsSettingsSnapshot {
  enabled: boolean;
  activeProfileId: string;
  profiles: TtsProfileSnapshot[];
  apiKeyEncryptionAvailable: boolean;
}
export interface TtsSettingsSaveInput {
  enabled: boolean;
}
export interface TtsToolInput {
  /** Verbatim transcript. Delivery instructions belong in style. */
  text: string;
  /** Provider voice ID, chosen by the Agent. Gemini examples: Kore, Puck, Aoede. Doubao examples: zh_female_vv_uranus_bigtts. */
  voice: string;
  /** Natural-language direction for emotion, tone, pacing, pitch and accent. */
  style: string;
  output_name?: string;
}
export interface GeneratedAudioFile {
  absolutePath: string;
  relativePath: string;
  mimeType: string;
  bytes: number;
}
export type TtsArtifactStatus = "running" | "completed" | "failed";
export interface TtsArtifact {
  id: string;
  threadId: string;
  toolUseId?: string;
  status: TtsArtifactStatus;
  text: string;
  parameters: Omit<TtsToolInput, "text">;
  provider: TtsProvider;
  profileName: string;
  model: string;
  workspacePath: string;
  generationRoot: string;
  audio: GeneratedAudioFile[];
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
export interface TtsArtifactListRequest {
  threadId: string;
}
export interface TtsArtifactReadRequest {
  artifactId: string;
  audioIndex: number;
}
export interface TtsArtifactReadResult {
  dataBase64: string;
  mimeType: string;
  path: string;
}
export class TtsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly providerStatus?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "TtsError";
  }
}
export function isEcoTtsToolName(value: string | undefined): boolean {
  const name = value?.trim().toLowerCase() ?? "";
  return (
    name === ECO_TTS_TOOL || name === ECO_TTS_FULL_TOOL || name === `${ECO_TTS_MCP_SERVER}_${ECO_TTS_TOOL}`
  );
}
export function buildTtsPromptAppend(input: {
  provider: TtsProvider;
  profileName: string;
  model: string;
}): string {
  return [
    "Built-in Speech Generation (Mori): use create_speech to create playable voice artifacts when speech is requested or useful to the task.",
    buildEcoMcpHubToolUsage({ server: ECO_TTS_MCP_SERVER }),
    `Active profile: ${input.profileName}; protocol=${input.provider}; model=${input.model}.`,
    "Choose the voice and style yourself to suit the content and user intent. style controls emotion, tone, pitch, pace, accent and delivery. text is the verbatim transcript: never put delivery instructions into text. Inline vocal events such as <laugh>, <sigh>, <short pause> are supported by Gemini 3.8.",
    "Gemini voices include Kore (firm), Puck (upbeat), Aoede (breezy), Charon (informative), Fenrir (excitable), Leda (youthful), Orus (firm), Zephyr (bright). Other providers require their own voice IDs.",
    "Doubao (Volcengine) voice IDs come from its voice library: zh_female_vv_uranus_bigtts (Vivi 2.0), zh_female_xiaohe_uranus_bigtts, zh_male_m191_uranus_bigtts, zh_female_qingxinnvsheng_uranus_bigtts, en_male_tim_uranus_bigtts, en_female_dacey_uranus_bigtts. For Doubao TTS 2.0 the style text is sent as a natural-language voice instruction, so phrase it as a request such as “请用温柔、略慢的语气朗读”。",
    "Mori saves the audio and displays a player in Feed and artifact cards. Report provider errors accurately; do not silently change provider or model.",
  ].join("\n");
}
