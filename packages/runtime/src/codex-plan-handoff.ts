/**
 * Plan approval handoff — replaces Claude plan defer + `buildAutonomousPlanContinuationPrompt`.
 *
 * Aligns with Codex TUI `plan_implementation.rs` three choices (§6.5.3):
 *   [A] same thread → Default mode + implement prompt
 *   [B] fork / clear context → new thread with plan body
 *   [C] continue Plan → keep `plan` collaboration mode
 *
 * Phase 0: pure functions returning turn specs (no RPC).
 *
 * @see docs/codex-integration-plan.md §6.5.3
 */

import type {
  CodexCollaborationModeDraft,
  CodexSandboxPolicy,
  CodexTurnOptions,
} from "./codex-prompt-materializer.js";
import { buildCodexTurnOptions } from "./codex-prompt-materializer.js";

export type PlanHandoffChoice = "same_thread" | "fork_thread" | "continue_plan";

/** Prefix for option [B] when starting a clean-context implementation thread. */
export const PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX =
  "Implement the following approved plan in a fresh context. The plan is authoritative:\n\n";

export const PLAN_IMPLEMENT_USER_MESSAGE = "Implement the plan.";

export interface PlanHandoffInput {
  /** Parsed markdown from completed `item/plan` (or user-edited panel text). */
  planMarkdown: string;
  /** User edited plan in Eco UI before approval. */
  planUserEdited?: boolean;
  /** Optional follow-up message when continuing Plan mode refinement. */
  userFollowUp?: string;
}

export interface PlanHandoffTurnSpec {
  choice: PlanHandoffChoice;
  collaborationMode: CodexCollaborationModeDraft;
  sandboxPolicy: CodexSandboxPolicy;
  approvalPolicy: CodexTurnOptions["approvalPolicy"];
  networkAccess?: boolean;
  userMessage: string;
  /** When true, caller should `thread/fork` or `thread/start` instead of reusing the plan thread. */
  forkThread: boolean;
}

/**
 * [A] Same thread execute — switch to Default + workspace write, inject implement prompt.
 */
export function buildPlanHandoffSameThread(_input: PlanHandoffInput): PlanHandoffTurnSpec {
  const agentOptions = buildCodexTurnOptions({ sessionMode: "agent" });
  return {
    choice: "same_thread",
    collaborationMode: agentOptions.collaborationMode,
    sandboxPolicy: agentOptions.sandboxPolicy,
    approvalPolicy: agentOptions.approvalPolicy,
    ...(agentOptions.networkAccess ? { networkAccess: true } : {}),
    userMessage: PLAN_IMPLEMENT_USER_MESSAGE,
    forkThread: false,
  };
}

/**
 * [B] Clear context execute — fork/new thread with plan body as first user message.
 */
export function buildPlanHandoffForkThread(input: PlanHandoffInput): PlanHandoffTurnSpec {
  const plan = input.planMarkdown.trim();
  const agentOptions = buildCodexTurnOptions({ sessionMode: "agent" });
  const prefix = input.planUserEdited
    ? "The user edited the plan in Mori before approval. Treat the plan below as authoritative.\n\n"
    : "";

  return {
    choice: "fork_thread",
    collaborationMode: agentOptions.collaborationMode,
    sandboxPolicy: agentOptions.sandboxPolicy,
    approvalPolicy: agentOptions.approvalPolicy,
    ...(agentOptions.networkAccess ? { networkAccess: true } : {}),
    userMessage: `${PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}${prefix}${plan}`,
    forkThread: true,
  };
}

/**
 * [C] Continue Plan — keep plan collaboration mode for further refinement.
 */
export function buildPlanHandoffContinuePlan(input: PlanHandoffInput): PlanHandoffTurnSpec {
  const planOptions = buildCodexTurnOptions({ sessionMode: "plan" });
  const followUp = input.userFollowUp?.trim();
  return {
    choice: "continue_plan",
    collaborationMode: planOptions.collaborationMode,
    sandboxPolicy: planOptions.sandboxPolicy,
    approvalPolicy: planOptions.approvalPolicy,
    ...(planOptions.networkAccess ? { networkAccess: true } : {}),
    userMessage: followUp || "Please refine the plan based on my feedback.",
    forkThread: false,
  };
}

export function buildPlanHandoff(choice: PlanHandoffChoice, input: PlanHandoffInput): PlanHandoffTurnSpec {
  switch (choice) {
    case "same_thread":
      return buildPlanHandoffSameThread(input);
    case "fork_thread":
      return buildPlanHandoffForkThread(input);
    case "continue_plan":
      return buildPlanHandoffContinuePlan(input);
  }
}

/** Phase 2 hook: execute handoff will call app-server `turn/start` with this spec. */
export function planHandoffToTurnOptions(
  spec: PlanHandoffTurnSpec,
): Pick<CodexTurnOptions, "collaborationMode" | "sandboxPolicy" | "approvalPolicy" | "networkAccess"> {
  return {
    collaborationMode: spec.collaborationMode,
    sandboxPolicy: spec.sandboxPolicy,
    approvalPolicy: spec.approvalPolicy,
    ...(spec.networkAccess ? { networkAccess: true } : {}),
  };
}
