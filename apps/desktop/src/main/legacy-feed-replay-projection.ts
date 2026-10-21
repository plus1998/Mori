import { createHash } from "node:crypto";
import { FEED_PROJECTION_MAX_AGENT_TIMELINE_ITEMS } from "../shared/conversation-v2-projection-limits";
import {
  buildSkeletonFeedProjection,
  isSkeletonUserPromptItem,
} from "../shared/conversation-v2-projection-skeleton";
import type {
  ThreadRunProjectionAgent,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
} from "../shared/ipc";

export {
  FEED_PROJECTION_MAX_AGENT_TIMELINE_ITEMS,
  FEED_PROJECTION_MAX_MAIN_TIMELINE_ITEMS,
} from "../shared/conversation-v2-projection-limits";
export { buildSkeletonFeedProjection } from "../shared/conversation-v2-projection-skeleton";

export const FEED_PROJECTION_MAX_TEXT_CHARS = 1_200;
export const FEED_PROJECTION_MAX_DELEGATION_PROMPT_CHARS = 2_000;
/** Streaming message/thinking delta preview on mobile wire (live push). */
export const FEED_STREAMING_PREVIEW_MAX_CHARS = 1_000;
/** Cap final message body on mobile wire (RPC + push) to avoid multi-MB packets. */
export const FEED_MESSAGE_FINAL_MAX_CHARS = 20_000;

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxChars), truncated: true };
}

function trimTimeline(
  items: readonly ThreadRunProjectionTimelineItem[],
  pageSize?: number,
): ThreadRunProjectionTimelineItem[] {
  const page = pageSize === undefined ? items : items.slice(-pageSize);
  return page.map(trimTimelineItemForFeed);
}

export function trimTimelineItemForFeed(
  item: ThreadRunProjectionTimelineItem,
): ThreadRunProjectionTimelineItem {
  const metadata = trimTimelineMetadata(item.metadata);
  // Streaming deltas keep cumulative text for merge-on-client, but remote wire applies a
  // separate streaming preview cap in trimProjectionForRemoteWire.
  // Finals keep a higher remote cap so long answers remain readable without multi-MB frames.
  const isMessageNarrative =
    item.eventType === "message.delta" ||
    item.eventType === "message.final" ||
    item.eventType === "thinking.delta" ||
    item.eventType === "thinking.final";
  // Active assistant deltas still need cumulative text for the live renderer;
  // thinking rows are collapsed in the Feed and only need a skeleton preview.
  // User prompts are primary dialogue content — truncating them made "展开全文"
  // scroll to a hard 1_200-char cut with no hydrate path (unlike thinking).
  const keepFullText =
    item.eventType === "message.final" ||
    item.eventType === "message.delta" ||
    isSkeletonUserPromptItem(item);
  const { text, truncated } = keepFullText
    ? { text: item.text, truncated: false }
    : truncateText(item.text, FEED_PROJECTION_MAX_TEXT_CHARS);
  const contentAvailable = isMessageNarrative && !keepFullText && item.text.length > text.length;
  const metadataChanged = metadata !== item.metadata;
  if (!truncated && !metadataChanged && !contentAvailable) {
    return item;
  }
  const nextMetadata = truncated
    ? {
        ...(metadata ?? {}),
        textTruncated: true,
      }
    : metadata;
  return {
    ...item,
    ...(truncated ? { text, summary: text } : {}),
    ...(contentAvailable ? { contentLoaded: false, contentAvailable: true } : {}),
    ...(nextMetadata ? { metadata: nextMetadata } : {}),
  };
}

function trimAgent(agent: ThreadRunProjectionAgent): ThreadRunProjectionAgent {
  const delegationPrompt = agent.delegationPrompt
    ? truncateText(agent.delegationPrompt, FEED_PROJECTION_MAX_DELEGATION_PROMPT_CHARS)
    : undefined;
  return {
    ...agent,
    timeline: trimTimeline(agent.timeline, FEED_PROJECTION_MAX_AGENT_TIMELINE_ITEMS),
    ...(delegationPrompt ? { delegationPrompt: delegationPrompt.text } : {}),
    ...(agent.latestActivity
      ? { latestActivity: truncateText(agent.latestActivity, FEED_PROJECTION_MAX_TEXT_CHARS).text }
      : {}),
  };
}

function trimTimelineMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return metadata;
  }
  const trimmedTool = trimToolMetadata(metadata.tool);
  if (trimmedTool === metadata.tool) {
    return metadata;
  }
  return {
    ...metadata,
    ...(trimmedTool ? { tool: trimmedTool } : {}),
  };
}

function trimToolMetadata(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of [
    "name",
    "detail",
    "toolUseId",
    "processId",
    "durationMs",
    "status",
    "description",
    "readTarget",
    "grepTarget",
    "imageView",
    "imageDisplay",
    "htmlHost",
    "webSearch",
    "fileChange",
    "sendMessage",
    "mcpDiscovery",
  ]) {
    if (value[key] === undefined) continue;
    // A change's header is small and the Feed draws it live; its diff preview is the
    // unbounded part and is what the detail feed exists to fetch. Keeping the preview
    // here put a whole diff into every live update.
    output[key] = key === "fileChange" ? trimFileChange(value[key]) : value[key];
  }
  return output;
}

function trimFileChange(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { previewLines: _previewLines, ...header } = value;
  return header;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function trimProjectionForFeed(snapshot: ThreadRunProjectionSnapshot): ThreadRunProjectionSnapshot {
  const skeleton = buildSkeletonFeedProjection(snapshot);
  return {
    ...skeleton,
    timeline: trimTimeline(skeleton.timeline),
    agents: skeleton.agents.map(trimAgent),
  };
}

export function filterFeedProjectionAfterSequence(
  snapshot: ThreadRunProjectionSnapshot,
  afterSequence: number | undefined,
): ThreadRunProjectionSnapshot {
  if (afterSequence === undefined || !Number.isFinite(afterSequence)) {
    return snapshot;
  }
  return {
    ...snapshot,
    timeline: snapshot.timeline.filter((item) => item.sequence > afterSequence),
    agents: snapshot.agents.map((agent) => ({
      ...agent,
      timeline: agent.timeline.filter((item) => item.sequence > afterSequence),
    })),
  };
}

/**
 * Live `thread.run_projection_updated` payload selection.
 *
 * Clients hard-replace on `historyRevision` increase (rewrite / skeleton
 * compaction). That only works if the bump carries an authoritative full
 * skeleton — never an afterSequence delta that dropped earlier user prompts.
 */
export function selectFeedProjectionLivePayload(input: {
  feedProjection: ThreadRunProjectionSnapshot;
  previousMaxSequence: number | undefined;
  previousEmittedRevision: number | undefined;
}): {
  payload: ThreadRunProjectionSnapshot;
  forceFull: boolean;
  nextEmittedRevision: number;
} {
  const nextEmittedRevision = input.feedProjection.historyRevision ?? 0;
  // Missing cursor = first emit for this thread (or after rewrite reset).
  // Revision change = skeleton compaction / rewrite — clients hard-replace.
  const forceFull =
    input.previousEmittedRevision === undefined || nextEmittedRevision !== input.previousEmittedRevision;
  if (forceFull) {
    return {
      payload: input.feedProjection,
      forceFull: true,
      nextEmittedRevision,
    };
  }
  return {
    payload: filterFeedProjectionAfterSequence(input.feedProjection, input.previousMaxSequence),
    forceFull: false,
    nextEmittedRevision,
  };
}

export function filterFeedProjectionForClient(
  snapshot: ThreadRunProjectionSnapshot,
  cursor: { afterSequence?: number; historyRevision?: number },
): ThreadRunProjectionSnapshot {
  if (cursor.historyRevision !== undefined && cursor.historyRevision !== (snapshot.historyRevision ?? 0)) {
    return snapshot;
  }
  return filterFeedProjectionAfterSequence(snapshot, cursor.afterSequence);
}

export function maxFeedProjectionTimelineSequence(snapshot: ThreadRunProjectionSnapshot): number | undefined {
  let maxSequence: number | undefined;
  for (const timeline of [snapshot.timeline, ...snapshot.agents.map((agent) => agent.timeline)]) {
    for (const item of timeline) {
      if (maxSequence === undefined || item.sequence > maxSequence) {
        maxSequence = item.sequence;
      }
    }
  }
  return maxSequence;
}

export function buildFeedProjectionSignature(snapshot: ThreadRunProjectionSnapshot): string {
  const feed = trimProjectionForFeed(snapshot);
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      thread: {
        ...feed.thread,
        generatedAt: undefined,
      },
      attempts: feed.attempts,
      requestSpans: feed.requestSpans,
      sourceEventCount: feed.sourceEventCount,
      historyRevision: feed.historyRevision,
      agents: feed.agents.map((agent) => {
        const isActive = agent.status === "active" || agent.status === "launching";
        return {
          ...agent,
          timeline: undefined,
          ...(isActive ? { durationMs: undefined } : {}),
        };
      }),
    }),
  );
  appendTimelineSignature(hash, feed.timeline);
  for (const agent of feed.agents) {
    hash.update(agent.agentId);
    appendTimelineSignature(hash, agent.timeline);
  }
  return hash.digest("hex");
}

function appendTimelineSignature(
  hash: ReturnType<typeof createHash>,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): void {
  for (const item of timeline) {
    hash.update("\0");
    hash.update(item.id);
    hash.update("\0");
    hash.update(String(item.sequence));
    hash.update("\0");
    hash.update(item.eventType);
    hash.update("\0");
    hash.update(item.text);
    hash.update("\0");
    hash.update(JSON.stringify(item.metadata ?? null));
  }
}

function streamKeyForItem(item: ThreadRunProjectionTimelineItem): string {
  if (typeof item.streamKey === "string" && item.streamKey.trim()) {
    return item.streamKey;
  }
  // Prefer timeline id so distinct messages are not collapsed when streamKey is absent.
  return item.id;
}

function isStreamingDeltaType(eventType: string): boolean {
  return eventType === "message.delta" || eventType === "thinking.delta";
}

function isFinalNarrativeType(eventType: string): boolean {
  return eventType === "message.final" || eventType === "thinking.final";
}

function collapseStreamingDeltaTimeline(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  const latestDeltaByStream = new Map<string, ThreadRunProjectionTimelineItem>();
  const kept: ThreadRunProjectionTimelineItem[] = [];
  for (const item of timeline) {
    if (!isStreamingDeltaType(item.eventType)) {
      kept.push(item);
      continue;
    }
    const key = streamKeyForItem(item);
    const previous = latestDeltaByStream.get(key);
    if (!previous || item.sequence >= previous.sequence) {
      latestDeltaByStream.set(key, item);
    }
  }
  for (const item of latestDeltaByStream.values()) {
    kept.push(item);
  }
  return kept;
}

function capTimelineTextForRemoteWire(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  options: { streaming: boolean },
): ThreadRunProjectionTimelineItem[] {
  return timeline.map((item) => {
    if (isStreamingDeltaType(item.eventType)) {
      const { text, truncated } = truncateText(item.text, FEED_STREAMING_PREVIEW_MAX_CHARS);
      if (!truncated) return item;
      return {
        ...item,
        text,
        metadata: { ...(item.metadata ?? {}), textTruncated: true },
      };
    }
    if (isFinalNarrativeType(item.eventType)) {
      // Final output is always visible in the Feed. Do not silently truncate it;
      // only collapsed process content is represented by a summary.
      return item;
    }
    if (options.streaming) {
      return item;
    }
    return item;
  });
}

function slimAgentForRemoteWire(
  agent: ThreadRunProjectionAgent,
  options: { streaming: boolean },
): ThreadRunProjectionAgent {
  let timeline = agent.timeline;
  if (options.streaming) {
    timeline = collapseStreamingDeltaTimeline(timeline);
  }
  timeline = capTimelineTextForRemoteWire(timeline, options);
  return {
    ...agent,
    ...(agent.latestActivity
      ? { latestActivity: truncateText(agent.latestActivity, FEED_PROJECTION_MAX_TEXT_CHARS).text }
      : {}),
    ...(agent.delegationPrompt
      ? {
          delegationPrompt: truncateText(agent.delegationPrompt, FEED_PROJECTION_MAX_DELEGATION_PROMPT_CHARS)
            .text,
        }
      : {}),
    timeline,
  };
}

/**
 * Shrink projection payloads for Mobile wire (live push + feed RPC).
 * Does not affect desktop local renderer projection builds before this step.
 */
export function trimProjectionForRemoteWire(
  snapshot: ThreadRunProjectionSnapshot,
  options: { streaming?: boolean } = {},
): ThreadRunProjectionSnapshot {
  const streaming = options.streaming === true;
  let timeline = snapshot.timeline;
  if (streaming) {
    timeline = collapseStreamingDeltaTimeline(timeline);
  }
  timeline = capTimelineTextForRemoteWire(timeline, { streaming });

  return {
    thread: snapshot.thread,
    attempts: snapshot.attempts,
    // Drops diagnostics and requestSpans from the remote envelope — UI that needs
    // them must load via desktop or a detail RPC later.
    requestSpans: [],
    diagnostics: [],
    timeline,
    agents: snapshot.agents.map((agent) => slimAgentForRemoteWire(agent, { streaming })),
    sourceEventCount: snapshot.sourceEventCount,
    ...(snapshot.hasEarlier ? { hasEarlier: true } : {}),
    ...(snapshot.historyRevision !== undefined ? { historyRevision: snapshot.historyRevision } : {}),
  };
}
