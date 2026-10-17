import type { AgentEvent, AgentEventType, AgentRole, RuntimeAgentRole } from "../../shared/src";
import { formatSubagentMissionMessage } from "./agent-mission.js";
import { formatSendMessageToolInputSummary } from "./send-message-tool.js";
import { formatSkillActivityLabel, resolveSkillDisplayName } from "./skill-display.js";
import {
  isSubagentRole,
  SDK_GENERAL_PURPOSE_AGENT_KEY,
  SDK_PLAN_AGENT_KEY,
  type SubagentRole,
} from "./subagent-availability.js";
import { normalizeSdkSubagentType } from "./subagent-resume.js";
import { createToolOutputPreview } from "./tool-output-preview.js";
import {
  formatGrepTargetLabel,
  formatReadTargetLabel,
  resolveGrepTargetFromToolInput,
  resolveReadTargetFromToolInput,
} from "./tool-target.js";

export function extractSdkRunFailure(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const isTerminalResult =
    payload.type === "result" || (payloadHasSdkResultShape(payload) && typeof payload.subtype === "string");

  if (!isTerminalResult) {
    return null;
  }

  if (payload.subtype === "success") {
    return null;
  }

  if (typeof payload.result === "string" && payload.result.trim()) {
    return payload.result.trim();
  }

  if (Array.isArray(payload.errors)) {
    const messages = payload.errors.filter((entry): entry is string => typeof entry === "string");
    if (messages.length > 0) {
      return messages.join("\n");
    }
  }

  return `Agent run failed (${String(payload.subtype ?? "error")}).`;
}

function payloadHasSdkResultShape(payload: Record<string, unknown>): boolean {
  return (
    "subtype" in payload && ("usage" in payload || "totalCostUsd" in payload || "total_cost_usd" in payload)
  );
}

export function extractCompactPostTokens(payload: unknown): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const meta =
    (isRecord(payload.compact_metadata) && payload.compact_metadata) ||
    (payload.subtype === "compact_boundary" && isRecord(payload.compact_metadata)
      ? payload.compact_metadata
      : undefined);
  if (!meta) {
    return undefined;
  }
  const post =
    typeof meta.post_tokens === "number"
      ? meta.post_tokens
      : typeof meta.postTokens === "number"
        ? meta.postTokens
        : undefined;
  return post !== undefined && Number.isFinite(post) ? post : undefined;
}

export type SdkTodoUpdatedKind = "task_started" | "task_updated" | "task_progress" | "task_notification";

/** Payload for `todo.updated` events — legacy task system messages (read/display only). */
export interface SdkTodoUpdatedPayload {
  sdkKind: SdkTodoUpdatedKind;
  task_id: string;
  run_id?: string;
  parent_task_id?: string;
  description?: string;
  subagent_type?: string;
  task_type?: string;
  skip_transcript?: boolean;
  prompt?: string;
  last_tool_name?: string;
  summary?: string;
  ambient?: boolean;
  is_backgrounded?: boolean;
  spawn_depth?: number;
  resource_links?: Array<{
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
  }>;
  status?: "completed" | "failed" | "stopped";
  patch?: {
    status?: string;
    description?: string;
    error?: string;
  };
}

export function buildSdkTodoUpdatedPayload(message: Record<string, unknown>): SdkTodoUpdatedPayload | null {
  const subtype = message.subtype;
  if (
    subtype !== "task_started" &&
    subtype !== "task_updated" &&
    subtype !== "task_progress" &&
    subtype !== "task_notification"
  ) {
    return null;
  }

  const taskId = typeof message.task_id === "string" ? message.task_id : "";
  if (!taskId) {
    return null;
  }

  const payload: SdkTodoUpdatedPayload = {
    sdkKind: subtype,
    task_id: taskId,
  };
  if (typeof message.run_id === "string" && message.run_id.trim()) payload.run_id = message.run_id.trim();
  if (typeof message.parent_task_id === "string" && message.parent_task_id.trim())
    payload.parent_task_id = message.parent_task_id.trim();

  if (typeof message.description === "string" && message.description.trim()) {
    payload.description = message.description.trim();
  }
  if (typeof message.subagent_type === "string" && message.subagent_type.trim()) {
    payload.subagent_type = message.subagent_type.trim();
  }
  if (typeof message.task_type === "string" && message.task_type.trim()) {
    payload.task_type = message.task_type.trim();
  }
  if (message.skip_transcript === true) {
    payload.skip_transcript = true;
  }
  if (typeof message.prompt === "string" && message.prompt.trim()) {
    payload.prompt = message.prompt.trim();
  }
  if (typeof message.last_tool_name === "string" && message.last_tool_name.trim()) {
    payload.last_tool_name = message.last_tool_name.trim();
  }
  if (typeof message.summary === "string" && message.summary.trim()) {
    payload.summary = message.summary.trim();
  }
  if (message.ambient === true) {
    payload.ambient = true;
  }
  if (message.is_backgrounded === true || message.isBackgrounded === true) {
    payload.is_backgrounded = true;
  }
  const spawnDepth =
    typeof message.spawn_depth === "number"
      ? message.spawn_depth
      : typeof message.spawnDepth === "number"
        ? message.spawnDepth
        : undefined;
  if (typeof spawnDepth === "number" && Number.isFinite(spawnDepth)) {
    payload.spawn_depth = spawnDepth;
  }
  if (
    subtype === "task_notification" &&
    (message.status === "completed" || message.status === "failed" || message.status === "stopped")
  ) {
    payload.status = message.status;
  }
  if (subtype === "task_updated" && isRecord(message.patch)) {
    const patch: SdkTodoUpdatedPayload["patch"] = {};
    if (typeof message.patch.status === "string") {
      patch.status = message.patch.status;
    }
    if (typeof message.patch.description === "string" && message.patch.description.trim()) {
      patch.description = message.patch.description.trim();
    }
    if (typeof message.patch.error === "string" && message.patch.error.trim()) {
      patch.error = message.patch.error.trim();
    }
    if (Object.keys(patch).length > 0) {
      payload.patch = patch;
    }
  }

  return payload;
}

function isAgentRole(value: string): value is AgentRole {
  return ["planner", "explore", "architect", "coder", "reviewer", "tester"].includes(value);
}

function resolveActivitySubagentRole(value: string): ActivityDisplayRole | undefined {
  const normalized = normalizeSdkRuntimeAgentRole(value);
  if (normalized) {
    return normalized;
  }
  return isAgentRole(value) ? value : undefined;
}

function normalizeSdkRuntimeAgentRole(value: string): RuntimeAgentRole | undefined {
  const trimmed = value.trim();
  if (trimmed === SDK_GENERAL_PURPOSE_AGENT_KEY || trimmed === SDK_PLAN_AGENT_KEY) {
    return trimmed;
  }
  return normalizeSdkSubagentType(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ActivityDisplayRole = RuntimeAgentRole | "system" | "thinking" | "tool";

export interface AgentEventDisplay {
  message: string;
  role: ActivityDisplayRole;
  stream: boolean;
}

/** SDK / proxy status lines that should appear in the activity log while waiting on the model. */
export function isUpstreamStatusActivityMessage(message: string | null | undefined): boolean {
  if (!message?.trim()) {
    return false;
  }
  return /^(?:Requesting model|Compacting context|API retry )/i.test(message.trim());
}

export function formatAgentEventDisplay(
  event: Pick<AgentEvent, "type" | "payload" | "role">,
): AgentEventDisplay | null {
  if (isRecord(event.payload) && event.payload.type === "eco_stream" && event.payload.streamPlaceholder) {
    return {
      message: "",
      role: inferActivityRole(event),
      stream: true,
    };
  }

  const message = formatAgentEventLine(event);
  if (
    !message &&
    !(isRecord(event.payload) && event.payload.type === "eco_stream" && event.payload.streamFinalize)
  ) {
    return null;
  }

  const finalize =
    isRecord(event.payload) && event.payload.type === "eco_stream" && event.payload.streamFinalize === true;

  return {
    message: message ?? "",
    role: inferActivityRole(event),
    stream: finalize ? false : isStreamableAgentEventType(event.type) && isStreamPayload(event.payload),
  };
}

export function formatAgentEventLine(event: Pick<AgentEvent, "type" | "payload" | "role">): string | null {
  if (event.type === "run.terminal" || event.type === "session.captured" || event.type === "session.title") {
    return null;
  }
  if (event.type === "usage.recorded" || event.type === "todo.updated") {
    if (event.type === "todo.updated" && isSdkTodoUpdatedPayload(event.payload)) {
      const sdkPayload = event.payload;
      if (sdkPayload.sdkKind === "task_updated") {
        const status = sdkPayload.patch?.status;
        return status ? `Task ${status}` : null;
      }
      return formatSdkPayloadMessage({
        type: "system",
        subtype: sdkPayload.sdkKind,
        task_id: sdkPayload.task_id,
        description: sdkPayload.description,
        subagent_type: sdkPayload.subagent_type,
        last_tool_name: sdkPayload.last_tool_name,
        summary: sdkPayload.summary,
      });
    }
    if (event.type === "usage.recorded") {
      return null;
    }
  }

  const fromPayload = formatSdkPayloadMessage(event.payload);
  if (fromPayload) {
    return fromPayload;
  }

  if (event.type === "agent.started") {
    return formatSdkPayloadMessage(event.payload) ?? "Agent session started.";
  }

  if (event.type === "plan.ready") {
    return "计划已生成，等待确认。";
  }

  if (
    event.type === "tool.started" &&
    isRecord(event.payload) &&
    typeof event.payload.tool_name === "string"
  ) {
    return `Running tool: ${event.payload.tool_name}`;
  }

  if (event.type === "tool.completed") {
    return formatSdkPayloadMessage(event.payload);
  }

  return null;
}

export function inferActivityRole(event: Pick<AgentEvent, "type" | "payload" | "role">): ActivityDisplayRole {
  if (isThinkingPayload(event.payload)) {
    return "thinking";
  }

  if (isRecord(event.payload)) {
    if (event.payload.type === "tool_permission_denied") {
      return "tool";
    }
    if (
      event.payload.type === "tool_progress" ||
      event.payload.type === "tool_result" ||
      event.payload.type === "tool_use_summary"
    ) {
      return "tool";
    }
    if (event.payload.type === "tool_use") {
      if (event.payload.tool_name === "Agent" && isRecord(event.payload.input)) {
        const subagent =
          (typeof event.payload.input.subagent_type === "string" && event.payload.input.subagent_type) ||
          (typeof event.payload.input.agent_type === "string" && event.payload.input.agent_type) ||
          undefined;
        const role = subagent ? resolveActivitySubagentRole(subagent) : undefined;
        if (role) {
          return role;
        }
      }
      if (typeof event.payload.subagent_type === "string") {
        const role = resolveActivitySubagentRole(event.payload.subagent_type);
        if (role) {
          return role;
        }
      }
      if (isRuntimeAgentActivityRole(event.role)) {
        return event.role;
      }
      return "tool";
    }
    if (typeof event.payload.subagent_type === "string") {
      const role = resolveActivitySubagentRole(event.payload.subagent_type);
      if (role) {
        return role;
      }
    }
    if (typeof event.payload.agent_type === "string") {
      const role = resolveActivitySubagentRole(event.payload.agent_type);
      if (role) {
        return role;
      }
    }
  }

  if (event.type === "todo.updated" && isRecord(event.payload)) {
    const subagent = event.payload.subagent_type;
    if (typeof subagent === "string") {
      const role = resolveActivitySubagentRole(subagent);
      if (role) {
        return role;
      }
    }
  }

  if (event.type === "tool.started" || event.type === "tool.completed") {
    if (isRuntimeAgentActivityRole(event.role)) {
      return event.role;
    }
    if (isRecord(event.payload) && event.payload.tool_name === "Agent" && isRecord(event.payload.input)) {
      const subagent =
        (typeof event.payload.input.subagent_type === "string" && event.payload.input.subagent_type) ||
        (typeof event.payload.input.agent_type === "string" && event.payload.input.agent_type) ||
        undefined;
      const role = subagent ? resolveActivitySubagentRole(subagent) : undefined;
      if (role) {
        return role;
      }
    }
    if (isRecord(event.payload) && typeof event.payload.subagent_type === "string") {
      const role = resolveActivitySubagentRole(event.payload.subagent_type);
      if (role) {
        return role;
      }
    }
    return "tool";
  }

  return event.role;
}

function isRuntimeAgentActivityRole(role: RuntimeAgentRole): boolean {
  return role !== "planner" && role !== "system" && role !== "thinking" && role !== "tool" && role !== "user";
}

export function isThinkingPayload(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }

  if (payload.type === "eco_stream" && payload.blockKind === "thinking") {
    return true;
  }

  if (payload.type === "stream_event" && isRecord(payload.event)) {
    const event = payload.event;
    if (
      event.type === "content_block_delta" &&
      isRecord(event.delta) &&
      event.delta.type === "thinking_delta"
    ) {
      return true;
    }
  }

  if (payload.type === "assistant" && isRecord(payload.message) && Array.isArray(payload.message.content)) {
    return payload.message.content.some(
      (block) => isRecord(block) && block.type === "thinking" && typeof block.thinking === "string",
    );
  }

  return false;
}

export function isStreamPayload(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  if (payload.type === "eco_stream") {
    return !payload.streamFinalize;
  }
  return payload.type === "stream_event";
}

export function formatSdkPayloadMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!isRecord(payload)) {
    return null;
  }

  if (payload.type === "tool_permission_denied" && typeof payload.tool_name === "string") {
    const reason = typeof payload.message === "string" ? `: ${payload.message}` : "";
    return `Permission denied for ${payload.tool_name}${reason}`;
  }

  if (typeof payload.label === "string" && typeof payload.ecoPhase === "string") {
    return payload.label.trim() || null;
  }

  if (payload.type === "assistant" && isRecord(payload.message)) {
    return extractBetaMessageText(payload.message);
  }

  if (payload.type === "eco_stream") {
    if (payload.streamPlaceholder) {
      return null;
    }
    if (typeof payload.text === "string" && payload.text.length > 0) {
      return payload.text;
    }
    return null;
  }

  if (payload.type === "stream_event" && isRecord(payload.event)) {
    return extractStreamEventText(payload.event);
  }

  if (payload.type === "tool_use" && typeof payload.tool_name === "string") {
    const skillName = resolveSkillDisplayName(payload.tool_name, payload.input);
    if (skillName) {
      return formatSkillActivityLabel(skillName);
    }
    if (payload.tool_name === "Agent") {
      const mission = formatAgentToolMissionMessage(payload.input);
      if (mission) {
        return mission;
      }
    }
    const detail = formatToolInputSummary(payload.tool_name, payload.input);
    return detail ? `Tool: ${payload.tool_name} · ${detail}` : `Tool: ${payload.tool_name}`;
  }

  if (payload.type === "tool_progress" && typeof payload.tool_name === "string") {
    const seconds =
      typeof payload.elapsed_time_seconds === "number"
        ? ` (${payload.elapsed_time_seconds.toFixed(1)}s)`
        : "";
    return `Tool: ${payload.tool_name}${seconds}`;
  }

  if (payload.type === "tool_result_error" && typeof payload.tool_name === "string") {
    if (payload.non_execution_kind === "cancelled") {
      return `Tool cancelled: ${payload.tool_name} (system cancelled — not a user denial)`;
    }
    const reason = typeof payload.message === "string" ? `: ${payload.message}` : "";
    return `Tool failed: ${payload.tool_name}${reason}`;
  }

  if (payload.type === "tool_result" && payload.is_error === true && typeof payload.tool_name === "string") {
    const reasonText =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.content === "string"
          ? payload.content
          : "";
    const reason = reasonText.trim() ? `: ${reasonText.trim()}` : "";
    return `Tool failed: ${payload.tool_name}${reason}`;
  }

  if (payload.type === "tool_result" && typeof payload.tool_name === "string") {
    const skillName = resolveSkillDisplayName(payload.tool_name, payload.input);
    if (skillName) {
      return formatSkillActivityLabel(skillName);
    }
    const detail = formatToolResultDisplayDetail(payload.tool_name, payload.input, payload.content);
    return detail ? `Tool: ${payload.tool_name} · ${detail}` : `Tool: ${payload.tool_name}`;
  }

  if (payload.type === "tool_use_summary" && typeof payload.summary === "string") {
    return payload.summary.trim() || null;
  }

  if (payload.type === "system") {
    if (payload.subtype === "init") {
      const model = typeof payload.model === "string" ? payload.model : "model";
      return `Codex runtime ready (${model}).`;
    }
    if (payload.subtype === "notification" && typeof payload.text === "string") {
      return payload.text.trim() || null;
    }
    if (payload.subtype === "status") {
      if (payload.status === "requesting") {
        return "Requesting model…";
      }
      if (payload.status === "compacting") {
        return "Compacting context…";
      }
      return null;
    }
    if (payload.subtype === "compact_boundary") {
      return "Compacting context…";
    }
    if (payload.subtype === "task_started" && typeof payload.description === "string") {
      const subagent =
        (typeof payload.subagent_type === "string" && payload.subagent_type.trim()) ||
        (typeof payload.agent_type === "string" && payload.agent_type.trim()) ||
        undefined;
      if (subagent) {
        return formatSubagentMissionMessage(subagent, payload.description);
      }
      return `Task started: ${payload.description}`;
    }
    if (payload.subtype === "task_progress") {
      const description = typeof payload.description === "string" ? payload.description.trim() : "";
      const toolName = typeof payload.last_tool_name === "string" ? payload.last_tool_name.trim() : "";
      if (description && toolName) {
        return `Tool: ${toolName} · ${description}`;
      }
      if (toolName) {
        return `Tool: ${toolName}`;
      }
      return description || null;
    }
    if (payload.subtype === "task_updated" && isRecord(payload.patch)) {
      const status = payload.patch.status;
      if (typeof status === "string") {
        return `Task ${status}`;
      }
      return null;
    }
    if (payload.subtype === "api_retry") {
      const attempt = typeof payload.attempt === "number" ? payload.attempt : "?";
      const maxRetries = typeof payload.max_retries === "number" ? payload.max_retries : "?";
      return `API retry ${attempt}/${maxRetries}…`;
    }
    if (payload.subtype === "permission_denied" && typeof payload.tool_name === "string") {
      const reason = typeof payload.message === "string" ? `: ${payload.message}` : "";
      return `Permission denied for ${payload.tool_name}${reason}`;
    }
  }

  if (payload.type === "auth_status" && Array.isArray(payload.output)) {
    const lines = payload.output.filter(
      (line): line is string => typeof line === "string" && line.trim().length > 0,
    );
    return lines.length > 0 ? lines.join("\n") : null;
  }

  if (payload.type === "result") {
    return null;
  }

  if (payload.type === "user") {
    return null;
  }

  if (typeof payload.message === "string") {
    const trimmed = payload.message.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}

function extractBetaMessageText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      parts.push(block.thinking);
      continue;
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      const detail = formatToolInputSummary(block.name, block.input);
      parts.push(detail ? `[tool] ${block.name} · ${detail}` : `[tool] ${block.name}`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function extractStreamEventText(event: Record<string, unknown>): string | null {
  if (event.type === "content_block_delta" && isRecord(event.delta)) {
    if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
      const text = event.delta.text;
      return text.length > 0 ? text : null;
    }
    if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
      const thinking = event.delta.thinking;
      return thinking.length > 0 ? thinking : null;
    }
  }

  return null;
}

const SUBAGENT_ROLE_LABELS: Record<SubagentRole, string> = {
  explore: "探索",
  architect: "架构",
  coder: "编码",
  reviewer: "审查",
  tester: "测试",
};

export function formatSubagentLabel(role: string): string {
  if (isSubagentRole(role)) {
    return SUBAGENT_ROLE_LABELS[role];
  }
  if (isAgentRole(role) && role !== "planner") {
    return role;
  }
  return role;
}

function isSdkTodoUpdatedPayload(payload: unknown): payload is SdkTodoUpdatedPayload {
  if (!isRecord(payload)) {
    return false;
  }
  const sdkKind = payload.sdkKind;
  if (
    sdkKind !== "task_started" &&
    sdkKind !== "task_updated" &&
    sdkKind !== "task_progress" &&
    sdkKind !== "task_notification"
  ) {
    return false;
  }
  return typeof payload.task_id === "string" && payload.task_id.length > 0;
}

function formatAgentToolMissionMessage(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }
  const subagent = resolveAgentToolSubagentType(input);
  if (!subagent) {
    return null;
  }
  const prompt = resolveAgentToolTaskPrompt(input);
  return formatSubagentMissionMessage(subagent, prompt);
}

function resolveAgentToolSubagentType(input: Record<string, unknown>): string | undefined {
  return (
    (typeof input.subagent_type === "string" && input.subagent_type.trim()) ||
    (typeof input.agent_type === "string" && input.agent_type.trim()) ||
    (typeof input.agent === "string" && input.agent.trim()) ||
    undefined
  );
}

function resolveAgentToolTaskPrompt(input: Record<string, unknown>): string {
  return (
    (typeof input.prompt === "string" && input.prompt.trim()) ||
    (typeof input.task === "string" && input.task.trim()) ||
    (typeof input.description === "string" && input.description.trim()) ||
    ""
  );
}

function formatToolResultDisplayDetail(toolName: string, input: unknown, content: unknown): string | null {
  const inputDetail = formatToolInputSummary(toolName, input);
  const contentDetail = formatToolResultContentSummary(content);
  if (inputDetail && contentDetail) {
    return `${inputDetail} · ${contentDetail}`;
  }
  return inputDetail ?? contentDetail;
}

function formatToolResultContentSummary(content: unknown): string | null {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    return null;
  }
  const preview = createToolOutputPreview(text, 240).text.replace(/\s+/g, " ").trim();
  if (!preview) {
    return null;
  }
  return preview.length > 80 ? `${preview.slice(0, 77)}…` : preview;
}

function formatToolInputSummary(toolName: string, input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  if (toolName === "SendMessage") {
    return formatSendMessageToolInputSummary(input) ?? null;
  }

  if (toolName === "AskUserQuestion") {
    if (!Array.isArray(input.questions)) {
      return "澄清问题";
    }
    const count = input.questions.length;
    const first = input.questions[0];
    if (isRecord(first) && typeof first.question === "string") {
      const preview = first.question.trim();
      const short = preview.length > 48 ? `${preview.slice(0, 45)}…` : preview;
      return count > 1 ? `澄清 ${count} 个问题 · ${short}` : short;
    }
    return count > 1 ? `澄清 ${count} 个问题` : "澄清问题";
  }

  const skillName = resolveSkillDisplayName(toolName, input);
  if (skillName) {
    return `${skillName} 技能`;
  }

  if (toolName === "Agent") {
    const subagent = resolveAgentToolSubagentType(input);
    if (subagent) {
      const label = formatSubagentLabel(subagent);
      const taskPrompt = resolveAgentToolTaskPrompt(input);
      if (taskPrompt) {
        const summary = taskPrompt.length > 60 ? `${taskPrompt.slice(0, 57)}…` : taskPrompt;
        return `${label} · ${summary}`;
      }
      return label;
    }
  }

  const readTarget = resolveReadTargetFromToolInput(toolName, input);
  if (readTarget) {
    return formatReadTargetLabel(readTarget);
  }

  const grepTarget = resolveGrepTargetFromToolInput(toolName, input);
  if (grepTarget) {
    return formatGrepTargetLabel(grepTarget);
  }

  const filePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : undefined;
  if (filePath) {
    return pathBasename(filePath);
  }

  if (typeof input.command === "string") {
    const command = input.command.trim();
    return command.length > 80 ? `${command.slice(0, 77)}…` : command;
  }

  if (typeof input.pattern === "string") {
    return input.pattern;
  }

  if (toolName === "WebSearch" || toolName === "web_search" || toolName.includes("eco_web_search")) {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (query) {
      return query.length > 80 ? `${query.slice(0, 77)}…` : query;
    }
  }

  if (toolName === "WebFetch") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (url) {
      return url.length > 80 ? `${url.slice(0, 77)}…` : url;
    }
  }

  return null;
}

function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

export function isStreamableAgentEventType(type: AgentEventType): boolean {
  return type === "message.delta";
}
