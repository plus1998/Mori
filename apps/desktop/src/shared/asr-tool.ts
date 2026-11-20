import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export const ECO_ASR_MCP_SERVER = "mori_asr";
export const ECO_ASR_TOOL = "transcribe_audio";
export const ECO_ASR_FULL_TOOL = `mcp__${ECO_ASR_MCP_SERVER}__${ECO_ASR_TOOL}`;
export const ASR_MCP_TOOL_TIMEOUT_MS = 300_000;
export function buildAsrPromptAppend(): string {
  return [
    "Built-in Speech Recognition (Mori): transcribe local audio files using the active voice input provider. Use the returned transcript to analyze speech content. This tool does not analyze music or non-speech sounds.",
    buildEcoMcpHubToolUsage({ server: ECO_ASR_MCP_SERVER }),
    "Pass an absolute or workspace-relative audio path. WAV, MP3, M4A, MP4, FLAC, OGG and WebM are accepted; actual format support depends on the configured provider. The encoded request must fit the 10 MiB ASR limit. Report provider errors accurately; do not silently change providers or models.",
  ].join("\n");
}
