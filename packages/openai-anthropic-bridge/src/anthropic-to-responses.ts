import { type JsonValue, jsonMarshal, jsonParse } from "./json.js";
import type {
  AnthropicContentBlock,
  AnthropicImageSource,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesReasoning,
  ResponsesRequest,
  ResponsesTextFormat,
  ResponsesTool,
} from "./types.js";

/** Floor for max_output_tokens in Responses requests (matches Go minMaxOutputTokens). */
export const minMaxOutputTokens = 128;

export function toResponsesCallID(id: string): string {
  return id;
}

export function fromResponsesCallID(id: string): string {
  if (id.startsWith("fc_")) {
    const after = id.slice(3);
    if (after.startsWith("toolu_") || after.startsWith("call_")) {
      return after;
    }
  }
  return id;
}

export function isWebSearchToolName(name: string | undefined): boolean {
  return (name ?? "").trim() === "web_search";
}

export function normalizeWebSearchDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

export function mapAnthropicEffortToResponses(effort: string): string {
  if (effort === "max") {
    return "xhigh";
  }
  return effort;
}

export function reasoningEffortFromThinkingBudget(budgetTokens: number): string {
  if (budgetTokens >= 4096) {
    return "high";
  }
  if (budgetTokens >= 2048) {
    return "medium";
  }
  if (budgetTokens >= 1024) {
    return "low";
  }
  return "minimal";
}

export function defaultReasoningSummaryMode(): "auto" | "detailed" {
  const detailed =
    (process.env.LITELLM_REASONING_AUTO_SUMMARY ?? "").toLowerCase() === "true" ||
    (process.env.ECO_REASONING_AUTO_SUMMARY ?? "").toLowerCase() === "true";
  return detailed ? "detailed" : "auto";
}

export function isAnthropicBillingHeaderText(text: string): boolean {
  return text.startsWith("x-anthropic-billing-header: ");
}

export function anthropicImageToDataURI(src: AnthropicImageSource | undefined): string {
  if (src === undefined) {
    return "";
  }
  if (src.type === "url") {
    return src.url?.trim() ?? "";
  }
  if (src.data === undefined || src.data === "") {
    return "";
  }
  let mediaType = src.media_type ?? "";
  if (mediaType === "") {
    mediaType = "image/png";
  }
  return `data:${mediaType};base64,${src.data}`;
}

export function isReasoningModel(model: string): boolean {
  return model.startsWith("gpt-5");
}

export function normalizeToolParameters(schema: unknown): unknown {
  if (schema === undefined || schema === null || jsonMarshal(schema) === "null") {
    return { type: "object", properties: {} };
  }

  let m: Record<string, JsonValue>;
  try {
    const parsed = typeof schema === "string" ? jsonParse(schema) : schema;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return schema;
    }
    m = parsed as Record<string, JsonValue>;
  } catch {
    return schema;
  }

  if (m.type !== "object") {
    return schema;
  }

  if ("properties" in m) {
    return schema;
  }

  return { ...m, properties: {} };
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function translateAnthropicContextManagementToResponses(raw: unknown): unknown | undefined {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (!isUnknownRecord(raw) || !Array.isArray(raw.edits)) {
    return undefined;
  }

  const out: Record<string, unknown>[] = [];
  for (const edit of raw.edits) {
    if (!isUnknownRecord(edit)) {
      continue;
    }
    if (edit.type !== "compact_20260112") {
      continue;
    }
    const converted: Record<string, unknown> = { type: "compaction" };
    const trigger = edit.trigger;
    if (isUnknownRecord(trigger)) {
      const value = trigger.value;
      if (typeof value === "number" && Number.isFinite(value)) {
        converted.compact_threshold = Math.trunc(value);
      }
    }
    out.push(converted);
  }

  return out.length > 0 ? out : undefined;
}

export function normalizeExitPlanModeToolParameters(schema: unknown): unknown {
  const normalized = normalizeToolParameters(schema);
  let m: Record<string, JsonValue>;
  try {
    const parsed = typeof normalized === "string" ? jsonParse(normalized) : normalized;
    if (!isJsonRecord(parsed) || parsed.type !== "object") {
      return normalized;
    }
    m = parsed;
  } catch {
    return normalized;
  }

  const properties = isJsonRecord(m.properties) ? { ...m.properties } : {};
  properties.plan = isJsonRecord(properties.plan)
    ? {
        ...properties.plan,
        description:
          typeof properties.plan.description === "string"
            ? properties.plan.description
            : "Complete Markdown plan to submit for Mori approval.",
      }
    : {
        type: "string",
        description: "Complete Markdown plan to submit for Mori approval.",
      };
  properties.planContent = isJsonRecord(properties.planContent)
    ? {
        ...properties.planContent,
        description:
          typeof properties.planContent.description === "string"
            ? properties.planContent.description
            : "Alias for the complete Markdown plan. Prefer plan when possible.",
      }
    : {
        type: "string",
        description: "Alias for the complete Markdown plan. Prefer plan when possible.",
      };

  const required = Array.isArray(m.required)
    ? m.required.filter((item): item is string => typeof item === "string")
    : [];
  if (!required.includes("plan")) {
    required.push("plan");
  }

  return { ...m, properties, required };
}

function normalizeToolParametersForTool(name: string, schema: unknown): unknown {
  return name === "ExitPlanMode"
    ? normalizeExitPlanModeToolParameters(schema)
    : normalizeToolParameters(schema);
}

function augmentToolDescription(name: string, description: string | undefined): string | undefined {
  if (name !== "ExitPlanMode") {
    return description;
  }
  const requirement = "Mori requirement: include the complete Markdown plan in the `plan` tool input field.";
  return description?.trim() ? `${description.trim()}\n\n${requirement}` : requirement;
}

/** Map Anthropic thinking/effort fields to OpenAI Responses reasoning, when enabled. */
export function resolveAnthropicReasoningForResponses(req: AnthropicRequest): ResponsesReasoning | undefined {
  if (req.thinking?.type === "disabled") {
    return undefined;
  }

  let effort: string | undefined;
  if (req.output_config?.effort !== undefined && req.output_config.effort !== "") {
    effort = req.output_config.effort;
  } else if (req.effort !== undefined && req.effort !== "") {
    effort = req.effort;
  } else if (req.thinking?.type === "adaptive") {
    effort = "medium";
  } else if (req.thinking?.type === "enabled") {
    effort = reasoningEffortFromThinkingBudget(req.thinking.budget_tokens ?? 0);
  }

  if (effort === undefined) {
    return undefined;
  }

  const reasoning: ResponsesReasoning = {
    effort: mapAnthropicEffortToResponses(effort),
  };

  if (req.thinking?.summary !== undefined && req.thinking.summary !== "") {
    reasoning.summary = req.thinking.summary;
  } else {
    // Anthropic thinking clients expect a textual thinking block. Without a
    // Responses reasoning summary request, closed reasoning models may return
    // only encrypted state and token counts, leaving nothing to translate.
    reasoning.summary = defaultReasoningSummaryMode();
  }

  return reasoning;
}

export function anthropicToResponses(req: AnthropicRequest): ResponsesRequest {
  let input = convertAnthropicToResponsesInput(undefined, req.messages);
  const instructions = anthropicSystemToResponsesInstructions(req.system);
  if (input.length === 0 && instructions !== "") {
    input = [
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: instructions }],
      },
    ];
  }

  const out: ResponsesRequest = {
    model: req.model,
    input,
    stream: req.stream ?? false,
    include: ["reasoning.encrypted_content"],
  };

  if (!isReasoningModel(req.model)) {
    out.temperature = req.temperature;
    out.top_p = req.top_p;
  }

  out.store = false;
  out.parallel_tool_calls = true;
  const outputFormat = anthropicOutputFormatToResponses(req.output_format);
  out.text =
    outputFormat === undefined ? { verbosity: "medium" } : { verbosity: "medium", format: outputFormat };

  if (instructions !== "" && input.length > 0 && input[0]?.role !== "system") {
    out.instructions = instructions;
  }

  if (req.max_tokens > 0) {
    let v = req.max_tokens;
    if (v < minMaxOutputTokens) {
      v = minMaxOutputTokens;
    }
    out.max_output_tokens = v;
  }

  if (req.tools !== undefined && req.tools.length > 0) {
    out.tools = convertAnthropicToolsToResponses(req.tools);
  }

  const reasoning = resolveAnthropicReasoningForResponses(req);
  if (reasoning !== undefined) {
    out.reasoning = reasoning;
  }

  if (req.tool_choice !== undefined) {
    out.tool_choice = convertAnthropicToolChoiceToResponses(req.tool_choice);
  }

  // Anthropic cache_control breakpoints (including the top-level shortcut) have no
  // direct Responses wire-body equivalent. Promoting one to a top-level parameter
  // makes strict Responses gateways reject the request.
  const contextManagement = translateAnthropicContextManagementToResponses(req.context_management);
  if (contextManagement !== undefined) {
    out.context_management = contextManagement;
  }

  return out;
}

export function anthropicOutputFormatToResponses(raw: unknown): ResponsesTextFormat | undefined {
  if (!isUnknownRecord(raw) || raw.type !== "json_schema" || raw.schema === undefined) {
    return undefined;
  }

  return {
    type: "json_schema",
    name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : "eco_structured_output",
    ...(typeof raw.description === "string" && raw.description.trim() !== ""
      ? { description: raw.description.trim() }
      : {}),
    schema: raw.schema,
    strict: raw.strict !== false,
  };
}

export function convertAnthropicToolChoiceToResponses(raw: unknown): unknown {
  // OpenAI Responses / DeepSeek Responses expect string tool_choice for
  // auto|none|required; object form is only for function|web_search|custom.
  // Returning { type: "auto" } causes: unknown variant `auto`, expected function|…
  if (typeof raw === "string") {
    if (raw === "any") return "required";
    return raw;
  }
  const tc = raw as { type?: string; name?: string };
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return isWebSearchToolName(tc.name) ? { type: "web_search" } : { type: "function", name: tc.name };
    default:
      return raw;
  }
}

export function convertAnthropicToResponsesInput(
  system: unknown,
  msgs: AnthropicMessage[],
): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];

  if (system !== undefined && system !== null) {
    const sysParts = parseAnthropicSystemContentParts(system);
    if (sysParts.length > 0) {
      out.push({
        type: "message",
        role: "developer",
        content: sysParts,
      });
    }
  }

  for (const m of msgs) {
    out.push(...anthropicMsgToResponsesItems(m));
  }
  return out;
}

export function anthropicSystemToResponsesInstructions(raw: unknown): string {
  const parts = parseAnthropicSystemContentParts(raw);
  return parts
    .map((part) => part.text ?? "")
    .filter((text) => text !== "")
    .join("\n");
}

export function parseAnthropicSystemContentParts(raw: unknown): ResponsesContentPart[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (typeof raw === "string") {
    if (isAnthropicBillingHeaderText(raw) || raw === "") {
      return [];
    }
    return [{ type: "input_text", text: raw }];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const blocks = raw as AnthropicContentBlock[];
  const parts: ResponsesContentPart[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text !== undefined && b.text !== "" && !isAnthropicBillingHeaderText(b.text)) {
      parts.push({ type: "input_text", text: b.text });
    }
  }
  return parts;
}

export function anthropicMsgToResponsesItems(m: AnthropicMessage): ResponsesInputItem[] {
  switch (m.role) {
    case "user":
      return anthropicUserToResponses(m.content);
    case "assistant":
      return anthropicAssistantToResponses(m.content);
    default:
      return anthropicUserToResponses(m.content);
  }
}

export function anthropicUserToResponses(raw: unknown): ResponsesInputItem[] {
  if (typeof raw === "string") {
    const parts: ResponsesContentPart[] = [{ type: "input_text", text: raw }];
    return [{ type: "message", role: "user", content: parts }];
  }

  const blocks = raw as AnthropicContentBlock[];
  const out: ResponsesInputItem[] = [];
  let toolResultImageParts: ResponsesContentPart[] = [];

  for (const b of blocks) {
    if (b.type !== "tool_result") {
      continue;
    }
    const { outputText, imageParts } = convertToolResultOutput(b);
    out.push({
      type: "function_call_output",
      call_id: toResponsesCallID(b.tool_use_id ?? ""),
      output: outputText,
    });
    toolResultImageParts = toolResultImageParts.concat(imageParts);
  }

  const parts: ResponsesContentPart[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        if (b.text !== undefined && b.text !== "") {
          parts.push({ type: "input_text", text: b.text });
        }
        break;
      case "image": {
        const uri = anthropicImageToDataURI(b.source);
        if (uri !== "") {
          parts.push({ type: "input_image", image_url: uri });
        }
        break;
      }
    }
  }
  parts.push(...toolResultImageParts);

  if (parts.length > 0) {
    out.push({ type: "message", role: "user", content: parts });
  }

  return out;
}

export function anthropicAssistantToResponses(raw: unknown): ResponsesInputItem[] {
  if (typeof raw === "string") {
    const parts: ResponsesContentPart[] = [{ type: "output_text", text: raw }];
    return [{ type: "message", role: "assistant", content: parts }];
  }

  const blocks = raw as AnthropicContentBlock[];
  const items: ResponsesInputItem[] = [];

  for (const b of blocks) {
    const reasoning = anthropicThinkingBlockToResponsesItem(b, items.length);
    if (reasoning !== undefined) {
      items.push(reasoning);
    }
  }

  const text = extractAnthropicTextFromBlocks(blocks);
  if (text !== "") {
    const parts: ResponsesContentPart[] = [{ type: "output_text", text }];
    items.push({ type: "message", role: "assistant", content: parts });
  }

  for (const b of blocks) {
    if (b.type !== "tool_use") {
      continue;
    }
    let args = "{}";
    if (b.input !== undefined) {
      args = typeof b.input === "string" ? b.input : jsonMarshal(b.input);
    }
    items.push({
      type: "function_call",
      call_id: toResponsesCallID(b.id ?? ""),
      name: b.name,
      arguments: args,
    });
  }

  return items;
}

function anthropicThinkingBlockToResponsesItem(
  block: AnthropicContentBlock,
  index: number,
): ResponsesInputItem | undefined {
  if (block.type !== "thinking" && block.type !== "redacted_thinking") {
    return undefined;
  }

  const item: ResponsesInputItem = {
    type: "reasoning",
    id: block.id ?? `rs_${index}`,
    summary: [],
  };
  if (block.type === "thinking" && block.thinking !== undefined && block.thinking !== "") {
    item.content = [{ type: "reasoning_text", text: block.thinking }];
  }
  if (block.type === "redacted_thinking" && block.data !== undefined && block.data !== "") {
    item.encrypted_content = block.data;
  }
  const content = Array.isArray(item.content) ? item.content : [];
  if (content.length === 0 && item.encrypted_content === undefined) {
    return undefined;
  }
  return item;
}

export function convertToolResultOutput(b: AnthropicContentBlock): {
  outputText: string;
  imageParts: ResponsesContentPart[];
} {
  if (b.content === undefined || b.content === null) {
    return { outputText: "", imageParts: [] };
  }

  if (typeof b.content === "string") {
    return { outputText: b.content, imageParts: [] };
  }

  const inner = b.content as AnthropicContentBlock[];
  const textParts: string[] = [];
  const imageParts: ResponsesContentPart[] = [];
  for (const ib of inner) {
    switch (ib.type) {
      case "text":
        if (ib.text !== undefined && ib.text !== "") {
          textParts.push(ib.text);
        }
        break;
      case "image": {
        const uri = anthropicImageToDataURI(ib.source);
        if (uri !== "") {
          imageParts.push({ type: "input_image", image_url: uri });
        }
        break;
      }
    }
  }

  return { outputText: textParts.join("\n"), imageParts };
}

export function extractAnthropicTextFromBlocks(blocks: AnthropicContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text !== undefined && b.text !== "") {
      parts.push(b.text);
    }
  }
  return parts.join("\n\n");
}

export function convertAnthropicToolsToResponses(tools: AnthropicTool[]): ResponsesTool[] {
  const out: ResponsesTool[] = [];
  for (const t of tools) {
    if ((t.type !== undefined && t.type.startsWith("web_search")) || isWebSearchToolName(t.name)) {
      const converted: ResponsesTool = { type: "web_search" };
      const allowedDomains = (t.allowed_domains ?? [])
        .map(normalizeWebSearchDomain)
        .filter((domain) => domain !== "");
      if (allowedDomains.length > 0) {
        converted.filters = { allowed_domains: allowedDomains };
      }
      out.push(converted);
      continue;
    }
    out.push({
      type: "function",
      name: t.name,
      description: augmentToolDescription(t.name, t.description),
      parameters: normalizeToolParametersForTool(t.name, t.input_schema),
      strict: false,
    });
  }
  return out;
}

export function extractAnthropicRequestToolNames(req: AnthropicRequest): string[] {
  const names: string[] = [];
  for (const tool of req.tools ?? []) {
    if (typeof tool.name === "string" && tool.name.trim() !== "") {
      names.push(tool.name.trim());
    }
  }
  return names;
}

/** Map upstream function names back to Anthropic/SDK tool ids (e.g. MCP prefixes). */
export function normalizeFunctionCallNameForRequest(
  name: string,
  requestToolNames: readonly string[],
): string {
  const trimmed = name.trim();
  if (trimmed === "" || requestToolNames.length === 0) {
    return trimmed;
  }
  if (requestToolNames.includes(trimmed)) {
    return trimmed;
  }
  const suffix = `__${trimmed}`;
  const bySuffix = requestToolNames.find((tool) => tool.endsWith(suffix));
  if (bySuffix) {
    return bySuffix;
  }
  const doubleUnderscore = requestToolNames.find(
    (tool) => tool.replace(/^mcp__/, "").replace(/__/g, "_") === trimmed.replace(/_/g, "_"),
  );
  if (doubleUnderscore) {
    return doubleUnderscore;
  }
  return trimmed;
}
