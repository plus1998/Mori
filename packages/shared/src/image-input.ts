/** Detect image blocks in model transcripts across Messages, Responses and Chat. */
export function containsImageInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImageInput);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (["image", "input_image", "image_url"].includes(String(record.type))) return true;
  // Tool arguments and schemas are data, not model image attachments.
  if (["tool_use", "function_call", "custom_tool_call"].includes(String(record.type))) return false;
  if (["function_call_output", "custom_tool_call_output"].includes(String(record.type))) {
    return containsImageInput(record.output);
  }
  return ["messages", "input", "content"].some((key) => containsImageInput(record[key]));
}
