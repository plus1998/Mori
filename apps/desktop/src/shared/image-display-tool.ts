import { ECO_IMAGE_DISPLAY_MCP_SERVER } from "@eco/runtime/eco-image-display-names";
import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export {
  ECO_IMAGE_DISPLAY_FULL_TOOL,
  ECO_IMAGE_DISPLAY_MCP_SERVER,
  ECO_IMAGE_DISPLAY_TOOL,
  isEcoImageDisplayToolName,
} from "@eco/runtime/eco-image-display-names";

export function buildImageDisplayPromptAppend(): string {
  return [
    "Built-in media display (Mori): use show_media_to_user to present images, videos and audio to the user in workspace cards and the task sidebar. Video and audio include playback controls. This tool displays media; image analysis is provided by Mori image viewing.",
    buildEcoMcpHubToolUsage({ server: ECO_IMAGE_DISPLAY_MCP_SERVER }),
  ].join("\n");
}
