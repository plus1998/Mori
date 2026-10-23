export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveThreadMessagePrompt(prompt: unknown): string {
  return readOptionalString(prompt) ?? "";
}
