import {
  ACP_IMAGE_ONLY_PROMPT,
  ACP_LOAD_SESSION_UNSUPPORTED,
  AcpAgentDriver,
  type AcpAskQuestionHandler,
  type AcpCreatePlanHandler,
  type AcpMcpServer,
  type AcpPermissionHandler,
  type AgentEvent,
  isAcpProviderExhaustionMessage,
  killTrackedCursorAcpProcesses,
} from "@eco/runtime";
import type { CoreKind } from "@eco/runtime/core-runtime";
import { definedProps } from "@eco/shared";
import type { WorktreePlan } from "@eco/workspace";
import type { PromptImageAttachment, ThreadSummary, WorkspaceInfo } from "../shared/ipc";
import type { ActiveRunRuntimeStateInput } from "./active-run-runtime-state";
import type { PreparedConversationCommandDispatch } from "./conversation-command-dispatch";
import type { RequestAttemptResult } from "./request-retry";
import { resolveAcpThreadAgentId } from "./resolve-acp-thread-agent-id";
import {
  resolveAskRunOutcome,
  resolveAutonomousRunOutcome,
  resolvePlanningRunOutcome,
  type ThreadRunOutcomeDecision,
} from "./thread-run-outcome";

export interface AcpThreadStartRunInput {
  thread: ThreadSummary;
  workspace: WorkspaceInfo;
  prompt: string;
  attachments?: PromptImageAttachment[];
  continuation?: boolean;
  /** User-facing prompt to restore when the turn is discarded (may differ from ACP wire prompt). */
  restorePrompt?: string;
  /** Set only when this run recorded a new user bubble. */
  recordedUserActivityLineId?: string;
  runtimeDispatch?: PreparedConversationCommandDispatch;
}

export interface AcpRuntimeOrchestrationDeps {
  requireThreadCore: (thread: Pick<ThreadSummary, "id" | "coreKind">, expected: CoreKind, op: string) => void;
  resolveSessionMode: (runtimeConfig: ThreadSummary["runtimeConfig"]) => "agent" | "plan" | "ask";
  startActiveRun: (threadId: string, run: ActiveRunRuntimeStateInput) => void;
  createSessionPlan: (workspacePath: string, threadId: string) => WorktreePlan;
  runThreadRequestOnce: (
    threadId: string,
    phase: "execution" | "ask" | "planning" | "continuation",
    signal: AbortSignal,
    run: () => Promise<RequestAttemptResult>,
    retryIndex?: number,
    runtimeDispatch?: PreparedConversationCommandDispatch,
  ) => Promise<RequestAttemptResult>;
  consumeEvents: (input: {
    events: AsyncIterable<AgentEvent>;
    threadId: string;
    worktreePath: string;
    signal: AbortSignal;
  }) => Promise<RequestAttemptResult>;
  updateThread: (threadId: string, patch: Pick<ThreadSummary, "message" | "status">) => void;
  markInterrupted: (threadId: string, reason: string) => void;
  finalizeCleanup: (threadId: string) => Promise<void>;
  captureSession: (threadId: string, sessionId: string, cwd: string) => void;
  getThreadCoreSession: (
    threadId: string,
  ) => { coreKind: string; externalSessionId: string; cwd: string } | undefined;
  /** Extra env for the Cursor ACP child (e.g. `{ CURSOR_API_KEY }`); empty when unset. */
  resolveAcpCursorEnv?: () => NodeJS.ProcessEnv;
  /** Composer-selected Eco MCP servers mapped to ACP `mcpServers`. */
  resolveAcpMcpServers?: (input: { threadId: string; workspacePath: string }) => Promise<AcpMcpServer[]>;
  /** ACP has no system-prompt field, so pass Eco integration guidance as turn context. */
  resolveAcpSystemPromptAppend?: (input: { threadId: string }) => string | undefined;
  resolvePromptImagesForMainContext?: (input: {
    threadId: string;
    prompt: string;
    attachments?: readonly PromptImageAttachment[];
    signal?: AbortSignal;
  }) => Promise<string>;
  /** Plan: park cursor/create_plan on Eco approval bridge. */
  resolveAcpCreatePlanHandler?: (input: {
    threadId: string;
    workspacePath: string;
    userPrompt: string;
  }) => AcpCreatePlanHandler;
  /** Ask: park cursor/ask_question on Eco clarification bridge. */
  resolveAcpAskQuestionHandler?: (input: {
    threadId: string;
    workspacePath: string;
  }) => AcpAskQuestionHandler;
  /** Eco takes over session/request_permission (always/auto ask; allow_all auto-allow). */
  resolveAcpPermissionHandler?: (input: { threadId: string; workspacePath: string }) => AcpPermissionHandler;
  /** True when Eco still has a stored pending plan for this thread. */
  hasStoredPendingPlan: (threadId: string) => boolean;
  /**
   * Drop a dead parked create_plan waiter but keep the stored pending plan so
   * approve can continue asynchronously (Cursor may already have disconnected).
   */
  releasePlanBridgeKeepPending: (threadId: string, reason: string) => void;
  applyRunDecision: (input: { threadId: string; decision: ThreadRunOutcomeDecision }) => Promise<void>;
  /** Zero-output start failure: drop the user turn and restore composer. */
  discardUnstartedTurn: (input: {
    threadId: string;
    reason: string;
    restorePrompt: string;
    attachments?: PromptImageAttachment[];
    recordedUserActivityLineId?: string;
    continuation?: boolean;
  }) => Promise<void>;
  /**
   * User-visible notice before an automatic retry of an unstarted ACP
   * retriable failure (e.g. Cursor HTTP/2 keepalive ping timeout).
   */
  notifyAcprAutoRetry?: (input: {
    threadId: string;
    attempt: number;
    maxAttempts: number;
    reason: string;
  }) => void;
  errorMessage: (error: unknown) => string;
  /** Explicit gap copy when session/load fails on continuation. */
  loadSessionFailedMessage: (detail: string) => string;
  /** Continuation without a stored externalSessionId after prior agent output — refuse fake resume. */
  cannotResumeWithoutSessionMessage: () => string;
  /** Whether the thread already has substantive agent/model output in activity. */
  threadHasPriorAgentOutput: (threadId: string) => boolean;
}

let activeDriver = new AcpAgentDriver();

/** Test seam — swap the module-level ACP driver (pass null to restore a fresh one). */
export function setAcpAgentDriverForTests(next: AcpAgentDriver | null): void {
  activeDriver = next ?? new AcpAgentDriver();
}

/** Max automatic retries after an unstarted Cursor ACP retriable failure. */
export const MAX_ACP_AUTORETRIES = 2;

/** Total attempts allowed for one ACP run when auto-retry applies. */
export const ACP_MAX_ATTEMPTS = MAX_ACP_AUTORETRIES + 1;

/**
 * Auto-retry gate for unstarted Cursor ACP retriable failures.
 *
 * Retry only when the turn produced no tools/thoughts (no side effects), the
 * failure is a transient upstream RetriableError envelope, and the run was not
 * cancelled (e.g. a user steer = cancel + resume took over). Retries reuse the
 * same long-lived process and Cursor session — callers must never dispose or
 * cancel the driver here.
 */
export function resolveAcprAutoRetry(input: {
  result: RequestAttemptResult;
  attempt: number;
  maxAttempts: number;
  aborted: boolean;
}): boolean {
  if (input.aborted) {
    return false;
  }
  if (input.result.ok || input.result.aborted || input.result.incomplete) {
    return false;
  }
  if (input.result.unstarted !== true) {
    return false;
  }
  if (!isAcpProviderExhaustionMessage(input.result.reason)) {
    return false;
  }
  return input.attempt < input.maxAttempts;
}

export type AcpResumeDecision =
  | { kind: "fresh" }
  | { kind: "resume"; sessionId: string }
  | { kind: "cannot_resume" };

/**
 * Pure ACP resume policy.
 *
 * - Fresh start: not a continuation, or continuation with no binding when the thread
 *   never produced agent output (first message failed before session/new persisted).
 * - Resume: continuation with a stored externalSessionId.
 * - Cannot resume: continuation without binding but prior agent output exists — session
 *   mapping was lost; do not silently session/new and pretend resume succeeded.
 */
export function decideAcpResume(input: {
  continuation?: boolean;
  externalSessionId?: string | null;
  hasPriorAgentOutput?: boolean;
}): AcpResumeDecision {
  if (!input.continuation) {
    return { kind: "fresh" };
  }
  const sessionId = input.externalSessionId?.trim() ?? "";
  if (sessionId) {
    return { kind: "resume", sessionId };
  }
  if (input.hasPriorAgentOutput) {
    return { kind: "cannot_resume" };
  }
  return { kind: "fresh" };
}

export function isAcpLoadSessionFailure(message: string): boolean {
  return message.includes(ACP_LOAD_SESSION_UNSUPPORTED) || /session\/load/i.test(message);
}

export function toAcpThreadStartRunInput(input: {
  thread: AcpThreadStartRunInput["thread"];
  workspace: AcpThreadStartRunInput["workspace"];
  prompt: string;
  attachments?: PromptImageAttachment[];
  continuation?: boolean;
  restorePrompt?: string;
  recordedUserActivityLineId?: string;
  runtimeDispatch?: PreparedConversationCommandDispatch;
}): AcpThreadStartRunInput {
  return {
    thread: input.thread,
    workspace: input.workspace,
    prompt: input.prompt,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.continuation ? { continuation: true } : {}),
    ...(input.restorePrompt !== undefined ? { restorePrompt: input.restorePrompt } : {}),
    ...(input.recordedUserActivityLineId
      ? { recordedUserActivityLineId: input.recordedUserActivityLineId }
      : {}),
    ...(input.runtimeDispatch ? { runtimeDispatch: input.runtimeDispatch } : {}),
  };
}

export function resolveAcpRunPrompt(input: {
  prompt: string | undefined;
  attachments?: readonly PromptImageAttachment[];
}): string {
  const text = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (text) return text;
  if (input.attachments && input.attachments.length > 0) {
    return ACP_IMAGE_ONLY_PROMPT;
  }
  return "";
}

/** Resolve thread status after an ACP turn, preserving awaiting_plan when a plan is pending. */
export function resolveAcpThreadRunDecision(input: {
  mode: "agent" | "plan" | "ask";
  result: RequestAttemptResult;
  hasPendingPlan: boolean;
}): ThreadRunOutcomeDecision {
  if (input.mode === "ask") {
    return resolveAskRunOutcome(input.result);
  }
  if (input.mode === "plan") {
    return resolvePlanningRunOutcome(input.result, { hasPendingPlan: input.hasPendingPlan });
  }
  return resolveAutonomousRunOutcome(input.result, {
    hasPendingPlan: input.hasPendingPlan,
    planCaptured: input.hasPendingPlan,
  });
}

export async function startAcpThreadRun(
  input: AcpThreadStartRunInput,
  deps: AcpRuntimeOrchestrationDeps,
): Promise<void> {
  return startAcpThreadRunWithDriver(input, deps, activeDriver);
}

export async function startAcpThreadRunWithDriver(
  input: AcpThreadStartRunInput,
  deps: AcpRuntimeOrchestrationDeps,
  acpDriver: AcpAgentDriver,
): Promise<void> {
  deps.requireThreadCore(input.thread, "acp", "start an ACP run");
  const acpAgentId = resolveAcpThreadAgentId(input.thread);
  const controller = new AbortController();
  deps.startActiveRun(input.thread.id, {
    controller,
    worktreePlan: deps.createSessionPlan(input.workspace.path, input.thread.id),
  });
  const mode = deps.resolveSessionMode(input.thread.runtimeConfig);
  const previous = input.continuation ? deps.getThreadCoreSession(input.thread.id) : undefined;
  const resume = decideAcpResume(
    definedProps({
      continuation: input.continuation,
      externalSessionId: previous?.externalSessionId,
      hasPriorAgentOutput: input.continuation ? deps.threadHasPriorAgentOutput(input.thread.id) : false,
    }),
  );
  const coldStartContinuation = input.continuation && resume.kind === "fresh";
  const phase =
    mode === "ask"
      ? "ask"
      : mode === "plan"
        ? "planning"
        : coldStartContinuation || !input.continuation
          ? "execution"
          : "continuation";

  let consumeSettled = false;
  try {
    if (resume.kind === "cannot_resume") {
      deps.markInterrupted(input.thread.id, deps.cannotResumeWithoutSessionMessage());
      return;
    }
    if (coldStartContinuation) {
      process.stderr.write(
        `[eco-acp] continue cold-start thread=${input.thread.id} reason=no_session_binding_before_first_agent_output\n`,
      );
    }
    const mcpServers = deps.resolveAcpMcpServers
      ? await deps.resolveAcpMcpServers({
          threadId: input.thread.id,
          workspacePath: input.workspace.path,
        })
      : [];
    const resolvedPrompt = deps.resolvePromptImagesForMainContext
      ? await deps.resolvePromptImagesForMainContext({
          threadId: input.thread.id,
          prompt: input.prompt,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          signal: controller.signal,
        })
      : input.prompt;
    const systemPromptAppend = deps.resolveAcpSystemPromptAppend?.({ threadId: input.thread.id })?.trim();
    const promptForAgent = systemPromptAppend
      ? `${systemPromptAppend}\n\n${resolvedPrompt}`
      : resolvedPrompt;
    const onCreatePlan = deps.resolveAcpCreatePlanHandler?.({
      threadId: input.thread.id,
      workspacePath: input.workspace.path,
      userPrompt: input.prompt,
    });
    const onAskQuestion = deps.resolveAcpAskQuestionHandler?.({
      threadId: input.thread.id,
      workspacePath: input.workspace.path,
    });
    const onRequestPermission = deps.resolveAcpPermissionHandler?.({
      threadId: input.thread.id,
      workspacePath: input.workspace.path,
    });
    const runOnce = () =>
      deps.consumeEvents({
        events: acpDriver.run({
          threadId: input.thread.id,
          prompt: promptForAgent,
          workspacePath: input.workspace.path,
          signal: controller.signal,
          acpAgentId,
          sessionMode: mode,
          userPromptForPlan: input.prompt,
          ...(input.thread.runtimeConfig?.cursorModelId
            ? { model: input.thread.runtimeConfig.cursorModelId }
            : {}),
          ...(deps.resolveAcpCursorEnv ? { env: deps.resolveAcpCursorEnv() } : {}),
          ...(resume.kind === "resume" ? { resumeSessionId: resume.sessionId } : {}),
          ...(!deps.resolvePromptImagesForMainContext && input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
          mcpServers,
          ...(onCreatePlan ? { onCreatePlan } : {}),
          ...(onAskQuestion ? { onAskQuestion } : {}),
          ...(onRequestPermission ? { onRequestPermission } : {}),
        } as Parameters<AcpAgentDriver["run"]>[0]),
        threadId: input.thread.id,
        worktreePath: input.workspace.path,
        signal: controller.signal,
      });

    // Auto-retry loop: unstarted RetriableError failures re-send the same
    // prompt on the same long-lived process/session (no dispose/cancel).
    let result: RequestAttemptResult;
    let attemptsUsed = 0;
    for (;;) {
      attemptsUsed += 1;
      result = await deps.runThreadRequestOnce(
        input.thread.id,
        phase,
        controller.signal,
        () => runOnce(),
        attemptsUsed - 1,
        attemptsUsed === 1 ? input.runtimeDispatch : undefined,
      );
      if (result.ok) {
        break;
      }
      if (input.runtimeDispatch) {
        break;
      }
      if (
        !resolveAcprAutoRetry({
          result,
          attempt: attemptsUsed,
          maxAttempts: ACP_MAX_ATTEMPTS,
          aborted: controller.signal.aborted,
        })
      ) {
        break;
      }
      deps.notifyAcprAutoRetry?.({
        threadId: input.thread.id,
        attempt: attemptsUsed,
        maxAttempts: ACP_MAX_ATTEMPTS,
        reason: result.reason,
      });
      // A steer/cancel landing in the retry gap hands control to the new run.
      if (controller.signal.aborted) {
        break;
      }
    }
    consumeSettled = true;
    const hasPendingPlan = deps.hasStoredPendingPlan(input.thread.id);
    const decision = resolveAcpThreadRunDecision({ mode, result, hasPendingPlan });
    if (decision.kind === "awaiting_plan") {
      // Disconnect fallback only: run already ended while create_plan was still pending.
      // Happy path keeps the RPC parked inside driver.run until the user decides.
      deps.releasePlanBridgeKeepPending(
        input.thread.id,
        "acp disconnect fallback: plan awaits Eco approval via continuation",
      );
    }
    if (decision.kind === "unstarted") {
      const reason = isAcpLoadSessionFailure(decision.reason)
        ? deps.loadSessionFailedMessage(decision.reason)
        : decision.reason;
      if (input.runtimeDispatch) {
        deps.markInterrupted(input.thread.id, reason);
        return;
      }
      await deps.discardUnstartedTurn({
        threadId: input.thread.id,
        reason,
        restorePrompt: input.restorePrompt ?? input.prompt,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.recordedUserActivityLineId
          ? { recordedUserActivityLineId: input.recordedUserActivityLineId }
          : {}),
        ...(input.continuation ? { continuation: true } : {}),
      });
      return;
    }
    if (decision.kind === "failed" || decision.kind === "incomplete") {
      const reason = decision.reason;
      deps.markInterrupted(
        input.thread.id,
        isAcpLoadSessionFailure(reason) ? deps.loadSessionFailedMessage(reason) : reason,
      );
      return;
    }
    await deps.applyRunDecision({
      threadId: input.thread.id,
      decision,
    });
  } catch (error) {
    const hasPendingPlan = deps.hasStoredPendingPlan(input.thread.id);
    if (hasPendingPlan) {
      deps.releasePlanBridgeKeepPending(
        input.thread.id,
        "acp disconnect fallback: run threw while plan awaits Eco approval",
      );
      await deps.applyRunDecision({
        threadId: input.thread.id,
        decision: { kind: "awaiting_plan", message: "" },
      });
      return;
    }
    const message = deps.errorMessage(error);
    const reason = isAcpLoadSessionFailure(message) ? deps.loadSessionFailedMessage(message) : message;
    if (consumeSettled) {
      deps.markInterrupted(input.thread.id, reason);
      return;
    }
    await deps.discardUnstartedTurn({
      threadId: input.thread.id,
      reason,
      restorePrompt: input.restorePrompt ?? input.prompt,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.recordedUserActivityLineId
        ? { recordedUserActivityLineId: input.recordedUserActivityLineId }
        : {}),
      ...(input.continuation ? { continuation: true } : {}),
    });
  } finally {
    await deps.finalizeCleanup(input.thread.id);
  }
}

export function cancelAcpThread(threadId: string): void {
  activeDriver.cancel(threadId);
}

/** Whether the ACP driver currently has an in-flight prompt turn for this thread. */
export function acpThreadHasInFlightTurn(threadId: string): boolean {
  return activeDriver.hasInFlightTurn(threadId);
}

/** Tear down the long-lived ACP process for a thread (delete thread / fingerprint miss). */
export function disposeAcpThread(threadId: string): void {
  activeDriver.dispose(threadId);
}

/**
 * App quit: dispose every Eco-tracked ACP connection and kill leftover managed trees.
 * Does not scan/kill other apps' Cursor ACP processes.
 */
export function stopAllAcpRuntimes(): void {
  activeDriver.disposeAll();
  killTrackedCursorAcpProcesses();
}
