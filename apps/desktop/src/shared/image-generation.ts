import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export const ECO_IMAGE_GENERATION_MCP_SERVER = "eco_image_generation";
export const ECO_IMAGE_GENERATION_TOOL = "create_image";
export const ECO_IMAGE_GENERATION_FULL_TOOL = `mcp__${ECO_IMAGE_GENERATION_MCP_SERVER}__${ECO_IMAGE_GENERATION_TOOL}`;
export const IMAGE_GENERATION_TASK_TAB_PREFIX = "image:";

/** Upstream HTTP wall clock for create_image (generations / edits). */
export const IMAGE_GENERATION_REQUEST_TIMEOUT_MS = 600_000;
/**
 * Agent-facing MCP tool-call timeout (Claude `timeout`, Pi `requestTimeoutMs`,
 * Codex `tool_timeout_sec`). Default SDK/Codex tool timeout is 60s — too short for drawing.
 */
export const IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS = 600_000;
export const IMAGE_GENERATION_CODEX_TOOL_TIMEOUT_SEC = Math.ceil(IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS / 1000);

export function imageGenerationTaskTabId(artifactId: string): string {
  return `${IMAGE_GENERATION_TASK_TAB_PREFIX}${artifactId}`;
}

export function parseImageGenerationTaskTabId(tabId: string): string | undefined {
  return tabId.startsWith(IMAGE_GENERATION_TASK_TAB_PREFIX)
    ? tabId.slice(IMAGE_GENERATION_TASK_TAB_PREFIX.length) || undefined
    : undefined;
}

export const IMAGE_GENERATION_PROVIDERS = [
  "openai",
  "gemini",
  "openai_compatible",
  "codex",
  "chatgpt_web",
] as const;
export type ImageGenerationProvider = (typeof IMAGE_GENERATION_PROVIDERS)[number];

export type ImageGenerationLoginRoute = "chatgpt_web" | "codex";
export type ImageGenerationSource = "api" | "chatgpt_login";
export interface ImageGenerationChatModelOption {
  modelId: string;
  displayName: string;
}

/** Dedicated to the Creative Drawing Web route, independent of the Codex catalog. */
export interface ChatGptWebImageModelCatalogSnapshot {
  models: ImageGenerationChatModelOption[];
  fetchedAt?: number;
  lastError?: string;
}

export interface ImageGenerationSourceInput {
  source: ImageGenerationSource;
  route?: ImageGenerationLoginRoute;
}

export function isImageGenerationLoginProvider(
  provider: ImageGenerationProvider,
): provider is ImageGenerationLoginRoute {
  return provider === "chatgpt_web" || provider === "codex";
}

/** Codex route image models offered in the UI; the Web route has no image model selector. */
export const IMAGE_GENERATION_CODEX_IMAGE_MODELS = [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.6-flare",
] as const;

export interface ImageGenerationProfileSnapshot {
  id: string;
  name: string;
  provider: ImageGenerationProvider;
  endpoint: string;
  /** Image model. Empty on the Web route, where the server chooses the image model. */
  model: string;
  /** Chat model that drives the Codex / Web generation request. Empty for API providers. */
  chatModel: string;
  /** When true, create_image may accept input_images for image-to-image edits. */
  supportsImageToImage: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ImageGenerationProfileSaveInput {
  id?: string;
  name: string;
  provider: ImageGenerationProvider;
  endpoint: string;
  model: string;
  chatModel?: string;
  supportsImageToImage?: boolean;
  apiKey?: string;
}

export interface ImageGenerationSettingsSnapshot {
  enabled: boolean;
  activeProfileId: string;
  profiles: ImageGenerationProfileSnapshot[];
  apiKeyEncryptionAvailable: boolean;
}

export interface ImageGenerationSettingsSaveInput {
  enabled: boolean;
}

export interface ImageGenerationToolInput {
  prompt: string;
  /** Local absolute paths or paths relative to the workspace for image-to-image. */
  input_images?: string[];
  size?: string;
  aspect_ratio?: string;
  quality?: "auto" | "low" | "medium" | "high";
  count?: number;
  output_name?: string;
}

export type ImageGenerationArtifactStatus = "running" | "completed" | "failed";

/** Identity snapshot only; never include login credentials. */
export interface ImageGenerationAccount {
  id: string;
  name: string;
  email?: string;
}

export interface GeneratedImageFile {
  account?: ImageGenerationAccount;
  /** Durable original owned by Mori. Paths below refer only to an independent working copy. */
  libraryImageId?: string;
  absolutePath: string;
  relativePath: string;
  mimeType: string;
  bytes: number;
}

export interface ImageGenerationArtifact {
  id: string;
  threadId: string;
  toolUseId?: string;
  status: ImageGenerationArtifactStatus;
  prompt: string;
  parameters: Omit<ImageGenerationToolInput, "prompt">;
  provider: ImageGenerationProvider;
  profileName: string;
  /** Accounts actually selected for this request, including partially failed batches. */
  accounts?: ImageGenerationAccount[];
  model: string;
  workspacePath: string;
  generationRoot: string;
  images: GeneratedImageFile[];
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImageGenerationArtifactListRequest {
  threadId: string;
}

export interface ImageGenerationArtifactReadRequest {
  artifactId: string;
  imageIndex: number;
}

export interface ImageGenerationArtifactReadResult {
  dataBase64: string;
  mimeType: string;
  path: string;
}

export class ImageGenerationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly providerStatus?: number,
    readonly requestId?: string,
    readonly partialImages: GeneratedImageFile[] = [],
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export function isImageGenerationProvider(value: unknown): value is ImageGenerationProvider {
  return typeof value === "string" && (IMAGE_GENERATION_PROVIDERS as readonly string[]).includes(value);
}

export function defaultImageGenerationEndpoint(provider: ImageGenerationProvider): string {
  if (provider === "chatgpt_web") return "https://chatgpt.com/backend-api";
  if (provider === "codex") return "https://chatgpt.com/backend-api/codex";
  if (provider === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}

export function defaultImageGenerationModel(provider: ImageGenerationProvider): string {
  if (provider === "codex") return "gpt-image-2.6-flare";
  if (provider === "chatgpt_web") return "";
  if (provider === "gemini") return "gemini-2.5-flash-image";
  if (provider === "openai") return "gpt-image-2";
  return "";
}

/** Older builds stored the API image model on Codex profiles; map it to the Codex default. */
export function remapLegacyImageGenerationModel(provider: ImageGenerationProvider, model: string): string {
  if (provider === "codex" && model === "gpt-image-2") return defaultImageGenerationModel(provider);
  return model;
}

export function defaultImageGenerationChatModel(provider: ImageGenerationProvider): string {
  if (provider === "codex") return "gpt-6.1-terra";
  if (provider === "chatgpt_web") return "gpt-5.5";
  return "";
}

/** Image models the user may pick; only the Codex route exposes this selector. */
export function imageGenerationImageModelOptions(provider: ImageGenerationProvider): readonly string[] {
  return provider === "codex" ? IMAGE_GENERATION_CODEX_IMAGE_MODELS : [];
}

/** Default for new profiles: official OpenAI/Gemini support edits; compatible gateways often do not. */
export function defaultSupportsImageToImage(provider: ImageGenerationProvider): boolean {
  return provider === "openai" || provider === "gemini" || provider === "codex" || provider === "chatgpt_web";
}

export function buildImageGenerationPromptAppend(input: {
  provider: ImageGenerationProvider;
  profileName: string;
  model: string;
  chatModel?: string;
  supportsImageToImage: boolean;
}): string {
  const providerParameters =
    input.provider === "gemini"
      ? "Gemini accepts size=1K|2K|4K, aspect_ratio, and count=1; quality is unsupported."
      : "OpenAI-style providers accept size, quality, and count=1..4; aspect_ratio is unsupported.";
  const imageToImage = input.supportsImageToImage
    ? input.provider === "gemini"
      ? "Image-to-image is enabled: pass input_images (1..3 local absolute or workspace-relative PNG/JPEG/WebP paths, including outside the workspace) with the edit prompt."
      : "Image-to-image is enabled: pass input_images (1..16 local absolute or workspace-relative PNG/JPEG/WebP paths, including outside the workspace) with the edit prompt."
    : "Image-to-image is disabled on this profile; do not pass input_images.";
  return [
    "Built-in Creative Drawing (Mori): generate illustrations and visual assets; edit reference images when the active profile supports image-to-image. Use this integration for image generation and editing.",
    buildEcoMcpHubToolUsage({ server: ECO_IMAGE_GENERATION_MCP_SERVER }),
    input.provider === "codex" || input.provider === "chatgpt_web"
      ? `Active profile: ${input.profileName}; provider=${input.provider}; chat model=${input.chatModel ?? ""}; image model=${input.model || "server-selected"}.`
      : `Active profile: ${input.profileName}; provider=${input.provider}; model=${input.model}.`,
    providerParameters,
    imageToImage,
    "Generated originals are saved automatically in Mori’s image library. Returned file paths are independent temporary working copies; you may edit or move them without changing the saved originals. Do not modify or clean Mori’s internal image-library storage; users manage originals through the library.",
    "Mori handles approval for every drawing call. After an error, changes to provider, model, size, quality, count or aspect ratio require the user's decision.",
  ].join("\n");
}

export function isEcoImageGenerationToolName(value: string | undefined): boolean {
  const name = value?.trim().toLowerCase() ?? "";
  return name.includes(ECO_IMAGE_GENERATION_MCP_SERVER) || name.endsWith(ECO_IMAGE_GENERATION_TOOL);
}
