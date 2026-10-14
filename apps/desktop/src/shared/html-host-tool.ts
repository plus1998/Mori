import { ECO_HTML_HOST_MCP_SERVER } from "@eco/runtime/eco-html-host-names";
import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export {
  ECO_HTML_HOST_FULL_TOOL,
  ECO_HTML_HOST_MCP_SERVER,
  ECO_HTML_HOST_TOOL,
  isEcoHtmlHostToolName,
} from "@eco/runtime/eco-html-host-names";

export function buildHtmlHostPromptAppend(): string {
  return [
    "Built-in HTML page hosting (Eco Artifacts): publish or update shareable, self-contained HTML pages for progress reports and statistics.",
    buildEcoMcpHubToolUsage({ server: ECO_HTML_HOST_MCP_SERVER }),
  ].join("\n");
}
