import { ECO_IMAGE_VIEW_MCP_SERVER, ECO_IMAGE_VIEW_TOOL } from "@eco/runtime/mori-image-view-names";
import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export {
  ECO_IMAGE_VIEW_FULL_TOOL,
  ECO_IMAGE_VIEW_MCP_SERVER,
  ECO_IMAGE_VIEW_TOOL,
  isEcoImageViewToolName,
} from "@eco/runtime/mori-image-view-names";

export const IMAGE_VIEW_MCP_TOOL_TIMEOUT_MS = 120_000;

export function buildImageViewPromptAppend(): string {
  return [
    "Built-in image viewing (Mori): analyze images, read screenshots and inspect visual results with a vision model; returns a text answer to your question.",
    buildEcoMcpHubToolUsage({ server: ECO_IMAGE_VIEW_MCP_SERVER }),
    `After discovery, call the Hub's \`call_tool\` wrapper with {"name":"${ECO_IMAGE_VIEW_MCP_SERVER}:${ECO_IMAGE_VIEW_TOOL}","arguments":{"path":"<absolute image path>","prompt":"<what to inspect>"}}. Use \`ref\` instead of \`path\` when given a durable image reference.`,
    "Use the returned analysis as evidence before describing an image or editing content based on it. Report a failed analysis and do not guess what the image contains. Mori reads the current vision model configuration on each call.",
    "For Codex Login without an independent vision model, the tool returns vision_model_unconfigured with nativeTool=view_image and a local image path. In that case, call Codex's native view_image with the returned path. A durable ref cannot be passed to the native tool.",
    "Report configured model or provider errors accurately. Do not treat authentication failures, HTTP errors or other analysis failures as an unconfigured model or silently switch to a different model.",
  ].join("\n");
}
