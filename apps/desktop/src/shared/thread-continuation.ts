import { stripSubagentBracketPrefix } from "./activity-display";
import type { ThreadActivityLine, ThreadActivityRewindTarget, ThreadStatus } from "./ipc";

export interface ActivityContextLine {
  role: string;
  message: string;
}

/** Thread statuses where the user may send another message on the same thread. */
export const CONTINUABLE_THREAD_STATUSES = ["idle", "completed", "failed", "blocked"] as const;

export type ContinuableThreadStatus = (typeof CONTINUABLE_THREAD_STATUSES)[number];

export function isContinuableThreadStatus(status: ThreadStatus): status is ContinuableThreadStatus {
  return (CONTINUABLE_THREAD_STATUSES as readonly string[]).includes(status);
}

export type ThreadContinueAction =
  | { kind: "resume_execution" }
  | { kind: "resume_sdk"; phase: "planning" | "execution" | "ask"; resume?: boolean }
  | { kind: "revise_plan" }
  | { kind: "fresh_plan" }
  | { kind: "fresh_autonomous" };

export interface ThreadContinueRoutingInput {
  sessionMode: import("./session-mode").SessionMode;
  followUp: string;
  canResume: boolean;
  hasPendingPlan: boolean;
  hasApprovedPlanOnDisk: boolean;
  enteredExecutionPhase: boolean;
  hasCoderTodos: boolean;
  hasAppliedDiff: boolean;
  threadStatus: ThreadStatus;
  activityLines: readonly ActivityContextLine[];
}

const PLAN_REVISION_PATTERNS = [
  /改计划/,
  /修改计划/,
  /重新规划/,
  /重做计划/,
  /换方案/,
  /换方向/,
  /改方向/,
  /先别做/,
  /先不要/,
  /不要.*(?:做|继续).*改/,
  /别.*(?:做|继续).*改/,
  /改成/,
  /修订计划/,
  /重新制定/,
  /\b(replan|revise\s+(the\s+)?plan)\b/i,
];

/** User explicitly wants a new planning pass instead of resuming execution. */
export function userRequestsPlanRevision(followUp: string): boolean {
  const text = followUp.trim();
  if (!text) {
    return false;
  }
  return PLAN_REVISION_PATTERNS.some((pattern) => pattern.test(text));
}

export interface ContinuePhaseInput {
  threadStatus: ThreadStatus;
  hasPendingPlan: boolean;
  hasApprovedPlanOnDisk: boolean;
  enteredExecutionPhase: boolean;
  hasCoderTodos: boolean;
  hasAppliedDiff: boolean;
  activityLines: readonly ActivityContextLine[];
}

const EXECUTION_ACTIVITY_MARKERS = ["计划已进入执行阶段", "子代理执行", "执行完成", "继续执行"] as const;

/** Whether the thread has entered phase-2 execution (approved plan or coder work). */
export function threadEnteredExecutionPhase(input: ContinuePhaseInput): boolean {
  if (input.hasApprovedPlanOnDisk || input.hasCoderTodos || input.hasAppliedDiff) {
    return true;
  }
  if (input.threadStatus === "completed") {
    return true;
  }
  return input.activityLines.some((line) =>
    EXECUTION_ACTIVITY_MARKERS.some((marker) => line.message.includes(marker)),
  );
}

export function resolveContinuePhase(input: ContinuePhaseInput): "planning" | "execution" {
  if (input.hasAppliedDiff || input.threadStatus === "completed") {
    return "execution";
  }
  if (threadEnteredExecutionPhase(input)) {
    return "execution";
  }
  if (input.hasPendingPlan && input.threadStatus === "awaiting_plan") {
    return "planning";
  }
  return "planning";
}

export function resolveThreadContinueAction(input: ThreadContinueRoutingInput): ThreadContinueAction {
  const wantsRevision = userRequestsPlanRevision(input.followUp);

  if (input.sessionMode === "ask") {
    return { kind: "resume_sdk", phase: "ask", resume: input.canResume };
  }

  if (input.sessionMode === "agent") {
    return input.canResume ? { kind: "resume_sdk", phase: "execution" } : { kind: "fresh_autonomous" };
  }

  if (wantsRevision) {
    return input.canResume ? { kind: "resume_sdk", phase: "planning" } : { kind: "revise_plan" };
  }

  const enteredExecution = input.enteredExecutionPhase;

  if (input.hasPendingPlan && enteredExecution) {
    return { kind: "resume_execution" };
  }

  if (!input.hasPendingPlan && input.hasApprovedPlanOnDisk && enteredExecution) {
    return { kind: "resume_execution" };
  }

  if (input.canResume) {
    const phase = resolveContinuePhase({
      threadStatus: input.threadStatus,
      hasPendingPlan: input.hasPendingPlan,
      hasApprovedPlanOnDisk: input.hasApprovedPlanOnDisk,
      enteredExecutionPhase: enteredExecution,
      hasCoderTodos: input.hasCoderTodos,
      hasAppliedDiff: input.hasAppliedDiff,
      activityLines: input.activityLines,
    });
    return { kind: "resume_sdk", phase };
  }

  if (enteredExecution && input.hasApprovedPlanOnDisk) {
    return { kind: "resume_execution" };
  }

  if (input.hasPendingPlan && input.threadStatus === "awaiting_plan" && !enteredExecution) {
    return { kind: "revise_plan" };
  }

  return { kind: "fresh_plan" };
}

export function continueStatusMessage(action: ThreadContinueAction): string {
  if (action.kind === "resume_sdk" && action.phase === "ask") {
    return "正在回答…";
  }
  if (action.kind === "resume_execution") {
    return "正在按计划执行…";
  }
  if (action.kind === "resume_sdk") {
    if (action.phase === "execution") {
      return "正在继续执行…";
    }
    return "正在分析并制定计划…";
  }
  if (action.kind === "fresh_autonomous") {
    return "正在交给主代理处理…";
  }
  if (action.kind === "revise_plan" || action.kind === "fresh_plan") {
    return "正在分析并制定计划…";
  }
  return "正在分析并制定计划…";
}

/** Agent turn prompt: keep the original task and add the latest user message. */
export function buildThreadTurnPrompt(threadPrompt: string, followUp: string): string {
  const original = threadPrompt.trim();
  const next = followUp.trim();
  if (!original) {
    return next;
  }
  if (!next || original === next) {
    return original;
  }
  return `${original}\n\n---\n\n后续消息：\n${next}`;
}

/** Return only the transcript before the selected user node. */
export function activityLinesBeforeRewindTarget(
  activityLines: readonly ThreadActivityLine[],
  rewindTarget: ThreadActivityRewindTarget,
): ThreadActivityLine[] {
  const index = activityLines.findIndex(
    (line) =>
      line.id === rewindTarget.activityLineId ||
      line.rewindTarget?.userMessageId === rewindTarget.userMessageId,
  );
  if (index < 0) {
    throw new Error("回到节点后无法定位历史边界，已停止继续对话。");
  }
  return activityLines.slice(0, index);
}

export function shouldUseInterruptedWorktree(worktreeExists: boolean, hasPriorActivity: boolean): boolean {
  return worktreeExists && hasPriorActivity;
}

const ACTIVITY_NOISE =
  /^(?:Tool:|Running tool:|Requesting model|Compacting context|API retry |Usage recorded|Run finished|Agent session started|Claude Agent SDK ready|状态已更新|已从异常退出恢复|【\d+\/\d+】)/i;

export function isActivityNoiseMessage(message: string): boolean {
  const text = stripSubagentBracketPrefix(message.trim());
  return !text || ACTIVITY_NOISE.test(text);
}

/** Usage/cost lines that must never appear in the activity body. */
export function isUsageNoiseMessage(message: string): boolean {
  const text = stripSubagentBracketPrefix(message.trim());
  return /^(?:Usage recorded|Run finished)/i.test(text);
}

/** Compress stored activity into narrative context for the next agent turn. */
export function buildActivityContextForPrompt(
  lines: readonly ActivityContextLine[],
  options?: { maxChars?: number; maxLines?: number },
): string {
  const maxChars = options?.maxChars ?? 12_000;
  const maxLines = options?.maxLines ?? 48;
  const entries: string[] = [];

  for (const line of lines) {
    if (line.role === "tool" || line.role === "thinking" || line.role === "system") {
      continue;
    }
    let text = stripSubagentBracketPrefix(line.message.trim());
    if (!text || ACTIVITY_NOISE.test(text)) {
      continue;
    }
    if (text.length > 600) {
      text = `${text.slice(0, 597)}…`;
    }
    const roleLabel =
      line.role === "user"
        ? "用户"
        : line.role === "main"
          ? "主代理"
          : line.role === "explore"
            ? "探索"
            : line.role === "architect"
              ? "架构"
              : line.role === "coder"
                ? "编码"
                : line.role === "reviewer"
                  ? "审查"
                  : line.role === "tester"
                    ? "测试"
                    : line.role;
    entries.push(`[${roleLabel}] ${text}`);
  }

  if (entries.length === 0) {
    return "";
  }

  let body = entries.slice(-maxLines).join("\n");
  if (body.length > maxChars) {
    body = `…（更早记录已省略）\n${body.slice(-maxChars)}`;
  }
  return body;
}

/** Task + optional transcript + latest user message for any agent mode. */
export function buildAgentPromptWithContext(
  threadPrompt: string,
  followUp: string,
  activityLines: readonly ActivityContextLine[],
): string {
  const turn = buildThreadTurnPrompt(threadPrompt, followUp);
  const history = buildActivityContextForPrompt(activityLines);
  if (!history) {
    return turn;
  }
  return `${turn}\n\n---\n\n## 对话记录（供续聊参考）\n${history}`;
}

/** UI: show planner session context, not max across all subagents. */
export function pickDisplayContextTokens(usageByRole: Record<string, { contextTokens: number }>): number {
  const planner = usageByRole.main?.contextTokens ?? 0;
  if (planner > 0) {
    return planner;
  }
  return Object.values(usageByRole).reduce((max, usage) => Math.max(max, usage.contextTokens), 0);
}

/**
 * Codex continue routing for eco↔Codex core session binding.
 * Binding is only written after successful thread/start or thread/resume.
 * - resume: has binding → use continuation and existing Codex thread
 * - cold_start: never mapped (or mapping lost) → start a new Codex conversation
 * - error: rewind/fork requires a mapping; there is no safe recovery without binding
 */
export type CodexContinueStrategy =
  | { kind: "resume" }
  | { kind: "cold_start" }
  | { kind: "error"; message: string };

export function resolveCodexContinueStrategy(input: {
  hasBinding: boolean;
  hasRewindTarget: boolean;
}): CodexContinueStrategy {
  if (input.hasBinding) {
    return { kind: "resume" };
  }
  if (input.hasRewindTarget) {
    return {
      kind: "error",
      message: "Codex thread binding is missing; cannot safely rewind this thread.",
    };
  }
  return { kind: "cold_start" };
}

const AGENT_OUTPUT_ROLES = new Set([
  "main",
  "explore",
  "architect",
  "coder",
  "reviewer",
  "tester",
  "assistant",
]);

/**
 * True when the thread already has substantive agent/model output in activity.
 * Used to distinguish "first message never established an ACP session" from
 * "session binding was lost after a prior successful turn".
 */
export function threadHasPriorAgentOutput(lines: readonly ActivityContextLine[]): boolean {
  return lines.some((line) => AGENT_OUTPUT_ROLES.has(line.role) && !isActivityNoiseMessage(line.message));
}
