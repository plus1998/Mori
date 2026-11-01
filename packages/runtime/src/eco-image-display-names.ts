export const ECO_IMAGE_DISPLAY_MCP_SERVER = "eco_image_display" as const;
export const ECO_IMAGE_DISPLAY_TOOL = "show_media_to_user" as const;
export const ECO_IMAGE_DISPLAY_FULL_TOOL =
  `mcp__${ECO_IMAGE_DISPLAY_MCP_SERVER}__${ECO_IMAGE_DISPLAY_TOOL}` as const;

export function isEcoImageDisplayToolName(value: string | undefined): boolean {
  const name = value?.trim().toLowerCase() ?? "";
  if (!name) return false;
  return (
    name.includes(ECO_IMAGE_DISPLAY_MCP_SERVER) ||
    name === ECO_IMAGE_DISPLAY_TOOL ||
    name.endsWith(`__${ECO_IMAGE_DISPLAY_TOOL}`) ||
    name === "display_image" ||
    name.endsWith("__display_image")
  );
}
