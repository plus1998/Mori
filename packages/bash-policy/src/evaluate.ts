import { matchBashAntiBypass } from "./anti-bypass";
import { collectCommandSegments, parseShellCommand } from "./parser";
import { isInsidePath } from "./path-utils";
import { DEFAULT_BASH_POLICY_RULES } from "./rules/default";
import { matchDeny } from "./rules/match";
import { AUTO_APPROVAL_SCORE_THRESHOLD, riskLevelFromScore, scoreShellAst } from "./scorer";
import type { BashPolicyDecision, BashPolicyInput, BashPolicyRules, BashReviewMode, ShellAst } from "./types";

function evaluateBashHardDenyCore(
  input: Omit<BashPolicyInput, "mode">,
  rules: BashPolicyRules = DEFAULT_BASH_POLICY_RULES,
): BashPolicyDecision | undefined {
  const command = input.command.trim();
  if (!command) {
    return denyDecision(100, "Empty command is not allowed", "empty_command");
  }

  const antiBypass = matchBashAntiBypass(command);
  if (antiBypass) {
    return denyDecision(100, antiBypass.reason, antiBypass.matchedRule);
  }

  const agentBash = input.agentBash;
  if (agentBash?.enabled === false) {
    return denyDecision(100, "Bash is disabled for this Eco agent.", "bash_disabled");
  }

  const ast = parseShellCommand(command);
  const denyMatch = matchDeny(ast, rules);
  if (denyMatch) {
    return denyDecision(100, denyMatch.reason, denyMatch.matchedRule);
  }

  return undefined;
}

/** Hard deny checks only (profile, allow/denylist, cwd, global deny rules). No risk scoring. */
export function evaluateBashHardDeny(
  input: Omit<BashPolicyInput, "mode">,
  rules: BashPolicyRules = DEFAULT_BASH_POLICY_RULES,
): BashPolicyDecision | undefined {
  return evaluateBashHardDenyCore(input, rules);
}

export function evaluateBashPolicy(
  input: BashPolicyInput,
  rules: BashPolicyRules = DEFAULT_BASH_POLICY_RULES,
): BashPolicyDecision {
  const hardDeny = evaluateBashHardDenyCore(input, rules);
  if (hardDeny) {
    return hardDeny;
  }

  const ast = parseShellCommand(input.command.trim());
  const outsideWorkspace = rules.workspace.reviewOutsideCwd && !isInsidePath(input.cwd, input.workspacePath);
  const riskScore = Math.max(scoreShellAst(ast, rules), outsideWorkspace ? 50 : 0);
  const riskLevel = riskLevelFromScore(riskScore);
  return decideByMode(
    input.mode,
    riskScore,
    riskLevel,
    outsideWorkspace
      ? {
          reason: "Command cwd is outside the workspace; review the actual action",
          matchedRule: "cwd_outside_workspace",
        }
      : resolveAutoAskReason(ast),
  );
}

function decideByMode(
  mode: BashReviewMode,
  riskScore: number,
  riskLevel: BashPolicyDecision["riskLevel"],
  autoAskReason?: { reason: string; matchedRule: string },
): BashPolicyDecision {
  if (mode === "allow_all") {
    return {
      action: "allow",
      riskScore,
      riskLevel,
      reason: "Command is allowed by allow_all mode",
    };
  }

  if (mode === "auto") {
    if (autoAskReason || riskScore > AUTO_APPROVAL_SCORE_THRESHOLD) {
      return {
        action: "ask",
        riskScore,
        riskLevel,
        reason:
          autoAskReason?.reason ??
          `Command risk score ${riskScore} exceeds threshold ${AUTO_APPROVAL_SCORE_THRESHOLD}`,
        matchedRule: autoAskReason?.matchedRule ?? "auto_threshold",
      };
    }
    return {
      action: "allow",
      riskScore,
      riskLevel,
      reason: "Command is within auto-approval risk threshold",
    };
  }

  return {
    action: "ask",
    riskScore,
    riskLevel,
    reason: "Bash requires user confirmation in always review mode",
    matchedRule: "always_mode",
  };
}

function resolveAutoAskReason(ast: ShellAst): { reason: string; matchedRule: string } | undefined {
  for (const segment of collectCommandSegments(ast)) {
    const program = segment.program.split("/").pop() ?? segment.program;
    if (program === "rm") {
      return { reason: "File deletion requires approval", matchedRule: "file_deletion" };
    }
    if (program === "git" && segment.args.some((arg) => ["rm", "reset", "clean", "restore"].includes(arg))) {
      return {
        reason: "Git deletion or rollback requires review of recoverability",
        matchedRule: "git_mutation",
      };
    }
  }
  return undefined;
}

function denyDecision(score: number, reason: string, matchedRule: string): BashPolicyDecision {
  return {
    action: "deny",
    riskScore: score,
    riskLevel: riskLevelFromScore(score),
    reason,
    matchedRule,
  };
}
