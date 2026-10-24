/**
 * Long Claude summaries can exceed a Responses provider's 1000-item limit even
 * though the token window fits. Join adjacent plain messages of the same role;
 * keep every content block and all tool/reasoning items in their original order.
 */
export function coalesceResponsesCompactionInput(body: Record<string, unknown>): void {
  if (!Array.isArray(body.input) || body.input.length <= 1000) return;
  const input: unknown[] = [];
  let previous: { role: string; content: unknown[] } | undefined;
  for (const item of body.input) {
    const message = plainTextMessage(item);
    if (message && previous?.role === message.role) {
      previous.content.push(
        { type: message.role === "assistant" ? "output_text" : "input_text", text: "\n\n" },
        ...message.content,
      );
    } else {
      const copy = message ? { ...message, content: [...message.content] } : item;
      input.push(copy);
      previous = message ? (copy as typeof message) : undefined;
    }
  }
  body.input = input;
}

function plainTextMessage(
  value: unknown,
): (Record<string, unknown> & { role: string; content: unknown[] }) | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    item.type !== "message" ||
    (item.role !== "user" && item.role !== "assistant") ||
    Object.keys(item).some((key) => key !== "type" && key !== "role" && key !== "content") ||
    !Array.isArray(item.content) ||
    !item.content.every(
      (part) =>
        part &&
        typeof part === "object" &&
        (part.type === "input_text" || part.type === "output_text") &&
        typeof part.text === "string",
    )
  )
    return undefined;
  return item as Record<string, unknown> & { role: string; content: unknown[] };
}
