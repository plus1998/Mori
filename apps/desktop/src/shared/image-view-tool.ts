import { ECO_IMAGE_VIEW_MCP_SERVER } from "@eco/runtime/eco-image-view-names";
import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export {
  ECO_IMAGE_VIEW_FULL_TOOL,
  ECO_IMAGE_VIEW_MCP_SERVER,
  ECO_IMAGE_VIEW_TOOL,
  isEcoImageViewToolName,
} from "@eco/runtime/eco-image-view-names";

export function buildImageViewPromptAppend(): string {
  return [
    "Built-in image viewing (Eco): analyze images, read screenshots and inspect visual results with a vision model; returns a text answer to your question.",
    buildEcoMcpHubToolUsage({ server: ECO_IMAGE_VIEW_MCP_SERVER }),
    "On Codex, use this Eco tool for image inspection with custom providers; the native view_image tool remains available with the built-in OpenAI account.",
  ].join("\n");
}
