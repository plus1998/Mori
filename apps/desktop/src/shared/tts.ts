import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export const ECO_TTS_MCP_SERVER = "eco_tts";
export const ECO_TTS_TOOL = "create_speech";
export const ECO_TTS_FULL_TOOL = `mcp__${ECO_TTS_MCP_SERVER}__${ECO_TTS_TOOL}`;
export const TTS_REQUEST_TIMEOUT_MS = 600_000;
export const TTS_MCP_TOOL_TIMEOUT_MS = 600_000;
export const TTS_CODEX_TOOL_TIMEOUT_SEC = 600;
export const TTS_TASK_TAB_PREFIX = "speech:";
export const TTS_PROVIDERS = ["gemini", "openai_compatible"] as const;
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
  return provider === "gemini"
    ? "https://generativelanguage.googleapis.com/v1beta"
    : "https://openrouter.ai/api/v1";
}
export function defaultTtsModel(provider: TtsProvider): string {
  return provider === "gemini" ? "gemini-3.8-flash-tts" : "google/gemini-3.8-flash-tts";
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
  /** Provider voice ID, chosen by the Agent. Gemini examples: Kore, Puck, Aoede. */
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
    "Built-in Speech Generation (Eco): use create_speech to create playable voice artifacts when speech is requested or useful to the task.",
    buildEcoMcpHubToolUsage({ server: ECO_TTS_MCP_SERVER }),
    `Active profile: ${input.profileName}; protocol=${input.provider}; model=${input.model}.`,
    "Choose the voice and style yourself to suit the content and user intent. style controls emotion, tone, pitch, pace, accent and delivery. text is the verbatim transcript: never put delivery instructions into text. Inline vocal events such as <laugh>, <sigh>, <short pause> are supported by Gemini 3.8.",
    "Gemini voices include Kore (firm), Puck (upbeat), Aoede (breezy), Charon (informative), Fenrir (excitable), Leda (youthful), Orus (firm), Zephyr (bright). Other providers require their own voice IDs.",
    "Eco saves the audio and displays a player in Feed and artifact cards. Report provider errors accurately; do not silently change provider or model.",
  ].join("\n");
}
