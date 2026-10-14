import type {
  BashRunCardDisplay,
  FileChangeCardDisplay,
  ToolActionLifecycle,
  WebSearchCardDisplay,
} from "../shared/activity-display";
import { isReconnectActivityMessage } from "../shared/activity-display";
import type { ContextCompactionTiming } from "../shared/context-compaction-timing";
import { type ActivityActionIcon, resolveActionKind } from "../shared/feed-action-kind";
import type { ThreadSubagentSessionTiming } from "../shared/ipc";
import {
  normalizeSubagentDisplayRole,
  resolveSubagentRunDisplayTitle as resolveSharedSubagentRunDisplayTitle,
} from "../shared/subagent-roles";
import type { GrepToolTargetDisplay, ReadToolTargetDisplay } from "../shared/tool-target";
import type { ThreadRunCodemodeMetadata } from "../shared/thread-run-events";
import type { WorktreeMergeSummary } from "../shared/worktree-merge";
import { i18n } from "./i18n";

export type { ActivityActionIcon } from "../shared/feed-action-kind";
export type { ToolActionLifecycle, WorktreeMergeSummary };
export { isReconnectActivityMessage, normalizeSubagentDisplayRole };

export function resolveSubagentRunDisplayTitle(role: string): string {
  return resolveSharedSubagentRunDisplayTitle(role, (key) => i18n.t(key));
}

export function buildSubagentTimingsByAgentId(
  sessions: readonly ThreadSubagentSessionTiming[],
): Record<string, ThreadSubagentSessionTiming> {
  const map: Record<string, ThreadSubagentSessionTiming> = {};
  for (const session of sessions) {
    map[session.agentId] = session;
  }
  return map;
}

export function buildSubagentMetricsByAgentId<T extends { agentId: string }>(
  rows: readonly T[],
): Record<string, T> {
  const map: Record<string, T> = {};
  for (const row of rows) {
    map[row.agentId] = row;
  }
  return map;
}

export type ActivityDetailBlock =
  | {
      kind: "phase";
      label: string;
      reconnecting?: boolean;
      reconnectFailed?: boolean;
      reconnectDetail?: string;
      compaction?: Partial<ContextCompactionTiming> & {
        lifecycle: "running" | "completed" | "failed";
      };
    }
  | {
      kind: "prompt-cache-timeline";
      narrative: string;
      steps: Array<{
        kind: "config_drift" | "invalidated" | "hit_dropped";
        at: string;
        label: string;
        episodeId?: string;
      }>;
    }
  | {
      kind: "subagent-mission";
      subagent: string;
      summary: string;
      prompt?: string;
      agentId?: string;
    }
  | { kind: "subagent-prompt"; text: string; subagent?: string; agentId?: string }
  | { kind: "model-request"; role?: string }
  | { kind: "agent-request"; subagent?: string; agentId?: string }
  | {
      kind: "thinking";
      text: string;
      streaming?: boolean;
      subagent?: string;
      agentId?: string;
      startedAt?: string;
      endedAt?: string;
      durationMs?: number;
    }
  | {
      /** OpenAI/Codex reasoning summary — single-line stage status (not long thinking card). */
      kind: "reasoning-stage";
      label: string;
      streaming?: boolean;
      subagent?: string;
      agentId?: string;
    }
  | { kind: "narrative"; text: string; streaming?: boolean; subagent?: string; agentId?: string }
  | {
      kind: "action";
      icon: ActivityActionIcon;
      label: string;
      lifecycle?: ToolActionLifecycle;
      toolName?: string;
      /**
       * When the tool call started — the row's own event/insertion timestamp. The live
       * elapsed display derives from it; only tool rows carry it, so its absence means
       * "not a runnable tool row" rather than "time unknown".
       */
      startedAt?: string;
      subagent?: string;
      agentId?: string;
      bashRun?: BashRunCardDisplay;
      fileChange?: FileChangeCardDisplay;
      webSearch?: WebSearchCardDisplay;
      imageView?: { path: string; eventId: string; prompt?: string };
      imageDisplay?: { artifactId: string; eventId: string; title?: string };
      htmlHost?: {
        pageId: string;
        publicUrl: string;
        eventId: string;
        title?: string;
        expiresAt?: string;
        canExtend?: boolean;
      };
      mcpDiscovery?: { kind: "search" };
      readTarget?: ReadToolTargetDisplay;
      grepTarget?: GrepToolTargetDisplay;
      /** PI `codemode`: script + script output + the calls the script made. */
      codemodeRun?: ThreadRunCodemodeMetadata;
      toolOutput?: string;
    }
  | {
      kind: "tool-failed";
      tool: string;
      command?: string;
      fileChange?: FileChangeCardDisplay | { path?: string; fileName?: string };
      error?: string;
      recoveredResult?: {
        kind: "patch-applied-verification-empty";
        files: Array<{ status: string; path: string }>;
      };
      subagent?: string;
      agentId?: string;
    }
  | {
      kind: "unknown-item";
      itemType: string;
      phase?: "started" | "completed";
      payload?: string;
      streaming?: boolean;
      subagent?: string;
      agentId?: string;
    }
  | {
      kind: "api-error";
      message: string;
      title?: string;
      statusCode?: number;
      code?: string;
      subagent?: string;
      agentId?: string;
    }
  | { kind: "worktree-merge"; summary: WorktreeMergeSummary };

function clampPreviewLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) {
    return oneLine;
  }
  return `${oneLine.slice(0, max - 1)}…`;
}

/** Single-line preview for collapsed thinking blocks. */
export function thinkingPreviewLine(text: string, max = 120): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return clampPreviewLine(plain, max);
}

/**
 * Reasoning summary label — keeps natural line breaks so the carousel can
 * rotate one stage at a time. Strips markdown markers like the preview line
 * but does not flatten whitespace. Adjacent bold stage titles (`**A****B**`)
 * become separate lines (OpenAI often emits one bold title per summary part).
 * Keeps a generous `maxLines` (default 20) as a sanity bound against
 * pathological inputs.
 */
export function reasoningSummaryLabel(text: string, maxLines = 20): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    // Separate glued bold stage titles (`**A****B**`) before stripping markers.
    .replace(/\*\*([^*]+)\*\*(?=\*\*)/g, "$1\n")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  const lines = plain.split("\n");
  if (lines.length <= maxLines) {
    return plain;
  }
  return lines.slice(-maxLines).join("\n");
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  // Sub-second (or zero) durations omit the label — avoid "已思考 0s".
  if (totalSeconds <= 0) {
    return "";
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
}

export function iconForToolName(toolName: string): ActivityActionIcon {
  return resolveActionKind({ toolName }).icon;
}
