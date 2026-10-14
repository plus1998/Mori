import { type McpServerConfigInput, type McpTransport, parseMcpArgsList, parseMcpEnvEntries } from "./mcp";

/**
 * Raw-JSON editing for MCP servers.
 *
 * The editor speaks the same shape users copy from vendor docs — a `mcpServers` map of
 * stdio/http/sse entries — so a pasted snippet round-trips without being rewritten into
 * app-specific fields. Parsing is deliberately forgiving about *syntax* (comments, trailing
 * commas, curly quotes) and strict about *semantics*, because a silently dropped `args`
 * array turns into a broken server that only fails at runtime.
 */

export type McpJsonIssueCode =
  | "empty"
  | "syntax"
  | "notObject"
  | "noServers"
  | "tooMany"
  | "missingName"
  | "duplicateName"
  | "nameInvalid"
  | "entryNotObject"
  | "missingCommand"
  | "missingUrl"
  | "invalidArgs"
  | "invalidEnv"
  | "invalidHeaders"
  | "invalidAllowedTools"
  | "invalidTransport"
  | "unknownField"
  | "ignoredTopLevel";

export interface McpJsonIssue {
  code: McpJsonIssueCode;
  /** Raw text from the input (parse message, offending key, …) shown next to the label. */
  detail?: string;
  line?: number;
  column?: number;
  serverName?: string;
  params?: Record<string, string>;
}

export interface McpJsonParseResult {
  ok: boolean;
  servers: McpServerConfigInput[];
  errors: McpJsonIssue[];
  warnings: McpJsonIssue[];
}

export interface ParseMcpJsonOptions {
  /** Name to use when the blob is a bare entry with no key of its own. */
  fallbackName?: string;
  /** Reject blobs that declare more than one server (single-server editor). */
  singleServer?: boolean;
}

const KNOWN_ENTRY_KEYS = new Set([
  "type",
  "transport",
  "command",
  "args",
  "env",
  "url",
  "headers",
  "httpHeaders",
  "allowedTools",
  "enabled",
  "name",
]);

const KNOWN_TOP_LEVEL_KEYS = new Set(["mcpServers", "$schema", "allowedTools"]);

type TransportResolution = { ok: true; transport: McpTransport } | { ok: false; error: McpJsonIssue };

const TRANSPORT_ALIASES = new Map<string, McpTransport>([
  ["stdio", "stdio"],
  ["local", "stdio"],
  ["http", "http"],
  ["streamablehttp", "http"],
  ["streamable", "http"],
  ["sse", "sse"],
]);

export function parseMcpJson(raw: string, options: ParseMcpJsonOptions = {}): McpJsonParseResult {
  const warnings: McpJsonIssue[] = [];
  const prepared = prepareJsonText(raw);
  if (!prepared.trim()) {
    return { ok: false, servers: [], errors: [{ code: "empty" }], warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(prepared) as unknown;
  } catch (caught) {
    return {
      ok: false,
      servers: [],
      errors: [syntaxIssue(raw, caught)],
      warnings,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, servers: [], errors: [{ code: "notObject" }], warnings };
  }

  const record = parsed as Record<string, unknown>;
  const entries = collectEntries(record, options, warnings);
  if (entries.length === 0) {
    return { ok: false, servers: [], errors: [{ code: "noServers" }], warnings };
  }
  if (options.singleServer && entries.length > 1) {
    return {
      ok: false,
      servers: [],
      errors: [{ code: "tooMany", params: { count: String(entries.length) } }],
      warnings,
    };
  }

  const servers: McpServerConfigInput[] = [];
  const errors: McpJsonIssue[] = [];
  const seen = new Map<string, string>();
  for (const [name, entry] of entries) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      errors.push({ code: "nameInvalid", serverName: name, params: { name } });
      continue;
    }
    const clash = seen.get(name.toLowerCase());
    if (clash) {
      errors.push({ code: "duplicateName", serverName: name, params: { name } });
      continue;
    }
    seen.set(name.toLowerCase(), name);

    const parsedEntry = parseEntry(name, entry, warnings);
    if (parsedEntry.error) {
      errors.push(parsedEntry.error);
      continue;
    }
    servers.push(parsedEntry.input);
  }

  return { ok: errors.length === 0, servers, errors, warnings };
}

/** Pretty-print servers back into the doc-style `mcpServers` blob. */
export function serializeMcpServersJson(servers: readonly McpServerConfigInput[]): string {
  const map: Record<string, unknown> = {};
  for (const server of servers) {
    const name = server.name.trim() || "server";
    map[name] = buildEntryObject(server);
  }
  return `${stringifyCompact({ mcpServers: map })}\n`;
}

/** Re-indent pasted JSON without re-serializing the app model, so unknown keys survive. */
export function prettifyMcpJson(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(prepareJsonText(raw)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return `${stringifyCompact(parsed)}\n`;
  } catch {
    return undefined;
  }
}

/**
 * Two-space pretty printing that keeps short scalar arrays on one line, because
 * `"args": ["-y", "@modelcontextprotocol/server-github"]` is what docs show and what
 * people actually scan for when they paste a config in.
 */
function stringifyCompact(value: unknown): string {
  return print(value, 0);
}

function print(value: unknown, depth: number): string {
  const pad = "  ".repeat(depth);
  const inner = "  ".repeat(depth + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isScalar)) {
      const inline = `[${value.map((item) => print(item, 0)).join(", ")}]`;
      if (inline.length <= 88) return inline;
    }
    const items = value.map((item) => `${inner}${print(item, depth + 1)}`);
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return "{}";
    const lines = entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${print(item, depth + 1)}`);
    return `{\n${lines.join(",\n")}\n${pad}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
  );
}

function buildEntryObject(server: McpServerConfigInput): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (server.transport === "stdio") {
    entry.command = server.command?.trim() ?? "";
    const args = parseMcpArgsList(server.argsJson ?? "[]");
    if (args.length > 0) entry.args = args;
    const env = parseMcpEnvEntries(server.envJson ?? "{}");
    if (env.length > 0) {
      entry.env = Object.fromEntries(env.map((item) => [item.key, item.value]));
    }
  } else {
    entry.type = server.transport;
    entry.url = server.url?.trim() ?? "";
    const headers = parseMcpEnvEntries(server.headersJson ?? "{}");
    if (headers.length > 0) {
      entry.headers = Object.fromEntries(headers.map((item) => [item.key, item.value]));
    }
  }

  const allowedTools = splitAllowedTools(server.allowedTools);
  if (allowedTools.length > 0) entry.allowedTools = allowedTools;
  if (server.enabled === false) entry.enabled = false;
  return entry;
}

function collectEntries(
  record: Record<string, unknown>,
  options: ParseMcpJsonOptions,
  warnings: McpJsonIssue[],
): Array<[string, unknown]> {
  const wrapped = record.mcpServers;
  if (isPlainObject(wrapped)) {
    for (const key of Object.keys(record)) {
      if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
        warnings.push({ code: "ignoredTopLevel", detail: key, params: { field: key } });
      }
    }
    return Object.entries(wrapped);
  }

  if (looksLikeEntry(record)) {
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const resolved = name || options.fallbackName?.trim() || "";
    if (!resolved) {
      warnings.push({ code: "missingName" });
      return [];
    }
    return [[resolved, record]];
  }

  const values = Object.values(record);
  if (values.length > 0 && values.every((value) => isPlainObject(value) && looksLikeEntry(value))) {
    return Object.entries(record);
  }
  return [];
}

function looksLikeEntry(value: Record<string, unknown>): boolean {
  return (
    typeof value.command === "string" ||
    typeof value.url === "string" ||
    typeof value.type === "string" ||
    typeof value.transport === "string"
  );
}

function parseEntry(
  name: string,
  value: unknown,
  warnings: McpJsonIssue[],
): { input: McpServerConfigInput; error?: undefined } | { input?: undefined; error: McpJsonIssue } {
  if (!isPlainObject(value)) {
    return { error: { code: "entryNotObject", serverName: name, params: { name } } };
  }

  for (const key of Object.keys(value)) {
    if (!KNOWN_ENTRY_KEYS.has(key)) {
      warnings.push({ code: "unknownField", serverName: name, detail: key, params: { name, field: key } });
    }
  }

  const resolved = resolveTransport(name, value);
  if (!resolved.ok) {
    return { error: resolved.error };
  }
  const transport = resolved.transport;

  const args = readStringArray(value.args);
  if (args.error) {
    return { error: { code: "invalidArgs", serverName: name, detail: args.error, params: { name } } };
  }
  const env = readStringMap(value.env);
  if (env.error) {
    return { error: { code: "invalidEnv", serverName: name, detail: env.error, params: { name } } };
  }
  const headers = readStringMap(value.headers ?? value.httpHeaders);
  if (headers.error) {
    return {
      error: { code: "invalidHeaders", serverName: name, detail: headers.error, params: { name } },
    };
  }
  const allowedTools = readAllowedTools(value.allowedTools);
  if (allowedTools.error) {
    return {
      error: {
        code: "invalidAllowedTools",
        serverName: name,
        detail: allowedTools.error,
        params: { name },
      },
    };
  }

  const input: McpServerConfigInput = {
    name,
    transport,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    argsJson: JSON.stringify(args.values ?? []),
    envJson: JSON.stringify(env.values ?? {}),
    headersJson: JSON.stringify(headers.values ?? {}),
    allowedTools: allowedTools.value ?? "",
  };

  if (transport === "stdio") {
    const command = typeof value.command === "string" ? value.command.trim() : "";
    if (!command) {
      return { error: { code: "missingCommand", serverName: name, params: { name } } };
    }
    input.command = command;
    return { input };
  }

  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!url) {
    return { error: { code: "missingUrl", serverName: name, params: { name } } };
  }
  input.url = url;
  return { input };
}

function resolveTransport(name: string, value: Record<string, unknown>): TransportResolution {
  const declared =
    typeof value.type === "string" ? value.type : typeof value.transport === "string" ? value.transport : "";
  if (declared.trim()) {
    const normalized = declared
      .trim()
      .toLowerCase()
      .replace(/[-_\s]/g, "");
    const mapped = TRANSPORT_ALIASES.get(normalized);
    if (!mapped) {
      return {
        ok: false,
        error: { code: "invalidTransport", serverName: name, detail: declared, params: { name } },
      };
    }
    return { ok: true, transport: mapped };
  }
  if (typeof value.command === "string" && value.command.trim()) {
    return { ok: true, transport: "stdio" };
  }
  if (typeof value.url === "string" && value.url.trim()) {
    return { ok: true, transport: "http" };
  }
  return { ok: false, error: { code: "missingCommand", serverName: name, params: { name } } };
}

function readStringArray(value: unknown): { values?: string[]; error?: string } {
  if (value === undefined || value === null) {
    return { values: [] };
  }
  if (!Array.isArray(value)) {
    return { error: "expected an array of strings" };
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      values.push(item);
      continue;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      values.push(String(item));
      continue;
    }
    return { error: "expected an array of strings" };
  }
  return { values };
}

function readStringMap(value: unknown): { values?: Record<string, string>; error?: string } {
  if (value === undefined || value === null) {
    return { values: {} };
  }
  if (!isPlainObject(value)) {
    return { error: "expected an object of string values" };
  }
  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      values[key] = raw;
      continue;
    }
    if (typeof raw === "number" || typeof raw === "boolean") {
      values[key] = String(raw);
      continue;
    }
    return { error: `field "${key}" must be a string` };
  }
  return { values };
}

function readAllowedTools(value: unknown): { value?: string; error?: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value === "string") {
    return { value: value.trim() };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return {
      value: (value as string[])
        .map((item) => item.trim())
        .filter(Boolean)
        .join(", "),
    };
  }
  return { error: "expected a string or an array of strings" };
}

function splitAllowedTools(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function syntaxIssue(raw: string, caught: unknown): McpJsonIssue {
  const message = caught instanceof Error ? caught.message : String(caught);
  const issue: McpJsonIssue = { code: "syntax", detail: message };
  const offset = findJsonErrorOffset(prepareJsonText(raw));
  if (offset !== undefined) {
    const before = raw.slice(0, Math.min(offset, raw.length));
    issue.line = before.split("\n").length;
    issue.column = offset - (before.lastIndexOf("\n") + 1) + 1;
    return issue;
  }
  const inline = /line (\d+) column (\d+)/i.exec(message);
  if (inline) {
    issue.line = Number(inline[1]);
    issue.column = Number(inline[2]);
    return issue;
  }
  const positioned = /position (\d+)/i.exec(message);
  if (positioned) {
    const offset = Math.min(Number(positioned[1]), raw.length);
    const before = raw.slice(0, offset);
    const line = before.split("\n").length;
    issue.line = line;
    issue.column = offset - (before.lastIndexOf("\n") + 1) + 1;
  }
  return issue;
}

/**
 * Make pasted blobs parseable: normalise smart quotes and non-breaking spaces, blank out
 * `//` + block comments, and drop trailing commas. Removed characters are replaced with
 * spaces instead of deleted, so a parse error still points at the line the user sees.
 * String contents are left untouched.
 */
export function prepareJsonText(raw: string): string {
  let text = raw.startsWith("\uFEFF") ? ` ${raw.slice(1)}` : raw;
  // A blanked comma can expose another trailing comma (`{"a":1, /*x*/,}`), so keep
  // re-scanning until the text stops changing. Every pass preserves offsets.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = blankJsonNoise(text);
    if (next === text) break;
    text = next;
  }
  return text;
}

function blankJsonNoise(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"') {
      const end = readString(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "\u00A0" || char === "\u200B" || char === "\u2028" || char === "\u2029") {
      out += " ";
      index += 1;
      continue;
    }
    if (char === "\u201C" || char === "\u201D" || char === "\u201E" || char === "\u301D") {
      const end = text.indexOf("\u201D", index + 1);
      if (end === -1) {
        out += char;
        index += 1;
        continue;
      }
      const body = text.slice(index + 1, end);
      out += `"${body.replace(/(?<!\\)"/g, '\\"')}"`;
      index = end + 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; index < stop; index += 1) {
        out += text[index] === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (char === ",") {
      const next = skipIgnorable(text, index + 1);
      if (text[next] === "}" || text[next] === "]") {
        out += " ";
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Consume a JSON string literal from `start`, returning the index just past it. */
function readString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return text.length;
}

type JsonScanState =
  | "value"
  | "objectKeyOrEnd"
  | "objectColon"
  | "objectComma"
  | "arrayItemOrEnd"
  | "arrayComma"
  | "done";

/**
 * Locate the first character that breaks JSON, so the editor can underline a line even on
 * engines whose `JSON.parse` message carries no position (JavaScriptCore, used by tests).
 */
function findJsonErrorOffset(text: string): number | undefined {
  const stack: Array<"object" | "array"> = [];
  let state: JsonScanState = "value";
  let index = 0;

  const skipSpace = () => {
    while (index < text.length && /[\s\u00A0\u200B]/.test(text[index] ?? "")) index += 1;
  };
  const afterValue = (): JsonScanState => {
    const top = stack[stack.length - 1];
    if (top === "object") return "objectComma";
    if (top === "array") return "arrayComma";
    return "done";
  };
  const closeContainer = (): JsonScanState => {
    stack.pop();
    return afterValue();
  };

  for (;;) {
    skipSpace();
    if (state === "done") return index < text.length ? index : undefined;
    if (index >= text.length) return text.length;
    const char = text[index] ?? "";

    if (state === "value") {
      if (char === "{") {
        stack.push("object");
        index += 1;
        state = "objectKeyOrEnd";
        continue;
      }
      if (char === "[") {
        stack.push("array");
        index += 1;
        state = "arrayItemOrEnd";
        continue;
      }
      const end = readScalar(text, index);
      if (end === undefined) return index;
      index = end;
      state = afterValue();
      continue;
    }
    if (state === "objectKeyOrEnd") {
      if (char === "}") {
        index += 1;
        state = closeContainer();
        continue;
      }
      if (char !== '"') return index;
      const end = readString(text, index);
      if (text[end - 1] !== '"') return index;
      index = end;
      state = "objectColon";
      continue;
    }
    if (state === "objectColon") {
      if (char !== ":") return index;
      index += 1;
      state = "value";
      continue;
    }
    if (state === "objectComma") {
      if (char === ",") {
        index += 1;
        state = "objectKeyOrEnd";
        continue;
      }
      if (char === "}") {
        index += 1;
        state = closeContainer();
        continue;
      }
      return index;
    }
    if (state === "arrayItemOrEnd") {
      if (char === "]") {
        index += 1;
        state = closeContainer();
        continue;
      }
      state = "value";
      continue;
    }
    // arrayComma
    if (char === ",") {
      index += 1;
      state = "value";
      continue;
    }
    if (char === "]") {
      index += 1;
      state = closeContainer();
      continue;
    }
    return index;
  }
}

/** Return the index past a JSON scalar (string, number, literal) or undefined if malformed. */
function readScalar(text: string, start: number): number | undefined {
  const char = text[start] ?? "";
  if (char === '"') {
    const end = readString(text, start);
    return text[end - 1] === '"' ? end : undefined;
  }
  if (char === "-" || (char >= "0" && char <= "9")) {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(start));
    return match ? start + (match[0]?.length ?? 0) : undefined;
  }
  for (const literal of ["true", "false", "null"]) {
    if (text.startsWith(literal, start)) return start + literal.length;
  }
  return undefined;
}

function skipIgnorable(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === "\n" || char === "\r" || char === "\t" || char === " " || char === "\u00A0") {
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    return index;
  }
  return index;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
