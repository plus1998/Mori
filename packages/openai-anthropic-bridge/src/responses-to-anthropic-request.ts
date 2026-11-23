import {
  CUSTOM_TOOL_INPUT_FIELD,
  customToolInputFromChatArguments,
  flattenNamespaceToolName,
} from "./codex-chat-common.js";
import {
  buildCodexToolContextFromRequest,
  type CodexToolContext,
  chatNameForResponseFunction,
  isCustomToolChatName,
} from "./codex-tool-context.js";
import { bytesTrimSpace, jsonMarshal, jsonParse } from "./json.js";
import {
  classifyResponsesReasoningItem,
  selectDisplayReasoningText,
} from "./reasoning-classify.js";
import type {
  AnthropicContentBlock,
  AnthropicImageSource,
  AnthropicMessage,
  AnthropicOutputConfig,
  AnthropicRequest,
  AnthropicThinking,
  AnthropicTool,
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesTool,
} from "./types.js";

export function responsesToAnthropicRequest(req: ResponsesRequest): AnthropicRequest {
  const toolContext = buildCodexToolContextFromRequest(req);
  const { system, messages, err } = convertResponsesInputToAnthropic(req.input, toolContext);
  if (err !== undefined) {
    throw err;
  }

  const out: AnthropicRequest = {
    model: req.model,
    messages,
    max_tokens: 8192,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: req.stream,
  };

  const combinedSystem = combineResponsesInstructionsAndSystem(req.instructions, system);
  if (combinedSystem !== undefined) {
    out.system = combinedSystem;
  }

  if (req.max_output_tokens !== undefined && req.max_output_tokens > 0) {
    out.max_tokens = req.max_output_tokens;
  }

  if (req.tools !== undefined && req.tools.length > 0) {
    out.tools = convertResponsesToAnthropicTools(req.tools, toolContext);
  }

  if (req.tool_choice !== undefined) {
    const tc = convertResponsesToAnthropicToolChoice(req.tool_choice);
    if (tc.err !== undefined) {
      throw new Error(`convert tool_choice: ${tc.err.message}`);
    }
    if (tc.value !== undefined) {
      out.tool_choice = tc.value;
    }
  }

  const reasoningEffort = typeof req.reasoning?.effort === "string" ? req.reasoning.effort.trim() : "";
  if (reasoningEffort !== "") {
    const requestedEffort = reasoningEffort.toLowerCase();
    if (["none", "off", "disabled"].includes(requestedEffort)) {
      out.thinking = { type: "disabled" } satisfies AnthropicThinking;
    } else {
      const effort = mapResponsesEffortToAnthropic(requestedEffort);
      out.output_config = { effort } satisfies AnthropicOutputConfig;
      if (effort !== "low") {
        out.thinking = {
          type: "enabled",
          budget_tokens: defaultThinkingBudget(effort),
        } satisfies AnthropicThinking;
      }
    }
  }

  return out;
}

export function defaultThinkingBudget(effort: string): number {
  switch (effort) {
    case "low":
      return 1024;
    case "medium":
      return 4096;
    case "high":
      return 10240;
    case "max":
      return 32768;
    default:
      return 10240;
  }
}

export function mapResponsesEffortToAnthropic(effort: string): string {
  if (effort === "xhigh") {
    return "max";
  }
  return effort;
}

function convertResponsesInputToAnthropic(
  inputRaw: unknown,
  toolContext: CodexToolContext = buildCodexToolContextFromRequest(undefined),
): {
  system: unknown | undefined;
  messages: AnthropicMessage[];
  err: Error | undefined;
} {
  const serialized = typeof inputRaw === "string" ? inputRaw : jsonMarshal(inputRaw);

  try {
    const asString = jsonParse(serialized) as unknown;
    if (typeof asString === "string") {
      return {
        system: undefined,
        messages: [{ role: "user", content: asString }],
        err: undefined,
      };
    }
  } catch {
    /* not a JSON string literal */
  }

  let items: ResponsesInputItem[];
  try {
    const parsed = jsonParse(serialized) as unknown;
    if (typeof parsed === "string") {
      return {
        system: undefined,
        messages: [{ role: "user", content: parsed }],
        err: undefined,
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        system: undefined,
        messages: [],
        err: new Error("parse responses input: expected array or string"),
      };
    }
    items = parsed as ResponsesInputItem[];
  } catch (e) {
    return {
      system: undefined,
      messages: [],
      err: new Error(`parse responses input: ${e instanceof Error ? e.message : String(e)}`),
    };
  }

  let system: unknown | undefined;
  const messages: AnthropicMessage[] = [];
  const functionOutputs = new Map(
    items
      .filter((item) => item.type === "function_call_output" && item.call_id)
      .map((item) => [item.call_id, item] as const),
  );
  const rejectedOutputs = new Map<ResponsesInputItem, AnthropicContentBlock>();
  const rejectedDiagnostics = new Set<AnthropicContentBlock>();

  for (const item of items) {
    if (item.role === "system" || item.role === "developer") {
      const text = extractTextFromContent(item.content);
      if (text !== "") {
        system = appendSystemText(system, text);
      }
    } else if (item.type === "reasoning") {
      const blocks = responsesReasoningInputToAnthropicBlocks(item);
      if (blocks.length > 0) {
        messages.push({
          role: "assistant",
          content: blocks,
        });
      }
    } else if (item.type === "function_call") {
      const wireName = item.name ?? "";
      const namespace =
        typeof (item as { namespace?: unknown }).namespace === "string"
          ? (item as { namespace: string }).namespace
          : undefined;
      const toolName = chatNameForResponseFunction(toolContext, wireName, namespace);
      const isCustom = isCustomToolChatName(toolContext, toolName) || isCustomToolChatName(toolContext, wireName);
      let input: unknown;
      try {
        input = item.arguments !== undefined && item.arguments !== "" ? jsonParse(item.arguments) : {};
        if (!isCustom && (input === null || typeof input !== "object" || Array.isArray(input))) {
          throw new Error("Function call arguments must be a JSON object.");
        }
      } catch (error) {
        const rejectedOutput = functionOutputs.get(item.call_id);
        const failure = extractTextFromContent(rejectedOutput?.output);
        // Codex records the rejected call as well as its parse error. Anthropic
        // needs a JSON object for tool_use.input, so represent the actual error
        // in the transcript without sending a tool_use for the rejected attempt.
        if (!rejectedOutput || !isFunctionArgumentParseFailure(failure)) {
          throw error;
        }
        const diagnostic: AnthropicContentBlock = {
          type: "text",
          text: `Tool call ${toolName} was rejected before execution because its arguments could not be parsed.\n${failure}`,
        };
        rejectedOutputs.set(rejectedOutput, diagnostic);
        rejectedDiagnostics.add(diagnostic);
        continue;
      }
      if (isCustom) {
        input = {
          [CUSTOM_TOOL_INPUT_FIELD]: customToolInputFromChatArguments(
            typeof item.arguments === "string" ? item.arguments : jsonMarshal(input),
          ),
        };
      }
      const block: AnthropicContentBlock = {
        type: "tool_use",
        id: fromResponsesCallIdToAnthropic(item.call_id ?? ""),
        name: toolName,
        input,
      };
      messages.push({
        role: "assistant",
        content: [block],
      });
    } else if (item.type === "custom_tool_call") {
      const name = item.name ?? "";
      if (name && !isCustomToolChatName(toolContext, name)) {
        toolContext.chatNameToSpec.set(name, { kind: "custom", name });
      }
      const freeformInput =
        typeof item.input === "string"
          ? item.input
          : item.input === undefined || item.input === null
            ? ""
            : jsonMarshal(item.input);
      const block: AnthropicContentBlock = {
        type: "tool_use",
        id: fromResponsesCallIdToAnthropic(item.call_id ?? ""),
        name,
        input: { [CUSTOM_TOOL_INPUT_FIELD]: freeformInput },
      };
      messages.push({
        role: "assistant",
        content: [block],
      });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const rejectedDiagnostic = rejectedOutputs.get(item);
      if (rejectedDiagnostic) {
        messages.push({ role: "user", content: [rejectedDiagnostic] });
        continue;
      }
      const content = convertResponsesFunctionCallOutputToAnthropicContent(item.output);
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: fromResponsesCallIdToAnthropic(item.call_id ?? ""),
        content,
      };
      messages.push({
        role: "user",
        content: [block],
      });
    } else if (item.role === "assistant") {
      const result = convertResponsesAssistantToAnthropicContent(item.content);
      if (result.err !== undefined) {
        return { system: undefined, messages: [], err: result.err };
      }
      messages.push({
        role: "assistant",
        content: result.content,
      });
    } else if (item.role === "user" || item.type === "message" || item.content !== undefined) {
      // Message items may omit role (Codex multi-agent history). Never pass Responses
      // content types (input_text/output_text) through raw to Anthropic.
      const result = convertResponsesUserToAnthropicContent(item.content);
      if (result.err !== undefined) {
        return { system: undefined, messages: [], err: result.err };
      }
      messages.push({
        role: "user",
        content: result.content,
      });
    }
  }

  const merged = mergeConsecutiveMessages(messages);
  if (rejectedDiagnostics.size > 0) {
    for (const message of merged) {
      if (message.role !== "user" || !Array.isArray(message.content)) continue;
      const blocks = message.content as AnthropicContentBlock[];
      if (!blocks.some((block) => rejectedDiagnostics.has(block))) continue;
      // Anthropic requires successful parallel tool results to precede any text.
      message.content = [
        ...blocks.filter((block) => block.type === "tool_result"),
        ...blocks.filter((block) => block.type !== "tool_result"),
      ];
    }
  }

  return {
    system,
    messages: sanitizeAnthropicMessages(merged),
    err: undefined,
  };
}

function isFunctionArgumentParseFailure(text: string): boolean {
  return /^(?:failed to parse function arguments:|err: .+ at line \d+ column \d+\s*$)/im.test(text);
}

function combineResponsesInstructionsAndSystem(
  instructions: string | undefined,
  system: unknown | undefined,
): unknown | undefined {
  const parts: string[] = [];
  if (instructions !== undefined && bytesTrimSpace(instructions) !== "") {
    parts.push(instructions);
  }
  const systemText = extractTextFromContent(system);
  if (systemText !== "") {
    parts.push(systemText);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n");
}

function appendSystemText(current: unknown | undefined, text: string): unknown {
  const existing = extractTextFromContent(current);
  if (existing === "") {
    return text;
  }
  return `${existing}\n${text}`;
}

function responsesReasoningInputToAnthropicBlocks(item: ResponsesInputItem): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  const classified = classifyResponsesReasoningItem({
    id: item.id,
    summary: Array.isArray(item.summary) ? item.summary : [],
    content: Array.isArray(item.content) ? (item.content as ResponsesContentPart[]) : undefined,
    encrypted_content: item.encrypted_content,
  });
  const display = selectDisplayReasoningText(classified);
  if (display !== "") {
    blocks.push({
      type: "thinking",
      thinking: display,
    });
  }
  if (item.encrypted_content !== undefined && item.encrypted_content !== "") {
    blocks.push({
      type: "redacted_thinking",
      data: item.encrypted_content,
    });
  }
  return blocks;
}

function convertResponsesFunctionCallOutputToAnthropicContent(
  raw: unknown,
): string | AnthropicContentBlock[] {
  if (raw === undefined || raw === null) {
    return "(empty)";
  }
  if (typeof raw === "string") {
    if (raw === "") {
      return "(empty)";
    }
    try {
      const parsed = jsonParse(raw);
      if (typeof parsed === "string") {
        return parsed;
      }
      return convertResponsesFunctionCallOutputToAnthropicContent(parsed);
    } catch {
      return raw;
    }
  }
  if (Array.isArray(raw)) {
    const blocks: AnthropicContentBlock[] = [];
    for (const part of raw) {
      if (part === null || typeof part !== "object" || Array.isArray(part)) {
        continue;
      }
      const p = part as ResponsesContentPart;
      switch (p.type) {
        case "input_text":
        case "output_text":
        case "text":
        case "encrypted_content": {
          const text = textFromResponsesContentPart(p);
          if (text !== "") {
            blocks.push({ type: "text", text });
          }
          break;
        }
        case "input_image": {
          const source = dataUriToAnthropicImageSource(p.image_url ?? "");
          if (source !== undefined) {
            blocks.push({ type: "image", source });
          }
          break;
        }
      }
    }
    if (blocks.length > 0) {
      return blocks;
    }
    return "(empty)";
  }
  return jsonMarshal(raw);
}

/** Codex multi-agent NEW_TASK puts the real body in `encrypted_content` (plaintext). */
function textFromResponsesContentPart(p: ResponsesContentPart): string {
  if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
    return typeof p.text === "string" ? p.text : "";
  }
  if (p.type === "encrypted_content") {
    const encrypted = (p as { encrypted_content?: unknown }).encrypted_content;
    if (typeof encrypted === "string") {
      return encrypted;
    }
    if (typeof p.text === "string") {
      return p.text;
    }
  }
  return "";
}

export function extractTextFromContent(raw: unknown): string {
  if (raw === undefined || raw === null) {
    return "";
  }
  if (typeof raw === "string") {
    try {
      const parsed = jsonParse(raw);
      if (typeof parsed === "string") {
        return parsed;
      }
      return extractTextFromContent(parsed);
    } catch {
      return raw;
    }
  }
  if (typeof raw === "string") {
    return raw;
  }
  const parts = raw as ResponsesContentPart[];
  if (Array.isArray(parts)) {
    const texts: string[] = [];
    for (const p of parts) {
      const text = textFromResponsesContentPart(p);
      if (text !== "") {
        texts.push(text);
      }
    }
    return texts.join("\n\n");
  }
  try {
    const s = jsonMarshal(raw);
    const parsed = jsonParse(s);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (Array.isArray(parsed)) {
      return extractTextFromContent(parsed);
    }
  } catch {
    /* ignore */
  }
  return "";
}

function convertResponsesUserToAnthropicContent(raw: unknown): {
  content: unknown;
  err: Error | undefined;
} {
  if (raw === undefined || raw === null) {
    return { content: "", err: undefined };
  }

  if (typeof raw === "string") {
    try {
      const parsed = jsonParse(raw);
      if (typeof parsed === "string") {
        return { content: parsed, err: undefined };
      }
      return convertResponsesUserToAnthropicContent(parsed);
    } catch {
      return { content: raw, err: undefined };
    }
  }

  let parts: ResponsesContentPart[];
  try {
    const serialized = typeof raw === "string" ? raw : jsonMarshal(raw);
    const parsed = jsonParse(serialized);
    if (typeof parsed === "string") {
      return { content: parsed, err: undefined };
    }
    if (!Array.isArray(parsed)) {
      // Single content part object (e.g. {type:'input_text', text:'...'}).
      if (parsed !== null && typeof parsed === "object") {
        return convertResponsesUserToAnthropicContent([parsed]);
      }
      const text = extractTextFromContent(parsed);
      return { content: text, err: undefined };
    }
    parts = parsed as unknown as ResponsesContentPart[];
  } catch {
    const text = extractTextFromContent(raw);
    return { content: text, err: undefined };
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "input_text":
      case "output_text":
      case "text":
      case "encrypted_content": {
        const text = textFromResponsesContentPart(p);
        if (text !== "") {
          blocks.push({ type: "text", text });
        }
        break;
      }
      case "input_image": {
        const src = dataUriToAnthropicImageSource(p.image_url ?? "");
        if (src !== undefined) {
          blocks.push({ type: "image", source: src });
        }
        break;
      }
    }
  }

  if (blocks.length === 0) {
    return { content: "", err: undefined };
  }
  return { content: blocks, err: undefined };
}

function convertResponsesAssistantToAnthropicContent(raw: unknown): {
  content: unknown;
  err: Error | undefined;
} {
  if (raw === undefined || raw === null) {
    return {
      content: [{ type: "text", text: "" }],
      err: undefined,
    };
  }

  if (typeof raw === "string") {
    try {
      const parsed = jsonParse(raw);
      if (typeof parsed === "string") {
        return {
          content: [{ type: "text", text: parsed }],
          err: undefined,
        };
      }
      return convertResponsesAssistantToAnthropicContent(parsed);
    } catch {
      return {
        content: [{ type: "text", text: raw }],
        err: undefined,
      };
    }
  }

  let parts: ResponsesContentPart[];
  try {
    const serialized = typeof raw === "string" ? raw : jsonMarshal(raw);
    const parsed = jsonParse(serialized);
    if (typeof parsed === "string") {
      return {
        content: [{ type: "text", text: parsed }],
        err: undefined,
      };
    }
    if (!Array.isArray(parsed)) {
      if (parsed !== null && typeof parsed === "object") {
        return convertResponsesAssistantToAnthropicContent([parsed]);
      }
      return {
        content: [{ type: "text", text: extractTextFromContent(parsed) }],
        err: undefined,
      };
    }
    parts = parsed as unknown as ResponsesContentPart[];
  } catch {
    return {
      content: [{ type: "text", text: extractTextFromContent(raw) }],
      err: undefined,
    };
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "input_text":
      case "output_text":
      case "text":
      case "encrypted_content": {
        const text = textFromResponsesContentPart(p);
        if (text !== "") {
          blocks.push({ type: "text", text });
        }
        break;
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return { content: blocks, err: undefined };
}

export function fromResponsesCallIdToAnthropic(id: string): string {
  if (id.startsWith("fc_")) {
    const after = id.slice(3);
    if (after.startsWith("toolu_") || after.startsWith("call_")) {
      return after;
    }
  }
  if (!id.startsWith("toolu_") && !id.startsWith("call_")) {
    return `toolu_${id}`;
  }
  return id;
}

export function dataUriToAnthropicImageSource(dataUri: string): AnthropicImageSource | undefined {
  if (!dataUri.startsWith("data:")) {
    return undefined;
  }
  let rest = dataUri.slice(5);
  const semicolonIdx = rest.indexOf(";");
  if (semicolonIdx < 0) {
    return undefined;
  }
  const mediaType = rest.slice(0, semicolonIdx);
  rest = rest.slice(semicolonIdx + 1);
  if (!rest.startsWith("base64,")) {
    return undefined;
  }
  const data = rest.slice(7);
  return {
    type: "base64",
    media_type: mediaType,
    data,
  };
}

export function mergeConsecutiveMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length <= 1) {
    return messages;
  }

  const merged: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (merged.length === 0 || merged[merged.length - 1]?.role !== msg.role) {
      merged.push(msg);
      continue;
    }

    const last = merged[merged.length - 1];
    if (last === undefined) {
      continue;
    }
    const lastBlocks = parseContentBlocks(last.content);
    const newBlocks = parseContentBlocks(msg.content);
    const combined = [...lastBlocks, ...newBlocks];
    last.content = combined;
  }
  return merged;
}

export function parseContentBlocks(raw: unknown): AnthropicContentBlock[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (Array.isArray(raw)) {
    return sanitizeAnthropicContentBlocks(raw);
  }
  try {
    const serialized = typeof raw === "string" ? raw : jsonMarshal(raw);
    const parsed = jsonParse(serialized);
    if (Array.isArray(parsed)) {
      return sanitizeAnthropicContentBlocks(parsed);
    }
    if (typeof parsed === "string") {
      return [{ type: "text", text: parsed }];
    }
  } catch {
    /* fall through */
  }
  if (typeof raw === "string") {
    return [{ type: "text", text: raw }];
  }
  return [];
}

/** Map residual Responses part types so Anthropic never sees input_text/output_text. */
export function sanitizeAnthropicContentBlocks(parts: unknown[]): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      continue;
    }
    const p = part as AnthropicContentBlock & {
      type?: string;
      text?: string;
      content?: unknown;
    };
    if (p.type === "input_text" || p.type === "output_text") {
      out.push({ type: "text", text: typeof p.text === "string" ? p.text : "" });
      continue;
    }
    if (p.type === "encrypted_content") {
      const encrypted = (p as { encrypted_content?: unknown }).encrypted_content;
      const text = typeof encrypted === "string" ? encrypted : typeof p.text === "string" ? p.text : "";
      if (text !== "") {
        out.push({ type: "text", text });
      }
      continue;
    }
    if (p.type === "tool_result" && Array.isArray(p.content)) {
      out.push({
        ...p,
        type: "tool_result",
        content: sanitizeAnthropicContentBlocks(p.content),
      } as AnthropicContentBlock);
      continue;
    }
    out.push(p as AnthropicContentBlock);
  }
  return out;
}

export function sanitizeAnthropicMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return msg;
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: sanitizeAnthropicContentBlocks(msg.content),
      };
    }
    return msg;
  });
}

function convertResponsesToAnthropicTools(
  tools: ResponsesTool[],
  toolContext: CodexToolContext = buildCodexToolContextFromRequest(undefined),
): AnthropicTool[] {
  const out: AnthropicTool[] = [];
  for (const t of tools) {
    switch (t.type) {
      case "web_search":
      case "web_search_preview":
      case "google_search":
      case "web_search_20250305": {
        const webSearchTool: AnthropicTool = {
          type: "web_search_20250305",
          name: "web_search",
          input_schema: {},
        };
        const allowedDomains = t.filters?.allowed_domains;
        if (allowedDomains !== undefined && allowedDomains.length > 0) {
          webSearchTool.allowed_domains = allowedDomains;
        }
        out.push(webSearchTool);
        break;
      }
      case "function":
        out.push({
          name: t.name ?? "",
          description: t.description,
          input_schema: normalizeAnthropicInputSchema(t.parameters),
        });
        break;
      case "namespace": {
        // Anthropic has no namespace tool type. Flatten children like chat/OpenAI paths
        // (`collaboration` + `spawn_agent` → `collaboration__spawn_agent`) so multi-agent
        // tools reach Anthropic-compatible /messages upstreams.
        const namespace = (t.name ?? "").replace(/_+$/g, "");
        if (!namespace) {
          break;
        }
        for (const child of t.tools ?? []) {
          if (child.type !== "function") {
            continue;
          }
          const childName = (child.name ?? "").trim();
          if (!childName) {
            continue;
          }
          const chatName = flattenNamespaceToolName(namespace, childName);
          out.push({
            name: chatName,
            description: child.description,
            input_schema: normalizeAnthropicInputSchema(child.parameters),
          });
        }
        break;
      }
      case "custom": {
        // Never send invalid Anthropic type:"custom". Wrap freeform tools as client tools.
        const name = t.name ?? "";
        if (name) {
          toolContext.chatNameToSpec.set(name, { kind: "custom", name });
        }
        out.push({
          name,
          description:
            t.description ?? `Original custom tool definition:\n\`\`\`json\n${jsonMarshal(t)}\n\`\`\``,
          input_schema: {
            type: "object",
            properties: {
              [CUSTOM_TOOL_INPUT_FIELD]: {
                type: "string",
                description: "Raw string input for the original custom tool. Preserve formatting exactly.",
              },
            },
            required: [CUSTOM_TOOL_INPUT_FIELD],
          },
        });
        break;
      }
      default:
        // Drop unknown tool types rather than forwarding invalid Anthropic tool shapes.
        if (typeof t.name === "string" && t.name.trim() && t.parameters !== undefined) {
          out.push({
            name: t.name,
            description: t.description,
            input_schema: normalizeAnthropicInputSchema(t.parameters),
          });
        }
        break;
    }
  }
  return out;
}

function normalizeAnthropicInputSchema(schema: unknown): unknown {
  if (schema === undefined || schema === null || jsonMarshal(schema) === "null") {
    return { type: "object", properties: {} };
  }
  return schema;
}

function convertResponsesToAnthropicToolChoice(raw: unknown): {
  value: unknown | undefined;
  err: Error | undefined;
} {
  if (typeof raw === "string") {
    try {
      const parsed = jsonParse(raw);
      return convertResponsesToAnthropicToolChoice(parsed);
    } catch {
      /* use as string below */
    }
  }

  let value = raw;
  if (typeof raw === "string") {
    try {
      value = jsonParse(raw);
    } catch {
      value = raw;
    }
  }

  if (typeof value === "string") {
    switch (value) {
      case "auto":
        return { value: { type: "auto" }, err: undefined };
      case "required":
        return { value: { type: "any" }, err: undefined };
      case "none":
        return { value: { type: "none" }, err: undefined };
      default:
        return { value: raw, err: undefined };
    }
  }

  const tc = value as {
    type?: string;
    name?: string;
    function?: { name?: string };
  };
  if (tc.type === "web_search" || tc.type === "web_search_preview") {
    return { value: { type: "tool", name: "web_search" }, err: undefined };
  }

  if (tc.type === "required") {
    return { value: { type: "any" }, err: undefined };
  }

  if (tc.type === "auto" || tc.type === "none") {
    return { value: { type: tc.type }, err: undefined };
  }

  if (tc.type === "function") {
    let name = (tc.name ?? "").trim();
    if (name === "") {
      name = (tc.function?.name ?? "").trim();
    }
    if (name === "") {
      return { value: raw, err: undefined };
    }
    return { value: { type: "tool", name }, err: undefined };
  }

  return { value: raw, err: undefined };
}
