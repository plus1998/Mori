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
    "Built-in image viewing (Mori): analyze images, read screenshots and inspect visual results with a vision model; returns a text answer to your question.",
    buildEcoMcpHubToolUsage({ server: ECO_IMAGE_VIEW_MCP_SERVER }),
    "Use Mori image viewing first; it reads the current vision model configuration at each call, including changes made during a turn. The tool remains available when no independent vision model is configured.",
    "For Codex Login without an independent vision model, the tool returns vision_model_unconfigured with nativeTool=view_image and a local image path. In that case, call Codex's native view_image with the returned path. A durable ref cannot be passed to the native tool.",
    "Report configured model or provider errors accurately. Do not treat authentication failures, HTTP errors or other analysis failures as an unconfigured model or silently switch to a different model.",
  ].join("\n");
}
