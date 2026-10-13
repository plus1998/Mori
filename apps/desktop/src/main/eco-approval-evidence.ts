import type { ApprovalHostEvidence } from "./eco-approval-local-evidence";

/** Hard budgets for approval evidence (characters, not estimated tokens). */

export const MAX_ENVELOPE_CHARS = 32_000;
export const MAX_TRANSCRIPT_CHARS = 16_000;
export const MAX_PLANNED_ACTION_CHARS = 8_000;
export const MAX_USER_REQUEST_CHARS = 2_000;
export const MAX_MESSAGE_ENTRY_CHARS = 2_000;
export const MAX_TOOL_ENTRY_CHARS = 1_200;
export const MAX_TRANSCRIPT_ENTRIES = 20;
export const MAX_HOST_EVIDENCE_CHARS = 8_000;

export interface ApprovalActivityLine {
  role: string;
  message: string;
  type?: string;
}

export interface ApprovalTranscriptEntry {
  index: number;
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface ApprovalPlannedAction {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  workspacePath: string;
  justification?: string;
}

export interface EcoApprovalEnvelopeV2 {
  /** Latest retained user message; earlier requests remain in the transcript. */
  userRequest: string;
  transcript: ApprovalTranscriptEntry[];
  plannedAction: ApprovalPlannedAction;
  reason: string;
  riskScore?: number;
  riskLevel?: string;
  /** Independently collected host facts; tool input cannot populate this field. */
  hostEvidence?: ApprovalHostEvidence;
  /** Logging only — never used for policy branching. */
  source?: string;
}

export type BuildApprovalEnvelopeResult =
  | { ok: true; envelope: EcoApprovalEnvelopeV2; serialized: string }
  | { ok: false; rationale: string; policyMatches: string[] };

const BASH_APPROVAL_TYPE = /^bash_approval\./i;
const TRUNCATION_MARKER = "<truncated />";

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= TRUNCATION_MARKER.length + 1) {
    return text.slice(0, maxChars);
  }
  const keep = maxChars - TRUNCATION_MARKER.length - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head)}${TRUNCATION_MARKER}${text.slice(text.length - tail)}`;
}

export function shouldIncludeActivityLine(line: ApprovalActivityLine): boolean {
  const role = line.role.trim().toLowerCase();
  const message = line.message.trim();
  if (!message) {
    return false;
  }
  if (line.type && BASH_APPROVAL_TYPE.test(line.type)) {
    return false;
  }
  if (role === "user") {
    return true;
  }
  if (
    BASH_APPROVAL_TYPE.test(message) ||
    /(?:辅助模型|审批模型)已允许|等待确认|已拒绝|已允许本次/.test(message)
  ) {
    return false;
  }
  if (role === "thinking") {
    return false;
  }
  if (role === "tool") {
    return true;
  }
  // Short assistant notes only; drop long assistant monologues.
  if (role === "assistant" || role === "system") {
    return message.length <= 400 && !message.includes("```");
  }
  return false;
}

export function mapActivityRole(role: string): ApprovalTranscriptEntry["role"] {
  const normalized = role.trim().toLowerCase();
  if (normalized === "user") {
    return "user";
  }
  if (normalized === "tool") {
    return "tool";
  }
  return "assistant";
}

export function buildApprovalTranscript(
  lines: readonly ApprovalActivityLine[],
  initialPrompt: string,
): ApprovalTranscriptEntry[] {
  const candidates: Array<{ role: ApprovalTranscriptEntry["role"]; text: string }> = [];
  const prompt = initialPrompt.trim();
  if (prompt) {
    candidates.push({ role: "user", text: truncateText(prompt, MAX_MESSAGE_ENTRY_CHARS) });
  }

  for (const line of lines) {
    if (!shouldIncludeActivityLine(line)) {
      continue;
    }
    const role = mapActivityRole(line.role);
    const max = role === "tool" ? MAX_TOOL_ENTRY_CHARS : MAX_MESSAGE_ENTRY_CHARS;
    candidates.push({ role, text: truncateText(line.message.trim(), max) });
  }

  const indexed = candidates.map((entry, index) => ({ ...entry, index }));
  const selected: typeof indexed = [];
  let used = 0;

  // Reserve room for the latest user intent before considering tool/assistant
  // traffic. Apply the entry cap after selection so long tool runs cannot evict it.
  const users = indexed.filter((entry) => entry.role === "user").reverse();
  const others = indexed.filter((entry) => entry.role !== "user").reverse();

  for (const entry of [...users, ...others]) {
    if (selected.length >= MAX_TRANSCRIPT_ENTRIES) {
      break;
    }
    const cost = entry.text.length + 24;
    if (used + cost > MAX_TRANSCRIPT_CHARS && selected.length > 0) {
      continue;
    }
    if (used + cost > MAX_TRANSCRIPT_CHARS) {
      const room = Math.max(0, MAX_TRANSCRIPT_CHARS - used - 24);
      if (room < 40) {
        break;
      }
      selected.push({ ...entry, text: truncateText(entry.text, room) });
      used = MAX_TRANSCRIPT_CHARS;
      break;
    }
    selected.push(entry);
    used += cost;
  }

  return selected
    .sort((left, right) => left.index - right.index)
    .map((entry, index) => ({
      index: index + 1,
      role: entry.role,
      text: entry.text,
    }));
}

export function buildUserRequestSummary(transcript: readonly ApprovalTranscriptEntry[]): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.role === "user") {
      return truncateText(entry.text, MAX_USER_REQUEST_CHARS);
    }
  }
  return "";
}

export function clampPlannedAction(action: ApprovalPlannedAction): ApprovalPlannedAction {
  const serialized = JSON.stringify(action.input);
  if (serialized.length <= MAX_PLANNED_ACTION_CHARS - 200) {
    return {
      ...action,
      ...(action.justification ? { justification: truncateText(action.justification, 500) } : {}),
    };
  }
  return {
    tool: action.tool,
    cwd: action.cwd,
    workspacePath: action.workspacePath,
    input: {
      _truncated: true,
      preview: truncateText(serialized, MAX_PLANNED_ACTION_CHARS - 80),
    },
    ...(action.justification ? { justification: truncateText(action.justification, 500) } : {}),
  };
}

export function serializeEnvelope(envelope: EcoApprovalEnvelopeV2): string {
  return JSON.stringify(envelope);
}

/**
 * Build a budget-safe approval envelope. Never enlarges across retries — callers
 * must reuse this result for review attempts.
 */
export function buildApprovalEnvelope(input: {
  activityLines: readonly ApprovalActivityLine[];
  initialPrompt: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  workspacePath: string;
  reason: string;
  riskScore?: number;
  riskLevel?: string;
  source?: string;
  hostEvidence?: ApprovalHostEvidence;
}): BuildApprovalEnvelopeResult {
  if (input.hostEvidence && JSON.stringify(input.hostEvidence).length > MAX_HOST_EVIDENCE_CHARS) {
    return {
      ok: false,
      rationale: "宿主文件证据超过字符预算，无法完整核对目标范围，需人工审批。",
      policyMatches: ["host_evidence_over_budget"],
    };
  }
  const transcript = buildApprovalTranscript(input.activityLines, input.initialPrompt);
  const plannedAction = clampPlannedAction({
    tool: input.toolName,
    input: input.toolInput,
    cwd: input.cwd,
    workspacePath: input.workspacePath,
    ...(input.reason ? { justification: input.reason } : {}),
  });
  const envelope: EcoApprovalEnvelopeV2 = {
    userRequest: buildUserRequestSummary(transcript),
    transcript,
    plannedAction,
    reason: truncateText(input.reason, 800),
    ...(input.riskScore !== undefined ? { riskScore: input.riskScore } : {}),
    ...(input.riskLevel !== undefined ? { riskLevel: input.riskLevel } : {}),
    ...(input.hostEvidence ? { hostEvidence: input.hostEvidence } : {}),
    ...(input.source ? { source: input.source } : {}),
  };

  let serialized = serializeEnvelope(envelope);
  if (serialized.length <= MAX_ENVELOPE_CHARS) {
    return { ok: true, envelope, serialized };
  }

  // Aggressive shrink: drop non-user transcript, then truncate transcript further.
  const usersOnly = envelope.transcript.filter((entry) => entry.role === "user").slice(-8);
  const shrunk: EcoApprovalEnvelopeV2 = {
    ...envelope,
    transcript: usersOnly.map((entry, index) => ({ ...entry, index: index + 1 })),
    plannedAction: clampPlannedAction({
      ...plannedAction,
      input: {
        _truncated: true,
        preview: truncateText(JSON.stringify(input.toolInput), 2_000),
      },
    }),
  };
  serialized = serializeEnvelope(shrunk);
  if (serialized.length <= MAX_ENVELOPE_CHARS) {
    return { ok: true, envelope: shrunk, serialized };
  }

  return {
    ok: false,
    rationale: "审批证据超过字符硬顶，已按失败关闭策略转人工审批（未调用审批模型）。",
    policyMatches: ["evidence_over_budget"],
  };
}
