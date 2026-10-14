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
    "Built-in image display (Eco): present images, screenshots and visual results to the user in workspace cards and the task sidebar. Image analysis is provided by Eco image viewing.",
    buildEcoMcpHubToolUsage({ server: ECO_IMAGE_DISPLAY_MCP_SERVER }),
  ].join("\n");
}
