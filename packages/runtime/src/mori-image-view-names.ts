export const ECO_IMAGE_VIEW_MCP_SERVER = "mori_image_view" as const;
export const ECO_IMAGE_VIEW_TOOL = "view_image" as const;
export const ECO_IMAGE_VIEW_FULL_TOOL = `mcp__${ECO_IMAGE_VIEW_MCP_SERVER}__${ECO_IMAGE_VIEW_TOOL}` as const;

export function isEcoImageViewToolName(value: string | undefined): boolean {
  const name = value?.trim().toLowerCase() ?? "";
  if (!name) return false;
  return name.includes(ECO_IMAGE_VIEW_MCP_SERVER);
}
