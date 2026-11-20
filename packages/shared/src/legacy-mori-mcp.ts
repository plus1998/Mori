// Stored settings and activity events can predate the MCP namespace rename.
// Use this only when reading those records; the live Hub exposes the new names.
const LEGACY_MORI_MCP_SERVICES =
  "agent_browser|asr|computer_use|html_host|image_display|image_generation|image_view|mcp|models|plan|scheduling|tts|web_search|wechat";
const LEGACY_MORI_MCP_SERVER = new RegExp(`^eco_(${LEGACY_MORI_MCP_SERVICES})$`);
const LEGACY_MORI_MCP_NAME = new RegExp(`^(mcp__)?eco_(${LEGACY_MORI_MCP_SERVICES})(?=$|[_.:-])`, "i");

export function normalizeStoredMoriMcpServer(name: string): string {
  return name.replace(LEGACY_MORI_MCP_SERVER, "mori_$1");
}

export function normalizeStoredMoriMcpName(name: string): string {
  return name.replace(
    LEGACY_MORI_MCP_NAME,
    (_, prefix: string | undefined, service: string) => `${prefix ?? ""}mori_${service.toLowerCase()}`,
  );
}
