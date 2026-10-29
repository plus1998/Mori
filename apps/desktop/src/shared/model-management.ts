import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export const MODEL_MANAGEMENT_MCP_SERVER = "eco_models";
export const MODEL_MANAGEMENT_PROMPT = [
  "Built-in model management (Mori): list, add, update, enable/disable and delete providers; discover, import, edit, order and delete models; test connections and refresh account model catalogs.",
  buildEcoMcpHubToolUsage({ server: MODEL_MANAGEMENT_MCP_SERVER }),
  "These tools change global Mori settings. Read current providers/models first and apply only user-requested changes. Omitted update fields are preserved. API keys are write-only; never request or expose existing secrets. Built-in account providers are managed by account settings; their model catalogs support manual additions/removals and refresh. Provider deletion also removes its models and dependent agent configurations/orchestrations and is blocked by active conversations; explain the impact before deleting. Do not claim a connection works without a successful test.",
].join("\n");
