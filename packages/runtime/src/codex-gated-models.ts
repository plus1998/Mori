import type { CodexGatewayApiCompat } from "../../shared/src";

/**
 * Models that Eco may expose via gateway catalog but must not become workflow defaults.
 * Community (Sep 2026): GPT-6 Astra capacity pressure + cyber_policy false positives in Codex.
 *
 * Explicit gaps (not implemented in this upgrade):
 * - Responses WebSocket `response.steer` / async tool calling (`async: true` MCP tools)
 * - `features.context_management.experimental_mode` (ChatGPT backend only; Eco gateway excluded)
 */
export const CODEX_GATED_OPTIONAL_MODEL_IDS = ["gpt-6-astra", "gpt-6-astra-fast"] as const;

export type CodexGatedOptionalModelId = (typeof CODEX_GATED_OPTIONAL_MODEL_IDS)[number];

export function isCodexGatedOptionalModelId(modelId: string): boolean {
  const needle = modelId.trim().toLowerCase();
  return CODEX_GATED_OPTIONAL_MODEL_IDS.some((id) => needle === id || needle.startsWith(`${id}-`));
}

/**
 * Astra / similar gated models require OpenAI Responses tool loops.
 * Chat Completions routes must not silently pretend tool calling works.
 */
export function assertCodexGatedModelApiCompat(input: {
  modelId: string;
  apiCompat: CodexGatewayApiCompat;
}): void {
  if (!isCodexGatedOptionalModelId(input.modelId)) {
    return;
  }
  if (input.apiCompat !== "openai_responses") {
    throw new Error(
      `Model "${input.modelId}" is gated for Mori and requires apiCompat=openai_responses (Chat Completions tool loops are unsupported). Not setting it as a default model.`,
    );
  }
}
