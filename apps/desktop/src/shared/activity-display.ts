export type { FileChangeCardDisplay, FileChangePreviewLine } from "./file-change";
export { resolveFileChangeCardDisplay } from "./file-change";

import { isSubagentMissionEnvelope, parseSubagentMissionMessage } from "@eco/runtime/agent-mission";
import { shortenModelId } from "@eco/runtime/usage";
import { ecoAgentBrowserToolSuffix, NAMED_AGENT_BROWSER_TOOL_SUFFIXES } from "./browser";
import { isEcoComputerUseToolName } from "./computer-use";
import { type ActionKindTranslate, formatActionLine, resolveActionKind } from "./feed-action-kind";
import { isEcoImageDisplayToolName } from "./image-display-tool";
import { isEcoImageGenerationToolName } from "./image-generation";
import { isEcoImageViewToolName } from "./image-view-tool";
import { isEcoWebSearchToolName } from "./integrated-web-search";
import { resolveSubagentRunDisplayTitle } from "./subagent-roles";

const SUBAGENT_BRACKET_PREFIX = /^【[^】]+】\s*/;

const reconnectClearSystemNoise = [
  /^Local model router ready:/i,
  /^Claude Agent SDK ready/i,
  /^Agent session started/i,
  /^Agent run completed/i,
  /^Compacting context/i,
  /^API retry /i,
  /^Usage recorded/i,
  /^Run finished/i,
  /^已从异常退出恢复/i,
];

export interface ParsedReconnectActivity {
  summary: string;
  detail?: string;
  failed?: boolean;
}

const RECONNECT_DETAIL_SEPARATORS = /^[\s：:·.\-—]+/;

/**
 * Upstream bodies that only repeat the HTTP status add nothing beyond the
 * `连接失败 · HTTP <code>` summary, so they are not surfaced as detail.
 */
export function readReconnectDetail(detail: string | undefined): string | undefined {
  const text = detail?.trim().replace(RECONNECT_DETAIL_SEPARATORS, "").trim();
  if (!text) {
    return undefined;
  }
  if (/^HTTP\s*\d{3}$/i.test(text)) {
    return undefined;
  }
  if (/^Upstream returned HTTP\s*\d{3}$/i.test(text)) {
    return undefined;
  }
  return text;
}

/** Auto-retry or upstream connection failure status — should replace prior line, not stack. */
export function isReconnectActivityMessage(message: string): boolean {
  return parseReconnectActivityMessage(message) !== null;
}

/** Parse proxy connection failure messages for legacy persisted rows. */
export function parseReconnectActivityMessage(message: string): ParsedReconnectActivity | null {
  const trimmed = message.trim();

  const connectionFailed = trimmed.match(/^【连接失败】\s*([\s\S]*)$/);
  if (connectionFailed) {
    const body = connectionFailed[1]?.trim() ?? "";
    const httpMatch = body.match(/^HTTP\s*(\d{3})\b\s*([\s\S]*)$/);
    if (httpMatch?.[1]) {
      const detail = readReconnectDetail(httpMatch[2]);
      return {
        summary: `连接失败 · HTTP ${httpMatch[1]}`,
        ...(detail ? { detail } : {}),
        failed: true,
      };
    }
    const colonSplit = body.match(/^([^：:]+)[：:]([\s\S]*)$/);
    if (colonSplit?.[1]) {
      const detail = readReconnectDetail(colonSplit[2]);
      return {
        summary: `连接失败 · ${colonSplit[1].trim()}`,
        ...(detail ? { detail } : {}),
        failed: true,
      };
    }
    return {
      summary: "连接失败",
      failed: true,
    };
  }

  return null;
}

/** Retry-in-progress placeholders — not evidence that upstream recovered. */
const reconnectInProgressPatterns = [/^Requesting model/i, /^API error/i];

/** True when a new activity line means the upstream connection resumed — drop reconnect status. */
export function shouldClearReconnectActivity(line: { message: string; role: string }): boolean {
  if (isReconnectActivityMessage(line.message)) {
    return false;
  }

  const trimmed = stripSubagentBracketPrefix(line.message.trim());
  if (!trimmed || trimmed === "状态已更新" || /^状态已更新\s/u.test(trimmed)) {
    return false;
  }
  if (reconnectClearSystemNoise.some((pattern) => pattern.test(trimmed))) {
    return false;
  }
  if (reconnectInProgressPatterns.some((pattern) => pattern.test(trimmed))) {
    return false;
  }

  if (isSubagentMissionEnvelope(trimmed)) {
    return true;
  }
  if (/^正在刷新上下文用量/.test(trimmed)) {
    return false;
  }
  if (/^Tool:/i.test(trimmed) && !/^Tool failed:/i.test(trimmed)) {
    return true;
  }
  if (/^【\d+\/\d+】/.test(trimmed)) {
    return true;
  }
  if (/^(Reading|Writing|Editing|Searching|Running)\s+/i.test(trimmed)) {
    return true;
  }
  if (line.role === "thinking" && trimmed.length > 0) {
    return true;
  }

  return false;
}

export function isToolProgressStatusText(text: string): boolean {
  return /^(Reading|Writing|Editing|Searching|Running)\s+/i.test(text.trim());
}

const PROGRESS_PATTERNS: Array<{ pattern: RegExp }> = [
  { pattern: /^Reading\s+(.+?)(?:\s*·\s*Read)?\s*$/i },
  { pattern: /^Writing\s+(.+?)(?:\s*·\s*Write)?\s*$/i },
  { pattern: /^Editing\s+(.+?)(?:\s*·\s*Edit)?\s*$/i },
  { pattern: /^Searching\s+(.+?)(?:\s*·\s*Grep)?\s*$/i },
  { pattern: /^Running\s+(.+?)(?:\s*·\s*Bash)?\s*$/i },
];

export function stripSubagentBracketPrefix(text: string): string {
  return text.replace(SUBAGENT_BRACKET_PREFIX, "").trim();
}

export function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

const TOOL_LINE_PATTERN = /^Tool:\s*([A-Za-z0-9_]+)(?:\s*·\s*(.+?)|\s+(\(\d+(?:\.\d+)?s\)))?\s*$/;

const MCP_TOOL_LINE_PATTERN = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/;

const NAMED_ECO_TOOL_SUFFIXES = new Set([
  "finalize_plan",
  "create_image",
  "computer_use",
  "view_image",
  "display_image",
  ...NAMED_AGENT_BROWSER_TOOL_SUFFIXES,
]);

export function isMcpToolName(tool: string): boolean {
  return tool.startsWith("mcp__") || tool === "mcp_tool";
}

function resolveNamedToolSuffix(tool: string): string | undefined {
  if (isEcoImageGenerationToolName(tool)) {
    return "create_image";
  }
  if (isEcoComputerUseToolName(tool)) {
    return "computer_use";
  }
  if (isEcoImageViewToolName(tool)) {
    return "view_image";
  }
  if (isEcoImageDisplayToolName(tool)) {
    return "display_image";
  }
  const browserSuffix = ecoAgentBrowserToolSuffix(tool);
  if (browserSuffix) {
    return NAMED_ECO_TOOL_SUFFIXES.has(browserSuffix) ? browserSuffix : "browser";
  }
  const match = tool.match(MCP_TOOL_LINE_PATTERN);
  if (match?.[2]) {
    const suffix = match[2].trim().toLowerCase();
    if (NAMED_ECO_TOOL_SUFFIXES.has(suffix)) {
      return suffix;
    }
  }
  const bare = tool.trim().toLowerCase();
  if (NAMED_ECO_TOOL_SUFFIXES.has(bare)) {
    return bare;
  }
  return undefined;
}

export function formatMcpToolDisplayName(tool: string, t: ActionKindTranslate): string {
  const named = resolveNamedToolSuffix(tool);
  if (named) {
    return t(`activity.named.${named}`);
  }
  const lower = tool.trim().toLowerCase();
  if (lower === "mcp" || lower === "mcpscript" || lower === "mcp_tool") {
    return formatActionLine({ resolved: resolveActionKind({ toolName: tool }), phase: "done" }, t);
  }
  const match = tool.match(MCP_TOOL_LINE_PATTERN);
  if (match?.[1] && match[2]) {
    const server = match[1].replace(/_/g, " ");
    const toolName = match[2].replace(/_/g, " ");
    return `${server} · ${toolName}`;
  }
  return tool
    .replace(/^mcp__/, "")
    .replace(/__/g, " · ")
    .replace(/_/g, " ");
}

/** Display label for a tool action row (icon conveys the verb; text shows target/detail). */
export function normalizeAgentLabelToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function isRedundantAgentModelShort(roleLabel: string, modelShort: string): boolean {
  if (!roleLabel.trim() || !modelShort.trim()) {
    return false;
  }
  return normalizeAgentLabelToken(roleLabel) === normalizeAgentLabelToken(modelShort);
}

export function activityLabelIncludesAgentRole(
  role: string,
  label: string,
  options?: {
    modelId?: string | undefined;
    displayName?: string | undefined;
  },
): boolean {
  const normalizedLabel = label.trim().toLowerCase();
  if (!normalizedLabel || !role.trim()) {
    return false;
  }
  const tokens = new Set<string>();
  for (const candidate of [
    role,
    options?.displayName,
    options?.modelId ? shortenModelId(options.modelId) : undefined,
    resolveSubagentRunDisplayTitle(role),
  ]) {
    if (!candidate?.trim()) {
      continue;
    }
    tokens.add(normalizeAgentLabelToken(candidate));
  }
  for (const token of tokens) {
    if (
      normalizedLabel === token ||
      normalizedLabel.startsWith(`${token} ·`) ||
      normalizedLabel.startsWith(`${token}·`)
    ) {
      return true;
    }
  }
  return false;
}

export function clampActivityPreviewLine(text: string, max = 56): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine || oneLine.length <= max) {
    return oneLine;
  }
  return `${oneLine.slice(0, max - 1)}…`;
}

export interface BashRunCardDisplay {
  title: string;
  meta?: string;
  command?: string;
  output?: string;
}

export function formatBashRunMeta(command: string, durationMs?: number): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return durationMs !== undefined && Number.isFinite(durationMs)
      ? `${(durationMs / 1000).toFixed(1)}s`
      : "";
  }
  const segments = trimmed.split(/\s*(?:&&|\|\||;)\s*/u).filter(Boolean);
  const firstToken = segments[0]?.trim().split(/\s+/u)[0] ?? "";
  const metaToken =
    firstToken && (firstToken.startsWith("/") || firstToken.startsWith("./") || firstToken.startsWith("~/"))
      ? pathBasename(firstToken)
      : firstToken;
  const parts: string[] = [];
  if (metaToken) {
    parts.push(metaToken);
  }
  if (segments.length > 1) {
    parts.push(`${segments.length - 1}+`);
  }
  if (durationMs !== undefined && Number.isFinite(durationMs)) {
    parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  }
  return parts.join(", ");
}

export function resolveBashRunCardDisplay(input: {
  toolName?: string;
  command?: string;
  output?: string;
  durationMs?: number;
  description?: string;
}): BashRunCardDisplay | undefined {
  if (input.toolName !== "Bash") {
    return undefined;
  }
  const command = input.command?.trim();
  const output = input.output?.trim();
  const title = formatBashRunTitle(input.description);
  const meta = command ? formatBashRunMeta(command, input.durationMs) : undefined;
  return {
    title,
    ...(meta && { meta }),
    ...(command && { command }),
    ...(output && { output }),
  };
}

export function formatBashRunTitle(description?: string): string {
  const normalizedDescription = description?.trim();
  return normalizedDescription ? clampActivityPreviewLine(normalizedDescription, 48) : "Shell";
}

export type WebSearchCardActionKind = "search" | "openPage" | "findInPage" | "other" | "fetch";

export interface WebSearchCardDisplay {
  /** search = WebSearch, fetch = WebFetch */
  kind: "search" | "fetch";
  /** Collapsed row title, e.g. 联网搜索 · query */
  title: string;
  query: string;
  meta?: string;
  statusText?: string;
  actionKind?: WebSearchCardActionKind;
  /** Secondary human line for action (open page / find in page). */
  actionLabel?: string;
  url?: string;
  pattern?: string;
  queries?: string[];
  provider?: string;
  results?: Array<{ title: string; url: string; description?: string }>;
  /** Footer note when SERP is not available in protocol payload. */
  note?: string;
}

export function isNetworkToolName(toolName: string | undefined): boolean {
  return toolName === "WebSearch" || toolName === "WebFetch" || isEcoWebSearchToolName(toolName);
}

export function resolveWebSearchCardDisplay(
  input: {
    toolName?: string;
    detail?: string;
    durationMs?: number;
    status?: string;
    webSearch?: {
      query?: string;
      actionType?: "search" | "openPage" | "findInPage" | "other";
      url?: string;
      pattern?: string;
      queries?: string[];
      mode?: "search" | "fetch";
      provider?: string;
      results?: Array<{ title: string; url: string; description?: string }>;
    };
  },
  t: ActionKindTranslate,
): WebSearchCardDisplay | undefined {
  if (!isNetworkToolName(input.toolName) && !input.webSearch) {
    return undefined;
  }
  const kind = input.toolName === "WebFetch" || input.webSearch?.mode === "fetch" ? "fetch" : "search";
  const structured = input.webSearch;
  const query =
    structured?.query?.trim() ||
    (kind === "fetch" ? structured?.url?.trim() : undefined) ||
    input.detail?.trim() ||
    "";
  if (!query && !structured?.url && !(structured?.queries && structured.queries.length > 0)) {
    // Still show a card for bare WebSearch lifecycle without query yet.
  }
  const actionKind: WebSearchCardActionKind | undefined =
    kind === "fetch"
      ? "fetch"
      : structured?.actionType === "openPage" ||
          structured?.actionType === "findInPage" ||
          structured?.actionType === "search" ||
          structured?.actionType === "other"
        ? structured.actionType
        : "search";
  const url = structured?.url?.trim() || (kind === "fetch" ? query : undefined);
  const pattern = structured?.pattern?.trim();
  const queries = structured?.queries?.filter((entry) => entry.trim()).map((entry) => entry.trim());
  const provider = structured?.provider?.trim();
  const results = structured?.results
    ?.map((entry) => ({
      title: entry.title?.trim() ?? "",
      url: entry.url?.trim() ?? "",
      ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
    }))
    .filter((entry) => entry.title || entry.url || entry.description)
    .slice(0, 12);
  const displayQuery = query || (queries && queries.length > 0 ? queries[0]! : "") || url || "";
  const title = formatToolDisplayLabel(
    kind === "fetch" ? "WebFetch" : "WebSearch",
    displayQuery || undefined,
    t,
  );
  const meta =
    input.durationMs !== undefined && Number.isFinite(input.durationMs)
      ? `${(input.durationMs / 1000).toFixed(1)}s`
      : undefined;
  const statusText =
    input.status === "started"
      ? kind === "fetch"
        ? t("activity.webSearch.fetching")
        : t("activity.webSearch.searching")
      : input.status === "failed"
        ? t("activity.webSearch.failed")
        : input.status === "completed"
          ? t("activity.lifecycle.completed")
          : undefined;
  const actionLabel = formatWebSearchActionLabel(
    {
      ...(actionKind ? { actionKind } : {}),
      ...(url ? { url } : {}),
      ...(pattern ? { pattern } : {}),
      ...(queries && queries.length > 0 ? { queries } : {}),
    },
    t,
  );
  const note =
    input.status === "completed"
      ? kind === "fetch"
        ? t("activity.webSearch.fetchCompletedNote")
        : results && results.length > 0
          ? undefined
          : t("activity.webSearch.searchCompletedNote")
      : input.status === "started"
        ? kind === "fetch"
          ? t("activity.running.webFetch", { suffix: "…" })
          : t("activity.running.webSearch", { suffix: "…" })
        : undefined;

  return {
    kind,
    title,
    query:
      displayQuery ||
      (kind === "fetch" ? t("activity.webSearch.fetchKicker") : t("activity.webSearch.kicker")),
    ...(meta && { meta }),
    ...(statusText && { statusText }),
    ...(actionKind && { actionKind }),
    ...(actionLabel && { actionLabel }),
    ...(url && { url }),
    ...(pattern && { pattern }),
    ...(queries && queries.length > 0 && { queries }),
    ...(provider && { provider }),
    ...(results && results.length > 0 && { results }),
    ...(note && { note }),
  };
}

function formatWebSearchActionLabel(
  input: {
    actionKind?: WebSearchCardActionKind;
    url?: string;
    pattern?: string;
    queries?: string[];
  },
  t: ActionKindTranslate,
): string | undefined {
  if (input.actionKind === "openPage") {
    const verb = t("activity.webSearch.openPage");
    return input.url ? `${verb} · ${input.url}` : verb;
  }
  if (input.actionKind === "findInPage") {
    const verb = t("activity.webSearch.findInPage");
    if (input.pattern && input.url) {
      return `${verb} "${input.pattern}" · ${input.url}`;
    }
    if (input.pattern) {
      return `${verb} "${input.pattern}"`;
    }
    return verb;
  }
  if (input.actionKind === "fetch") {
    return input.url ? `${t("activity.webSearch.fetchKicker")} · ${input.url}` : undefined;
  }
  if (input.queries && input.queries.length > 1) {
    return `${input.queries.length} ${t("activity.webSearch.queriesLabel")}`;
  }
  return undefined;
}

/** Compact single-line preview for subagent cards and status rows. */
export function formatToolStatusPreview(
  toolName: string,
  detail: string | undefined,
  t: ActionKindTranslate,
  max = 56,
): string {
  const normalizedDetail = detail?.trim();
  if (!normalizedDetail) {
    return formatToolDisplayLabel(toolName, undefined, t);
  }
  if (toolName.trim().toLowerCase() === "bash") {
    return clampActivityPreviewLine(normalizedDetail, max);
  }
  return clampActivityPreviewLine(formatToolDisplayLabel(toolName, normalizedDetail, t), max);
}

export function formatToolDisplayLabel(
  toolName: string,
  detail: string | undefined,
  t: ActionKindTranslate,
): string {
  const normalizedDetail = detail?.trim() || undefined;
  const lowerName = toolName.trim().toLowerCase();
  if (
    lowerName === "skill" ||
    lowerName === "skills" ||
    lowerName === "readskill" ||
    (normalizedDetail && normalizedDetail.endsWith(" 技能"))
  ) {
    return (
      normalizedDetail ?? formatActionLine({ resolved: resolveActionKind({ toolName }), phase: "done" }, t)
    );
  }
  if (lowerName === "mcp_tool" && normalizedDetail?.startsWith("mcp__")) {
    return formatMcpToolDisplayName(normalizedDetail, t);
  }
  if (isMcpToolName(toolName) || lowerName === "mcp" || lowerName === "mcpscript") {
    return formatMcpToolDisplayName(toolName, t);
  }
  if (lowerName === "agent" || lowerName === "task") {
    return (
      normalizedDetail ?? formatActionLine({ resolved: resolveActionKind({ toolName }), phase: "done" }, t)
    );
  }
  if (lowerName === "websearch" || lowerName === "webfetch") {
    const verb = t(lowerName === "websearch" ? "activity.named.web_search" : "activity.named.web_fetch");
    return normalizedDetail ? `${verb} · ${normalizedDetail}` : verb;
  }
  if (normalizedDetail) {
    return normalizedDetail;
  }
  return formatActionLine({ resolved: resolveActionKind({ toolName }), phase: "done" }, t);
}

export function parseToolActionDisplayLabel(raw: string, t: ActionKindTranslate): string {
  const text = stripSubagentBracketPrefix(raw.trim());
  if (!text) {
    return raw.trim();
  }

  for (const { pattern } of PROGRESS_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return pathBasename(match[1].trim());
    }
  }

  const toolMatch = text.match(TOOL_LINE_PATTERN);
  if (toolMatch) {
    const tool = toolMatch[1] ?? "";
    let detail = toolMatch[2]?.trim() ?? toolMatch[3]?.trim();
    if (detail && /^\(\d+(?:\.\d+)?s\)$/.test(detail)) {
      detail = undefined;
    } else if (detail) {
      detail = detail.replace(/\s+\(\d+(?:\.\d+)?s\)\s*$/, "").trim() || undefined;
    }
    return formatToolDisplayLabel(tool, detail, t);
  }

  const bareMatch = text.match(/^([A-Za-z][A-Za-z0-9_]*)\s*·\s*(.+)$/);
  if (bareMatch?.[1] && bareMatch[2]) {
    const detail = bareMatch[2].replace(/\s+\(\d+(?:\.\d+)?s\)\s*$/, "").trim();
    return formatToolDisplayLabel(bareMatch[1], detail, t);
  }

  if (isMcpToolName(text)) {
    return formatMcpToolDisplayName(text, t);
  }

  return text;
}

export function normalizeActivityActionLabel(raw: string, t: ActionKindTranslate): string {
  return parseToolActionDisplayLabel(raw, t);
}

export function activityActionKey(
  subagent: string | undefined,
  label: string,
  icon: string | undefined,
  t: ActionKindTranslate,
): string {
  return `${subagent ?? ""}\0${icon ?? ""}\0${normalizeActivityActionLabel(label, t)}`;
}

export type ToolActionLifecycle =
  | "approval-pending"
  | "approval-approved"
  | "approval-rejected"
  | "running"
  | "completed"
  | "failed";

export function bashApprovalPhaseToLifecycle(
  phase: "requested" | "approved" | "rejected" | "denied",
): ToolActionLifecycle {
  if (phase === "requested") {
    return "approval-pending";
  }
  if (phase === "approved") {
    return "approval-approved";
  }
  return "approval-rejected";
}

export function toolStatusToLifecycle(
  status: "started" | "completed" | "failed" | undefined,
  eventType?: string,
): ToolActionLifecycle | undefined {
  if (status === "failed" || eventType === "tool.failed") {
    return "failed";
  }
  if (status === "completed" || eventType === "tool.completed") {
    return "completed";
  }
  if (status === "started" || eventType === "tool.started") {
    return "running";
  }
  return undefined;
}

export function compareToolActionLifecyclePriority(
  left: ToolActionLifecycle,
  right: ToolActionLifecycle,
): number {
  const rank: Record<ToolActionLifecycle, number> = {
    "approval-rejected": 1,
    "approval-pending": 2,
    "approval-approved": 3,
    running: 4,
    completed: 5,
    failed: 5,
  };
  return rank[left] - rank[right];
}

export interface ThreadRunBashApprovalMetadataLike {
  toolUseId: string;
  phase: "requested" | "approved" | "rejected" | "denied";
  toolName: string;
  detail?: string;
  description?: string;
}

export function readBashApprovalMetadata(
  metadata: Record<string, unknown> | undefined,
): ThreadRunBashApprovalMetadataLike | undefined {
  const raw = metadata?.bashApproval;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const toolUseId = typeof record.toolUseId === "string" ? record.toolUseId.trim() : "";
  const toolName = typeof record.toolName === "string" ? record.toolName.trim() : "";
  const phase = record.phase;
  if (
    !toolUseId ||
    !toolName ||
    (phase !== "requested" && phase !== "approved" && phase !== "rejected" && phase !== "denied")
  ) {
    return undefined;
  }
  const detail = typeof record.detail === "string" ? record.detail.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    toolUseId,
    phase,
    toolName,
    ...(detail && { detail }),
    ...(description && { description }),
  };
}
