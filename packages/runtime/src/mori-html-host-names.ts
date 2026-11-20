export const ECO_HTML_HOST_MCP_SERVER = "mori_html_host" as const;
export const ECO_HTML_HOST_TOOL = "publish_html" as const;
export const ECO_HTML_HOST_FULL_TOOL =
  `mcp__${ECO_HTML_HOST_MCP_SERVER}__${ECO_HTML_HOST_TOOL}` as const;

export function isEcoHtmlHostToolName(value: string | undefined): boolean {
  const name = value?.trim().toLowerCase() ?? "";
  if (!name) return false;
  return (
    name.includes(ECO_HTML_HOST_MCP_SERVER) ||
    name === ECO_HTML_HOST_TOOL ||
    name.endsWith(`__${ECO_HTML_HOST_TOOL}`)
  );
}
