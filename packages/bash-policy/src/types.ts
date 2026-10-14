import type { ApprovalRiskLevel } from "../../shared/src";

export type BashReviewMode = "always" | "auto" | "allow_all";

export type BashPolicyAction = "allow" | "ask" | "deny";

export interface CommandSegment {
  program: string;
  flags: string[];
  args: string[];
  targets: string[];
  raw: string;
  hasHeredoc?: boolean;
}

export interface PipelineNode {
  stages: CommandSegment[];
  raw: string;
}

export interface CompoundSegment {
  pipelines: PipelineNode[];
  raw: string;
}

export interface ShellAst {
  compounds: CompoundSegment[];
}

export interface CommandDenyRule {
  targets?: string[];
  flags?: string[];
  args?: string[];
}

export interface CommandScoreWhenRule {
  flagsContain?: string[];
  argsContain?: string[];
  targetsContain?: string[];
  score: number;
}

export interface CommandRule {
  deny?: CommandDenyRule[];
  score?: number;
  scoreWhen?: CommandScoreWhenRule[];
}

export interface PipelineRule {
  pattern: string[];
  score: number;
}

export interface BashPolicyRules {
  commands: Record<string, CommandRule>;
  pipelines: PipelineRule[];
  workspace: {
    reviewOutsideCwd: boolean;
  };
}

export interface AgentBashPolicy {
  enabled?: boolean;
}

export interface BashPolicyInput {
  command: string;
  cwd: string;
  workspacePath: string;
  mode: BashReviewMode;
  agentBash?: AgentBashPolicy;
}

export interface BashPolicyDecision {
  action: BashPolicyAction;
  riskScore: number;
  riskLevel: ApprovalRiskLevel;
  reason: string;
  matchedRule?: string;
}

export interface DenyMatch {
  reason: string;
  matchedRule: string;
}
