import {
  clarificationHistoryRows,
  readClarificationHistoryContent,
  parseClarificationAnswersSummary,
  type ClarificationHistoryRow,
} from "./clarification-history";
import { isMainAgentRole, normalizeAgentRole } from "@eco/shared";
import { ReadAloudButton, useReadAloudAutoRead } from "./ReadAloud";
import { isSubagentMissionEnvelope, resolveMissionDisplayText } from "@eco/runtime/agent-mission";
import { isSkillActivityLabel } from "@eco/runtime/skill-display";
import {
  isReadToolName,
  resolveGrepTargetFromToolInput,
  resolveReadTargetFromToolInput,
} from "@eco/runtime/tool-target";
import {
  formatCostUsd,
  formatRoleModelLabel,
  formatTokenCount,
  formatUsageBadge,
  shortenModelId,
} from "@eco/runtime/usage";
import type {
  ConversationDetailItem,
  ConversationMessage,
  ConversationMessageOrigin,
  ConversationRun,
  ConversationToolCall,
} from "@eco/shared";
import { isConversationMessageOrigin } from "@eco/shared";
import {
  AppWindow,
  ArrowDownToLine,
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  CircleHelp,
  Clock3,
  Code,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Gauge,
  GitFork,
  Globe2,
  Image as ImageIcon,
  Images,
  LoaderCircle,
  Minimize2,
  Monitor,
  PanelRight,
  Pencil,
  RefreshCw,
  Reply,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Volume2,
  Wrench,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  Fragment,
  type KeyboardEvent,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  activityLabelIncludesAgentRole,
  clampActivityPreviewLine,
  formatToolDisplayLabel,
  type ToolActionLifecycle,
} from "../shared/activity-display";
import {
  formatCodexAsyncQuestionReplySummary,
  parseCodexAsyncQuestionReplyText,
} from "../shared/codex-async-questions";
import {
  CONVERSATION_RUNTIME_EVENT_FAILURE_ORIGIN,
  CONVERSATION_RUNTIME_EVENT_FAILURE_ROLE,
  CONVERSATION_RUNTIME_EVENT_FAILURE_TITLE,
} from "../shared/conversation-runtime-event-failure";
import {
  type ActionGroupBucket,
  type ActionKindPayload,
  formatActionLine,
  type ResolvedAction,
  resolveActionKind,
  summarizeActionGroup,
} from "../shared/feed-action-kind";
import { resolveFileChangeFromToolInput } from "../shared/file-change";
import { isEcoImageDisplayToolName } from "../shared/image-display-tool";
import { isEcoImageGenerationToolName } from "../shared/image-generation";
import { isEcoWebSearchToolName } from "../shared/integrated-web-search";
import type {
  PromptImageAttachment,
  ThreadActivityRewindTarget,
  ThreadBillingSnapshot,
  ThreadContextSnapshot,
  ThreadContinueResult,
  ThreadRunProjectionAgent,
  ThreadRunProjectionAttempt,
  ThreadRunProjectionDetailKind,
  ThreadRunProjectionRequestSpan,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
  ThreadSubagentMetricsSummary,
  ThreadSubagentSessionTiming,
  ThreadSummary,
  ThreadUsageSnapshot,
  ThreadUserMessageEditGetResult,
} from "../shared/ipc";
import { type PromptImagePreview, readPromptImagePreviews } from "../shared/prompt-image-metadata";
import { attachOutputTokensToRequestSpans } from "../shared/request-span-usage";
import { isAgentDisplayRole, normalizeAgentDisplayRole } from "../shared/subagent-roles";
import { resolveSubagentActivityTitle } from "../shared/subagent-task-name";
import { supportsHistoryRewrite } from "../shared/thread-request-retry";
import {
  isContextCompactionEventType,
  parseThreadRunCodemodeMetadata,
  type ThreadRunCodemodeCallMetadata,
  type ThreadRunCodemodeMetadata,
} from "../shared/thread-run-events";
import { isCodemodeToolName, resolveCodemodeMetadata } from "../shared/thread-run-tool-projection";
import { parseWorktreeMergeMessage } from "../shared/worktree-merge";
import {
  type ActivityFeedLayoutChange,
  ActivityFeedLayoutContext,
  useActivityFeedLayoutChange,
} from "./activity-feed-layout-context";
import {
  type ActivityActionIcon,
  type ActivityDetailBlock,
  formatDuration,
  iconForToolName,
  resolveSubagentRunDisplayTitle,
  thinkingPreviewLine,
} from "./activity-log";
import { dispatchBrowserLinkOpen, isHttpishHref, openPublishedHtmlInBrowser } from "./browser-link";
import { copyTextToClipboard } from "./clipboard";
import { COMPOSER_MAX_IMAGES, readImageFileAsAttachment } from "./composer-attachments";
import {
  advanceComposerAgentSilenceClock,
  COMPOSER_FLOATING_LOADING_DELAY_MS,
  type ComposerAgentSilenceClock,
  isComposerAgentSilent,
  resolveComposerAgentSilenceDelayMs,
} from "./composer-floating-loading";
import {
  buildThreadRunProjectionViewModel,
  collapseConsecutiveThinkingTimelineItems,
  filterProjectionTimelineForDetailFeed,
  isProjectionRequestActive,
  isProjectionSubagentPromptItem,
  isProjectionUserPromptItem,
  isThreadConversationStopped,
  projectionItemToDetailBlock,
  readProjectionAgentDelegation,
  readProjectionToolMetadata,
  resolveProjectionAgentStatusText,
  type ThreadRunProjectionAgentEchoFeedEntry,
  type ThreadRunProjectionMainFeedEntry,
  type ThreadRunProjectionTimelineFeedEntry,
  type ThreadRunProjectionToolGroupFeedEntry,
} from "./conversation-v2-projection-view";
import { FeedTextContextMenu, type FeedTextContextMenuAnchor } from "./FeedTextContextMenu";
import {
  type ConversationV2RendererState,
  orderedConversationV2Messages,
} from "./conversation-v2-renderer-state";
import { buildThreadRunTurnFeedSections, type ThreadRunTurnFeedSection } from "./conversation-v2-turn-feed";
import { FeedErrorCard } from "./FeedErrorCard";
import { FeedStatusDivider } from "./FeedStatusDivider";
import { resolveFeedPaceTargetKey } from "./feed-pace-target";
import {
  FEED_VIRTUALIZE_MIN_SECTIONS,
  FeedVirtualSectionWindow,
  FeedVirtualUserMessageSentinels,
  listUserMessageAnchorsFromSections,
  useFeedSectionVirtualizer,
} from "./feed-virtual-sections";
import { i18n } from "./i18n";
import { ICON_SIZE, ICON_STROKE } from "./icon-metrics";
import { ImageLightbox } from "./image-lightbox";
import { createImageObjectUrlFromBase64, revokeImageObjectUrl } from "./image-object-url";
import { imageViewAnalysisPanel } from "./image-view-analysis-panel";
import { releaseMermaidModule } from "./prosemirror/mermaid-block";
import { buildRequestFailureRetryTargets, type RequestFailureRetryTarget } from "./request-failure-retry";
import { type RuntimeAgentDisplayNames, resolveRuntimeAgentName } from "./runtime-agent-display";
import { type RuntimeAgentThemes, resolveSubagentRowThemeStyle } from "./runtime-agent-theme";
import { StreamingMarkdownContent } from "./StreamingMarkdownContent";
import { RequestSpansContext, TokenSpeedBadge } from "./TokenSpeedBadge";
import { readTtsToolUseId, TtsFeedArtifacts } from "./TtsArtifactPlayer";
import {
  findThinkingFeedScrollRoot,
  isThinkingPreferenceDrivenExpand,
  resolveThinkingCollapseHoldMs,
  resolveThinkingExpanded,
  resolveThinkingLayoutNotifyOptions,
  shouldEagerMountThinkingBody,
  THINKING_COLLAPSE_ANIM_MS,
} from "./thinking-block-expand";
import { resolveThinkingCarouselIndex, THINKING_CAROUSEL_STAGE_MS } from "./thinking-carousel";
import {
  readStoredThinkingDisplayPreferences,
  type ThinkingDisplayMode,
  thinkingModeDefaultExpanded,
} from "./thinking-display-preferences";
import { resolveToolWritingIndicator, resolveToolWritingLabel } from "./tool-writing-indicator";
import { UserPromptBodyContent } from "./UserPromptBodyContent";
import { WorkspaceChangesCard } from "./WorkspaceChangesCard";

type ForkMessageHandler = (input: {
  activityLineId: string;
  expectedHistoryRevision: number;
}) => Promise<void>;

type RestorePromptHandler = (prompt: string, rewindTarget?: ThreadActivityRewindTarget) => void;
type LoadUserMessageEditHandler = (activityLineId: string) => Promise<ThreadUserMessageEditGetResult>;
type RetryFailedRequestHandler = (target: RequestFailureRetryTarget) => void | Promise<void>;
type RewriteUserMessageHandler = (input: {
  activityLineId: string;
  prompt: string;
  attachments: PromptImageAttachment[];
  expectedHistoryRevision: number;
}) => Promise<ThreadContinueResult>;
type OpenSubagentHandler = (agentId: string) => void;
type OpenImageGenerationToolHandler = (toolUseId: string) => void;
type OpenImageDisplayToolHandler = (toolUseId: string) => void;
type OpenImageDisplayArtifactHandler = (artifactId: string) => void;
type ProjectionDetailLoader = (kind: ThreadRunProjectionDetailKind, key: string) => Promise<void>;
type ProjectionRequestSpan = ThreadRunProjectionSnapshot["requestSpans"][number];
type ProjectionRequestSpansById = Map<string, ProjectionRequestSpan>;
type ToolGroupDetailBlock = Extract<ActivityDetailBlock, { kind: "action" | "tool-failed" }>;

const SUBAGENT_DETAIL_STICK_THRESHOLD_PX = 96;
const SUBAGENT_DETAIL_USER_SCROLL_DELTA_PX = 2;
const LIVE_DURATION_TICK_MS = 1_000;
const TOOL_RUNNING_MIN_VISIBLE_MS = 1_000;
/**
 * 工具行的耗时只在调用已运行超过该阈值后才显示：更短的工具在数字变得有意义之前
 * 就已经结束了（快工具走 TOOL_RUNNING_MIN_VISIBLE_MS 的最小可见窗口，不会出现闪烁）。
 */
const TOOL_ELAPSED_MIN_VISIBLE_MS = 3_000;

function distanceFromBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

function readRewindTarget(value: unknown): ThreadActivityRewindTarget | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const target = value as Partial<ThreadActivityRewindTarget>;
  const activityLineId = typeof target.activityLineId === "string" ? target.activityLineId.trim() : "";
  const userMessageId = typeof target.userMessageId === "string" ? target.userMessageId.trim() : "";
  if (!activityLineId) {
    return undefined;
  }
  return userMessageId ? { activityLineId, userMessageId } : { activityLineId };
}

function readProjectionRewindTarget(
  item: ThreadRunProjectionTimelineItem,
): ThreadActivityRewindTarget | undefined {
  return readRewindTarget(item.metadata?.rewindTarget);
}

const runLogMessageTimes = new Map<string, { label: string; title: string; dateTime: string }>();
const runLogTimeFormatters = new Map<string, { label: Intl.DateTimeFormat; title: Intl.DateTimeFormat }>();

function formatRunLogMessageTime(
  value?: string,
): { label: string; title: string; dateTime: string } | undefined {
  if (!value) {
    return undefined;
  }
  const locale = i18n.resolvedLanguage;
  const key = `${locale ?? ""}:${value}`;
  const cached = runLogMessageTimes.get(key);
  if (cached) return cached;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  let formatters = runLogTimeFormatters.get(locale ?? "");
  if (!formatters) {
    formatters = {
      label: new Intl.DateTimeFormat(locale, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
      title: new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    };
    runLogTimeFormatters.set(locale ?? "", formatters);
  }
  const formatted = {
    label: formatters.label.format(date),
    title: formatters.title.format(date),
    dateTime: value,
  };
  if (runLogMessageTimes.size >= 512) {
    const oldest = runLogMessageTimes.keys().next();
    if (!oldest.done) runLogMessageTimes.delete(oldest.value);
  }
  runLogMessageTimes.set(key, formatted);
  return formatted;
}

function copyRunLogMessageText(text: string): void {
  void copyTextToClipboard(text);
}

function scrollBashOutputFromCommand(event: WheelEvent<HTMLDivElement>): void {
  const output = event.currentTarget
    .closest(".run-log-bash-terminal")
    ?.querySelector<HTMLElement>(".run-log-bash-output-wrap");
  if (!output || event.deltaY === 0) {
    return;
  }
  const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? output.clientHeight : 1;
  const deltaY = event.deltaY * multiplier;
  const maxScrollTop = Math.max(0, output.scrollHeight - output.clientHeight);
  const nextScrollTop = Math.min(maxScrollTop, Math.max(0, output.scrollTop + deltaY));
  if (nextScrollTop === output.scrollTop) {
    return;
  }
  output.scrollTop = nextScrollTop;
  event.preventDefault();
  event.stopPropagation();
}

type MessageForkAction = {
  activityLineId: string;
  expectedHistoryRevision: number;
  onFork: ForkMessageHandler;
  disabledReason?: string;
};

function MessageForkButton({
  activityLineId,
  expectedHistoryRevision,
  onFork,
  disabledReason,
}: MessageForkAction) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <>
      <button
        type="button"
        className="run-log-message-meta-button run-log-fork-button"
        disabled={saving || Boolean(disabledReason)}
        aria-label={i18n.t("activity.fork")}
        title={disabledReason ?? i18n.t("activity.forkTitle")}
        onClick={() => {
          if (saving || disabledReason) return;
          setSaving(true);
          setError(undefined);
          void onFork({ activityLineId, expectedHistoryRevision })
            .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
            .finally(() => setSaving(false));
        }}
      >
        {saving ? <LoaderCircle size={13} className="spin" /> : <GitFork size={13} />}
      </button>
      {error ? (
        <span role="alert" className="run-log-user-prompt-edit-error">
          {error}
        </span>
      ) : null}
    </>
  );
}

function RunLogMessageMeta({
  createdAt,
  copyText,
  readAloud,
  restorePrompt,
  editUserMessage,
  align = "start",
  sticky = false,
  trailing,
  forkAction,
}: {
  createdAt?: string;
  copyText?: string;
  readAloud?: { entryId: string; sourceText: string };
  restorePrompt?: {
    text: string;
    rewindTarget: ThreadActivityRewindTarget;
    onRestorePrompt: RestorePromptHandler;
  };
  editUserMessage?: {
    onEdit: () => void;
    disabled?: boolean;
  };
  align?: "start" | "end";
  sticky?: boolean;
  /** Extra content after the timestamp (e.g. token speed). */
  trailing?: ReactNode;
  forkAction?: MessageForkAction;
}) {
  const time = formatRunLogMessageTime(createdAt);
  const canCopy = Boolean(copyText?.trim());
  if (!time && !canCopy && !restorePrompt && !editUserMessage && !trailing && !forkAction) {
    return null;
  }

  return (
    <div
      className={[
        "run-log-message-meta",
        align === "end" ? "run-log-message-meta--end" : "run-log-message-meta--start",
        sticky ? "run-log-message-meta--sticky" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {restorePrompt ? (
        <button
          type="button"
          className="run-log-message-meta-button"
          onClick={() => restorePrompt.onRestorePrompt(restorePrompt.text, restorePrompt.rewindTarget)}
          aria-label={i18n.t("activity.rewind")}
          title={i18n.t("activity.rewindTitle")}
        >
          <Reply size={13} />
        </button>
      ) : null}
      {editUserMessage ? (
        <button
          type="button"
          className="run-log-message-meta-button"
          onClick={editUserMessage.onEdit}
          aria-label={i18n.t("activity.editMessage", {
            defaultValue: "编辑消息",
          })}
          title={i18n.t("activity.editMessageTitle", {
            defaultValue: "编辑消息并从此处继续",
          })}
          disabled={editUserMessage.disabled}
        >
          <Pencil size={13} />
        </button>
      ) : null}
      {canCopy ? (
        <button
          type="button"
          className="run-log-message-meta-button"
          onClick={() => copyRunLogMessageText(copyText ?? "")}
          aria-label={i18n.t("activity.copyMessage")}
          title={i18n.t("activity.copyMessage")}
        >
          <Copy size={13} />
        </button>
      ) : null}
      {readAloud ? <ReadAloudButton {...readAloud} /> : null}
      {forkAction ? <MessageForkButton {...forkAction} /> : null}
      {time ? (
        <time className="run-log-message-meta-time" dateTime={time.dateTime} title={time.title}>
          {time.label}
        </time>
      ) : null}
      {trailing ?? null}
    </div>
  );
}
function shouldOmitSubagentIdentity(block: ActivityDetailBlock, hideSubagentIdentity?: boolean): boolean {
  if (!hideSubagentIdentity) {
    return false;
  }
  if (block.kind === "model-request") {
    return isAgentDisplayRole(block.role);
  }
  if (block.kind === "phase" || block.kind === "thinking" || block.kind === "reasoning-stage") {
    return false;
  }
  if ("subagent" in block && block.subagent) {
    return isAgentDisplayRole(block.subagent);
  }
  return false;
}

function usePlannerLayoutChangeEffect(
  layoutSignature: string,
  onPlannerLayoutChange?: ActivityFeedLayoutChange,
) {
  const onPlannerLayoutChangeRef = useRef(onPlannerLayoutChange);
  onPlannerLayoutChangeRef.current = onPlannerLayoutChange;

  useLayoutEffect(() => {
    onPlannerLayoutChangeRef.current?.();
  }, [layoutSignature]);
}

/**
 * Report whether the Feed has gone quiet mid-run so the Composer can float its own
 * "still working" dots. The clock lives here rather than in the Composer because the
 * signature it measures is the Feed's: `layoutSignature` changes exactly when a rendered
 * row's visible text or tool lifecycle changes, and holds still while the agent writes a
 * tool call nothing renders yet. See `composer-floating-loading.ts`.
 */
function useComposerAgentSilenceEffect(
  input: { active: boolean; feedIndicatorVisible: boolean; signature: string },
  onComposerAgentSilenceChange?: (silent: boolean) => void,
) {
  const onComposerAgentSilenceChangeRef = useRef(onComposerAgentSilenceChange);
  onComposerAgentSilenceChangeRef.current = onComposerAgentSilenceChange;
  const clockRef = useRef<ComposerAgentSilenceClock | undefined>(undefined);
  // Every streamed token re-runs the effect below. Reporting only on a change keeps a
  // live turn from pushing a state update into the app on each one.
  const reportedRef = useRef(false);
  const report = useCallback((silent: boolean) => {
    if (reportedRef.current === silent) {
      return;
    }
    reportedRef.current = silent;
    onComposerAgentSilenceChangeRef.current?.(silent);
  }, []);
  const { active, feedIndicatorVisible, signature } = input;

  useEffect(() => {
    const nowMs = Date.now();
    const clock = advanceComposerAgentSilenceClock(clockRef.current, signature, nowMs);
    clockRef.current = clock;
    const emit = () => {
      report(isComposerAgentSilent({ active, feedIndicatorVisible, clock, nowMs: Date.now() }));
    };
    emit();
    if (!active || feedIndicatorVisible) {
      return;
    }
    // Re-armed by every change of the signature, so one timer for the delay's remainder
    // is enough: the only way this clock advances is a new signature.
    const timer = window.setTimeout(emit, resolveComposerAgentSilenceDelayMs(clock, nowMs));
    return () => window.clearTimeout(timer);
  }, [active, feedIndicatorVisible, report, signature]);

  // A Feed that unmounts mid-gap must take the indicator with it. Its cleanups run before
  // the replacing Feed's effects, so this cannot clear a report the new one has made.
  useEffect(
    () => () => {
      if (!reportedRef.current) {
        return;
      }
      reportedRef.current = false;
      onComposerAgentSilenceChangeRef.current?.(false);
    },
    [],
  );
}

function isThreadStoppedForFinalSummary(status: string): boolean {
  return isThreadConversationStopped(status);
}

/**
 * The thread summary and the feed projection arrive through separate live
 * updates.  A terminal summary is authoritative for the activity tail: keep
 * an older active projection from resurrecting a waiting indicator after the
 * thread has already completed.
 */
export function reconcileActivityProjectionThreadStatus(
  projection: ThreadRunProjectionSnapshot,
  thread?: Pick<ThreadSummary, "status">,
): ThreadRunProjectionSnapshot {
  // `idle` is also the V2 projection's provisional status while its message rows have
  // arrived but the corresponding run row has not. In that window the thread summary is
  // the live source and must be allowed to restore `running`; terminal projection states
  // remain authoritative so an old active thread summary cannot resurrect a finished run.
  if (
    !thread ||
    (isThreadStoppedForFinalSummary(projection.thread.status) && projection.thread.status !== "idle")
  ) {
    return projection;
  }
  if (thread.status === projection.thread.status) {
    return projection;
  }
  return {
    ...projection,
    thread: {
      ...projection.thread,
      status: thread.status,
    },
  };
}

function resolveTurnFinalSummaryItemIds(
  entries: readonly ThreadRunProjectionMainFeedEntry[],
  threadStatus: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  let latestSummaryId: string | undefined;

  const commitTurn = () => {
    if (latestSummaryId) {
      ids.add(latestSummaryId);
      latestSummaryId = undefined;
    }
  };

  for (const entry of entries) {
    if (entry.kind !== "timeline") {
      continue;
    }
    if (isProjectionUserPromptItem(entry.item)) {
      commitTurn();
      continue;
    }
    if (entry.item.eventType !== "message.final") {
      continue;
    }
    const block = projectionItemToDetailBlock(entry.item);
    if (block?.kind === "narrative" && !block.streaming && block.text.trim()) {
      latestSummaryId = entry.item.id;
    }
  }

  if (isThreadStoppedForFinalSummary(threadStatus)) {
    commitTurn();
  }
  return ids;
}

/** Stand-in row for the live 「正在思考」/「正在写」 line, appended to the Feed's sections. */
const ACTIVE_TAIL_FEED_SECTION = {
  kind: "active-tail",
  key: "run-log:active-tail",
} as const satisfies ThreadRunTurnFeedSection;

export interface ActivityLogViewProps {
  thread?: ThreadSummary;
  onRestorePrompt?: RestorePromptHandler;
  onLoadUserMessageEdit?: LoadUserMessageEditHandler;
  onRewriteUserMessage?: RewriteUserMessageHandler;
  onForkMessage?: ForkMessageHandler;
  onRetryFailedRequest?: RetryFailedRequestHandler;
  onSwitchCodexAccount?: () => void;
  onOpenChatGptSubscriptionAccounts?: (accountId?: string) => void;
  modelByRole?: Record<string, string>;
  usageByRole?: Record<string, ThreadUsageSnapshot>;
  context?: ThreadContextSnapshot;
  billing?: ThreadBillingSnapshot;
  conversationV2?: ConversationV2RendererState;
  /** The host's projection of the same V2 state, shared with its navigator/panels. */
  conversationV2Projection?: ThreadRunProjectionSnapshot;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
  subagentTimings?: ThreadSubagentSessionTiming[];
  subagentMetrics?: ThreadSubagentMetricsSummary[];
  selectedSubagentAgentId?: string;
  onOpenSubagent?: OpenSubagentHandler;
  onOpenImageGenerationTool?: OpenImageGenerationToolHandler;
  onOpenImageDisplayTool?: OpenImageDisplayToolHandler;
  onOpenImageDisplayArtifact?: OpenImageDisplayArtifactHandler;
  /** Called when planner / main-window log content changes — scroll the activity feed. */
  onPlannerLayoutChange?: ActivityFeedLayoutChange;
  /**
   * Reports whether the Feed renders virtualized rows. An end-anchored
   * virtualizer pins the live tail inside virtual-core; the host must then keep
   * its hands off `scrollTop` for content growth, because a second writer on
   * the same property re-derives the virtual window on every stream tick.
   */
  onFeedEndAnchorChange?: (endAnchored: boolean) => void;
  feedUserDetached?: boolean;
  /**
   * Called when the Feed has gone quiet mid-run: the agent is alive but has produced
   * nothing visible for {@link COMPOSER_FLOATING_LOADING_DELAY_MS}, which is the gap while
   * it writes its next tool call. The Composer floats its loading dots on `true`.
   */
  onComposerAgentSilenceChange?: (silent: boolean) => void;
  onLoadProjectionDetail?: ProjectionDetailLoader;
  thinkingDisplayMode?: ThinkingDisplayMode;
}

function conversationV2MessageToTimelineItem(
  message: ConversationMessage,
  at: string,
): ThreadRunProjectionTimelineItem {
  const isThinking = message.channel === "thinking";
  // A subagent's narration belongs to that agent's transcript, not to the main
  // Feed. The message carries the same agent identity its tool rows do, so the merge
  // routes it to the agent card when one exists. The default `scope` stays `main`:
  // without a card to hold the content (the V2-only projection has no agents, or an
  // orphan agent id) the legacy projection reclaims the row for the main Feed rather
  // than hiding it.
  const agentId = message.agentId?.trim() || undefined;
  // A system-channel row is a notice the provider reported (a failed request), not the
  // agent's speech: the Feed renders that distinction — the legacy chain's `api.error` row
  // is what carries the failure text and the retry affordance — so the row keeps the event
  // type the reader and the retry logic look for instead of being flattened into a message.
  const isNotice = message.channel === "system" && !isThinking;
  const isDiagnostic = message.role === "system" && message.channel === "commentary";
  return {
    id: `conversation-v2:${message.messageId}`,
    sequence: message.createdSeq,
    eventType: isNotice
      ? "api.error"
      : isDiagnostic
        ? "diagnostic"
        : isThinking
          ? message.status === "streaming"
            ? "thinking.delta"
            : "thinking.final"
          : message.status === "streaming"
            ? "message.delta"
            : "message.final",
    scope: "main",
    // The Feed asks the row's role who wrote it (`role === "main"` marks a turn's
    // final output) and normalizing it to the channel role left V2 unable to answer.
    // The provider's own label is carried on the row; the channel role is the fallback
    // for rows written before it was recorded.
    role: normalizeAgentRole(message.providerRole?.trim() || (isThinking ? "thinking" : message.role)),
    ...(agentId ? { agentId } : {}),
    ...(message.runId ? { runAttemptId: message.runId } : {}),
    streamKey: message.messageId,
    text: message.body,
    summary: message.body,
    contentLoaded: true,
    contentAvailable: true,
    at,
    metadata: {
      conversationV2MessageId: message.messageId,
      ...(isThinking && message.startedAt ? { thinkingStartedAt: message.startedAt } : {}),
      conversationV2TurnId: message.turnId,
      conversationV2VersionSeq: message.versionSeq,
      conversationV2ContentVersion: message.contentVersion,
      conversationV2Channel: message.channel,
      conversationV2Status: message.status,
      ...(message.origin ? { messageOrigin: message.origin } : {}),
      ...(isNotice && message.providerRole === CONVERSATION_RUNTIME_EVENT_FAILURE_ROLE
        ? {
            activityOrigin: CONVERSATION_RUNTIME_EVENT_FAILURE_ORIGIN,
            apiError: { title: CONVERSATION_RUNTIME_EVENT_FAILURE_TITLE, message: message.body },
          }
        : {}),
      ...(message.agentInstanceId ? { conversationV2AgentInstanceId: message.agentInstanceId } : {}),
      // The row's own stream key is the message id, which names the logical entity the row
      // is: the read model upserts a stream's deltas into one message, so one message is one
      // visible row. Without this the display layer cannot tell two messages of the same
      // request apart and collapses them into one (keeping only the newest), which is how a
      // request's earlier reasoning blocks disappeared from the Feed once request spans were
      // present.
      logicalEntityId: message.messageId,
      ...(message.role === "user" && { liveType: "thread.user_prompt" }),
      ...(message.role === "user" && message.historyTarget ? { rewindTarget: message.historyTarget } : {}),
      ...(message.role === "user" && message.attachments?.length
        ? { promptImagePreviews: message.attachments }
        : {}),
    },
  } satisfies ThreadRunProjectionTimelineItem;
}

/**
 * `message.accepted` is the durable receipt written when a follow-up is queued.
 * It must stay out of the conversation feed until the runtime finalizes it;
 * the queue panel is the only UI that represents this pending user message.
 */
function isQueuedConversationV2UserMessage(message: ConversationMessage): boolean {
  return message.role === "user" && message.status === "queued";
}

function isDeferredAcceptedConversationV2Message(message: ConversationMessage): boolean {
  return message.role === "user" && message.versionSeq > message.createdSeq;
}

function readConversationV2MessageId(item: ThreadRunProjectionTimelineItem): string | undefined {
  const value = item.metadata?.conversationV2MessageId;
  if (typeof value !== "string") {
    return undefined;
  }
  const messageId = value.trim();
  return messageId || undefined;
}

function isConversationV2MessageTimelineItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (
    item.eventType === "message.delta" ||
    item.eventType === "message.final" ||
    item.eventType === "thinking.delta" ||
    item.eventType === "thinking.final"
  ) {
    return true;
  }
  return (
    item.eventType === "thread.status" &&
    item.role === "user" &&
    item.metadata?.liveType === "thread.user_prompt"
  );
}

/**
 * The Feed skeleton keeps a single narrative row per finished segment, so a run's
 * other messages have no legacy row left to anchor to. Their V2 order is still
 * authoritative, so give each one a position of its own next to the nearest
 * anchored sibling of the same run: before the following sibling (counted back
 * from it, preserving order) or after the preceding one. Collapsing them onto the
 * run's first row instead made every message of a turn share one position and one
 * timestamp, which left the feed sort with nothing but the message hash to order
 * them by.
 */
function buildConversationV2RunMessagePositions(
  messages: readonly ConversationMessage[],
  anchoredByMessageId: ReadonlyMap<string, ThreadRunProjectionTimelineItem>,
  runAnchorByRunId: ReadonlyMap<string, ThreadRunProjectionTimelineItem>,
): Map<string, { anchor: ThreadRunProjectionTimelineItem; sequence: number }> | undefined {
  const messagesByRun = new Map<string, ConversationMessage[]>();
  for (const message of messages) {
    const runId = message.runId?.trim();
    if (!runId) continue;
    const siblings = messagesByRun.get(runId);
    if (siblings) {
      siblings.push(message);
    } else {
      messagesByRun.set(runId, [message]);
    }
  }
  if (messagesByRun.size === 0) {
    return undefined;
  }
  const positions = new Map<string, { anchor: ThreadRunProjectionTimelineItem; sequence: number }>();
  for (const [runId, siblings] of messagesByRun) {
    const siblingAnchors = siblings.map((message) => anchoredByMessageId.get(message.messageId));
    const runAnchor = runAnchorByRunId.get(runId);
    for (let index = 0; index < siblings.length; index += 1) {
      const message = siblings[index];
      if (!message || siblingAnchors[index]) continue;
      let previousIndex = -1;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (siblingAnchors[cursor]) {
          previousIndex = cursor;
          break;
        }
      }
      let nextIndex = -1;
      for (let cursor = index + 1; cursor < siblings.length; cursor += 1) {
        if (siblingAnchors[cursor]) {
          nextIndex = cursor;
          break;
        }
      }
      const previousAnchor = previousIndex >= 0 ? siblingAnchors[previousIndex] : undefined;
      const nextAnchor = nextIndex >= 0 ? siblingAnchors[nextIndex] : undefined;
      if (nextAnchor) {
        // Count back from the following sibling. The clamp only matters when the
        // two anchored siblings sit less than one sequence step apart.
        const before = nextAnchor.sequence - (nextIndex - index);
        positions.set(message.messageId, {
          anchor: nextAnchor,
          sequence: previousAnchor ? Math.max(previousAnchor.sequence + 1, before) : before,
        });
        continue;
      }
      if (previousAnchor) {
        positions.set(message.messageId, {
          anchor: previousAnchor,
          sequence: previousAnchor.sequence + (index - previousIndex),
        });
        continue;
      }
      if (runAnchor) {
        // No message of this run survived the skeleton: keep V2 order and sit the
        // group just above the run row the feed still shows.
        positions.set(message.messageId, {
          anchor: runAnchor,
          sequence: runAnchor.sequence - (siblings.length - index),
        });
      }
    }
  }
  return positions;
}

/**
 * Builds the Feed projection from V2 alone.
 *
 * This is the read path the V2 migration ends on: messages, runs, tools and agents
 * all come from the V2 read models, so no legacy row has to exist for a turn to
 * render. It is also the counterpart the differential tests compare the legacy
 * projection against — anything the Feed shows that this function cannot produce is
 * a V2 gap, not a legacy feature.
 */
export function buildConversationV2OnlyProjection(
  conversationV2: Pick<
    ConversationV2RendererState,
    | "conversationId"
    | "messages"
    | "runs"
    | "agents"
    | "tools"
    | "details"
    | "projectionExtras"
    | "historyRevision"
  >,
  thread?: Pick<ThreadSummary, "createdAt" | "status">,
): ThreadRunProjectionSnapshot {
  const at = thread?.createdAt ?? "1970-01-01T00:00:00.000Z";
  const runs = [...conversationV2.runs.values()].sort((left, right) => left.versionSeq - right.versionSeq);
  const attempts: ThreadRunProjectionAttempt[] = runs.map((run) => ({
    attemptId: run.runId,
    phase: "execution",
    retryIndex: run.retryOfRunId ? 1 : 0,
    status: conversationV2RunStatusToAttemptStatus(run.status),
    startedAt: run.startedAt ?? at,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
  }));
  const attemptById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));

  const sortedTools = [...conversationV2.tools.values()].sort(
    (left, right) => left.createdSeq - right.createdSeq || left.toolCallId.localeCompare(right.toolCallId),
  );
  const toolsByOwner = new Map<string, ConversationToolCall[]>();
  const unownedTools: ConversationToolCall[] = [];
  for (const tool of sortedTools) {
    const agentId = tool.agentId?.trim();
    if (!agentId) {
      unownedTools.push(tool);
      continue;
    }
    const owned = toolsByOwner.get(agentId) ?? [];
    owned.push(tool);
    toolsByOwner.set(agentId, owned);
  }
  const registry = new Map([...conversationV2.agents.values()].map((agent) => [agent.agentId, agent]));
  // Owner ids also identify auxiliary requests (for example image_view errors).
  // Only a durable agent record establishes an agent lifecycle and warrants a card.
  // Who gets a card, and therefore who owns rows. The Feed draws a card for a subagent,
  // and a row belongs to the main feed unless its owner is one — a planner instance is the
  // attempt's own main agent, whose messages and tools are the conversation itself. An
  // owner the registry does not know is not promoted into a card here either: the legacy
  // chain learns its agents from their lifecycle rows, and a row whose owner never
  // announced itself is a main-feed row, not a card invented from an id (invariant 14:
  // content is shown, never hidden behind a card no agent record backs).
  const cardAgentIds = new Set<string>(
    [...registry.values()].filter((agent) => agent.kind === "subagent").map((agent) => agent.agentId),
  );
  // Rows whose owner is not a card owner stay in the main feed, so the split happens here
  // once rather than at each use.
  const toolsByAgent = new Map<string, ConversationToolCall[]>();
  const mainTools: ConversationToolCall[] = [...unownedTools];
  for (const [agentId, owned] of toolsByOwner) {
    if (cardAgentIds.has(agentId)) {
      toolsByAgent.set(agentId, owned);
      continue;
    }
    mainTools.push(...owned);
  }

  const messagesByAgent = new Map<string, ThreadRunProjectionTimelineItem[]>();
  const mainTimeline: ThreadRunProjectionTimelineItem[] = [];
  for (const message of orderedConversationV2Messages(conversationV2)) {
    // `message.accepted` is the durable acknowledgement of a user send. The
    // queue panel owns this row until the runtime finalizes it; otherwise the
    // same prompt would be rendered twice.
    if (isQueuedConversationV2UserMessage(message)) {
      continue;
    }
    const ownerAgentId = message.agentId?.trim();
    const agentId = ownerAgentId && cardAgentIds.has(ownerAgentId) ? ownerAgentId : undefined;
    const item = conversationV2MessageToTimelineItem(message, message.occurredAt ?? at);
    if (!agentId) {
      mainTimeline.push(item);
      continue;
    }
    item.scope = "agent";
    const owned = messagesByAgent.get(agentId) ?? [];
    owned.push(item);
    messagesByAgent.set(agentId, owned);
  }
  for (const tool of mainTools) {
    const attempt = attemptById.get(tool.runId);
    mainTimeline.push(
      conversationV2ToolToTimelineItem(
        tool,
        // The row carries when the call happened; the run window is only a fallback
        // for rows written before the read model recorded it. Using the run window for
        // everything collapses a turn's rows onto one instant, which is what puts every
        // tool after every message and splits one turn into several.
        tool.occurredAt ?? attempt?.endedAt ?? attempt?.startedAt ?? at,
        tool.createdSeq,
      ),
    );
  }

  const clarificationRequests = new Map(
    [...conversationV2.details.values()]
      .filter(detail => detail.type === "clarification.requested" && detail.toolCallId)
      .map(detail => [detail.toolCallId!, detail]),
  );
  for (const detail of conversationV2.details.values()) {
    const item = isContextCompactionEventType(detail.type)
      ? conversationV2CompactionToTimelineItem(detail)
      : detail.type === "clarification.requested" || detail.type === "clarification.resolved"
        ? conversationV2ClarificationToTimelineItem(detail, conversationV2, detail.toolCallId ? clarificationRequests.get(detail.toolCallId) : undefined)
        : undefined;
    if (!item) continue;
    const agentId = detail.agentId && cardAgentIds.has(detail.agentId) ? detail.agentId : undefined;
    if (agentId) {
      item.scope = "agent";
      const owned = messagesByAgent.get(agentId) ?? [];
      owned.push(item);
      messagesByAgent.set(agentId, owned);
    } else {
      item.scope = "main";
      mainTimeline.push(item);
    }
  }

  const agents: ThreadRunProjectionAgent[] = [];
  for (const [agentId, record] of registry) {
    const ownedTools = toolsByAgent.get(agentId) ?? [];
    const ownedMessages = messagesByAgent.get(agentId) ?? [];
    const timeline = [
      ...ownedTools.map((tool) => {
        const attempt = attemptById.get(tool.runId);
        return conversationV2ToolToTimelineItem(
          tool,
          tool.occurredAt ?? attempt?.endedAt ?? attempt?.startedAt ?? at,
          tool.createdSeq,
          true,
        );
      }),
      ...ownedMessages,
    ].sort(compareConversationV2TimelinePosition);
    const startedAt = record?.startedAt ?? at;
    const endedAt = record?.endedAt;
    const activity = latestAgentActivity(timeline);
    const durationMs = endedAt
      ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
      : Math.max(0, Date.now() - Date.parse(startedAt));
    agents.push({
      agentId,
      role: record.role,
      kind: isMainAgentRole(record.kind) ? "main" : "subagent",
      status: agentProjectionStatus(record.status),
      startedAt,
      durationMs,
      ...(record?.runId ? { runAttemptId: record.runId } : {}),
      ...(record?.parentAgentInstanceId ? { parentAgentId: record.parentAgentInstanceId } : {}),
      ...(record?.parentToolCallId ? { parentToolUseId: record.parentToolCallId } : {}),
      ...(record?.mission !== undefined ? { mission: record.mission } : {}),
      // The card's own text: the provider's task name labels it and the delegation is
      // the line under it. Both used to reach the card straight from the legacy instance
      // row; without them a V2 card shows a bare role.
      ...(record?.taskName ? { taskName: record.taskName } : {}),
      ...(record?.delegationSummary ? { delegationSummary: record.delegationSummary } : {}),
      ...(record?.delegationPrompt ? { delegationPrompt: record.delegationPrompt } : {}),
      ...(record?.todoId ? { todoId: record.todoId } : {}),
      ...(endedAt ? { endedAt } : {}),
      ...(activity ? { latestActivity: activity } : {}),
      timeline,
    });
  }
  agents.sort((left, right) => left.agentId.localeCompare(right.agentId));

  mainTimeline.sort(compareConversationV2TimelinePosition);
  const runningAttemptId = attempts.find((attempt) => attempt.status === "running")?.attemptId;
  const running = runningAttemptId !== undefined;
  return {
    thread: {
      threadId: conversationV2.conversationId,
      status: running ? "running" : thread?.status && attempts.length === 0 ? thread.status : "idle",
      generatedAt: at,
      ...(running && runningAttemptId ? { currentAttemptId: runningAttemptId } : {}),
    },
    attempts,
    agents,
    requestSpans: attachOutputTokensToRequestSpans(
      conversationV2.projectionExtras?.requestSpans ?? [],
      conversationV2.projectionExtras?.ledgerEvents ?? [],
    ),
    timeline: mainTimeline,
    diagnostics: [],
    sourceEventCount:
      conversationV2.messages.size +
      conversationV2.runs.size +
      conversationV2.tools.size +
      conversationV2.details.size,
    historyRevision: conversationV2.historyRevision,
    ...(conversationV2.projectionExtras?.billing ? { billing: conversationV2.projectionExtras.billing } : {}),
    ...(conversationV2.projectionExtras?.context ? { context: conversationV2.projectionExtras.context } : {}),
    ...(conversationV2.projectionExtras?.subagentTimings
      ? { subagentTimings: conversationV2.projectionExtras.subagentTimings }
      : {}),
    ...(conversationV2.projectionExtras?.subagentMetrics
      ? { subagentMetrics: conversationV2.projectionExtras.subagentMetrics }
      : {}),
  };
}

function conversationV2ClarificationToTimelineItem(
  detail: ConversationDetailItem,
  state: Pick<ConversationV2RendererState, "tools" | "runs">,
  recordedRequest?: ConversationDetailItem,
): ThreadRunProjectionTimelineItem | undefined {
  const content = readClarificationHistoryContent(detail);
  const resolved = detail.type === "clarification.resolved";
  const request = resolved ? recordedRequest : detail;
  const rows = clarificationHistoryRows(
    request ? readClarificationHistoryContent(request) : undefined,
    resolved ? content : undefined,
  );
  // Submission receipts are not answers. Only recorded questions/answers form a card.
  if (rows.length === 0) return undefined;
  const tool = detail.toolCallId ? state.tools.get(detail.toolCallId) : undefined;
  return {
    id: detail.itemId,
    sequence: detail.createdSeq,
    eventType: "message.final",
    scope: "main",
    role: "main",
    text: resolved && typeof content.message === "string"
      ? content.message : rows.map(row => row.question).join("\n"),
    at: tool?.occurredAt ?? state.runs.get(detail.runId)?.startedAt ?? "1970-01-01T00:00:00.000Z",
    runAttemptId: detail.runId,
    ...(detail.agentId ? { agentId: detail.agentId } : {}),
    metadata: {
      liveType: resolved ? "clarification.answered" : "clarification.requested",
      clarificationRows: rows,
      ...(detail.toolCallId ? {
        tool: { name: "AskUserQuestion", toolUseId: detail.toolCallId, status: resolved ? "completed" : "started" },
      } : {}),
    },
  };
}

function conversationV2CompactionToTimelineItem(
  detail: ConversationDetailItem,
): ThreadRunProjectionTimelineItem {
  const content = JSON.parse(detail.content ?? "null");
  if (
    !isContextCompactionEventType(detail.type) ||
    !content ||
    typeof content.message !== "string" ||
    typeof content.observedAt !== "string"
  ) {
    throw new Error(`Conversation V2 compaction detail ${detail.itemId} is invalid.`);
  }
  return {
    id: detail.itemId,
    sequence: detail.createdSeq,
    eventType: detail.type,
    scope: "main",
    text: content.message,
    at: content.observedAt,
    runAttemptId: detail.runId,
    ...(detail.agentId ? { agentId: detail.agentId } : {}),
    ...(typeof content.role === "string" ? { role: content.role } : {}),
    ...(typeof content.requestId === "string" ? { requestId: content.requestId } : {}),
    ...(typeof content.streamKey === "string" ? { streamKey: content.streamKey } : {}),
    ...(content.metadata || content.timing
      ? {
          metadata: {
            ...content.metadata,
            ...(content.timing ? { compactionTiming: content.timing } : {}),
          },
        }
      : {}),
  };
}

function agentProjectionStatus(status: string | undefined): ThreadRunProjectionAgent["status"] {
  switch (status) {
    case "completed":
    case "stopped":
      return "stopped";
    case "failed":
    case "cancelled":
    case "interrupted":
    case "abandoned":
      return "abandoned";
    case undefined:
      return "active";
    default:
      return "active";
  }
}

function latestAgentActivity(timeline: readonly ThreadRunProjectionTimelineItem[]): string | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const text = timeline[index]?.text.trim();
    if (text) return text;
  }
  return undefined;
}

function isTerminalAttemptStatus(status: ThreadRunProjectionAttempt["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function conversationV2RunStatusToAttemptStatus(
  status: ConversationRun["status"],
): ThreadRunProjectionAttempt["status"] {
  switch (status) {
    case "queued":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "unknown":
      return "cancelled";
  }
}

function conversationV2ToolEventType(
  status: ConversationToolCall["status"],
): "tool.started" | "tool.completed" | "tool.failed" {
  switch (status) {
    case "started":
    case "running":
      return "tool.started";
    case "completed":
      return "tool.completed";
    case "failed":
    case "cancelled":
      return "tool.failed";
  }
}

function conversationV2ToolProjectionStatus(
  status: ConversationToolCall["status"],
): "started" | "running" | "completed" | "failed" {
  return status === "cancelled" ? "failed" : status;
}

function conversationV2ToolInputRecord(tool: ConversationToolCall): Record<string, unknown> {
  const input = isRecord(tool.input) ? tool.input : {};
  const argumentsValue = isRecord(input.arguments) ? input.arguments : {};
  const webSearchValue = isRecord(input.webSearch) ? input.webSearch : {};
  return { ...input, ...argumentsValue, ...webSearchValue };
}

function conversationV2ToolText(
  values: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function conversationV2ToolValue(
  values: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = values[key];
  return isRecord(value) ? value : undefined;
}

function conversationV2ToolPreview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text?.trim()) return undefined;
  return text.length <= 4000 ? text : `${text.slice(0, 4000)}…`;
}

function conversationV2ToolPresentation(tool: ConversationToolCall): {
  detail?: string;
  outputPreview?: string;
  metadata: Record<string, unknown>;
} {
  const values = conversationV2ToolInputRecord(tool);
  const detail = conversationV2ToolText(values, [
    "command",
    "cmd",
    "script",
    "file_path",
    "filePath",
    "path",
    "query",
    "url",
    "pattern",
    "detail",
    "description",
  ]);
  const outputPreview = conversationV2ToolPreview(tool.output);
  const presentation: Record<string, unknown> = {
    name: tool.name,
    toolUseId: tool.toolCallId,
  };
  if (detail) presentation.detail = detail;
  if (outputPreview) presentation.outputPreview = outputPreview;

  const description = conversationV2ToolText(values, ["description"]);
  if (description) presentation.description = description;
  for (const key of [
    "imageDisplay",
    "htmlHost",
    "mcpDiscovery",
    "sendMessage",
    "processId",
    "nonExecutionKind",
    "bashApproval",
    "clarification",
    "planApproval",
  ]) {
    const value = values[key];
    if (value !== undefined) presentation[key] = value;
  }

  const readTarget =
    conversationV2ToolValue(values, "readTarget") ??
    (isReadToolName(tool.name) ? resolveReadTargetFromToolInput(tool.name, values) : undefined);
  if (readTarget) presentation.readTarget = readTarget;
  const grepTarget =
    conversationV2ToolValue(values, "grepTarget") ?? resolveGrepTargetFromToolInput(tool.name, values);
  if (grepTarget) presentation.grepTarget = grepTarget;
  const fileChange =
    conversationV2ToolValue(values, "fileChange") ?? resolveFileChangeFromToolInput(tool.name, values);
  if (fileChange) presentation.fileChange = fileChange;

  const rawWebSearch = conversationV2ToolValue(values, "webSearch");
  if (
    rawWebSearch ||
    tool.name === "WebSearch" ||
    tool.name === "WebFetch" ||
    isEcoWebSearchToolName(tool.name)
  ) {
    const webSearch = rawWebSearch ?? {};
    presentation.webSearch = {
      ...webSearch,
      ...(typeof values.query === "string" && { query: values.query }),
      ...(typeof values.url === "string" && { url: values.url }),
      ...(typeof values.pattern === "string" && { pattern: values.pattern }),
      ...(typeof values.actionType === "string" && {
        actionType: values.actionType,
      }),
      ...(typeof values.mode === "string" && { mode: values.mode }),
      ...(Array.isArray(values.queries) && { queries: values.queries }),
      ...(typeof values.provider === "string" && { provider: values.provider }),
      ...(Array.isArray(values.results) && { results: values.results }),
    };
  }

  const rawImageView = conversationV2ToolValue(values, "imageView");
  const imagePath = conversationV2ToolText(values, ["path", "file_path", "filePath"]);
  if (rawImageView || (imagePath && (tool.name === "view_image" || tool.name === "ViewImage"))) {
    presentation.imageView = rawImageView ?? { path: imagePath };
  }

  // PI's codemode: the script is the call and its return value is what the model saw, so both
  // belong on the row. Without them the row can only ever read "执行了工具".
  const codemode = mergeCodemodeMetadata(
    resolveCodemodeMetadata({
      name: tool.name,
      callInput: values,
      output: typeof tool.output === "string" ? tool.output : (outputPreview ?? ""),
    }),
    // PI's nested calls and full-output path are stored on the row itself: the tool table has no
    // column for them, so they ride inside `input`.
    parseThreadRunCodemodeMetadata(conversationV2ToolValue(values, "codemode")),
  );
  if (codemode) presentation.codemode = codemode;

  return {
    ...(detail ? { detail } : {}),
    ...(outputPreview ? { outputPreview } : {}),
    metadata: presentation,
  };
}

/**
 * The rows a subagent card shows, through the same filters the card applies: this is the
 * definition of "what the card says", in the order it says it.
 */
export function subagentCardVisibleRows(
  agent: ThreadRunProjectionAgent,
  options: {
    missionText?: string;
    requestSpansById?: ReadonlyMap<string, unknown>;
    thinkingDisplayMode?: ThinkingDisplayMode;
  } = {},
): ThreadRunProjectionTimelineItem[] {
  const delegation = readProjectionAgentDelegation(agent);
  const missionDisplay = resolveMissionDisplayText(
    options.missionText || delegation?.prompt || delegation?.summary || "",
  );
  const prepared = filterSubagentDetailTimelineNoise(agent.timeline);
  const collapsed = filterProjectionTimelineForDetailFeed(
    prepared,
    options.requestSpansById as never,
    true,
    options.thinkingDisplayMode,
    agent.status === "active" || agent.status === "launching",
  ).filter((item) => !shouldSuppressSubagentCardTimelineItem(item, missionDisplay));
  return collapseConsecutiveThinkingTimelineItems(collapsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function conversationV2ToolToTimelineItem(
  tool: ConversationToolCall,
  at: string,
  sequence = tool.createdSeq,
  agentScope = false,
): ThreadRunProjectionTimelineItem {
  const eventType = conversationV2ToolEventType(tool.status);
  const presentation = conversationV2ToolPresentation(tool);
  const agentId = tool.agentId?.trim() || undefined;
  return {
    id: `conversation-v2:tool:${tool.toolCallId}`,
    sequence,
    eventType,
    scope: agentScope ? "agent" : "main",
    // Same as a message row: the legacy chain reports the provider's own label for a
    // tool row (`tool` for the main agent, `coder`/`explore` inside a subagent).
    role: tool.providerRole?.trim() || "tool",
    ...(agentId ? { agentId } : {}),
    runAttemptId: tool.runId,
    text: presentation.detail ? `Tool: ${tool.name} · ${presentation.detail}` : `Tool: ${tool.name}`,
    summary: tool.name,
    contentLoaded: true,
    contentAvailable: true,
    at,
    metadata: {
      liveType: eventType,
      conversationV2ToolCallId: tool.toolCallId,
      conversationV2VersionSeq: tool.versionSeq,
      ...(tool.agentInstanceId ? { conversationV2AgentInstanceId: tool.agentInstanceId } : {}),
      ...(tool.parentAgentInstanceId
        ? { conversationV2ParentAgentInstanceId: tool.parentAgentInstanceId }
        : {}),
      ...(tool.parentToolCallId ? { conversationV2ParentToolCallId: tool.parentToolCallId } : {}),
      tool: {
        ...presentation.metadata,
        status: conversationV2ToolProjectionStatus(tool.status),
      },
      ...(presentation.metadata.bashApproval ? { bashApproval: presentation.metadata.bashApproval } : {}),
    },
  };
}

/**
 * Two copies of one script's metadata reach the Feed from different places: the live tool event
 * carries PI's nested calls and the full-output path, while a persisted conversationV2 row rebuilds
 * only the script and its output from `input`/`output`. Union them by field so neither reader drops
 * what the other has.
 */
function mergeCodemodeMetadata(
  existing: ThreadRunCodemodeMetadata | undefined,
  incoming: ThreadRunCodemodeMetadata | undefined,
): ThreadRunCodemodeMetadata | undefined {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  const longerText = (left: string | undefined, right: string | undefined): string | undefined =>
    (left?.length ?? 0) >= (right?.length ?? 0) ? left : right;
  const richerCalls = (
    left: ThreadRunCodemodeMetadata["calls"],
    right: ThreadRunCodemodeMetadata["calls"],
  ) => ((left?.length ?? 0) >= (right?.length ?? 0) ? left : right);
  const script = longerText(existing.script, incoming.script);
  const output = longerText(existing.output, incoming.output);
  const fullOutputPath = existing.fullOutputPath ?? incoming.fullOutputPath;
  const calls = richerCalls(existing.calls, incoming.calls);
  return {
    ...(script ? { script } : {}),
    ...(output ? { output } : {}),
    ...(fullOutputPath ? { fullOutputPath } : {}),
    ...(calls && calls.length > 0 ? { calls } : {}),
  };
}

function mergeConversationV2ToolIntoTimelineItem(
  item: ThreadRunProjectionTimelineItem,
  tool: ConversationToolCall,
): ThreadRunProjectionTimelineItem {
  const existingTool = readProjectionToolMetadata(item);
  const presentation = conversationV2ToolPresentation(tool);
  const eventType = conversationV2ToolEventType(tool.status);
  const codemode = mergeCodemodeMetadata(
    existingTool?.codemode,
    parseThreadRunCodemodeMetadata(presentation.metadata.codemode),
  );
  return {
    ...item,
    eventType,
    ...(tool.agentId?.trim() ? { agentId: tool.agentId.trim() } : {}),
    runAttemptId: tool.runId,
    text:
      item.text.trim() ||
      (presentation.detail ? `Tool: ${tool.name} · ${presentation.detail}` : `Tool: ${tool.name}`),
    metadata: {
      ...(item.metadata ?? {}),
      liveType: eventType,
      conversationV2ToolCallId: tool.toolCallId,
      conversationV2VersionSeq: tool.versionSeq,
      ...(tool.agentInstanceId ? { conversationV2AgentInstanceId: tool.agentInstanceId } : {}),
      ...(tool.parentAgentInstanceId
        ? { conversationV2ParentAgentInstanceId: tool.parentAgentInstanceId }
        : {}),
      ...(tool.parentToolCallId ? { conversationV2ParentToolCallId: tool.parentToolCallId } : {}),
      tool: {
        ...(existingTool ?? {}),
        ...presentation.metadata,
        ...(codemode ? { codemode } : {}),
        status: conversationV2ToolProjectionStatus(tool.status),
      },
      ...(presentation.metadata.bashApproval ? { bashApproval: presentation.metadata.bashApproval } : {}),
    },
  };
}

function compareConversationV2TimelinePosition(
  left: ThreadRunProjectionTimelineItem,
  right: ThreadRunProjectionTimelineItem,
): number {
  const atDiff = left.at.localeCompare(right.at);
  if (atDiff !== 0) return atDiff;
  const sequenceDiff = left.sequence - right.sequence;
  if (sequenceDiff !== 0) return sequenceDiff;
  return left.id.localeCompare(right.id);
}

function insertConversationV2TimelineItem(
  timeline: ThreadRunProjectionTimelineItem[],
  item: ThreadRunProjectionTimelineItem,
): void {
  const index = timeline.findIndex((current) => compareConversationV2TimelinePosition(item, current) < 0);
  if (index < 0) {
    timeline.push(item);
  } else {
    timeline.splice(index, 0, item);
  }
}

function mergeConversationV2ExecutionIntoProjection(
  projection: ThreadRunProjectionSnapshot,
  conversationV2: ConversationV2RendererState,
): ThreadRunProjectionSnapshot {
  const runs = [...conversationV2.runs.values()];
  const tools = [...conversationV2.tools.values()];
  if (runs.length === 0 && tools.length === 0) {
    return projection;
  }

  const runById = new Map(runs.map((run) => [run.runId, run]));
  const attemptsById = new Map(projection.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const attempts = projection.attempts.map((attempt) => {
    const run = runById.get(attempt.attemptId);
    if (!run) return attempt;
    const runStatus = conversationV2RunStatusToAttemptStatus(run.status);
    // An attempt settles once, so two *different* terminal statuses for the same
    // run cannot both be true: the V2 run is then a stale mirror (a build that
    // closed a run when one of its tools completed left "completed in 11s"
    // behind for a turn that kept running and later failed), and the attempt
    // lifecycle record — the write model behind this projection — wins.
    if (
      isTerminalAttemptStatus(attempt.status) &&
      isTerminalAttemptStatus(runStatus) &&
      attempt.status !== runStatus
    ) {
      return attempt;
    }
    return {
      ...attempt,
      status: runStatus,
      startedAt: run.startedAt ?? attempt.startedAt,
      ...((run.endedAt ?? attempt.endedAt) ? { endedAt: run.endedAt ?? attempt.endedAt } : {}),
    };
  });
  for (const run of runs) {
    if (attemptsById.has(run.runId)) continue;
    const startedAt = run.startedAt ?? projection.thread.generatedAt;
    attempts.push({
      attemptId: run.runId,
      phase: "initial",
      retryIndex: 0,
      status: conversationV2RunStatusToAttemptStatus(run.status),
      startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    });
  }

  const legacyToolItemsById = new Map<string, ThreadRunProjectionTimelineItem[]>();
  for (const item of projection.timeline) {
    const toolUseId = readProjectionToolUseId(item);
    if (!toolUseId) continue;
    const items = legacyToolItemsById.get(toolUseId) ?? [];
    items.push(item);
    legacyToolItemsById.set(toolUseId, items);
  }
  // A V2 tool whose legacy row the feed skeleton dropped still has to land inside
  // its own turn. Without the run row there is no V2 clock to place it by (V2
  // stores no timestamps), so use what the projection knows about the attempt and
  // keep the group just after the run's surviving row instead of stamping it with
  // `generatedAt` — that piled every tool of every older turn onto the bottom of
  // the feed as extra turns in the order they happened to be read.
  const mergedAttemptById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const runRowByRunId = new Map<string, ThreadRunProjectionTimelineItem>();
  for (const item of projection.timeline) {
    const runId = item.runAttemptId?.trim();
    if (runId && !runRowByRunId.has(runId)) {
      runRowByRunId.set(runId, item);
    }
  }
  const placedToolCountByRun = new Map<string, number>();
  const timeline = projection.timeline.map((item) => item);
  const orderedTools = [...tools].sort((left, right) => left.createdSeq - right.createdSeq);
  for (const tool of orderedTools) {
    const legacyItems = legacyToolItemsById.get(tool.toolCallId);
    if (legacyItems && legacyItems.length > 0) {
      for (const legacyItem of legacyItems) {
        const index = timeline.findIndex((candidate) => candidate.id === legacyItem.id);
        const current = index >= 0 ? timeline[index] : undefined;
        if (current) {
          timeline[index] = mergeConversationV2ToolIntoTimelineItem(current, tool);
        }
      }
      continue;
    }
    if (timeline.some((item) => item.id === `conversation-v2:tool:${tool.toolCallId}`)) {
      continue;
    }
    const run = runById.get(tool.runId);
    const attempt = mergedAttemptById.get(tool.runId);
    const runRow = runRowByRunId.get(tool.runId);
    const placedCount = placedToolCountByRun.get(tool.runId) ?? 0;
    placedToolCountByRun.set(tool.runId, placedCount + 1);
    insertConversationV2TimelineItem(
      timeline,
      conversationV2ToolToTimelineItem(
        tool,
        attempt?.endedAt ??
          attempt?.startedAt ??
          run?.endedAt ??
          run?.startedAt ??
          projection.thread.generatedAt,
        (runRow?.sequence ?? tool.createdSeq) + (runRow ? placedCount + 1 : 0),
      ),
    );
  }

  const activeRun = runs.some((run) => run.status === "queued" || run.status === "running");
  const latestRun = [...runs].sort((left, right) => left.versionSeq - right.versionSeq).at(-1);
  const projectedStatus =
    activeRun || (projection.thread.status === "idle" && latestRun)
      ? activeRun
        ? "running"
        : conversationV2RunStatusToAttemptStatus(latestRun!.status)
      : projection.thread.status;
  const sourceEventCount =
    runs.length > 0 || tools.length > 0
      ? Math.max(projection.sourceEventCount, timeline.length, 1)
      : projection.sourceEventCount;

  const activeRunId = activeRun
    ? runs.find((run) => run.status === "running" || run.status === "queued")?.runId
    : undefined;
  return {
    ...projection,
    thread: {
      ...projection.thread,
      status: projectedStatus,
      ...(activeRunId && !projection.thread.currentAttemptId ? { currentAttemptId: activeRunId } : {}),
    },
    attempts,
    timeline,
    sourceEventCount,
    historyRevision: Math.max(projection.historyRevision ?? 0, conversationV2.historyRevision),
  };
}

export function mergeConversationV2IntoProjection(
  projection: ThreadRunProjectionSnapshot,
  conversationV2?: ConversationV2RendererState,
): ThreadRunProjectionSnapshot {
  if (!conversationV2 || conversationV2.conversationId !== projection.thread.threadId) {
    return projection;
  }
  const withMessages = mergeConversationV2MessagesIntoProjection(projection, conversationV2);
  return mergeConversationV2ExecutionIntoProjection(withMessages, conversationV2);
}

export function mergeConversationV2MessagesIntoProjection(
  projection: ThreadRunProjectionSnapshot,
  conversationV2?: ConversationV2RendererState,
): ThreadRunProjectionSnapshot {
  if (!conversationV2 || conversationV2.conversationId !== projection.thread.threadId) {
    return projection;
  }
  const messages = orderedConversationV2Messages(conversationV2).filter(
    (message) => !isQueuedConversationV2UserMessage(message),
  );
  const v2MessageIds = new Set(conversationV2.messages.keys());
  if (messages.length === 0 && v2MessageIds.size === 0) {
    return projection;
  }
  const legacyV2Anchors = new Map<string, ThreadRunProjectionTimelineItem>();
  for (const item of projection.timeline) {
    if (!isConversationV2MessageTimelineItem(item)) {
      continue;
    }
    const messageId = readConversationV2MessageId(item);
    if (messageId && !legacyV2Anchors.has(messageId)) {
      legacyV2Anchors.set(messageId, item);
    }
  }
  const canonicalItems = new Map<string, ThreadRunProjectionTimelineItem>();
  const canonicalPositionAnchors = new Map<string, ThreadRunProjectionTimelineItem>();
  // V2 messages of a subagent belong to that agent's transcript. The legacy
  // projection kept them off the main timeline by scope; merged V2 rows have to be
  // routed the same way, otherwise a subagent's narration shows up in the main Feed.
  const knownAgentIds = new Set(
    projection.agents.map((agent) => agent.agentId.trim()).filter((agentId) => agentId.length > 0),
  );
  const agentTimelineAdditions = new Map<string, ThreadRunProjectionTimelineItem[]>();
  const runAnchorByRunId = new Map<string, ThreadRunProjectionTimelineItem>();
  for (const item of projection.timeline) {
    const runId = item.runAttemptId?.trim();
    if (runId && !runAnchorByRunId.has(runId)) {
      runAnchorByRunId.set(runId, item);
    }
  }
  const runMessagePositions = buildConversationV2RunMessagePositions(
    messages,
    legacyV2Anchors,
    runAnchorByRunId,
  );
  for (const message of messages) {
    // A queued acceptance was recorded before the preceding turn completed.
    // Do not reuse that early legacy anchor after finalization.
    const explicitAnchor = isDeferredAcceptedConversationV2Message(message)
      ? undefined
      : legacyV2Anchors.get(message.messageId);
    const runPosition = explicitAnchor ? undefined : runMessagePositions?.get(message.messageId);
    const fallbackAnchor =
      explicitAnchor ??
      (isDeferredAcceptedConversationV2Message(message)
        ? undefined
        : message.role === "user"
          ? projection.timeline.find(
              (item) =>
                isConversationV2MessageTimelineItem(item) &&
                item.role !== "user" &&
                item.sequence >= message.createdSeq,
            )
          : undefined);
    const anchor = explicitAnchor ?? runPosition?.anchor ?? fallbackAnchor;
    const item = conversationV2MessageToTimelineItem(message, anchor?.at ?? projection.thread.generatedAt);
    if (anchor) {
      // V2 owns the body/version, while the explicit legacy identity (or the
      // sibling-relative offset) preserves the original position in the
      // transitional mixed projection.
      item.sequence = runPosition?.sequence ?? anchor.sequence;
    }
    const ownerAgentId = item.agentId?.trim();
    if (ownerAgentId && knownAgentIds.has(ownerAgentId)) {
      item.scope = "agent";
      const items = agentTimelineAdditions.get(ownerAgentId) ?? [];
      items.push(item);
      agentTimelineAdditions.set(ownerAgentId, items);
      continue;
    }
    canonicalItems.set(message.messageId, item);
    if (anchor) {
      canonicalPositionAnchors.set(message.messageId, anchor);
    }
  }
  const legacyTimeline = projection.timeline.filter((item) => {
    if (!isConversationV2MessageTimelineItem(item)) {
      return true;
    }
    const legacyV2MessageId = item.metadata?.conversationV2MessageId;
    if (typeof legacyV2MessageId === "string" && v2MessageIds.has(legacyV2MessageId.trim())) {
      return false;
    }
    return true;
  });
  const existingV2MessageIds = new Set(
    projection.timeline
      .filter((item) => item.id.startsWith("conversation-v2:"))
      .map(readConversationV2MessageId)
      .filter((value): value is string => Boolean(value)),
  );
  const additions = messages.filter((message) => !existingV2MessageIds.has(message.messageId));
  if (additions.length === 0 && legacyTimeline.length === projection.timeline.length) {
    return projection;
  }
  const mergedTimeline: ThreadRunProjectionTimelineItem[] = [];
  const emittedMessageIds = new Set<string>();
  for (const item of projection.timeline) {
    const messageId = readConversationV2MessageId(item);
    const canonical = messageId ? canonicalItems.get(messageId) : undefined;
    if (isConversationV2MessageTimelineItem(item) && messageId && v2MessageIds.has(messageId)) {
      if (canonical && !emittedMessageIds.has(messageId)) {
        mergedTimeline.push(canonical);
        emittedMessageIds.add(messageId);
      }
      continue;
    }
    mergedTimeline.push(item);
  }
  for (const message of additions) {
    if (emittedMessageIds.has(message.messageId)) {
      continue;
    }
    const canonical = canonicalItems.get(message.messageId);
    if (!canonical) {
      continue;
    }
    const anchor = canonicalPositionAnchors.get(message.messageId);
    const anchorIndex = anchor
      ? mergedTimeline.findIndex((item) => item.id === anchor.id)
      : mergedTimeline.findIndex((item) => item.sequence > canonical.sequence);
    if (anchorIndex >= 0) {
      mergedTimeline.splice(anchorIndex, 0, canonical);
    } else {
      mergedTimeline.push(canonical);
    }
    emittedMessageIds.add(message.messageId);
  }
  return {
    ...projection,
    timeline: mergedTimeline,
    agents: mergeConversationV2AgentTimelines(projection.agents, agentTimelineAdditions),
    sourceEventCount: projection.sourceEventCount + additions.length,
    historyRevision: Math.max(projection.historyRevision ?? 0, conversationV2.historyRevision),
  };
}

/** Appends merged V2 messages to the transcript of the agent that owns them. */
function mergeConversationV2AgentTimelines(
  agents: ThreadRunProjectionSnapshot["agents"],
  additions: ReadonlyMap<string, ThreadRunProjectionTimelineItem[]>,
): ThreadRunProjectionSnapshot["agents"] {
  if (additions.size === 0) {
    return agents;
  }
  return agents.map((agent) => {
    const extra = additions.get(agent.agentId);
    if (!extra?.length) {
      return agent;
    }
    const byId = new Map(agent.timeline.map((item) => [item.id, item]));
    for (const item of extra) {
      byId.set(item.id, item);
    }
    return {
      ...agent,
      timeline: [...byId.values()].sort(
        (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
      ),
    };
  });
}

function ProjectionFeedLoading() {
  return (
    <div className="run-log run-log-empty" role="status" aria-label={i18n.t("activity.loading")}>
      <div className="run-log-projection-loading" aria-hidden>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export const ActivityLogView = memo(function ActivityLogView(props: ActivityLogViewProps) {
  useTranslation();
  useEffect(() => {
    return () => {
      releaseMermaidModule();
    };
  }, []);
  // V2 is the only production Feed source. A missing V2 state is a bootstrap or
  // recovery condition; it must render loading/prompt UI instead of reopening the
  // retired projection path.
  const projection = useMemo(
    () =>
      props.conversationV2
        ? reconcileActivityProjectionThreadStatus(
            props.conversationV2Projection ??
              buildConversationV2OnlyProjection(props.conversationV2, props.thread),
            props.thread,
          )
        : undefined,
    [props.conversationV2, props.conversationV2Projection, props.thread?.createdAt, props.thread?.status],
  );
  if (!projection?.sourceEventCount) {
    if (props.thread?.prompt && !isThreadStoppedForFinalSummary(props.thread.status)) {
      return (
        <div className="run-log">
          {wrapRunLogFeedEntry(
            <UserPromptBlock
              text={props.thread.prompt}
              anchorId={`thread:${props.thread.id}`}
              {...(props.thread.createdAt ? { createdAt: props.thread.createdAt } : {})}
            />,
          )}
          {/* No V2 event has landed yet, so the prompt bubble is the entire feed. The
              run is already under way — keep the waiting line up rather than leaving a
              blank pane under the prompt, which is what a first send used to look like. */}
          <RunLogActiveTail stopping={Boolean(props.thread.cancelling)} />
        </div>
      );
    }
    if (props.thread?.status === "idle" && !props.thread.prompt)
      return <div className="run-log run-log-empty" />;
    return <ProjectionFeedLoading />;
  }
  return (
    <ConversationV2ProjectionActivityLogView
      projection={projection}
      {...(props.thread && { thread: props.thread })}
      {...(props.agentDisplayNames && {
        agentDisplayNames: props.agentDisplayNames,
      })}
      {...(props.agentThemes && { agentThemes: props.agentThemes })}
      {...(props.onRestorePrompt && { onRestorePrompt: props.onRestorePrompt })}
      {...(props.onLoadUserMessageEdit && {
        onLoadUserMessageEdit: props.onLoadUserMessageEdit,
      })}
      {...(props.onRewriteUserMessage && {
        onRewriteUserMessage: props.onRewriteUserMessage,
      })}
      {...(props.onForkMessage && { onForkMessage: props.onForkMessage })}
      {...(props.onRetryFailedRequest && {
        onRetryFailedRequest: props.onRetryFailedRequest,
      })}
      {...(props.onSwitchCodexAccount && { onSwitchCodexAccount: props.onSwitchCodexAccount })}
      {...(props.onOpenChatGptSubscriptionAccounts && {
        onOpenChatGptSubscriptionAccounts: props.onOpenChatGptSubscriptionAccounts,
      })}
      {...(props.selectedSubagentAgentId && {
        selectedSubagentAgentId: props.selectedSubagentAgentId,
      })}
      {...(props.onOpenSubagent && { onOpenSubagent: props.onOpenSubagent })}
      {...(props.onOpenImageGenerationTool && {
        onOpenImageGenerationTool: props.onOpenImageGenerationTool,
      })}
      {...(props.onOpenImageDisplayTool && {
        onOpenImageDisplayTool: props.onOpenImageDisplayTool,
      })}
      {...(props.onOpenImageDisplayArtifact && {
        onOpenImageDisplayArtifact: props.onOpenImageDisplayArtifact,
      })}
      {...(props.onPlannerLayoutChange && {
        onPlannerLayoutChange: props.onPlannerLayoutChange,
      })}
      {...(props.onComposerAgentSilenceChange && {
        onComposerAgentSilenceChange: props.onComposerAgentSilenceChange,
      })}
      {...(props.onFeedEndAnchorChange && {
        onFeedEndAnchorChange: props.onFeedEndAnchorChange,
      })}
      feedUserDetached={props.feedUserDetached ?? false}
      {...(props.onLoadProjectionDetail && {
        onLoadProjectionDetail: props.onLoadProjectionDetail,
      })}
      {...(props.thinkingDisplayMode && {
        thinkingDisplayMode: props.thinkingDisplayMode,
      })}
    />
  );
});

/**
 * Render a projection snapshot produced by the V2 read model.
 *
 * This surface is kept separate from `ActivityLogView` so pure presentation
 * tests and replay fixtures can exercise the feed without reintroducing a
 * production V1 fallback into the app's entry component.
 */
function ConversationV2ProjectionActivityLogViewImpl({
  projection,
  thread,
  onRestorePrompt,
  onLoadUserMessageEdit,
  onRewriteUserMessage,
  onForkMessage,
  onRetryFailedRequest,
  onSwitchCodexAccount,
  onOpenChatGptSubscriptionAccounts,
  onPlannerLayoutChange,
  onComposerAgentSilenceChange,
  onFeedEndAnchorChange,
  feedUserDetached = false,
  agentDisplayNames,
  agentThemes,
  onLoadProjectionDetail,
  selectedSubagentAgentId,
  onOpenSubagent,
  onOpenImageGenerationTool,
  onOpenImageDisplayTool,
  onOpenImageDisplayArtifact,
  thinkingDisplayMode,
}: {
  projection: ThreadRunProjectionSnapshot;
  thread?: ThreadSummary;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
  onLoadProjectionDetail?: ProjectionDetailLoader;
  selectedSubagentAgentId?: string;
  onOpenSubagent?: OpenSubagentHandler;
  onOpenImageGenerationTool?: OpenImageGenerationToolHandler;
  onOpenImageDisplayTool?: OpenImageDisplayToolHandler;
  onOpenImageDisplayArtifact?: OpenImageDisplayArtifactHandler;
  onRestorePrompt?: RestorePromptHandler;
  onLoadUserMessageEdit?: LoadUserMessageEditHandler;
  onRewriteUserMessage?: RewriteUserMessageHandler;
  onForkMessage?: ForkMessageHandler;
  onRetryFailedRequest?: RetryFailedRequestHandler;
  onSwitchCodexAccount?: () => void;
  onOpenChatGptSubscriptionAccounts?: (accountId?: string) => void;
  onPlannerLayoutChange?: ActivityFeedLayoutChange;
  onComposerAgentSilenceChange?: (silent: boolean) => void;
  onFeedEndAnchorChange?: (endAnchored: boolean) => void;
  feedUserDetached?: boolean;
  thinkingDisplayMode?: ThinkingDisplayMode;
}) {
  useTranslation();
  const requestSpansById = useMemo(
    () => new Map(projection.requestSpans.map((span) => [span.requestId, span])),
    [projection.requestSpans],
  );
  // Request spans include every agent; only the main agent's write owns this Feed's live slot.
  const toolWritingIndicator = useMemo(
    () => resolveToolWritingIndicator(projection.requestSpans),
    [projection.requestSpans],
  );
  const toolWritingLabel = useMemo(() => {
    if (!toolWritingIndicator) {
      return undefined;
    }
    const label = resolveToolWritingLabel(toolWritingIndicator);
    return i18n.t(label.key, label.params);
  }, [toolWritingIndicator, i18n]);
  const resolvedThinkingDisplayMode = thinkingDisplayMode ?? readStoredThinkingDisplayPreferences().mode;
  const viewModel = useMemo(
    () =>
      buildThreadRunProjectionViewModel(
        projection,
        thread ? { id: thread.id, prompt: thread.prompt } : undefined,
        {
          agentDisplayNames,
          thinkingDisplayMode: resolvedThinkingDisplayMode,
        },
      ),
    [agentDisplayNames, projection, resolvedThinkingDisplayMode, thread?.id, thread?.prompt],
  );
  const showThreadPrompt = viewModel.showThreadPrompt;
  const feedSections = useMemo(
    () => buildThreadRunTurnFeedSections(viewModel.mainFeedEntries, projection),
    [projection, viewModel.mainFeedEntries],
  );
  // Late output can sort last in the raw timeline but render inside an earlier turn.
  // Live status must follow the same order as the sections the reader actually sees.
  const orderedFeedEntries = useMemo(
    () => feedSections.flatMap((section) =>
      section.kind === "turn"
        ? [...section.processEntries, ...(section.finalEntry ? [section.finalEntry] : [])]
        : section.kind === "entry" ? [section.entry] : [],
    ),
    [feedSections],
  );
  const paceTargetKey = useMemo(() => resolveFeedPaceTargetKey(feedSections), [feedSections]);
  const retryTargets = useMemo(
    () =>
      buildRequestFailureRetryTargets({
        items: projection.timeline,
        ...(thread?.coreKind && { coreKind: thread.coreKind }),
        threadStatus: thread?.status ?? projection.thread.status,
      }),
    [projection.timeline, projection.thread.status, thread?.coreKind, thread?.status],
  );
  const allowUserMessageRewrite = supportsHistoryRewrite(thread?.coreKind);
  const forkStatus = thread?.status ?? projection.thread.status;
  const hideMessageActions =
    forkStatus === "running" || forkStatus === "queued" || Boolean(thread?.cancelling);
  const forkDisabledReason =
    hideMessageActions
      ? i18n.t("activity.forkWait", { defaultValue: "等待当前执行结束，或停止后再分叉" })
      : undefined;
  const showMessageActions = !hideMessageActions;
  const conversationActive = !isThreadStoppedForFinalSummary(projection.thread.status);
  const pendingThinking = projection.requestSpans.some(
    (span) => !span.ownerAgentId && isPendingThinkingWithoutContent(span, projection.timeline),
  );
  // Settled tool groups keep their "running" display for TOOL_RUNNING_MIN_VISIBLE_MS
  // (resolveToolGroupDisplayState). The tail must honor the same window, otherwise the
  // settling tool row and the「正在思考」tail state render at the same time.
  const [settlingToolClock, setSettlingToolClock] = useState(0);
  const settlingToolExtensionMs = useMemo(() => {
    const nowMs = Date.now();
    let deadlineMs = 0;
    for (const entry of viewModel.mainFeedEntries) {
      if (entry.kind !== "tool-group") {
        continue;
      }
      const endMs = resolveToolGroupSettledExtensionEndMs(entry.entries);
      if (endMs !== undefined && endMs > deadlineMs) {
        deadlineMs = endMs;
      }
    }
    // settlingToolClock only re-arms the deadline after the timer fires.
    return deadlineMs > nowMs ? deadlineMs - nowMs : 0;
  }, [settlingToolClock, viewModel.mainFeedEntries]);

  useEffect(() => {
    if (settlingToolExtensionMs <= 0) {
      return;
    }
    const timer = window.setTimeout(
      () => setSettlingToolClock((value) => value + 1),
      settlingToolExtensionMs,
    );
    return () => window.clearTimeout(timer);
  }, [settlingToolClock, settlingToolExtensionMs]);

  const runningToolVisible =
    viewModel.mainFeedEntries.some((entry) => isRunningToolFeedEntry(entry)) || settlingToolExtensionMs > 0;
  // The Feed's live row is one slot, and three states take turns owning it:
  //   1. 阅后即焚的思考 — the ephemeral reasoning tip takes the slot by replacing the
  //      trailing tool entry in the projection (`replaceLatestToolWithReasoningStage`)
  //      and is then deferred into the active-tail row;
  //   2. 最后一行工具调用聚合 — the trailing tool-group owns the slot by rendering its own
  //      row, and the active tail stays away while it is there;
  //   3. 「正在准备 xxx」 — the model writing its next call owns the slot *instead of* the
  //      settled aggregate row it follows, never beneath it, and it outranks the
  //      minimum-visible "running" window so a quick succession of calls still narrates.
  // A tool that is still genuinely running keeps its row: with parallel calls the running
  // activity is the thing to narrate, so a wait label may not hide it.
  const liveSlotEntry = useMemo(
    () => resolveFeedLiveSlotEntry(orderedFeedEntries, requestSpansById),
    [orderedFeedEntries, requestSpansById],
  );
  const latestContentIsToolGroup = liveSlotEntry?.kind === "tool-group";
  const runningContextCompactionVisible = viewModel.mainFeedEntries.some((entry) =>
    isRunningContextCompactionFeedEntry(entry),
  );
  const writingTakesLiveSlot =
    conversationActive &&
    !runningContextCompactionVisible &&
    Boolean(toolWritingIndicator) &&
    latestContentIsToolGroup &&
    !(liveSlotEntry && isRunningToolFeedEntry(liveSlotEntry));
  const thinkingTakesLiveSlot =
    conversationActive &&
    pendingThinking &&
    !runningContextCompactionVisible &&
    latestContentIsToolGroup &&
    !(liveSlotEntry && isRunningToolFeedEntry(liveSlotEntry));
  // A native thinking start or writing state replaces a settled tool; a running tool keeps its row.
  const suppressedFeedEntryKey =
    writingTakesLiveSlot || thinkingTakesLiveSlot ? liveSlotEntry?.key : undefined;
  // While the conversation is live, Summary tip shares the active-tail slot with
  // empty "正在思考" — never render both as sibling WaitingThinkingBlocks.
  const liveReasoningStageLabel =
    conversationActive && !pendingThinking
      ? resolveLiveReasoningStageLabel(orderedFeedEntries)
      : undefined;
  const deferReasoningStageTip =
    conversationActive && !runningToolVisible && !runningContextCompactionVisible;
  // A prompt needs acknowledgement even before its request span exists.
  const awaitingAgentAnswer = isAwaitingAgentAnswer(orderedFeedEntries);
  const waitingThinkingVisible =
    (!runningToolVisible || thinkingTakesLiveSlot) &&
    !runningContextCompactionVisible &&
    (!latestContentIsToolGroup || thinkingTakesLiveSlot) &&
    (pendingThinking ||
      awaitingAgentAnswer ||
      Boolean(liveReasoningStageLabel) ||
      viewModel.mainFeedEntries.some((entry) => {
        if (entry.kind !== "timeline" && entry.kind !== "agent-echo") {
          return false;
        }
        return isWaitingThinkingItem(entry.item, requestSpansById);
      }));
  // Copy/time meta under each turn final causes layout jitter while the run is
  // still live (sticky opacity + min-height appear as streaming settles). Only
  // attach those ids after the conversation has stopped.
  const finalSummaryItemIds = useMemo(() => {
    if (!isThreadStoppedForFinalSummary(projection.thread.status)) {
      return new Set<string>();
    }
    const ids = new Set(resolveTurnFinalSummaryItemIds(viewModel.mainFeedEntries, projection.thread.status));
    for (const section of feedSections) {
      if (section.kind === "turn" && section.finalEntry?.kind === "timeline") {
        ids.add(section.finalEntry.item.id);
      }
    }
    return ids;
  }, [feedSections, projection.thread.status, viewModel.mainFeedEntries]);
  const stickyFinalSummaryItemId = useMemo(() => {
    let itemId: string | undefined;
    for (const entry of viewModel.mainFeedEntries) {
      if (entry.kind === "timeline" && finalSummaryItemIds.has(entry.item.id)) {
        itemId = entry.item.id;
      }
    }
    return itemId;
  }, [finalSummaryItemIds, viewModel.mainFeedEntries]);
  // A completed turn can be followed immediately by another queued turn.
  // Auto-read observes final outputs independently from the meta row's layout policy.
  let readAloudCandidate: { id: string; text: string; runId: string } | undefined;
  for (const section of feedSections) {
    if (section.kind !== "turn" || section.attempt.status !== "completed" || section.finalEntry?.kind !== "timeline") continue;
    const item = section.finalEntry.item;
    if (item.contentLoaded !== false && item.runAttemptId && item.text.trim()) {
      readAloudCandidate = { id: item.id, text: item.text, runId: item.runAttemptId };
    }
  }
  useReadAloudAutoRead(
    projection.thread.threadId,
    !isThreadStoppedForFinalSummary(projection.thread.status),
    readAloudCandidate,
    projection.thread.currentAttemptId ?? projection.attempts.find((attempt) => attempt.status === "running")?.attemptId,
  );

  const layoutSignature = useMemo(
    () =>
      [
        showThreadPrompt ? `prompt:${thread?.id ?? ""}` : "",
        // The slot swap is a layout change: the row it vacates leaves the DOM.
        suppressedFeedEntryKey ? `suppressed:${suppressedFeedEntryKey}` : "",
        ...viewModel.mainFeedEntries.map((entry) => {
          if (entry.kind === "timeline" || entry.kind === "agent-echo") {
            return `${entry.key}:${projectionTimelineItemRenderSignature(entry.item)}`;
          }
          if (entry.kind === "tool-group") {
            return `${entry.key}:${entry.entries
              .map((child) => `${child.key}:${projectionTimelineItemRenderSignature(child.item)}`)
              .join(",")}`;
          }
          const lastItem = entry.card.agent.timeline.at(-1);
          return [
            entry.key,
            entry.card.agent.timeline.length,
            lastItem?.id ?? "",
            lastItem ? projectionTimelineItemRenderSignature(lastItem) : "",
          ].join(":");
        }),
      ]
        .filter(Boolean)
        .join("|"),
    [showThreadPrompt, suppressedFeedEntryKey, thread?.id, viewModel.mainFeedEntries],
  );

  usePlannerLayoutChangeEffect(layoutSignature, onPlannerLayoutChange);
  // The Feed owns the tail while it has something of its own animating there — its waiting
  // line, or a thinking row still streaming its shimmer. The Composer's dots are for the
  // gaps the Feed cannot narrate, so they wait for the Feed to go quiet first.
  useComposerAgentSilenceEffect(
    {
      active: conversationActive,
      feedIndicatorVisible:
        waitingThinkingVisible ||
        Boolean(toolWritingIndicator) ||
        isTailThinkingStreamingLive(viewModel.mainFeedEntries),
      signature: layoutSignature,
    },
    onComposerAgentSilenceChange,
  );

  const runLogRef = useRef<HTMLDivElement>(null);
  const feedHeaderRef = useRef<HTMLDivElement>(null);
  const [feedTextContextMenu, setFeedTextContextMenu] = useState<FeedTextContextMenuAnchor>();
  const closeFeedTextContextMenu = useCallback(() => {
    setFeedTextContextMenu(undefined);
  }, []);
  const handleFeedContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) {
      return;
    }
    const selection = window.getSelection();
    const anchorNode = selection?.anchorNode;
    const focusNode = selection?.focusNode;
    if (
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !anchorNode ||
      !focusNode ||
      !event.currentTarget.contains(anchorNode) ||
      !event.currentTarget.contains(focusNode)
    ) {
      return;
    }
    const selectedText = selection.toString();
    if (!selectedText.trim()) {
      return;
    }
    event.preventDefault();
    setFeedTextContextMenu({
      x: event.clientX,
      y: event.clientY,
      selectedText,
    });
  }, []);
  /*
    `latestContentIsToolGroup` keeps 「正在思考」 and Summary tips from stacking under a tool
    row — that row owns the slot. It must not swallow the one state that outlives it: a
    *settled* tool group is not an activity, and the model writing its next call is. A
    10.9s write after a finished Edit was invisible because of this, with nothing else on
    the wire to notice it — so the writing state now takes that row itself
    (`writingTakesLiveSlot`) rather than appearing below it.
  */
  const activeTailVisible =
    conversationActive &&
    (waitingThinkingVisible || Boolean(toolWritingIndicator) || Boolean(thread?.cancelling)) &&
    !runningContextCompactionVisible &&
    (writingTakesLiveSlot || thinkingTakesLiveSlot || (!runningToolVisible && !latestContentIsToolGroup));
  // The live tail is a row of the Feed, not decoration appended after it. The
  // virtualizer keeps the bottom pinned only for geometry it measures, so a tail
  // rendered outside the window pushes the newest output out of view.
  const renderedFeedSections = useMemo(
    () => (activeTailVisible ? [...feedSections, ACTIVE_TAIL_FEED_SECTION] : feedSections),
    [feedSections, activeTailVisible],
  );
  const virtualizeEnabled = renderedFeedSections.length >= FEED_VIRTUALIZE_MIN_SECTIONS;
  const {
    enabled: feedVirtualized,
    virtualItems,
    totalSize,
    scrollMargin,
    paddingStart: feedPaddingStart,
    paddingEnd: feedPaddingEnd,
    measureElement,
    resolveSectionTopPx,
  } = useFeedSectionVirtualizer({
    sections: renderedFeedSections,
    enabled: virtualizeEnabled,
    userDetached: feedUserDetached,
    runLogRef,
    headerRef: feedHeaderRef,
  });
  useEffect(() => {
    if (!onFeedEndAnchorChange) {
      return undefined;
    }
    onFeedEndAnchorChange(virtualizeEnabled);
    return () => {
      onFeedEndAnchorChange(false);
    };
  }, [onFeedEndAnchorChange, virtualizeEnabled]);
  const userMessageAnchors = useMemo(() => listUserMessageAnchorsFromSections(feedSections), [feedSections]);
  const mountedSectionIndexes = useMemo(
    () => new Set(virtualItems.map((item) => item.index)),
    [virtualItems],
  );

  const sharedSectionProps = {
    requestSpansById,
    finalSummaryItemIds,
    deferReasoningStageTip,
    ...(suppressedFeedEntryKey && { suppressedFeedEntryKey }),
    ...(stickyFinalSummaryItemId && { stickyFinalSummaryItemId }),
    ...(selectedSubagentAgentId && { selectedSubagentAgentId }),
    ...(onOpenSubagent && { onOpenSubagent }),
    ...(onOpenImageGenerationTool && { onOpenImageGenerationTool }),
    ...(onOpenImageDisplayTool && { onOpenImageDisplayTool }),
    ...(onOpenImageDisplayArtifact && { onOpenImageDisplayArtifact }),
    ...(agentDisplayNames && { agentDisplayNames }),
    ...(agentThemes && { agentThemes }),
    // ACP/Pi have no history rewrite; active runs also omit the message-action handlers so
    // Reply/Pencil/Fork icons stay hidden until the conversation settles.
    ...(showMessageActions && onRestorePrompt && allowUserMessageRewrite && { onRestorePrompt }),
    ...(showMessageActions && onLoadUserMessageEdit && allowUserMessageRewrite && { onLoadUserMessageEdit }),
    ...(showMessageActions && onRewriteUserMessage && allowUserMessageRewrite && { onRewriteUserMessage }),
    ...(showMessageActions && onForkMessage && { onForkMessage }),
    ...(forkDisabledReason && { forkDisabledReason }),
    ...(onRetryFailedRequest && { onRetryFailedRequest }),
    ...(thread?.coreKind === "codex" && onSwitchCodexAccount && { onSwitchCodexAccount }),
    ...(onOpenChatGptSubscriptionAccounts && { onOpenChatGptSubscriptionAccounts }),
    retryTargets,
    allowUserMessageRewrite,
    historyRevision: projection.historyRevision ?? 0,
    ...(paceTargetKey && { paceTargetKey }),
    ...(onLoadProjectionDetail && { onLoadProjectionDetail }),
  } as const;

  const renderFeedSection = (index: number) => {
    const section = renderedFeedSections[index];
    if (!section) {
      return null;
    }
    if (section.kind === "turn") {
      return (
        <ProjectionTurnFeedSection
          section={section}
          {...sharedSectionProps}
          stopping={Boolean(thread?.cancelling)}
        />
      );
    }
    if (section.kind === "active-tail") {
      return (
        <RunLogActiveTail
          stopping={Boolean(thread?.cancelling)}
          writing={Boolean(toolWritingLabel)}
          {...(toolWritingLabel
            ? { label: toolWritingLabel }
            : liveReasoningStageLabel
              ? { label: liveReasoningStageLabel }
              : {})}
        />
      );
    }
    return <ProjectionMainFeedEntry entry={section.entry} {...sharedSectionProps} />;
  };

  return (
    <RequestSpansContext.Provider value={projection.requestSpans}>
      <ActivityFeedLayoutContext.Provider value={onPlannerLayoutChange}>
        <div
          ref={runLogRef}
          className={["run-log", feedVirtualized ? "run-log--virtualized" : ""].filter(Boolean).join(" ")}
          onContextMenu={handleFeedContextMenu}
        >
          <div ref={feedHeaderRef} className="run-log-virtual-header">
            {showThreadPrompt && thread?.prompt
              ? wrapRunLogFeedEntry(
                  <UserPromptBlock
                    text={thread.prompt}
                    anchorId={`thread:${thread.id}`}
                    {...(thread.createdAt ? { createdAt: thread.createdAt } : {})}
                    {...(showMessageActions && onRestorePrompt && { onRestorePrompt })}
                    {...(showMessageActions && onLoadUserMessageEdit && { onLoadUserMessageEdit })}
                    {...(showMessageActions && onRewriteUserMessage && { onRewriteUserMessage })}
                    {...(showMessageActions && onForkMessage && { onForkMessage })}
                    {...(forkDisabledReason && { forkDisabledReason })}
                    allowUserMessageRewrite={allowUserMessageRewrite}
                    historyRevision={projection.historyRevision ?? 0}
                  />,
                )
              : null}
          </div>
          {feedVirtualized ? (
            <>
              <FeedVirtualUserMessageSentinels
                anchors={userMessageAnchors}
                mountedSectionIndexes={mountedSectionIndexes}
                resolveSectionTopPx={resolveSectionTopPx}
              />
              <FeedVirtualSectionWindow
                sections={renderedFeedSections}
                totalSize={totalSize}
                scrollMargin={scrollMargin}
                paddingStart={feedPaddingStart}
                paddingEnd={feedPaddingEnd}
                virtualItems={virtualItems}
                measureElement={measureElement}
                renderSection={renderFeedSection}
              />
            </>
          ) : (
            renderedFeedSections.map((section, index) => (
              <div key={section.key} className="run-log-virtual-row" data-index={index}>
                {renderFeedSection(index)}
              </div>
            ))
          )}
        </div>
        {feedTextContextMenu ? (
          <FeedTextContextMenu
            anchor={feedTextContextMenu}
            onClose={closeFeedTextContextMenu}
          />
        ) : null}
      </ActivityFeedLayoutContext.Provider>
    </RequestSpansContext.Provider>
  );
}

export const ConversationV2ProjectionActivityLogView = memo(ConversationV2ProjectionActivityLogViewImpl);

type ProjectionFeedEntrySharedProps = {
  requestSpansById: Map<string, ThreadRunProjectionSnapshot["requestSpans"][number]>;
  finalSummaryItemIds: ReadonlySet<string>;
  stickyFinalSummaryItemId?: string;
  /** Defer reasoning-stage tip rows into the feed active-tail (live conversation). */
  deferReasoningStageTip?: boolean;
  /** The slot-owning entry a live state has taken over; that row renders as null. */
  suppressedFeedEntryKey?: string;
  selectedSubagentAgentId?: string;
  onOpenSubagent?: OpenSubagentHandler;
  onOpenImageGenerationTool?: OpenImageGenerationToolHandler;
  onOpenImageDisplayTool?: OpenImageDisplayToolHandler;
  onOpenImageDisplayArtifact?: OpenImageDisplayArtifactHandler;
  onRestorePrompt?: RestorePromptHandler;
  onLoadUserMessageEdit?: LoadUserMessageEditHandler;
  onRewriteUserMessage?: RewriteUserMessageHandler;
  onForkMessage?: ForkMessageHandler;
  forkDisabledReason?: string;
  onRetryFailedRequest?: RetryFailedRequestHandler;
  onSwitchCodexAccount?: () => void;
  onOpenChatGptSubscriptionAccounts?: (accountId?: string) => void;
  retryTargets?: Map<string, RequestFailureRetryTarget>;
  allowUserMessageRewrite?: boolean;
  historyRevision: number;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
  stopping?: boolean;
  paceTargetKey?: string;
  onLoadProjectionDetail?: ProjectionDetailLoader;
};

function ProjectionTurnFeedSection({
  section,
  ...entryProps
}: ProjectionFeedEntrySharedProps & {
  section: Extract<ThreadRunTurnFeedSection, { kind: "turn" }>;
}) {
  const requestSpansById = entryProps.requestSpansById;
  const deferReasoningStageTip = Boolean(entryProps.deferReasoningStageTip);
  const suppressedFeedEntryKey = entryProps.suppressedFeedEntryKey;
  const detailLoaded = section.processEntries.some(
    (entry) =>
      (entry.kind === "timeline" || entry.kind === "agent-echo") && entry.item.contentLoaded === true,
  );
  // Empty "正在思考" / live Summary tip are deferred to the feed active-tail, and the
  // tool aggregate a live state took over is suppressed outright. If the process would
  // only render those rows as null, mark process empty so the divider does not open a
  // hollow padding gap sitting above the tail waiting line.
  const processEmpty = !section.processEntries.some((entry) => {
    if (suppressedFeedEntryKey && entry.key === suppressedFeedEntryKey) {
      return false;
    }
    if (entry.kind === "timeline" || entry.kind === "agent-echo") {
      return !isDeferredThinkingStatusItem(entry.item, requestSpansById, deferReasoningStageTip);
    }
    return true;
  });

  return (
    <RunLogTurnSection
      turnKey={section.key}
      running={section.running}
      showHeading={!section.running || !section.continuation}
      stopping={Boolean(entryProps.stopping) && section.running}
      status={section.attempt.status}
      startedAt={section.attempt.startedAt}
      {...(section.attempt.endedAt && { endedAt: section.attempt.endedAt })}
      processEmpty={processEmpty}
      detailLoaded={detailLoaded}
      {...(entryProps.onLoadProjectionDetail && {
        onLoadDetail: () =>
          entryProps.onLoadProjectionDetail?.("turn", section.attempt.attemptId) ?? Promise.resolve(),
      })}
      process={
        <>
          {section.processEntries.map((entry) => (
            <ProjectionMainFeedEntry key={entry.key} entry={entry} {...entryProps} />
          ))}
        </>
      }
      {...(section.finalEntry && {
        final: <ProjectionMainFeedEntry entry={section.finalEntry} {...entryProps} />,
      })}
    />
  );
}

function RunLogTurnSection({
  turnKey,
  running,
  showHeading = true,
  stopping = false,
  status,
  startedAt,
  endedAt,
  projectedDurationMs = 0,
  leading,
  process,
  processEmpty,
  detailLoaded = false,
  final,
  onLoadDetail,
  className,
}: {
  turnKey: string;
  running: boolean;
  showHeading?: boolean;
  stopping?: boolean;
  status?: ThreadRunProjectionAttempt["status"];
  startedAt: string;
  endedAt?: string;
  projectedDurationMs?: number;
  leading?: ReactNode;
  process: ReactNode;
  processEmpty: boolean;
  detailLoaded?: boolean;
  final?: ReactNode;
  onLoadDetail?: () => Promise<void>;
  className?: string;
}) {
  const onLayoutChange = useActivityFeedLayoutChange();
  const [userExpanded, setExpanded] = useState(false);
  const expanded = running || userExpanded;
  const [animateExpansion, setAnimateExpansion] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | undefined>();
  const [detailLoadedLocally, setDetailLoadedLocally] = useState(false);
  const measuredDurationMs = useTurnDurationMs(startedAt, endedAt, running);
  const durationMs = Math.max(measuredDurationMs, projectedDurationMs);
  const headingLabel = formatRunLogTurnHeading(running, status, durationMs, stopping);
  const contentId = `turn-process-${turnKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  useLayoutEffect(() => {
    setAnimateExpansion(false);
    if (running) {
      setExpanded(false);
    }
  }, [running]);

  useLayoutEffect(() => {
    onLayoutChange?.({ immediate: true });
  }, [expanded, onLayoutChange]);

  return (
    <section
      className={[
        "run-log-turn",
        className,
        running ? "is-running" : "is-completed",
        expanded ? "is-expanded" : "is-collapsed",
        animateExpansion ? "is-user-transitioning" : "",
        !showHeading ? "is-continuation" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={running ? i18n.t("activity.process") : i18n.t("activity.turnResult")}
    >
      {leading}
      {showHeading ? (
        <button
          type="button"
          className="run-log-turn-toggle"
          onClick={() => {
            if (running) {
              return;
            }
            setAnimateExpansion(true);
            const nextExpanded = !expanded;
            setExpanded(nextExpanded);
            if (nextExpanded && onLoadDetail && !detailLoading && !detailLoaded && !detailLoadedLocally) {
              setDetailError(undefined);
              setDetailLoading(true);
              void onLoadDetail()
                .then(() => setDetailLoadedLocally(true))
                .catch((error) => setDetailError(error instanceof Error ? error.message : String(error)))
                .finally(() => setDetailLoading(false));
            }
          }}
          disabled={running}
          aria-expanded={expanded}
          aria-controls={contentId}
        >
          <span className="run-log-turn-heading">
            <span className="run-log-turn-status">{headingLabel}</span>
            {!running ? (
              <ChevronRight
                size={15}
                className={`run-log-turn-chevron${expanded ? " open" : ""}`}
                aria-hidden
              />
            ) : null}
          </span>
          <span className="run-log-turn-divider" aria-hidden />
        </button>
      ) : null}
      <div
        id={contentId}
        className="run-log-turn-process"
        aria-label={i18n.t("activity.process")}
        aria-hidden={!expanded}
      >
        <div className={`run-log-turn-process-inner${processEmpty ? " is-empty" : ""}`}>
          {expanded || animateExpansion ? process : null}
        </div>
      </div>
      {detailLoading ? <div className="run-log-turn-detail-loading" aria-busy="true" /> : null}
      {detailError ? (
        <button
          type="button"
          className="run-log-turn-detail-error"
          role="alert"
          onClick={() => {
            if (!onLoadDetail || detailLoading) return;
            setDetailLoading(true);
            setDetailError(undefined);
            void onLoadDetail()
              .then(() => setDetailLoadedLocally(true))
              .catch((error) => setDetailError(error instanceof Error ? error.message : String(error)))
              .finally(() => setDetailLoading(false));
          }}
        >
          {detailError}
        </button>
      ) : null}
      {final ? (
        <div className="run-log-turn-final" aria-label={i18n.t("activity.finalOutput")}>
          {final}
        </div>
      ) : null}
    </section>
  );
}

export function formatRunLogTurnHeading(
  running: boolean,
  status: ThreadRunProjectionAttempt["status"] | undefined,
  durationMs: number,
  stopping = false,
): string {
  if (running) {
    const duration = formatDuration(durationMs);
    const label = stopping ? i18n.t("activity.stopping") : i18n.t("activity.processing");
    return `${label}${duration ? ` ${duration}` : ""}`;
  }

  if (status === "cancelled" || status === "failed") {
    const duration = formatStoppedTurnDuration(durationMs);
    if (status === "cancelled") {
      return duration ? i18n.t("activity.stoppedByYouAfter", { duration }) : i18n.t("activity.stoppedByYou");
    }
    return duration
      ? i18n.t("activity.stoppedUnexpectedlyAfter", { duration })
      : i18n.t("activity.stoppedUnexpectedly");
  }

  const duration = formatDuration(durationMs);
  return `${i18n.t("activity.processed")}${duration ? ` ${duration}` : ""}`;
}

function formatStoppedTurnDuration(durationMs: number): string {
  const duration = formatDuration(durationMs);
  if (!duration || !i18n.resolvedLanguage?.toLowerCase().startsWith("zh")) {
    return duration;
  }
  return duration
    .replace(/(\d+)h\b/g, "$1小时")
    .replace(/(\d+)m\b/g, "$1分")
    .replace(/(\d+)s\b/g, "$1秒");
}

function useTurnDurationMs(startedAt: string, endedAt: string | undefined, running: boolean): number {
  const resolve = useCallback(() => {
    const startMs = Date.parse(startedAt);
    const endMs = endedAt ? Date.parse(endedAt) : Date.now();
    return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
  }, [endedAt, startedAt]);
  const [durationMs, setDurationMs] = useState(resolve);

  useEffect(() => {
    const update = () => {
      const next = resolve();
      setDurationMs((current) => (current === next ? current : next));
    };
    update();
    if (!running) return;
    const timer = setInterval(update, LIVE_DURATION_TICK_MS);
    return () => clearInterval(timer);
  }, [resolve, running]);

  return durationMs;
}

export function resolveActiveSubagentDurationMs(
  startedAt: string,
  projectedDurationMs: number,
  nowMs = Date.now(),
): number {
  const startedAtMs = Date.parse(startedAt);
  const elapsedSinceStartMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;
  return Math.max(0, projectedDurationMs, elapsedSinceStartMs);
}

function useSubagentDurationMs(agent: ThreadRunProjectionAgent, running: boolean): number {
  const resolve = useCallback(
    () =>
      running
        ? resolveActiveSubagentDurationMs(agent.startedAt, agent.durationMs)
        : Math.max(0, agent.durationMs),
    [agent.durationMs, agent.startedAt, running],
  );
  const [durationMs, setDurationMs] = useState(resolve);

  useEffect(() => {
    const update = () => {
      const next = resolve();
      setDurationMs((current) => (current === next ? current : next));
    };
    update();
    if (!running) return;
    const timer = setInterval(update, LIVE_DURATION_TICK_MS);
    return () => clearInterval(timer);
  }, [resolve, running]);

  return durationMs;
}

function isTightFeedDetailBlock(block: ActivityDetailBlock): boolean {
  if (
    block.kind === "action" &&
    (block.bashRun ||
      block.fileChange ||
      block.webSearch ||
      block.imageView ||
      block.imageDisplay ||
      block.htmlHost)
  ) {
    return false;
  }
  return (
    block.kind === "action" ||
    block.kind === "model-request" ||
    block.kind === "agent-request" ||
    block.kind === "thinking" ||
    block.kind === "reasoning-stage" ||
    block.kind === "tool-failed" ||
    block.kind === "unknown-item" ||
    block.kind === "subagent-mission"
  );
}

function wrapRunLogFeedEntry(node: ReactNode, options?: { compact?: boolean; tight?: boolean }): ReactNode {
  if (options?.compact) {
    return node;
  }
  const className = options?.tight ? "run-log-feed-entry run-log-feed-entry--tight" : "run-log-feed-entry";
  return <div className={className}>{node}</div>;
}

export function readImageGenerationToolUseId(item: ThreadRunProjectionTimelineItem): string | undefined {
  const rawTool = item.metadata?.tool;
  if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) {
    return undefined;
  }
  const tool = rawTool as Record<string, unknown>;
  const name = typeof tool.name === "string" ? tool.name : undefined;
  const toolUseId = typeof tool.toolUseId === "string" ? tool.toolUseId.trim() : "";
  return name && toolUseId && isEcoImageGenerationToolName(name) ? toolUseId : undefined;
}

export function readImageDisplayToolUseId(item: ThreadRunProjectionTimelineItem): string | undefined {
  const rawTool = item.metadata?.tool;
  if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) {
    return undefined;
  }
  const tool = rawTool as Record<string, unknown>;
  const name = typeof tool.name === "string" ? tool.name : undefined;
  const toolUseId = typeof tool.toolUseId === "string" ? tool.toolUseId.trim() : "";
  return name && toolUseId && isEcoImageDisplayToolName(name) ? toolUseId : undefined;
}

/**
 * PI marks a call a tool issued itself (today only a codemode script) with `parentToolCallId`.
 * It is deliberately not `parentToolUseId`, which everywhere else means "owned by a subagent".
 */
function readProjectionParentToolCallId(item: ThreadRunProjectionTimelineItem): string | undefined {
  const raw = item.metadata?.conversationV2ParentToolCallId;
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  // The legacy row has no column for the link, so it rides on the tool metadata instead.
  const rawTool = item.metadata?.tool;
  if (rawTool && typeof rawTool === "object" && !Array.isArray(rawTool)) {
    const nested = (rawTool as Record<string, unknown>).parentToolCallId;
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }
  return undefined;
}

function readProjectionToolUseId(item: ThreadRunProjectionTimelineItem): string | undefined {
  const rawTool = item.metadata?.tool;
  if (rawTool && typeof rawTool === "object" && !Array.isArray(rawTool)) {
    const toolUseId = (rawTool as Record<string, unknown>).toolUseId;
    if (typeof toolUseId === "string" && toolUseId.trim()) return toolUseId.trim();
  }
  const approval = item.metadata?.bashApproval;
  if (approval && typeof approval === "object" && !Array.isArray(approval)) {
    const toolUseId = (approval as Record<string, unknown>).toolUseId;
    if (typeof toolUseId === "string" && toolUseId.trim()) return toolUseId.trim();
  }
  return undefined;
}

function ProjectionMainFeedEntry({
  entry,
  requestSpansById,
  finalSummaryItemIds,
  stickyFinalSummaryItemId,
  deferReasoningStageTip = false,
  suppressedFeedEntryKey,
  selectedSubagentAgentId,
  onOpenSubagent,
  onOpenImageGenerationTool,
  onOpenImageDisplayTool,
  onOpenImageDisplayArtifact,
  onRestorePrompt,
  onLoadUserMessageEdit,
  onRewriteUserMessage,
  onForkMessage,
  forkDisabledReason,
  onRetryFailedRequest,
  onSwitchCodexAccount,
  onOpenChatGptSubscriptionAccounts,
  retryTargets,
  allowUserMessageRewrite,
  historyRevision,
  agentDisplayNames,
  agentThemes,
  paceTargetKey,
  onLoadProjectionDetail,
}: {
  entry: ThreadRunProjectionMainFeedEntry;
  requestSpansById: Map<string, ThreadRunProjectionSnapshot["requestSpans"][number]>;
  finalSummaryItemIds: ReadonlySet<string>;
  stickyFinalSummaryItemId?: string;
  deferReasoningStageTip?: boolean;
  /** The slot-owning entry a live state has taken over; that row renders as null. */
  suppressedFeedEntryKey?: string;
  selectedSubagentAgentId?: string;
  onOpenSubagent?: OpenSubagentHandler;
  onOpenImageGenerationTool?: OpenImageGenerationToolHandler;
  onOpenImageDisplayTool?: OpenImageDisplayToolHandler;
  onOpenImageDisplayArtifact?: OpenImageDisplayArtifactHandler;
  onRestorePrompt?: RestorePromptHandler;
  onLoadUserMessageEdit?: LoadUserMessageEditHandler;
  onRewriteUserMessage?: RewriteUserMessageHandler;
  onForkMessage?: ForkMessageHandler;
  forkDisabledReason?: string;
  onRetryFailedRequest?: RetryFailedRequestHandler;
  onSwitchCodexAccount?: () => void;
  onOpenChatGptSubscriptionAccounts?: (accountId?: string) => void;
  retryTargets?: Map<string, RequestFailureRetryTarget>;
  allowUserMessageRewrite?: boolean;
  historyRevision: number;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
  paceTargetKey?: string;
  onLoadProjectionDetail?: ProjectionDetailLoader;
}) {
  // A live state owns this row now (see `writingTakesLiveSlot`). Rendering it as null is
  // what makes the swap a swap: the tail takes the slot the aggregate vacates, so the two
  // can never be seen as sibling rows.
  if (suppressedFeedEntryKey && entry.key === suppressedFeedEntryKey) {
    return null;
  }
  if (entry.kind === "timeline") {
    const showMessageMeta = finalSummaryItemIds.has(entry.item.id);
    return (
      <ProjectionTimelineEntry
        item={entry.item}
        requestSpansById={requestSpansById}
        deferWaitingIndicator
        deferReasoningStageTip={deferReasoningStageTip}
        showMessageMeta={showMessageMeta}
        stickyMessageMeta={showMessageMeta && entry.item.id === stickyFinalSummaryItemId}
        pacing={paceTargetKey ? entry.key === paceTargetKey : true}
        {...(onRestorePrompt && { onRestorePrompt })}
        {...(onLoadUserMessageEdit && { onLoadUserMessageEdit })}
        {...(onRewriteUserMessage && { onRewriteUserMessage })}
        {...(onForkMessage && { onForkMessage })}
        {...(forkDisabledReason && { forkDisabledReason })}
        {...(onRetryFailedRequest && { onRetryFailedRequest })}
        {...(onSwitchCodexAccount && { onSwitchCodexAccount })}
        {...(onOpenChatGptSubscriptionAccounts && {
          onOpenChatGptSubscriptionAccounts,
        })}
        {...(retryTargets && { retryTargets })}
        allowUserMessageRewrite={Boolean(allowUserMessageRewrite)}
        historyRevision={historyRevision ?? 0}
        {...(onOpenImageGenerationTool && { onOpenImageGenerationTool })}
        {...(onOpenImageDisplayTool && { onOpenImageDisplayTool })}
        {...(onOpenImageDisplayArtifact && { onOpenImageDisplayArtifact })}
      />
    );
  }
  if (entry.kind === "tool-group") {
    return wrapRunLogFeedEntry(
      <ProjectionToolGroupEntry
        entry={entry}
        requestSpansById={requestSpansById}
        {...(onOpenImageGenerationTool && { onOpenImageGenerationTool })}
        {...(onOpenImageDisplayTool && { onOpenImageDisplayTool })}
        {...(onLoadProjectionDetail && { onLoadProjectionDetail })}
      />,
      { tight: true },
    );
  }
  if (entry.kind === "agent-card") {
    return wrapRunLogFeedEntry(
      <ProjectionSubagentRunRow
        agent={entry.card.agent}
        missionText={entry.card.missionText}
        openable={entry.card.openable}
        selected={selectedSubagentAgentId === entry.card.key}
        onOpen={() => {
          if (!entry.card.openable) return;
          onOpenSubagent?.(entry.card.key);
        }}
        {...(agentDisplayNames && { agentDisplayNames })}
        {...(agentThemes && { agentThemes })}
      />,
    );
  }
  if (deferReasoningStageTip && isReasoningStageItem(entry.item)) {
    return null;
  }
  return wrapRunLogFeedEntry(
    <ProjectionAgentEchoEntry
      entry={entry}
      requestSpansById={requestSpansById}
      pacing={paceTargetKey ? entry.key === paceTargetKey : true}
    />,
    {
      tight: isTightAgentEchoEntry(entry),
    },
  );
}

function isTightAgentEchoEntry(
  entry: Extract<ThreadRunProjectionMainFeedEntry, { kind: "agent-echo" }>,
): boolean {
  const block = projectionItemToDetailBlock(entry.item);
  return block ? isTightFeedDetailBlock(block) : false;
}

export function ProjectionToolGroupEntry({
  entry,
  requestSpansById,
  defaultExpanded = false,
  onOpenImageGenerationTool,
  onOpenImageDisplayTool,
  onLoadProjectionDetail,
}: {
  entry: Extract<ThreadRunProjectionMainFeedEntry, { kind: "tool-group" }>;
  requestSpansById: Map<string, ThreadRunProjectionSnapshot["requestSpans"][number]>;
  defaultExpanded?: boolean;
  onOpenImageGenerationTool?: OpenImageGenerationToolHandler;
  onOpenImageDisplayTool?: OpenImageDisplayToolHandler;
  onLoadProjectionDetail?: ProjectionDetailLoader;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Same pure window as the feed tail (resolveToolGroupDisplayState): the settling
  // "running" row and the「正在思考」tail can never render together.
  const [displayClock, setDisplayClock] = useState(0);
  const display = useMemo(
    () => resolveToolGroupDisplayState(entry.entries, Date.now()),
    // displayClock only re-arms the minimum-visible deadline.
    [displayClock, entry.entries],
  );
  const { summary, lifecycle, remainingMs } = display;
  // The live elapsed display derives from the running tool's own start time — the row's
  // event/insertion timestamp (occurredAt on V2 rows, the tool.started insert otherwise).
  // The group's `at` (its first child) is the same instant for a single running tool.
  const runningStartedAt = useMemo(() => {
    for (let index = entry.entries.length - 1; index >= 0; index -= 1) {
      const child = entry.entries[index];
      if (!child) {
        continue;
      }
      const block = projectionItemToDetailBlock(child.item);
      if (block?.kind === "action" && block.lifecycle === "running" && block.startedAt) {
        return block.startedAt;
      }
    }
    return entry.at;
  }, [entry]);
  const runningElapsedMs = useTurnDurationMs(runningStartedAt, undefined, lifecycle === "running");
  const { topLevel, nestedByParent } = useMemo(
    () => partitionCodemodeToolGroupChildren(entry.entries),
    [entry.entries],
  );
  useEffect(() => {
    if (remainingMs <= 0) {
      return;
    }
    const timer = window.setTimeout(() => setDisplayClock((value) => value + 1), remainingMs);
    return () => window.clearTimeout(timer);
  }, [remainingMs, displayClock]);
  const imageToolUseIds = [
    ...new Set(
      entry.entries
        .map((child) => readImageGenerationToolUseId(child.item))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const imageToolUseId = imageToolUseIds.length === 1 ? imageToolUseIds[0] : undefined;
  return (
    <div className={["run-log-tool-group", expanded ? "is-expanded" : ""].filter(Boolean).join(" ")}>
      <RunLogCollapsibleActionTrigger
        icon={summary.icon}
        label={
          lifecycle === "running" ? (
            <>
              <ShimmerText>{summary.label}</ShimmerText>
              {runningElapsedMs > TOOL_ELAPSED_MIN_VISIBLE_MS ? (
                <span className="run-log-tool-group-elapsed">{formatDuration(runningElapsedMs)}</span>
              ) : null}
            </>
          ) : (
            summary.label
          )
        }
        {...(lifecycle && { lifecycle })}
        expanded={expanded}
        onClick={() => {
          setExpanded((value) => !value);
          if (imageToolUseId) onOpenImageGenerationTool?.(imageToolUseId);
        }}
      />
      {expanded ? (
        <div className="run-log-tool-group-details">
          {topLevel.map((child) => {
            const toolUseId = child.kind === "timeline" ? readProjectionToolUseId(child.item) : undefined;
            const nestedChildren = toolUseId ? nestedByParent.get(toolUseId) : undefined;
            return (
              <ProjectionToolGroupChildEntry
                key={child.key}
                entry={child}
                requestSpansById={requestSpansById}
                {...(nestedChildren && nestedChildren.length > 0 ? { nestedChildren } : {})}
                {...(onOpenImageGenerationTool && { onOpenImageGenerationTool })}
                {...(onOpenImageDisplayTool && { onOpenImageDisplayTool })}
                {...(onLoadProjectionDetail && { onLoadProjectionDetail })}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export interface ToolGroupDisplayState {
  summary: { label: string; icon: ActivityActionIcon };
  lifecycle?: ToolActionLifecycle;
  /** ms until the minimum-visible "running" extension ends (0 when settled display applies). */
  remainingMs: number;
}

/**
 * Settled tool groups keep their "running" display until TOOL_RUNNING_MIN_VISIBLE_MS
 * has elapsed since the latest action started, so fast tools do not flash past. The
 * window is derived from item timestamps — a settled action's item is its completion
 * event (possibly a merged started+completed) that started at `at - durationMs` — so
 * the feed tail can share the exact same window: a settling tool row must never
 * render alongside the「正在思考」tail state.
 */
type ToolGroupChildEntry = ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry;

/**
 * A codemode script calls the tools itself, so PI emits those calls as tool events carrying the
 * script's `parentToolCallId`. They are not model-issued calls: they belong inside the script's
 * card. Left as siblings they dominate the group header ("已执行 12 个工具") and the one thing
 * that actually happened — the script — disappears from the summary.
 */
function partitionCodemodeToolGroupChildren(entries: readonly ToolGroupChildEntry[]): {
  topLevel: ToolGroupChildEntry[];
  nestedByParent: Map<string, ToolGroupChildEntry[]>;
} {
  const scriptIds = new Set<string>();
  for (const child of entries) {
    if (child.kind !== "timeline") {
      continue;
    }
    const tool = readProjectionToolMetadata(child.item);
    if (!tool || !isCodemodeToolName(tool.name)) {
      continue;
    }
    const toolUseId = readProjectionToolUseId(child.item);
    if (toolUseId) {
      scriptIds.add(toolUseId);
    }
  }
  if (scriptIds.size === 0) {
    return { topLevel: [...entries], nestedByParent: new Map() };
  }
  const topLevel: ToolGroupChildEntry[] = [];
  const nestedByParent = new Map<string, ToolGroupChildEntry[]>();
  for (const child of entries) {
    const parentId = child.kind === "timeline" ? readProjectionParentToolCallId(child.item) : undefined;
    if (parentId && scriptIds.has(parentId)) {
      const siblings = nestedByParent.get(parentId) ?? [];
      siblings.push(child);
      nestedByParent.set(parentId, siblings);
      continue;
    }
    topLevel.push(child);
  }
  return { topLevel, nestedByParent };
}

export function resolveToolGroupDisplayState(
  entries: readonly (ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry)[],
  nowMs: number,
): ToolGroupDisplayState {
  // The header describes what the model asked for; a script's own calls are described by the
  // script's card, so they stay out of the count and out of the lifecycle.
  const { topLevel } = partitionCodemodeToolGroupChildren(entries);
  const blocks = topLevel
    .map((child) => projectionItemToDetailBlock(child.item))
    .filter(
      (block): block is ToolGroupDetailBlock => block?.kind === "action" || block?.kind === "tool-failed",
    );
  const summary = summarizeActionBlocks(blocks);
  const lifecycle = resolveActionBlocksLifecycle(blocks);
  if (lifecycle === "running") {
    return { summary, lifecycle, remainingMs: 0 };
  }
  const extensionEndMs = resolveToolGroupSettledExtensionEndMs(topLevel);
  if (extensionEndMs !== undefined && extensionEndMs > nowMs) {
    return {
      summary: resolveToolGroupRunningLabel(topLevel) ?? summary,
      lifecycle: "running",
      remainingMs: extensionEndMs - nowMs,
    };
  }
  return { summary, ...(lifecycle && { lifecycle }), remainingMs: 0 };
}

/**
 * End of the minimum-visible window for a settled tool group, or undefined when no
 * settled action is inside (or recently closed) the window.
 */
export function resolveToolGroupSettledExtensionEndMs(
  entries: readonly (ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry)[],
): number | undefined {
  let endMs: number | undefined;
  for (const child of entries) {
    const block = projectionItemToDetailBlock(child.item);
    // Only actions that finished running settle into the extension window.
    if (block?.kind !== "action" || (block.lifecycle !== "completed" && block.lifecycle !== "failed")) {
      continue;
    }
    const endedAtMs = Date.parse(child.item.at);
    if (Number.isNaN(endedAtMs)) {
      continue;
    }
    const durationMs = readSettledToolDurationMs(child.item);
    const candidate = endedAtMs - (durationMs ?? 0) + TOOL_RUNNING_MIN_VISIBLE_MS;
    if (endMs === undefined || candidate > endMs) {
      endMs = candidate;
    }
  }
  return endMs;
}

function readSettledToolDurationMs(item: ThreadRunProjectionTimelineItem): number | undefined {
  const durationMs = readProjectionToolMetadata(item)?.durationMs;
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : undefined;
}

/** Label shown while a settled group still presents its minimum "running" window. */
function resolveToolGroupRunningLabel(
  entries: readonly (ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry)[],
): { label: string; icon: ActivityActionIcon } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const child = entries[index];
    if (!child) {
      continue;
    }
    const block = projectionItemToDetailBlock(child.item);
    if (block?.kind !== "action") {
      continue;
    }
    return { label: formatBlockActionLine(block, "running"), icon: block.icon };
  }
  return undefined;
}

function ProjectionToolGroupChildEntry({
  entry,
  requestSpansById,
  nestedChildren,
  onOpenImageGenerationTool,
  onOpenImageDisplayTool,
  onLoadProjectionDetail,
}: {
  entry: ThreadRunProjectionTimelineFeedEntry | ThreadRunProjectionAgentEchoFeedEntry;
  requestSpansById: Map<string, ThreadRunProjectionSnapshot["requestSpans"][number]>;
  /** Tool calls a codemode script made; rendered inside that script's card. */
  nestedChildren?: ToolGroupChildEntry[];
  onOpenImageGenerationTool?: OpenImageGenerationToolHandler;
  onOpenImageDisplayTool?: OpenImageDisplayToolHandler;
  onLoadProjectionDetail?: ProjectionDetailLoader;
}) {
  const block = projectionItemToDetailBlock(entry.item);
  const toolUseId = readProjectionToolUseId(entry.item);
  if (block?.kind === "action" && block.bashRun) {
    return (
      <ProjectionToolGroupBashChild
        block={block}
        {...(toolUseId && { toolUseId })}
        detailLoaded={entry.item.contentLoaded === true}
        {...(onLoadProjectionDetail && { onLoadProjectionDetail })}
      />
    );
  }
  if (block?.kind === "tool-failed" && !block.recoveredResult && block.tool.trim().toLowerCase() === "bash") {
    return (
      <ProjectionToolGroupBashChild
        block={block}
        {...(toolUseId && { toolUseId })}
        detailLoaded={entry.item.contentLoaded === true}
        {...(onLoadProjectionDetail && { onLoadProjectionDetail })}
      />
    );
  }
  if (block?.kind === "action" && block.codemodeRun) {
    return (
      <ProjectionToolGroupCodemodeChild
        block={block}
        {...(nestedChildren ? { nestedChildren } : {})}
        requestSpansById={requestSpansById}
        {...(onOpenImageGenerationTool && { onOpenImageGenerationTool })}
        {...(onOpenImageDisplayTool && { onOpenImageDisplayTool })}
        {...(onLoadProjectionDetail && { onLoadProjectionDetail })}
      />
    );
  }
  if (entry.kind === "timeline") {
    return (
      <ProjectionTimelineEntry
        item={entry.item}
        requestSpansById={requestSpansById}
        {...(block?.kind === "action" && {
          actionLabelOverride: formatToolGroupChildDetail(block),
        })}
        compact
        forceActionDetailsExpanded={Boolean(
          block?.kind === "action" && (block.webSearch || readTtsToolUseId(entry.item)),
        )}
        {...(onOpenImageGenerationTool && { onOpenImageGenerationTool })}
        {...(onOpenImageDisplayTool && { onOpenImageDisplayTool })}
      />
    );
  }
  return (
    <ProjectionAgentEchoEntry
      entry={entry}
      requestSpansById={requestSpansById}
      forceActionDetailsExpanded={Boolean(
        block?.kind === "action" && (block.webSearch || readTtsToolUseId(entry.item)),
      )}
    />
  );
}

function ProjectionToolGroupBashChild({
  block,
  toolUseId,
  detailLoaded = false,
  onLoadProjectionDetail,
}: {
  block:
    | Extract<ActivityDetailBlock, { kind: "action" }>
    | Extract<ActivityDetailBlock, { kind: "tool-failed" }>;
  toolUseId?: string;
  detailLoaded?: boolean;
  onLoadProjectionDetail?: ProjectionDetailLoader;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadedLocally, setLoadedLocally] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const bashRun =
    block.kind === "action"
      ? block.bashRun
      : {
          ...(block.command && { command: block.command }),
          ...(block.error && { output: block.error }),
        };
  if (!bashRun) {
    return null;
  }
  const canLoadDetails = Boolean(toolUseId && onLoadProjectionDetail);
  const hasDetails = Boolean(bashRun.command || bashRun.output || canLoadDetails);
  const summary =
    block.kind === "tool-failed"
      ? summarizeFailedTool(block.tool, block.command)
      : formatToolGroupChildDetail(block);
  const lifecycle = block.kind === "tool-failed" ? "failed" : block.lifecycle;
  const icon = block.kind === "tool-failed" ? iconForToolName(block.tool) : block.icon;

  return (
    <div className={`run-log-tool-group-child${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className={[
          "run-log-tool-group-trigger",
          "run-log-tool-group-child-trigger",
          lifecycle === "running" ? "is-running" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => {
          if (!hasDetails) return;
          const next = !expanded;
          setExpanded(next);
          if (next && toolUseId && onLoadProjectionDetail && !loading && !detailLoaded && !loadedLocally) {
            setLoadError(undefined);
            setLoading(true);
            void onLoadProjectionDetail("tool", toolUseId)
              .then(() => setLoadedLocally(true))
              .catch((error) => setLoadError(error instanceof Error ? error.message : String(error)))
              .finally(() => setLoading(false));
          }
        }}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        <RunLogActionIcon icon={icon} />
        <span className="run-log-tool-group-summary">
          {lifecycle === "running" ? <ShimmerText>{summary}</ShimmerText> : summary}
        </span>
        {lifecycle === "failed" ? (
          <span className="run-log-tool-status-dot" title={i18n.t("activity.incomplete")} aria-hidden />
        ) : null}
        {hasDetails ? (
          <ChevronRight
            size={15}
            className={`run-log-tool-group-chevron${expanded ? " open" : ""}`}
            aria-hidden
          />
        ) : null}
      </button>
      {expanded ? (
        <div className="run-log-tool-group-child-details">
          {loading ? <div className="run-log-tool-detail-loading" aria-busy="true" /> : null}
          {loadError ? (
            <button
              type="button"
              className="run-log-tool-detail-error"
              onClick={() => {
                if (!toolUseId || !onLoadProjectionDetail || loading) return;
                setLoadError(undefined);
                setLoading(true);
                void onLoadProjectionDetail("tool", toolUseId)
                  .then(() => setLoadedLocally(true))
                  .catch((error) => setLoadError(error instanceof Error ? error.message : String(error)))
                  .finally(() => setLoading(false));
              }}
            >
              <span>{loadError}</span>
              <span>{i18n.t("common.retry")}</span>
            </button>
          ) : null}
          <RunLogBashTerminal
            {...(bashRun.command && { command: bashRun.command })}
            {...(bashRun.output && { output: bashRun.output })}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * PI's codemode card: the script the model wrote, the calls that script made, and what the script
 * returned. The nested calls never reach the model as tool calls, so this card is their only
 * record — but all three panes stay behind the row, like every other tool child: a script and its
 * call list are the tallest blocks in the Feed, and a group that opens with them pushes the actual
 * answer out of view. The row's call-count badge is what says there is something to open.
 */
function ProjectionToolGroupCodemodeChild({
  block,
  nestedChildren = [],
  requestSpansById,
  onOpenImageGenerationTool,
  onOpenImageDisplayTool,
  onLoadProjectionDetail,
}: {
  block: Extract<ActivityDetailBlock, { kind: "action" }>;
  nestedChildren?: ToolGroupChildEntry[];
  requestSpansById: Map<string, ThreadRunProjectionSnapshot["requestSpans"][number]>;
  onOpenImageGenerationTool?: OpenImageGenerationToolHandler;
  onOpenImageDisplayTool?: OpenImageDisplayToolHandler;
  onLoadProjectionDetail?: ProjectionDetailLoader;
}) {
  const [expanded, setExpanded] = useState(false);
  const callCount = countCodemodeCalls(block, nestedChildren);
  const summary = formatToolGroupChildDetail(block);
  const lifecycle = block.lifecycle;
  const hasDetails = Boolean(
    block.codemodeRun?.script?.trim() || block.codemodeRun?.output?.trim() || callCount > 0,
  );
  return (
    <div className={`run-log-tool-group-child run-log-codemode${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className={[
          "run-log-tool-group-trigger",
          "run-log-tool-group-child-trigger",
          lifecycle === "running" ? "is-running" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        <RunLogActionIcon icon={block.icon} {...(lifecycle && { lifecycle })} />
        <span className="run-log-tool-group-summary">
          {lifecycle === "running" ? <ShimmerText>{summary}</ShimmerText> : summary}
        </span>
        {callCount > 0 ? (
          <span className="run-log-codemode-count">
            {i18n.t("activity.codemode.callCount", { count: callCount })}
          </span>
        ) : null}
        {lifecycle === "failed" ? (
          <span className="run-log-tool-status-dot" title={i18n.t("activity.incomplete")} aria-hidden />
        ) : null}
        {hasDetails ? (
          <ChevronRight
            size={15}
            className={`run-log-tool-group-chevron${expanded ? " open" : ""}`}
            aria-hidden
          />
        ) : null}
      </button>
      {expanded ? (
        <ProjectionCodemodeDetails
          block={block}
          nestedChildren={nestedChildren}
          requestSpansById={requestSpansById}
          {...(onOpenImageGenerationTool && { onOpenImageGenerationTool })}
          {...(onOpenImageDisplayTool && { onOpenImageDisplayTool })}
          {...(onLoadProjectionDetail && { onLoadProjectionDetail })}
        />
      ) : null}
    </div>
  );
}

/**
 * The three panes of a codemode card. Split out so the collapsed row above stays a row: the
 * disclosure decision and the content it hides are separate questions.
 */
export function ProjectionCodemodeDetails({
  block,
  nestedChildren = [],
  requestSpansById,
  onOpenImageGenerationTool,
  onOpenImageDisplayTool,
  onLoadProjectionDetail,
}: {
  block: Extract<ActivityDetailBlock, { kind: "action" }>;
  nestedChildren?: ToolGroupChildEntry[];
  requestSpansById: Map<string, ThreadRunProjectionSnapshot["requestSpans"][number]>;
  onOpenImageGenerationTool?: OpenImageGenerationToolHandler;
  onOpenImageDisplayTool?: OpenImageDisplayToolHandler;
  onLoadProjectionDetail?: ProjectionDetailLoader;
}) {
  const script = block.codemodeRun?.script?.trim() ?? "";
  const output = block.codemodeRun?.output?.trim() ?? "";
  const fullOutputPath = block.codemodeRun?.fullOutputPath?.trim() ?? "";
  const detailCallRows = resolveCodemodeDetailCallRows(block, nestedChildren);
  const callCount = nestedChildren.length + detailCallRows.length;
  return (
    <div className="run-log-codemode-details">
      {script ? <RunLogCodemodeScript script={script} /> : null}
      {callCount > 0 ? (
        <div className="run-log-codemode-calls">
          <div className="run-log-codemode-section-label">{i18n.t("activity.codemode.callsLabel")}</div>
          {/* The label stays put and only the rows scroll: a 60-call script must not push the
              script and its output out of view. */}
          <div className="run-log-codemode-calls-list">
            {nestedChildren.map((child) => (
              <ProjectionToolGroupChildEntry
                key={child.key}
                entry={child}
                requestSpansById={requestSpansById}
                {...(onOpenImageGenerationTool && { onOpenImageGenerationTool })}
                {...(onOpenImageDisplayTool && { onOpenImageDisplayTool })}
                {...(onLoadProjectionDetail && { onLoadProjectionDetail })}
              />
            ))}
            {detailCallRows.map(({ call, key }) => (
              <div className="run-log-codemode-call" key={key}>
                <span className={`run-log-codemode-call-status is-${call.status ?? "ok"}`} aria-hidden>
                  {codemodeCallGlyph(call.status)}
                </span>
                <span className="run-log-codemode-call-name">{call.name}</span>
                {call.args ? <span className="run-log-codemode-call-args">{call.args}</span> : null}
                {call.durationMs !== undefined ? (
                  <span className="run-log-codemode-call-meta">{formatDuration(call.durationMs)}</span>
                ) : null}
                {call.cost !== undefined ? (
                  <span className="run-log-codemode-call-meta">
                    {i18n.t("activity.codemode.modelCost", { cost: call.cost.toFixed(3) })}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {output ? (
        <div className="run-log-codemode-output">
          <div className="run-log-codemode-section-label">{i18n.t("activity.codemode.outputLabel")}</div>
          <RunLogBashOutput output={output} />
        </div>
      ) : null}
      {fullOutputPath ? (
        <div className="run-log-codemode-full-output">
          {i18n.t("activity.codemode.fullOutput", { path: fullOutputPath })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * PI gives each nested call the id of the tool event it caused, so any call that reached the tool
 * pipeline is in both lists: as a full row, and as one of the script's own records. Keep the row,
 * and keep only the records with no row — the calls cancelled when the script ended, which never
 * produced one. A record with no id is kept: it cannot be matched, and losing it is worse.
 */
function resolveCodemodeDetailCallRows(
  block: Extract<ActivityDetailBlock, { kind: "action" }>,
  nestedChildren: readonly ToolGroupChildEntry[],
): { call: ThreadRunCodemodeCallMetadata; key: string }[] {
  const nestedCallIds = new Set(
    nestedChildren
      .map((child) => (child.kind === "timeline" ? readProjectionToolUseId(child.item) : undefined))
      .filter((id): id is string => Boolean(id)),
  );
  return (block.codemodeRun?.calls ?? [])
    .filter((call) => !call.id || !nestedCallIds.has(call.id))
    .map((call, index) => ({
      call,
      key: call.id ?? `${call.name}:${index}`,
    }));
}

function countCodemodeCalls(
  block: Extract<ActivityDetailBlock, { kind: "action" }>,
  nestedChildren: readonly ToolGroupChildEntry[],
): number {
  return nestedChildren.length + resolveCodemodeDetailCallRows(block, nestedChildren).length;
}

/** Same glyphs PI's TUI uses for the calls a script made. */
function codemodeCallGlyph(status: "running" | "ok" | "error" | "cancelled" | undefined): string {
  switch (status) {
    case "running":
      return "…";
    case "error":
      return "✗";
    case "cancelled":
      return "⊘";
    default:
      return "✓";
  }
}

function RunLogCodemodeScript({ script }: { script: string }) {
  return (
    <div className="run-log-codemode-script">
      <div className="run-log-codemode-script-head">
        <span className="run-log-codemode-section-label">{i18n.t("activity.codemode.scriptLabel")}</span>
        <button
          type="button"
          className="run-log-bash-copy"
          onClick={(event) => {
            event.stopPropagation();
            copyRunLogMessageText(script);
          }}
          aria-label={i18n.t("activity.codemode.copyScript")}
          title={i18n.t("activity.codemode.copyScript")}
        >
          <Copy size={13} aria-hidden />
        </button>
      </div>
      <pre className="run-log-bash-command-text">{script}</pre>
    </div>
  );
}

function summarizeActionBlocks(blocks: readonly ToolGroupDetailBlock[]): {
  label: string;
  icon: ActivityActionIcon;
} {
  const actionBlocks = blocks.filter(
    (block): block is Extract<ActivityDetailBlock, { kind: "action" }> => block.kind === "action",
  );
  const failedBlocks = blocks.filter(
    (block): block is Extract<ActivityDetailBlock, { kind: "tool-failed" }> => block.kind === "tool-failed",
  );
  // Every group child is one tool call. A group holding a single tool call keeps that
  // tool's own failure copy ("运行了命令", "编辑了 panel.ts", recovered-patch notices).
  // A group that aggregates several calls has to describe all of them
  // ("已运行 4 条命令和已处理 1 张图像") — otherwise a single failed image / HTML tool
  // retitles the aggregate ("已查看 1 张图像") and hides every action next to it.
  if (blocks.length === 1) {
    const block = blocks[0];
    if (block?.kind === "tool-failed") {
      const commandHeader =
        resolveActionKind({
          toolName: block.tool,
          ...(block.command && {
            payload: { bashRun: { command: block.command } },
          }),
        }).kind === "command"
          ? {
              label: translateActionKind("activity.done.command.fallback"),
              icon: iconForToolName(block.tool),
            }
          : undefined;
      return {
        label: block.recoveredResult
          ? i18n.t("activity.patchRecovered")
          : (commandHeader?.label ??
            summarizeFailedTool(
              block.tool,
              block.command,
              block.fileChange ? { fileChange: block.fileChange } : undefined,
            )),
        icon: commandHeader?.icon ?? iconForToolName(block.tool),
      };
    }
  }

  let runningBlock: Extract<ActivityDetailBlock, { kind: "action" }> | undefined;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind === "action" && block.lifecycle === "running") {
      runningBlock = block;
      break;
    }
  }
  if (runningBlock) {
    return {
      label: formatBlockActionLine(runningBlock, "running"),
      icon: runningBlock.icon,
    };
  }
  if (actionBlocks.length === 1 && actionBlocks[0] && failedBlocks.length === 0) {
    return (
      summarizeSingleCommandGroupHeader(actionBlocks[0], "done") ?? {
        label: formatBlockActionLine(actionBlocks[0], "done"),
        icon: actionBlocks[0].icon,
      }
    );
  }

  const fileBucketKeys = new Map<ActionGroupBucket, Set<string>>();
  const items: ResolvedAction[] = [];
  const pushAction = (action: ResolvedAction, targetKey: string) => {
    if (
      action.bucket === "readFiles" ||
      action.bucket === "writtenFiles" ||
      action.bucket === "editedFiles"
    ) {
      let seen = fileBucketKeys.get(action.bucket);
      if (!seen) {
        seen = new Set();
        fileBucketKeys.set(action.bucket, seen);
      }
      if (seen.has(targetKey)) {
        return;
      }
      seen.add(targetKey);
    }
    items.push(action);
  };
  for (const block of actionBlocks) {
    pushAction(resolveBlockAction(block), actionBlockTargetKey(block));
  }
  // Failed tools count into the aggregate too: the header claims what the group holds,
  // while the failure itself stays visible on the child row.
  for (const block of failedBlocks) {
    pushAction(
      resolveFailedBlockAction(block),
      block.command ?? block.fileChange?.path ?? block.fileChange?.fileName ?? "",
    );
  }

  return summarizeActionGroup(items, translateActionKind);
}

/** Bucket a failed tool by what it tried to do, so aggregates count it like its siblings. */
function resolveFailedBlockAction(
  block: Extract<ActivityDetailBlock, { kind: "tool-failed" }>,
): ResolvedAction {
  const fileChange = block.fileChange as ActionKindPayload["fileChange"] | undefined;
  const payload: ActionKindPayload = {};
  if (block.command) {
    payload.bashRun = { command: block.command };
  }
  if (fileChange) {
    payload.fileChange = fileChange;
  }
  return resolveActionKind({ toolName: block.tool, payload });
}

function translateActionKind(key: string, vars?: Record<string, string | number>): string {
  return vars ? i18n.t(key, vars) : i18n.t(key);
}

function resolveBlockAction(block: Extract<ActivityDetailBlock, { kind: "action" }>): ResolvedAction {
  return resolveActionKind({
    ...(block.toolName ? { toolName: block.toolName } : {}),
    payload: {
      ...(block.fileChange && { fileChange: block.fileChange }),
      ...(block.readTarget && { readTarget: block.readTarget }),
      ...(block.grepTarget && { grepTarget: block.grepTarget }),
      ...(block.webSearch && { webSearch: block.webSearch }),
      ...(block.mcpDiscovery && { mcpDiscovery: block.mcpDiscovery }),
      ...(block.imageView && { imageView: block.imageView }),
      ...(block.imageDisplay && { imageDisplay: block.imageDisplay }),
      ...(block.htmlHost && { htmlHost: block.htmlHost }),
      ...(block.bashRun && { bashRun: block.bashRun }),
    },
  });
}

function formatBlockActionLine(
  block: Extract<ActivityDetailBlock, { kind: "action" }>,
  phase: "running" | "done",
): string {
  // Skill reads carry a self-contained label ("读取 <name> 技能"); do not prepend
  // the generic read verb again ("读取了 读取 … 技能").
  const skillLabel = isSkillActivityLabel(block.label.trim()) ? block.label.trim() : undefined;
  if (skillLabel) {
    return skillLabel;
  }
  return formatActionLine(
    {
      resolved: resolveBlockAction(block),
      phase,
      rawTarget: actionBlockTargetKey(block),
      payload: {
        ...(block.fileChange && { fileChange: block.fileChange }),
        ...(block.readTarget && { readTarget: block.readTarget }),
        ...(block.grepTarget && { grepTarget: block.grepTarget }),
        ...(block.webSearch && { webSearch: block.webSearch }),
        ...(block.bashRun && { bashRun: block.bashRun }),
        ...(block.imageView && { imageView: block.imageView }),
        ...(block.imageDisplay && { imageDisplay: block.imageDisplay }),
        ...(block.htmlHost && { htmlHost: block.htmlHost }),
      },
    },
    translateActionKind,
  );
}

function summarizeSingleCommandGroupHeader(
  block: Extract<ActivityDetailBlock, { kind: "action" }>,
  phase: "running" | "done",
): { label: string; icon: ActivityActionIcon } | undefined {
  if (resolveBlockAction(block).kind !== "command") {
    return undefined;
  }
  return {
    label:
      phase === "done"
        ? translateActionKind("activity.done.command.fallback")
        : translateActionKind("activity.running.command", { suffix: "" }),
    icon: block.icon,
  };
}

function formatToolGroupChildDetail(block: Extract<ActivityDetailBlock, { kind: "action" }>): string {
  return formatBlockActionLine(block, "done");
}

function summarizeFailedTool(
  tool: string,
  command?: string,
  sibling?: {
    label?: string;
    fileChange?: { path?: string; fileName?: string };
    readTarget?: Extract<ActivityDetailBlock, { kind: "action" }>["readTarget"];
    webSearch?: Extract<ActivityDetailBlock, { kind: "action" }>["webSearch"];
    bashRun?: Extract<ActivityDetailBlock, { kind: "action" }>["bashRun"];
  },
): string {
  const action: Extract<ActivityDetailBlock, { kind: "action" }> = {
    kind: "action",
    icon: iconForToolName(tool),
    label: sibling?.label ?? "",
    toolName: tool,
  };
  if (command) {
    action.bashRun = { title: command, command };
  } else if (sibling?.bashRun) {
    action.bashRun = sibling.bashRun;
  }
  if (sibling?.fileChange) {
    const fileChange = sibling.fileChange as Extract<ActivityDetailBlock, { kind: "action" }>["fileChange"];
    if (fileChange) {
      action.fileChange = fileChange;
    }
  }
  if (sibling?.readTarget) {
    action.readTarget = sibling.readTarget;
  }
  if (sibling?.webSearch) {
    action.webSearch = sibling.webSearch;
  }
  return formatBlockActionLine(action, "done");
}

function actionBlockTargetKey(block: Extract<ActivityDetailBlock, { kind: "action" }>): string {
  const fallbackLabel = block.label.replace(/\s+\(\d+(?:\.\d+)?s\)\s*$/u, "").trim();
  // When the row label is just the tool's generic verb label (e.g. PI's lowercase
  // `read` with no target detail), there is no real target to show after the verb.
  const genericLabel = block.toolName
    ? formatToolDisplayLabel(block.toolName, undefined, translateActionKind)
    : undefined;
  const meaningfulLabel = genericLabel && fallbackLabel === genericLabel ? "" : fallbackLabel;
  return (
    block.webSearch?.query ||
    block.fileChange?.path ||
    block.fileChange?.fileName ||
    block.readTarget?.filePath ||
    block.readTarget?.fileName ||
    block.grepTarget?.path ||
    meaningfulLabel ||
    ""
  );
}

function resolveActionBlocksLifecycle(
  blocks: readonly ToolGroupDetailBlock[],
): ToolActionLifecycle | undefined {
  const lifecycles = blocks
    .filter((block): block is Extract<ActivityDetailBlock, { kind: "action" }> => block.kind === "action")
    .map((block) => block.lifecycle)
    .filter((value): value is ToolActionLifecycle => Boolean(value));
  if (lifecycles.includes("failed")) {
    return "failed";
  }
  if (lifecycles.includes("running")) {
    return "running";
  }
  if (lifecycles.includes("approval-pending")) {
    return "approval-pending";
  }
  if (lifecycles.includes("approval-rejected")) {
    return "approval-rejected";
  }
  if (lifecycles.includes("approval-approved")) {
    return "approval-approved";
  }
  return lifecycles.length > 0 ? "completed" : undefined;
}

type SubagentDetailFeedEntry = ThreadRunProjectionTimelineFeedEntry;
type SubagentDetailDisplayEntry = SubagentDetailFeedEntry | ThreadRunProjectionToolGroupFeedEntry;

interface SubagentDetailTurn {
  key: string;
  prompt?: SubagentDetailFeedEntry;
  entries: SubagentDetailDisplayEntry[];
  finalResult?: SubagentDetailFeedEntry;
  running: boolean;
  startedAt: string;
  endedAt?: string;
  projectedDurationMs?: number;
}

function groupSubagentDetailFeedEntries(
  entries: readonly SubagentDetailFeedEntry[],
): SubagentDetailDisplayEntry[] {
  const grouped: SubagentDetailDisplayEntry[] = [];
  let pending: SubagentDetailFeedEntry[] = [];

  const flush = () => {
    const first = pending[0];
    if (first) {
      grouped.push({
        kind: "tool-group",
        key: `subagent-tool-group:${first.key}`,
        entries: pending,
        at: first.at,
        sequence: first.sequence,
      });
    }
    pending = [];
  };

  for (const entry of entries) {
    const block = projectionItemToDetailBlock(entry.item);
    if (block?.kind === "action" || block?.kind === "tool-failed") {
      pending.push(entry);
      continue;
    }
    flush();
    grouped.push(entry);
  }
  flush();
  return grouped;
}

function buildSubagentDetailTurns(
  entries: readonly SubagentDetailFeedEntry[],
  agent: ThreadRunProjectionAgent,
): SubagentDetailTurn[] {
  const running = agent.status === "active" || agent.status === "launching";
  const rawTurns: Array<{
    key: string;
    prompt?: SubagentDetailFeedEntry;
    entries: SubagentDetailFeedEntry[];
    startedAt: string;
  }> = [];
  let current: (typeof rawTurns)[number] | undefined;

  for (const entry of entries) {
    if (isProjectionSubagentPromptItem(entry.item)) {
      current = {
        key: `subagent-turn:${entry.item.requestId ?? entry.item.id}`,
        prompt: entry,
        entries: [],
        startedAt: entry.at,
      };
      rawTurns.push(current);
      continue;
    }
    if (!current) {
      current = {
        key: `subagent-turn:initial:${entry.item.requestId ?? entry.item.id}`,
        entries: [],
        startedAt: entry.at,
      };
      rawTurns.push(current);
    }
    current.entries.push(entry);
  }

  return rawTurns.map((turn, index) => {
    const turnRunning = running && index === rawTurns.length - 1;
    const finalResult = turnRunning ? undefined : resolveSubagentTurnFinalResult(turn.entries);
    const processEntries = (
      finalResult ? turn.entries.filter((entry) => entry.item.id !== finalResult.item.id) : turn.entries
    ).filter((entry) => !isDuplicateSubagentTurnResultPhase(entry, finalResult));
    const nextTurn = rawTurns[index + 1];
    const startedAt = index === 0 ? agent.startedAt : turn.startedAt;
    const endedAt = turnRunning
      ? undefined
      : (nextTurn?.startedAt ?? agent.endedAt ?? turn.entries.at(-1)?.at);
    return {
      key: turn.key,
      ...(turn.prompt && { prompt: turn.prompt }),
      entries: groupSubagentDetailFeedEntries(processEntries),
      ...(finalResult && { finalResult }),
      running: turnRunning,
      startedAt,
      ...(endedAt && { endedAt }),
      ...(rawTurns.length === 1 && { projectedDurationMs: agent.durationMs }),
    };
  });
}

function resolveSubagentTurnFinalResult(
  entries: readonly SubagentDetailFeedEntry[],
): SubagentDetailFeedEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.item.eventType !== "message.final") {
      continue;
    }
    const block = projectionItemToDetailBlock(entry.item);
    if (block?.kind === "narrative" && !block.streaming && block.text.trim()) {
      return entry;
    }
  }
  return undefined;
}

function isDuplicateSubagentTurnResultPhase(
  entry: SubagentDetailFeedEntry,
  finalResult: SubagentDetailFeedEntry | undefined,
): boolean {
  if (!finalResult) {
    return false;
  }
  const block = projectionItemToDetailBlock(entry.item);
  return (
    block?.kind === "phase" &&
    entry.item.text.trim().replace(/\s+/gu, " ") === finalResult.item.text.trim().replace(/\s+/gu, " ")
  );
}

function projectionRequestSpanRenderSignature(span?: ProjectionRequestSpan): string {
  if (!span) {
    return "";
  }
  return [
    span.requestId,
    span.ownerAgentId ?? "",
    span.status,
    span.startedAt,
    span.firstTokenAt ?? "",
    span.endedAt ?? "",
    span.error ?? "",
    span.providerRequestId ?? "",
    span.outputTokens ?? "",
    span.pendingThinkingSince ?? "",
    span.pendingThinkingMessageId ?? "",
  ].join(":");
}

function projectionTimelineItemRenderSignature(item: ThreadRunProjectionTimelineItem): string {
  return (
    JSON.stringify([
      item.id,
      item.sequence,
      item.eventType,
      item.scope,
      item.role ?? "",
      item.agentId ?? "",
      item.requestId ?? "",
      item.streamKey ?? "",
      item.at,
      item.text,
      item.metadata ?? null,
    ]) ?? ""
  );
}

function projectionSubagentDetailEntrySignature(entry: SubagentDetailFeedEntry): string {
  return [
    "timeline",
    entry.key,
    entry.at,
    entry.sequence,
    projectionTimelineItemRenderSignature(entry.item),
  ].join(":");
}

function projectionSubagentDetailEntryRequestSpanSignature(
  entry: SubagentDetailFeedEntry,
  requestSpansById: ProjectionRequestSpansById,
): string {
  return projectionSubagentDetailTimelineRequestSpanSignature([entry.item], requestSpansById);
}

function projectionSubagentDetailTimelineRequestSpanSignature(
  timeline: readonly ThreadRunProjectionTimelineItem[],
  requestSpansById: ProjectionRequestSpansById,
): string {
  const requestIds = new Set<string>();
  const addItemRequestId = (item: ThreadRunProjectionTimelineItem) => {
    const requestId = item.requestId?.trim();
    if (requestId) {
      requestIds.add(requestId);
    }
  };

  for (const item of timeline) {
    addItemRequestId(item);
  }

  return [...requestIds]
    .sort()
    .map(
      (requestId) => `${requestId}:${projectionRequestSpanRenderSignature(requestSpansById.get(requestId))}`,
    )
    .join("|");
}

function useStableSubagentDetailFeedEntries(
  agentId: string,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): SubagentDetailFeedEntry[] {
  const cacheRef = useRef(new Map<string, { signature: string; entry: SubagentDetailFeedEntry }>());
  const agentIdRef = useRef(agentId);
  return useMemo(() => {
    if (agentIdRef.current !== agentId) {
      agentIdRef.current = agentId;
      cacheRef.current.clear();
    }
    const activeKeys = new Set<string>();
    const entries = timeline.map((item) => {
      const key = `subagent-timeline:${agentId}:${item.id}`;
      activeKeys.add(key);
      const signature = projectionTimelineItemRenderSignature(item);
      const cached = cacheRef.current.get(key);
      if (cached?.signature === signature) {
        return cached.entry;
      }
      const entry: SubagentDetailFeedEntry = {
        kind: "timeline",
        key,
        item,
        at: item.at,
        sequence: item.sequence,
      };
      cacheRef.current.set(key, { signature, entry });
      return entry;
    });
    for (const key of cacheRef.current.keys()) {
      if (!activeKeys.has(key)) {
        cacheRef.current.delete(key);
      }
    }
    return entries;
  }, [agentId, timeline]);
}

function areProjectionSubagentDetailFeedEntryPropsEqual(
  prev: {
    entry: SubagentDetailFeedEntry;
    requestSpansById: ProjectionRequestSpansById;
  },
  next: {
    entry: SubagentDetailFeedEntry;
    requestSpansById: ProjectionRequestSpansById;
  },
): boolean {
  return (
    projectionSubagentDetailEntrySignature(prev.entry) ===
      projectionSubagentDetailEntrySignature(next.entry) &&
    projectionSubagentDetailEntryRequestSpanSignature(prev.entry, prev.requestSpansById) ===
      projectionSubagentDetailEntryRequestSpanSignature(next.entry, next.requestSpansById)
  );
}

const ProjectionSubagentDetailFeedEntry = memo(function ProjectionSubagentDetailFeedEntry({
  entry,
  requestSpansById,
}: {
  entry: SubagentDetailFeedEntry;
  requestSpansById: ProjectionRequestSpansById;
}) {
  // Same feed-entry wrapper / spacing path as the main agent; only hide role chrome
  // because this surface is already scoped to one subagent.
  return (
    <ProjectionTimelineEntry item={entry.item} requestSpansById={requestSpansById} hideSubagentIdentity />
  );
}, areProjectionSubagentDetailFeedEntryPropsEqual);

function ProjectionSubagentTurn({
  turn,
  requestSpansById,
  pendingThinking = false,
}: {
  turn: SubagentDetailTurn;
  requestSpansById: ProjectionRequestSpansById;
  pendingThinking?: boolean;
}) {
  const waitingThinkingVisible =
    turn.running &&
    (turn.entries.length === 0 ||
      (pendingThinking &&
        !turn.entries.some(
          (entry) => isRunningToolFeedEntry(entry) || isRunningContextCompactionFeedEntry(entry),
        )));
  return (
    <RunLogTurnSection
      turnKey={turn.key}
      running={turn.running}
      startedAt={turn.startedAt}
      {...(turn.endedAt && { endedAt: turn.endedAt })}
      {...(turn.projectedDurationMs !== undefined && {
        projectedDurationMs: turn.projectedDurationMs,
      })}
      className="subagent-conversation-turn"
      processEmpty={turn.entries.length === 0}
      {...(turn.prompt && {
        leading: (
          <ProjectionSubagentDetailFeedEntry entry={turn.prompt} requestSpansById={requestSpansById} />
        ),
      })}
      process={
        <>
          {turn.entries.map((entry) =>
            entry.kind === "tool-group" ? (
              <Fragment key={entry.key}>
                {wrapRunLogFeedEntry(
                  <ProjectionToolGroupEntry entry={entry} requestSpansById={requestSpansById} />,
                  { tight: true },
                )}
              </Fragment>
            ) : (
              <ProjectionSubagentDetailFeedEntry
                key={entry.key}
                entry={entry}
                requestSpansById={requestSpansById}
              />
            ),
          )}
          {waitingThinkingVisible
            ? wrapRunLogFeedEntry(<WaitingThinkingBlock active />, {
                tight: true,
              })
            : null}
        </>
      }
      {...(turn.finalResult && {
        final: (
          <ProjectionSubagentDetailFeedEntry entry={turn.finalResult} requestSpansById={requestSpansById} />
        ),
      })}
    />
  );
}

function ProjectionAgentEchoEntry({
  entry,
  requestSpansById,
  forceActionDetailsExpanded = false,
  pacing = true,
}: {
  entry: Extract<ThreadRunProjectionMainFeedEntry, { kind: "agent-echo" }>;
  requestSpansById: Map<string, ThreadRunProjectionSnapshot["requestSpans"][number]>;
  forceActionDetailsExpanded?: boolean;
  pacing?: boolean;
}) {
  const block = projectionItemToDetailBlock(entry.item);
  const ttsToolUseId = readTtsToolUseId(entry.item);
  if (!block) {
    return null;
  }
  const requestSpan = entry.item.requestId ? requestSpansById.get(entry.item.requestId) : undefined;
  const requestActive = isProjectionRequestActive(requestSpan);

  if (block.kind === "narrative") {
    return (
      <ProjectionAgentEchoShell label={entry.agentLabel} agentId={entry.agent.agentId}>
        <RunLogNarrative
          text={block.text}
          createdAt={entry.item.at}
          {...(block.streaming !== undefined && { streaming: block.streaming })}
          pacing={pacing}
          omitSubagentBadge
          {...(requestSpan && { requestSpan })}
        />
      </ProjectionAgentEchoShell>
    );
  }
  if (block.kind === "thinking") {
    return (
      <ProjectionAgentEchoShell label={entry.agentLabel} agentId={entry.agent.agentId}>
        <ThinkingBlock
          text={block.text}
          {...(block.streaming !== undefined && { streaming: block.streaming })}
          pacing={pacing}
          {...(block.startedAt && { startedAt: block.startedAt })}
          {...(block.endedAt && { endedAt: block.endedAt })}
          {...(block.durationMs !== undefined && {
            durationMs: block.durationMs,
          })}
        />
      </ProjectionAgentEchoShell>
    );
  }
  if (block.kind === "reasoning-stage") {
    return (
      <ProjectionAgentEchoShell label={entry.agentLabel} agentId={entry.agent.agentId}>
        <WaitingThinkingBlock active label={block.label} />
      </ProjectionAgentEchoShell>
    );
  }
  return (
    <ProjectionAgentEchoShell label={entry.agentLabel} agentId={entry.agent.agentId}>
      <DetailBlock
        block={block}
        {...(ttsToolUseId && {
          actionDetails: <TtsFeedArtifacts toolUseIds={[ttsToolUseId]} />,
        })}
        requestActive={requestActive}
        hideSubagentIdentity
        forceActionDetailsExpanded={forceActionDetailsExpanded}
        {...(requestSpan && { requestSpan })}
      />
    </ProjectionAgentEchoShell>
  );
}

function ProjectionAgentEchoShell({
  label,
  agentId,
  children,
}: {
  label: string;
  agentId: string;
  children: ReactNode;
}) {
  return (
    <div className="run-log-agent-echo" data-agent-id={agentId}>
      <span className="run-log-subagent-badge run-log-agent-echo-badge" title={label}>
        {label}
      </span>
      {children}
    </div>
  );
}

function useLatchedAgentText(agentId: string, text: string): string {
  const latchRef = useRef<{ agentId: string; text: string }>({
    agentId: "",
    text: "",
  });
  if (latchRef.current.agentId !== agentId) {
    latchRef.current = { agentId, text: "" };
  }
  if (text) {
    latchRef.current.text = text;
  }
  return text || latchRef.current.text;
}

function ProjectionSubagentRunRow({
  agent,
  missionText: incomingMissionText,
  openable = true,
  selected,
  onOpen,
  agentDisplayNames,
  agentThemes,
}: {
  agent: ThreadRunProjectionAgent;
  missionText: string;
  openable?: boolean;
  selected: boolean;
  onOpen: () => void;
  agentDisplayNames?: RuntimeAgentDisplayNames;
  agentThemes?: RuntimeAgentThemes;
}) {
  const running = agent.status === "active" || agent.status === "launching";
  const liveDurationMs = useSubagentDurationMs(agent, running);

  const roleLabel =
    resolveRuntimeAgentName(agent.role, agentDisplayNames) ?? resolveSubagentRunDisplayTitle(agent.role);
  const titleLabel = resolveSubagentActivityTitle(roleLabel, agent.taskName);
  const rawStatus = resolveProjectionAgentStatusText(agent);
  const statusText =
    rawStatus && rawStatus !== roleLabel && rawStatus !== titleLabel
      ? rawStatus
      : agent.status === "active" || agent.status === "launching"
        ? i18n.t("activity.working")
        : openable
          ? i18n.t("activity.viewDetails")
          : "";
  const elapsedMs = running ? liveDurationMs : agent.durationMs;
  const elapsedLabel = formatDuration(elapsedMs);
  const durationLabel = elapsedLabel
    ? running
      ? elapsedLabel
      : i18n.t("activity.duration", { duration: elapsedLabel })
    : undefined;
  const missionText = useLatchedAgentText(agent.agentId, incomingMissionText);
  return (
    <div
      className={`subagent-run-row-wrap has-agent-id${running ? " is-running" : ""}${selected ? " is-expanded" : ""}${openable ? "" : " is-status-only"}`}
      data-agent-id={agent.agentId}
      data-role={normalizeAgentDisplayRole(agent.role) ?? agent.role}
      style={resolveSubagentRowThemeStyle(agent.role, agentThemes)}
    >
      <SubagentRunCardButton
        roleLabel={titleLabel}
        running={running}
        statusText={statusText}
        openable={openable}
        {...(missionText && { missionText })}
        {...(durationLabel && { durationLabel })}
        selected={selected}
        onOpen={onOpen}
      />
    </div>
  );
}

interface ProjectionSubagentDetailFeedProps {
  agent: ThreadRunProjectionAgent;
  missionText: string;
  images?: readonly PromptImagePreview[];
  requestSpansById: ProjectionRequestSpansById;
  threadActive: boolean;
  thinkingDisplayMode?: ThinkingDisplayMode;
}

function projectionSubagentDetailAgentSignature(agent: ThreadRunProjectionAgent): string {
  const usage = agent.usage;
  return [
    agent.agentId,
    agent.status,
    agent.endedAt ?? "",
    agent.mission ?? "",
    agent.delegationPrompt ?? "",
    agent.delegationSummary ?? "",
    agent.timeline.map(projectionTimelineItemRenderSignature).join("|"),
    usage
      ? [
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheCreationTokens,
          usage.ecoCostUsd,
          usage.modelId ?? "",
        ].join("/")
      : "",
    agent.context?.occupancyPct ?? "",
  ].join(":");
}

function areProjectionSubagentDetailFeedPropsEqual(
  prev: ProjectionSubagentDetailFeedProps,
  next: ProjectionSubagentDetailFeedProps,
): boolean {
  return (
    prev.missionText === next.missionText &&
    prev.thinkingDisplayMode === next.thinkingDisplayMode &&
    hasPendingAgentThinking(prev.agent, prev.requestSpansById) ===
      hasPendingAgentThinking(next.agent, next.requestSpansById) &&
    promptImagePreviewSignature(prev.images) === promptImagePreviewSignature(next.images) &&
    projectionSubagentDetailTimelineRequestSpanSignature(prev.agent.timeline, prev.requestSpansById) ===
      projectionSubagentDetailTimelineRequestSpanSignature(next.agent.timeline, next.requestSpansById) &&
    projectionSubagentDetailAgentSignature(prev.agent) === projectionSubagentDetailAgentSignature(next.agent)
  );
}

function isPendingThinkingWithoutContent(
  span: ProjectionRequestSpan,
  timeline: readonly ThreadRunProjectionTimelineItem[],
): boolean {
  if (!span.pendingThinkingSince) return false;
  return !timeline.some(
    (item) =>
      span.pendingThinkingMessageId !== undefined &&
      item.metadata?.conversationV2MessageId === span.pendingThinkingMessageId &&
      Boolean(item.text.trim()),
  );
}

function hasPendingAgentThinking(
  agent: ThreadRunProjectionAgent,
  spans: ProjectionRequestSpansById,
): boolean {
  for (const span of spans.values()) {
    if (span.ownerAgentId === agent.agentId && isPendingThinkingWithoutContent(span, agent.timeline))
      return true;
  }
  return false;
}

export const ProjectionSubagentDetailFeed = memo(function ProjectionSubagentDetailFeed({
  agent,
  missionText,
  images,
  requestSpansById,
  threadActive,
  thinkingDisplayMode,
}: ProjectionSubagentDetailFeedProps) {
  void threadActive;
  const feedRef = useRef<HTMLDivElement>(null);
  const userDetachedFromBottomRef = useRef(false);
  const scrollTopRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const delegation = readProjectionAgentDelegation(agent);
  const missionDisplay = resolveMissionDisplayText(
    missionText || delegation?.prompt || delegation?.summary || "",
  );
  const running = agent.status === "active" || agent.status === "launching";
  const resolvedThinkingDisplayMode = thinkingDisplayMode ?? readStoredThinkingDisplayPreferences().mode;
  const visibleTimeline = useMemo(() => {
    // Same display collapse core as the main feed; only subagent-specific noise /
    // mission suppression / consecutive-thinking join stay as surface adapters.
    const prepared = filterSubagentDetailTimelineNoise(agent.timeline);
    const collapsed = filterProjectionTimelineForDetailFeed(
      prepared,
      requestSpansById,
      true,
      resolvedThinkingDisplayMode,
      running,
    ).filter((item) => !shouldSuppressSubagentCardTimelineItem(item, missionDisplay));
    return collapseConsecutiveThinkingTimelineItems(collapsed);
  }, [agent.timeline, missionDisplay, requestSpansById, resolvedThinkingDisplayMode, running]);
  const detailFeedEntries = useStableSubagentDetailFeedEntries(agent.agentId, visibleTimeline);
  const turns = useMemo(() => buildSubagentDetailTurns(detailFeedEntries, agent), [agent, detailFeedEntries]);
  const pendingThinking = running && hasPendingAgentThinking(agent, requestSpansById);
  const latestTimelineItem = visibleTimeline.at(-1);
  const layoutSignature = [
    agent.agentId,
    agent.status,
    missionDisplay.length,
    turns.length,
    latestTimelineItem?.id ?? "",
    latestTimelineItem?.text.length ?? 0,
    pendingThinking,
  ].join(":");
  const scrollToBottom = useCallback((force = false) => {
    const feed = feedRef.current;
    if (!feed) {
      return;
    }
    if (!force && userDetachedFromBottomRef.current) {
      return;
    }
    programmaticScrollRef.current = true;
    const maxScrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight);
    feed.scrollTop = maxScrollTop;
    scrollTopRef.current = feed.scrollTop;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        const current = feedRef.current;
        if (!current) {
          return;
        }
        scrollTopRef.current = current.scrollTop;
        if (distanceFromBottom(current) <= SUBAGENT_DETAIL_STICK_THRESHOLD_PX) {
          userDetachedFromBottomRef.current = false;
        }
      });
    });
  }, []);

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) {
      return;
    }
    scrollTopRef.current = feed.scrollTop;
    const onScroll = () => {
      if (programmaticScrollRef.current) {
        return;
      }
      const nextScrollTop = feed.scrollTop;
      const distance = distanceFromBottom(feed);
      if (nextScrollTop < scrollTopRef.current - SUBAGENT_DETAIL_USER_SCROLL_DELTA_PX) {
        userDetachedFromBottomRef.current = true;
      } else if (
        nextScrollTop > scrollTopRef.current + SUBAGENT_DETAIL_USER_SCROLL_DELTA_PX &&
        distance <= SUBAGENT_DETAIL_STICK_THRESHOLD_PX
      ) {
        userDetachedFromBottomRef.current = false;
      } else if (distance <= SUBAGENT_DETAIL_STICK_THRESHOLD_PX) {
        userDetachedFromBottomRef.current = false;
      }
      scrollTopRef.current = nextScrollTop;
    };
    feed.addEventListener("scroll", onScroll, { passive: true });
    return () => feed.removeEventListener("scroll", onScroll);
  }, [agent.agentId]);

  useLayoutEffect(() => {
    userDetachedFromBottomRef.current = false;
    scrollToBottom(true);
    const frame = requestAnimationFrame(() => scrollToBottom(true));
    return () => cancelAnimationFrame(frame);
  }, [agent.agentId, scrollToBottom]);

  useLayoutEffect(() => {
    scrollToBottom();
    const frame = requestAnimationFrame(() => scrollToBottom());
    return () => cancelAnimationFrame(frame);
  }, [layoutSignature, scrollToBottom]);

  useEffect(() => {
    const feed = feedRef.current;
    const content = feed?.querySelector(".subagent-conversation-log-content");
    if (!feed || !(content instanceof HTMLElement)) {
      return;
    }
    const observer = new ResizeObserver(() => {
      scrollToBottom();
      requestAnimationFrame(() => scrollToBottom());
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [agent.agentId, scrollToBottom]);

  return (
    <div className="subagent-task-detail-feed subagent-conversation">
      <div ref={feedRef} className="subagent-conversation-log">
        <div className="run-log subagent-conversation-log-content">
          {missionDisplay
            ? wrapRunLogFeedEntry(
                <UserPromptBlock
                  text={missionDisplay}
                  className="subagent-conversation-prompt"
                  {...(images && { images })}
                />,
              )
            : null}
          {turns.length > 0 ? (
            turns.map((turn) => (
              <ProjectionSubagentTurn
                key={turn.key}
                turn={turn}
                requestSpansById={requestSpansById}
                pendingThinking={pendingThinking && turn === turns.at(-1)}
              />
            ))
          ) : running ? (
            wrapRunLogFeedEntry(<WaitingThinkingBlock active />, {
              tight: true,
            })
          ) : (
            <p className="subagent-task-detail-empty">{i18n.t("activity.noDetails")}</p>
          )}
        </div>
      </div>
      <ProjectionSubagentRunInstanceStrip agent={agent} />
    </div>
  );
}, areProjectionSubagentDetailFeedPropsEqual);

function promptImagePreviewSignature(images: readonly PromptImagePreview[] | undefined): string {
  return images?.map((image) => `${image.id}:${image.mediaType}:${image.data}`).join("|") ?? "";
}

function ProjectionSubagentRunInstanceStrip({ agent }: { agent: ThreadRunProjectionAgent }) {
  const usage = agent.usage;
  const context = agent.context;
  const contextLabel = context && context.limit > 0 ? `${context.occupancyPct}%` : undefined;
  const contextProgressWidth =
    context && context.limit > 0 ? `${Math.min(100, Math.max(0, context.occupancyPct))}%` : "0%";
  const contextDetail =
    context && context.limit > 0
      ? `${formatTokenCount(context.occupied)} / ${formatTokenCount(context.limit)}`
      : undefined;
  const modelId = agent.usage?.modelId ?? agent.context?.modelId;
  const modelLabel = modelId ? shortenModelId(modelId) : undefined;
  const costLabel = usage ? formatCostUsd(usage.ecoCostUsd) : undefined;

  if (!usage && !contextLabel && !modelLabel) {
    return null;
  }

  return (
    <section className="subagent-run-instance-strip" aria-label={i18n.t("activity.metrics")}>
      {usage ? (
        <>
          <div
            className="subagent-run-instance-metric subagent-run-instance-metric--io"
            title={i18n.t("activity.ioTitle", {
              input: formatTokenCount(usage.inputTokens),
              output: formatTokenCount(usage.outputTokens),
            })}
          >
            <span className="subagent-run-instance-heading">
              <ArrowDownToLine size={13} aria-hidden />
              <span className="subagent-run-instance-label">{i18n.t("activity.inputOutput")}</span>
            </span>
            <span className="subagent-run-instance-split-values">
              <span>
                <small>IN</small>
                {formatTokenCount(usage.inputTokens)}
              </span>
              <span>
                <small>OUT</small>
                {formatTokenCount(usage.outputTokens)}
              </span>
            </span>
          </div>
          <div
            className="subagent-run-instance-metric subagent-run-instance-metric--cache"
            title={i18n.t("activity.cacheTitle", {
              read: formatTokenCount(usage.cacheReadTokens),
              write: formatTokenCount(usage.cacheCreationTokens),
            })}
          >
            <span className="subagent-run-instance-heading">
              <Database size={13} aria-hidden />
              <span className="subagent-run-instance-label">{i18n.t("activity.cache")}</span>
            </span>
            <span className="subagent-run-instance-split-values">
              <span>
                <small>READ</small>
                {formatTokenCount(usage.cacheReadTokens)}
              </span>
              <span>
                <small>WRITE</small>
                {formatTokenCount(usage.cacheCreationTokens)}
              </span>
            </span>
          </div>
        </>
      ) : null}
      {contextLabel ? (
        <div
          className="subagent-run-instance-metric subagent-run-instance-metric--context"
          title={i18n.t("activity.contextTitle", {
            label: contextLabel,
            detail: contextDetail ? ` (${contextDetail})` : "",
          })}
        >
          <span className="subagent-run-instance-heading">
            <Gauge size={13} aria-hidden />
            <span className="subagent-run-instance-label">{i18n.t("activity.context")}</span>
          </span>
          <span className="subagent-run-instance-context-value">
            <strong>{contextLabel}</strong>
            <small>{contextDetail}</small>
          </span>
          <span className="subagent-run-instance-progress-track" aria-hidden="true">
            <span className="subagent-run-instance-progress-fill" style={{ width: contextProgressWidth }} />
          </span>
        </div>
      ) : null}
      {costLabel || modelLabel ? (
        <div
          className="subagent-run-instance-metric subagent-run-instance-metric--billing-model"
          title={[
            costLabel ? i18n.t("activity.billingTitle", { cost: costLabel }) : "",
            modelId ? i18n.t("activity.modelTitle", { model: modelId }) : "",
          ]
            .filter(Boolean)
            .join(" / ")}
        >
          <span className="subagent-run-instance-heading">
            <CircleDollarSign size={13} aria-hidden />
            <span className="subagent-run-instance-label">{i18n.t("activity.billingModel")}</span>
          </span>
          <span className="subagent-run-instance-billing-model-values">
            <strong>{costLabel ?? "-"}</strong>
            <small>{modelLabel ?? "-"}</small>
          </span>
        </div>
      ) : null}
    </section>
  );
}

function ProjectionTimelineEntry({
  item,
  requestSpansById,
  onRestorePrompt,
  onLoadUserMessageEdit,
  onRewriteUserMessage,
  onForkMessage,
  forkDisabledReason,
  onRetryFailedRequest,
  onSwitchCodexAccount,
  onOpenChatGptSubscriptionAccounts,
  retryTargets,
  allowUserMessageRewrite = false,
  historyRevision,
  compact = false,
  hideSubagentIdentity = false,
  deferWaitingIndicator = false,
  deferReasoningStageTip = false,
  forceActionDetailsExpanded = false,
  actionLabelOverride,
  showMessageMeta = false,
  stickyMessageMeta = false,
  pacing = true,
  onOpenImageGenerationTool,
  onOpenImageDisplayTool,
  onOpenImageDisplayArtifact,
}: {
  item: ThreadRunProjectionTimelineItem;
  requestSpansById: Map<string, ThreadRunProjectionSnapshot["requestSpans"][number]>;
  onRestorePrompt?: RestorePromptHandler;
  onLoadUserMessageEdit?: LoadUserMessageEditHandler;
  onRewriteUserMessage?: RewriteUserMessageHandler;
  onForkMessage?: ForkMessageHandler;
  forkDisabledReason?: string;
  onRetryFailedRequest?: RetryFailedRequestHandler;
  onSwitchCodexAccount?: () => void;
  onOpenChatGptSubscriptionAccounts?: (accountId?: string) => void;
  retryTargets?: Map<string, RequestFailureRetryTarget>;
  allowUserMessageRewrite?: boolean;
  historyRevision?: number;
  compact?: boolean;
  /** Hide role badges without skipping the shared `.run-log-feed-entry` spacing wrapper. */
  hideSubagentIdentity?: boolean;
  deferWaitingIndicator?: boolean;
  deferReasoningStageTip?: boolean;
  forceActionDetailsExpanded?: boolean;
  actionLabelOverride?: string;
  showMessageMeta?: boolean;
  stickyMessageMeta?: boolean;
  pacing?: boolean;
  onOpenImageGenerationTool?: OpenImageGenerationToolHandler;
  onOpenImageDisplayTool?: OpenImageDisplayToolHandler;
  onOpenImageDisplayArtifact?: OpenImageDisplayArtifactHandler;
}) {
  const omitIdentity = compact || hideSubagentIdentity;
  if (deferWaitingIndicator && isDeferredThinkingStatusItem(item, requestSpansById, deferReasoningStageTip)) {
    return null;
  }
  if (isProjectionUserPromptItem(item)) {
    if (omitIdentity) {
      return null;
    }
    const rewindTarget = readProjectionRewindTarget(item);
    return wrapRunLogFeedEntry(
      <UserPromptBlock
        text={item.text}
        {...(isConversationMessageOrigin(item.metadata?.messageOrigin)
          ? { origin: item.metadata.messageOrigin }
          : {})}
        images={readPromptImagePreviews(item.metadata)}
        anchorId={item.id}
        {...(item.at ? { createdAt: item.at } : {})}
        {...(rewindTarget && { rewindTarget })}
        {...(onRestorePrompt && { onRestorePrompt })}
        {...(onLoadUserMessageEdit && { onLoadUserMessageEdit })}
        {...(onRewriteUserMessage && { onRewriteUserMessage })}
        {...(onForkMessage && { onForkMessage })}
        {...(forkDisabledReason && { forkDisabledReason })}
        allowUserMessageRewrite={allowUserMessageRewrite}
        historyRevision={historyRevision ?? 0}
      />,
    );
  }

  const block = projectionItemToDetailBlock(item);
  if (!block) {
    return null;
  }

  const requestSpan = item.requestId ? requestSpansById.get(item.requestId) : undefined;
  const requestActive = isProjectionRequestActive(requestSpan);
  const ttsToolUseId = readTtsToolUseId(item);
  const imageToolUseId = readImageGenerationToolUseId(item);
  const imageDisplayToolUseId = readImageDisplayToolUseId(item);
  const retryTarget = !compact ? retryTargets?.get(item.id) : undefined;
  const onRetry =
    retryTarget && onRetryFailedRequest
      ? () => {
          void onRetryFailedRequest(retryTarget);
        }
      : undefined;

  // Account recovery must remain available even when the failed turn already
  // produced output and cannot use one-click request retry.
  const failureMessage =
    block.kind === "api-error"
      ? block.message
      : block.kind === "phase"
        ? block.reconnectDetail ?? block.label
        : undefined;
  const usageLimitReached =
    failureMessage !== undefined &&
    (/\byou['’]ve hit your usage limit\b/iu.test(failureMessage) ||
      (block.kind === "api-error" && block.code === "usage_limit_reached"));
  const subscriptionUsagePaused =
    block.kind === "api-error" &&
    block.code === "subscription_sharing_usage_limit_exceeded";
  if (
    !compact &&
    item.scope !== "agent" &&
    subscriptionUsagePaused &&
    onOpenChatGptSubscriptionAccounts
  ) {
    return wrapRunLogFeedEntry(
      <FeedErrorCard
        message={
          <>
            {i18n.t("activity.chatgptUsagePaused")}{" "}
            <a
              className="feed-error-card-link"
              href="https://chatgpt.com/settings/usage"
              target="_blank"
              rel="noreferrer"
            >
              {i18n.t("activity.viewChatgptUsage")}
            </a>
          </>
        }
        actionLabel={i18n.t("activity.manualTestChatgptAccount")}
        onAction={() => onOpenChatGptSubscriptionAccounts(block.accountId)}
      />,
    );
  }
  if (!compact && item.scope !== "agent" && onSwitchCodexAccount && usageLimitReached) {
    return wrapRunLogFeedEntry(
      <FeedErrorCard
        message={failureMessage}
        actionLabel={i18n.t("activity.switchAccount")}
        onAction={onSwitchCodexAccount}
      />,
    );
  }

  if (block.kind === "subagent-prompt") {
    return wrapRunLogFeedEntry(
      <UserPromptBlock text={block.text} className="subagent-conversation-prompt" createdAt={item.at} />,
      { compact },
    );
  }
  if (block.kind === "narrative") {
    return wrapRunLogFeedEntry(
      <RunLogNarrative
        text={block.text}
        createdAt={item.at}
        showMessageMeta={showMessageMeta}
        stickyMessageMeta={stickyMessageMeta}
        {...(block.streaming !== undefined && { streaming: block.streaming })}
        pacing={pacing}
        {...(block.subagent && { subagent: block.subagent })}
        omitSubagentBadge={omitIdentity || isAgentDisplayRole(block.subagent)}
        compact={compact}
        {...(requestSpan && { requestSpan })}
        item={item}
        {...(onForkMessage && {onForkMessage})}
        {...(forkDisabledReason && {forkDisabledReason})}
        historyRevision={historyRevision ?? 0}
      />,
      { compact },
    );
  }
  if (block.kind === "thinking") {
    return wrapRunLogFeedEntry(
      <ThinkingBlock
        text={block.text}
        {...(block.streaming !== undefined && { streaming: block.streaming })}
        pacing={pacing}
        {...(block.startedAt && { startedAt: block.startedAt })}
        {...(block.endedAt && { endedAt: block.endedAt })}
        {...(block.durationMs !== undefined && {
          durationMs: block.durationMs,
        })}
      />,
      { compact, tight: true },
    );
  }
  if (block.kind === "reasoning-stage") {
    return wrapRunLogFeedEntry(<WaitingThinkingBlock active label={block.label} />, {
      compact,
      tight: true,
    });
  }
  if (block.kind === "unknown-item") {
    return wrapRunLogFeedEntry(
      <UnknownItemBlock
        itemType={block.itemType}
        {...(block.phase && { phase: block.phase })}
        {...(block.payload && { payload: block.payload })}
        {...(block.streaming !== undefined && { streaming: block.streaming })}
      />,
      { compact, tight: true },
    );
  }
  if (block.kind === "phase") {
    return wrapRunLogFeedEntry(
      <PhaseBlock
        label={block.label}
        {...(block.compaction && { compaction: block.compaction })}
        {...(block.reconnecting && { reconnecting: block.reconnecting })}
        {...(block.reconnectFailed && {
          reconnectFailed: block.reconnectFailed,
        })}
        {...(block.reconnectDetail && {
          reconnectDetail: block.reconnectDetail,
        })}
        {...(onRetry && { onRetry })}
      />,
      { compact },
    );
  }

  return wrapRunLogFeedEntry(
    <DetailBlock
      block={block}
      {...(ttsToolUseId && { actionDetails: <TtsFeedArtifacts toolUseIds={[ttsToolUseId]} /> })}
      requestActive={requestActive}
      createdAt={item.at}
      hideSubagentIdentity={omitIdentity}
      forceActionDetailsExpanded={forceActionDetailsExpanded}
      {...(actionLabelOverride && { actionLabelOverride })}
      {...(requestSpan && { requestSpan })}
      {...(onRetry && { onRetry })}
      {...(imageToolUseId &&
        onOpenImageGenerationTool && {
          onActionActivate: () => onOpenImageGenerationTool(imageToolUseId),
        })}
      {...(!imageToolUseId &&
        imageDisplayToolUseId &&
        onOpenImageDisplayTool && {
          onActionActivate: () => onOpenImageDisplayTool(imageDisplayToolUseId),
        })}
      {...(onOpenImageDisplayArtifact && { onOpenImageDisplayArtifact })}
    />,
    { compact, tight: isTightFeedDetailBlock(block) },
  );
}

/**
 * Rows the card itself explains: the lifecycle rows say the card exists and a mission
 * envelope repeats the card's own headline. The card's reader never sees them, so a
 * comparison of two chains has to drop them too — exported for that comparison.
 */
export function shouldSuppressSubagentCardTimelineItem(
  item: ThreadRunProjectionTimelineItem,
  missionText: string,
): boolean {
  if (
    item.eventType === "agent.started" ||
    item.eventType === "agent.stopped" ||
    item.eventType === "agent.abandoned"
  ) {
    return true;
  }
  if (isSubagentMissionEnvelope(item.text)) {
    return true;
  }
  if (!missionText) {
    return false;
  }
  const block = projectionItemToDetailBlock(item);
  if (block?.kind === "subagent-mission") {
    return true;
  }
  if (block?.kind !== "subagent-prompt" && block?.kind !== "narrative") {
    return false;
  }
  // Some Codex child-thread histories echo the delegated task as a regular
  // assistant message instead of preserving its user-message marker. The
  // drawer already renders the mission header, so either representation would
  // otherwise show the same task twice.
  const normalizeMissionComparisonText = (text: string): string =>
    resolveMissionDisplayText(text).replace(/\s+/gu, " ").trim();
  return normalizeMissionComparisonText(block.text) === normalizeMissionComparisonText(missionText);
}

/**
 * The lifecycle rows of an agent (`agent.started` …) explain the card's existence, not its
 * content, so the detail feed drops them. Exported because it is the difference between a
 * card's raw timeline and the rows a reader sees: a comparison that skips it reports
 * differences no reader can see.
 */
export function filterSubagentDetailTimelineNoise(
  timeline: readonly ThreadRunProjectionTimelineItem[],
): ThreadRunProjectionTimelineItem[] {
  // Empty thinking.delta used to linger as inline「正在思考」after tools moved on.
  const filtered = timeline.filter(
    (item) =>
      !(
        (item.eventType === "thinking.final" || item.eventType === "thinking.delta") &&
        item.text.trim().length === 0
      ),
  );
  const ordered: ThreadRunProjectionTimelineItem[] = [];
  for (let index = 0; index < filtered.length; index += 1) {
    const item = filtered[index];
    const next = filtered[index + 1];
    if (
      item?.eventType === "request.started" &&
      item.requestId &&
      next?.requestId === item.requestId &&
      isProjectionSubagentPromptItem(next)
    ) {
      ordered.push(next, item);
      index += 1;
      continue;
    }
    if (item) {
      ordered.push(item);
    }
  }
  return ordered;
}

function SubagentRunCardButton({
  roleLabel,
  running,
  statusText,
  missionText,
  durationLabel,
  selected,
  openable = true,
  onOpen,
}: {
  roleLabel: string;
  running: boolean;
  statusText: string;
  missionText?: string;
  durationLabel?: string;
  selected: boolean;
  openable?: boolean;
  onOpen: () => void;
}) {
  const resolvedMissionText = missionText ? resolveMissionDisplayText(missionText) : "";
  const className = `subagent-run-row run-log-feed-surface${running ? " is-running" : ""}${selected ? " is-expanded" : ""}${openable ? "" : " is-status-only"}`;
  const body = (
    <div className="subagent-run-main">
      <div className="subagent-run-title-row">
        <span className="subagent-run-title-group">
          <Bot size={14} className="subagent-run-icon" aria-hidden />
          <span className="subagent-run-title">
            {running ? (
              <ShimmerText>{roleLabel}</ShimmerText>
            ) : (
              <span className="subagent-run-title-role">{roleLabel}</span>
            )}
          </span>
          {durationLabel ? <span className="subagent-run-duration">{durationLabel}</span> : null}
        </span>
      </div>
      {resolvedMissionText ? (
        <ExpandableMissionText
          text={resolvedMissionText}
          expanded={false}
          className="subagent-run-mission-preview"
        />
      ) : statusText ? (
        <p className="subagent-run-mission-preview subagent-run-mission-placeholder" title={statusText}>
          {statusText}
        </p>
      ) : openable ? (
        <p className="subagent-run-mission-preview subagent-run-mission-placeholder">
          {i18n.t("activity.waitingMission")}
        </p>
      ) : null}
    </div>
  );

  if (!openable) {
    return (
      <div className={className} aria-disabled="true" title={statusText}>
        {body}
      </div>
    );
  }

  return (
    <button type="button" className={className} onClick={onOpen} aria-pressed={selected}>
      {body}
    </button>
  );
}

function ExpandableMissionText({
  text,
  expanded,
  className,
}: {
  text: string;
  expanded: boolean;
  className?: string;
}) {
  const renderedText = expanded ? text : thinkingPreviewLine(text);

  return (
    <div className={`run-log-expandable-text-wrap${expanded ? " is-expanded" : ""}`}>
      <p className={["run-log-expandable-text", className].filter(Boolean).join(" ")} title={text}>
        {renderedText}
      </p>
    </div>
  );
}

function DetailBlock({
  block,
  modelByRole,
  usageByRole,
  hideSubagentIdentity,
  forceActionDetailsExpanded = false,
  actionLabelOverride,
  actionDetails,
  requestActive = false,
  requestSpan,
  agentThemes,
  createdAt,
  onActionActivate,
  onOpenImageDisplayArtifact,
  onRetry,
}: {
  block: ActivityDetailBlock;
  modelByRole?: Record<string, string>;
  usageByRole?: Record<string, ThreadUsageSnapshot>;
  hideSubagentIdentity?: boolean;
  forceActionDetailsExpanded?: boolean;
  actionLabelOverride?: string;
  actionDetails?: ReactNode;
  requestActive?: boolean;
  requestSpan?: ThreadRunProjectionRequestSpan;
  agentThemes?: RuntimeAgentThemes;
  createdAt?: string;
  onActionActivate?: () => void;
  onOpenImageDisplayArtifact?: OpenImageDisplayArtifactHandler;
  onRetry?: () => void;
}) {
  const omitSubagent = shouldOmitSubagentIdentity(block, hideSubagentIdentity);

  if (block.kind === "phase") {
    return (
      <PhaseBlock
        label={block.label}
        {...(block.compaction && { compaction: block.compaction })}
        {...(block.reconnecting && { reconnecting: block.reconnecting })}
        {...(block.reconnectFailed && {
          reconnectFailed: block.reconnectFailed,
        })}
        {...(block.reconnectDetail && {
          reconnectDetail: block.reconnectDetail,
        })}
        {...(onRetry && { onRetry })}
      />
    );
  }
  if (block.kind === "prompt-cache-timeline") {
    return <PromptCacheTimelineBlock narrative={block.narrative} steps={block.steps} />;
  }
  if (block.kind === "subagent-mission") {
    return (
      <SubagentMissionBlock
        subagent={block.subagent}
        summary={block.summary}
        {...(block.prompt !== undefined && { prompt: block.prompt })}
        omitRoleLabel={omitSubagent}
        {...(!omitSubagent && modelByRole && { modelByRole })}
        {...(agentThemes && { agentThemes })}
      />
    );
  }
  if (block.kind === "subagent-prompt") {
    return <UserPromptBlock text={block.text} className="subagent-conversation-prompt" />;
  }
  if (block.kind === "model-request") {
    return (
      <WaitingThinkingBlock
        active={isProjectionRequestWaitingForFirstToken(requestSpan)}
        {...(requestSpan && { requestSpan })}
      />
    );
  }
  if (block.kind === "agent-request") {
    return (
      <WaitingThinkingBlock
        active={isProjectionRequestWaitingForFirstToken(requestSpan)}
        {...(requestSpan && { requestSpan })}
      />
    );
  }
  if (block.kind === "action") {
    if (block.imageDisplay) {
      return (
        <ImageDisplayBlock
          imageDisplay={block.imageDisplay}
          {...(block.lifecycle && { lifecycle: block.lifecycle })}
          {...(block.subagent && { subagent: block.subagent })}
          omitRoleLabel={omitSubagent}
          {...(!omitSubagent && modelByRole && { modelByRole })}
          {...(onOpenImageDisplayArtifact && { onOpenImageDisplayArtifact })}
        />
      );
    }
    if (block.htmlHost) {
      return (
        <HtmlHostBlock
          htmlHost={block.htmlHost}
          {...(block.lifecycle && { lifecycle: block.lifecycle })}
          {...(block.subagent && { subagent: block.subagent })}
          omitRoleLabel={omitSubagent}
          {...(!omitSubagent && modelByRole && { modelByRole })}
        />
      );
    }
    if (block.imageView) {
      return (
        <ImageViewBlock
          imageView={block.imageView}
          {...(block.toolOutput && { output: block.toolOutput })}
          {...(block.lifecycle && { lifecycle: block.lifecycle })}
          {...(block.subagent && { subagent: block.subagent })}
          omitRoleLabel={omitSubagent}
          {...(!omitSubagent && modelByRole && { modelByRole })}
        />
      );
    }
    return (
      <RunLogAction
        icon={block.icon}
        label={block.label}
        {...(actionLabelOverride && {
          displayLabelOverride: actionLabelOverride,
        })}
        {...(block.startedAt && { startedAt: block.startedAt })}
        {...(block.bashRun && { bashRun: block.bashRun })}
        {...(block.fileChange && { fileChange: block.fileChange })}
        {...(block.webSearch && { webSearch: block.webSearch })}
        {...(!actionDetails && block.toolOutput && { toolOutput: block.toolOutput })}
        {...(actionDetails && { details: actionDetails })}
        {...(block.lifecycle && { lifecycle: block.lifecycle })}
        {...(block.subagent && { subagent: block.subagent })}
        omitRoleLabel={omitSubagent}
        forceDetailsExpanded={forceActionDetailsExpanded}
        {...(onActionActivate && { onActivate: onActionActivate })}
        {...(!omitSubagent && modelByRole && { modelByRole })}
      />
    );
  }
  if (block.kind === "tool-failed") {
    return (
      <ToolFailedBlock
        tool={block.tool}
        {...(block.command && { command: block.command })}
        {...(block.fileChange && { fileChange: block.fileChange })}
        {...(block.error && { error: block.error })}
        {...(block.recoveredResult && {
          recoveredResult: block.recoveredResult,
        })}
        {...(block.subagent && { subagent: block.subagent })}
        omitRoleLabel={omitSubagent}
        {...(!omitSubagent && modelByRole && { modelByRole })}
      />
    );
  }
  if (block.kind === "api-error") {
    return (
      <ApiErrorBlock
        message={block.message}
        {...(block.title && { title: block.title })}
        {...(block.statusCode !== undefined && {
          statusCode: block.statusCode,
        })}
        {...(block.subagent && { subagent: block.subagent })}
        omitRoleLabel={omitSubagent}
        {...(!omitSubagent && modelByRole && { modelByRole })}
        {...(onRetry && { onRetry })}
      />
    );
  }
  if (block.kind === "thinking") {
    return (
      <ThinkingBlock
        text={block.text}
        {...(block.streaming !== undefined && { streaming: block.streaming })}
        {...(block.startedAt && { startedAt: block.startedAt })}
        {...(block.endedAt && { endedAt: block.endedAt })}
        {...(block.durationMs !== undefined && {
          durationMs: block.durationMs,
        })}
      />
    );
  }
  if (block.kind === "reasoning-stage") {
    return <WaitingThinkingBlock active label={block.label} />;
  }
  if (block.kind === "unknown-item") {
    return (
      <UnknownItemBlock
        itemType={block.itemType}
        {...(block.phase && { phase: block.phase })}
        {...(block.payload && { payload: block.payload })}
        {...(block.streaming !== undefined && { streaming: block.streaming })}
      />
    );
  }
  if (block.kind === "worktree-merge") {
    return <WorkspaceChangesCard summary={block.summary} />;
  }
  if (block.kind !== "narrative") {
    return null;
  }
  return (
    <RunLogNarrative
      text={block.text}
      {...(createdAt && { createdAt })}
      {...(block.streaming !== undefined && { streaming: block.streaming })}
      {...(block.subagent && { subagent: block.subagent })}
      omitSubagentBadge={omitSubagent}
      {...(!omitSubagent && modelByRole && { modelByRole })}
      {...(!omitSubagent && usageByRole && { usageByRole })}
      {...(requestSpan && { requestSpan })}
      compact
    />
  );
}

function PhaseBlock({
  label,
  compaction,
  reconnecting,
  reconnectFailed,
  reconnectDetail,
  onRetry,
}: {
  label: string;
  compaction?: Extract<ActivityDetailBlock, { kind: "phase" }>["compaction"];
  reconnecting?: boolean;
  reconnectFailed?: boolean;
  reconnectDetail?: string;
  onRetry?: () => void;
}) {
  if (compaction || isContextCompactionPhaseLabel(label)) {
    return (
      <div className="run-log-context-action" role="status" aria-live="polite">
        <RunLogAction
          icon="context"
          label={label}
          lifecycle={compaction?.lifecycle ?? contextCompactionLifecycle(label)}
          {...(compaction?.startedAt && { startedAt: compaction.startedAt })}
          {...(compaction?.durationMs !== undefined && { durationMs: compaction.durationMs })}
          elapsedInline
        />
      </div>
    );
  }
  if (isPromptCacheNoticePhaseLabel(label)) {
    return <PromptCacheNoticeDivider label={label} />;
  }
  if (reconnecting) {
    const isFailure = Boolean(reconnectFailed);
    if (isFailure) {
      return (
        <FeedErrorCard
          message={label}
          {...(reconnectDetail && { detail: reconnectDetail })}
          {...(onRetry && { actionLabel: i18n.t("common.retry"), onAction: onRetry })}
        />
      );
    }
    const className = `run-log-reconnect${isFailure ? " run-log-reconnect--failed" : ""}`;
    const ReconnectIcon = isFailure ? CircleAlert : RefreshCw;
    const summaryRow = (
      <>
        <ReconnectIcon
          size={14}
          className={`run-log-reconnect-icon${isFailure ? "" : " spinning"}`}
          aria-hidden
        />
        <span>{label}</span>
      </>
    );
    if (!reconnectDetail) {
      return (
        <div className={`${className} run-log-reconnect-inline`} role="status" aria-live="polite">
          {summaryRow}
        </div>
      );
    }
    return (
      <details className={className} role="status" aria-live="polite">
        <summary className="run-log-reconnect-summary">{summaryRow}</summary>
        <pre className="run-log-reconnect-detail">{reconnectDetail}</pre>
      </details>
    );
  }
  if (onRetry) {
    return <FeedErrorCard message={label} actionLabel={i18n.t("common.retry")} onAction={onRetry} />;
  }
  return <div className="run-log-phase">{label}</div>;
}

function isContextCompactionPhaseLabel(label: string): boolean {
  return (
    /^正在压缩上下文$/u.test(label) ||
    /^上下文已压缩$/u.test(label) ||
    /^正在(?:自动|手动)压缩上下文$/u.test(label) ||
    /^上下文已(?:自动|手动)压缩$/u.test(label) ||
    /^上下文压缩失败/u.test(label)
  );
}

function contextCompactionLifecycle(label: string): ToolActionLifecycle {
  if (/^上下文压缩失败/u.test(label)) {
    return "failed";
  }
  if (/^正在(?:压缩|自动压缩|手动压缩)上下文$/u.test(label)) {
    return "running";
  }
  return "completed";
}

function isPromptCacheNoticePhaseLabel(label: string): boolean {
  return (
    /prompt cache 已失效/u.test(label) ||
    /Prompt cache 命中率从/u.test(label) ||
    /已经变更为/u.test(label) ||
    /已变更，本会话 prompt cache 已失效/u.test(label) ||
    /已变更（Composer）/u.test(label) ||
    /输出已截断/u.test(label)
  );
}

function PromptCacheNoticeDivider({ label }: { label: string }) {
  return <FeedStatusDivider message={label} />;
}

function PromptCacheTimelineBlock({
  narrative,
  steps,
}: {
  narrative: string;
  steps: Array<{
    kind: "config_drift" | "invalidated" | "hit_dropped";
    at: string;
    label: string;
    episodeId?: string;
  }>;
}) {
  const info = steps.map((step) => step.label).join("\n");
  return <FeedStatusDivider message={narrative} {...(info && { info })} />;
}

function ShimmerText({ children }: { children: string }) {
  return (
    <span className="run-log-shimmer-text" aria-live="polite">
      {children}
    </span>
  );
}

export function splitThinkingCarouselLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => splitReasoningCarouselStageLine(line))
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Split one physical line into carousel stages.
 * Prefer sentence boundaries (EN/CJK) when parts were glued without newlines —
 * not camelCase, which falsely splits identifiers like iPhone.
 */
function splitReasoningCarouselStageLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/(?<=[.!?。！？])\s*(?=[A-Z\u4e00-\u9fff])/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function ScrollingThinkingText({ text }: { text: string }) {
  const lines = splitThinkingCarouselLines(text);
  const linesKey = lines.join("\n");
  const [activeLine, setActiveLine] = useState(0);
  /** The stage list playback came from, so a grown tip can carry its position over. */
  const playedLinesRef = useRef<readonly string[] | null>(null);

  useEffect(() => {
    const previousLines = playedLinesRef.current;
    playedLinesRef.current = lines;
    // The tip streams in, so most updates are this same tip getting longer — the stage on
    // screen keeps its turn through those. Only a different tip starts a fresh pass.
    const nextLine = resolveThinkingCarouselIndex(previousLines, lines, activeLine);
    if (nextLine !== activeLine) {
      setActiveLine(nextLine);
    }
  }, [linesKey, activeLine]);

  const lastIndex = lines.length - 1;
  useEffect(() => {
    // Played through the stages there are: hold on the last one until the tip grows again.
    if (activeLine >= lastIndex) {
      return;
    }
    // Deliberately not keyed on the text: a stage keeping its turn while the agent writes
    // more of the same stage is the point. Restarting this clock per token is what left the
    // tip parked on its first stage until the run ended.
    const timer = window.setTimeout(() => {
      setActiveLine((value) => Math.min(value + 1, lastIndex));
    }, THINKING_CAROUSEL_STAGE_MS);
    return () => window.clearTimeout(timer);
  }, [activeLine, lastIndex]);

  const activeIndex = lines.length > 0 ? Math.min(activeLine, lines.length - 1) : 0;
  const activeText = lines[activeIndex] ?? i18n.t("activity.thinking");

  return (
    <span className={`run-log-thinking-carousel${lines.length > 1 ? " has-slides" : ""}`}>
      <span className="run-log-thinking-carousel-track">
        <span className="run-log-thinking-carousel-slide" key={`${activeIndex}-${activeText}`}>
          <ShimmerText>{activeText}</ShimmerText>
        </span>
      </span>
    </span>
  );
}

/** Empty/live thinking status — same shell for "正在思考" and ephemeral reasoning summary. */
function WaitingThinkingBlock({
  active,
  label,
  spinner = false,
}: {
  active?: boolean;
  /** Defaults to i18n "正在思考". Used by OpenAI reasoning summary stage lines. */
  label?: string;
  /** Leading rotating loader, for states that read as "about to become a row". */
  spinner?: boolean;
  requestSpan?: ThreadRunProjectionRequestSpan;
}) {
  if (!active) {
    return null;
  }

  const displayLabel = label?.trim() || i18n.t("activity.thinking");

  return (
    <div className="run-log-thinking streaming empty" role="status" aria-live="polite">
      <div className="run-log-thinking-header">
        {/* Same 14px/8px slot the tool row's own icon occupies, so the label does not
            slide sideways when the row this wait announces finally lands. */}
        {spinner ? (
          <LoaderCircle size={14} className="run-log-action-icon run-log-thinking-spinner" aria-hidden />
        ) : null}
        <span className="run-log-thinking-label">
          <ScrollingThinkingText text={displayLabel} />
        </span>
      </div>
    </div>
  );
}

/**
 * Whether the Feed's newest row is a thinking block that is still streaming, and therefore
 * already carrying its own「正在思考」shimmer.
 *
 * A thinking row stays `thinking.delta` while the agent moves on to writing its tool call,
 * so this covers the thinking → tool gap as well: the block the reader is looking at is
 * still animating, which is why that gap never reads as stalled even though nothing new
 * arrives. The Composer's dots defer to it rather than doubling up on the same row.
 */
export function isTailThinkingStreamingLive(entries: readonly ThreadRunProjectionMainFeedEntry[]): boolean {
  const last = entries.at(-1);
  if (!last || (last.kind !== "timeline" && last.kind !== "agent-echo")) {
    return false;
  }
  const block = projectionItemToDetailBlock(last.item);
  return block?.kind === "thinking" && Boolean(block.streaming);
}

/**
 * Whether the feed is still waiting on the agent for its newest row — true when the last
 * row is the user's own prompt, or when the feed holds nothing at all yet.
 *
 * Every send opens this window, not just a thread's first message. Mid-turn steers sort
 * after the output they interrupt, so a prompt landing last means the agent has not
 * answered it; once it does, the newest row is a request/thinking/tool/narrative row and
 * the normal waiting rules take over.
 */
function isAwaitingAgentAnswer(entries: readonly ThreadRunProjectionMainFeedEntry[]): boolean {
  const last = entries.at(-1);
  if (!last) {
    return true;
  }
  if (last.kind !== "timeline" && last.kind !== "agent-echo") {
    return false;
  }
  return isProjectionUserPromptItem(last.item);
}

function isWaitingThinkingItem(
  item: ThreadRunProjectionTimelineItem,
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionRequestSpan>,
): boolean {
  const block = projectionItemToDetailBlock(item);
  if (!block) {
    return false;
  }
  if (block.kind === "model-request" || block.kind === "agent-request") {
    const requestSpan = item.requestId ? requestSpansById.get(item.requestId) : undefined;
    return isProjectionRequestWaitingForFirstToken(requestSpan);
  }
  if (block.kind !== "thinking" && block.kind !== "narrative") {
    return false;
  }
  const requestSpan = item.requestId ? requestSpansById.get(item.requestId) : undefined;
  return (
    Boolean(block.streaming) && !block.text.trim() && isProjectionRequestWaitingForFirstToken(requestSpan)
  );
}

function isProjectionRequestWaitingForFirstToken(span: ThreadRunProjectionRequestSpan | undefined): boolean {
  return span?.status === "waiting_first_token" && !span.firstTokenAt;
}

function isReasoningStageItem(item: ThreadRunProjectionTimelineItem): boolean {
  if (item.eventType !== "thinking.delta" && item.eventType !== "thinking.final") return false;
  return projectionItemToDetailBlock(item)?.kind === "reasoning-stage";
}

/** Empty waiting + (optionally) live Summary tip — deferred into the active-tail. */
function isDeferredThinkingStatusItem(
  item: ThreadRunProjectionTimelineItem,
  requestSpansById: ReadonlyMap<string, ThreadRunProjectionRequestSpan>,
  deferReasoningStageTip: boolean,
): boolean {
  if (isWaitingThinkingItem(item, requestSpansById)) {
    return true;
  }
  return deferReasoningStageTip && isReasoningStageItem(item);
}

/** Latest visible reasoning-stage tip label on the main feed (collapse already keeps one tip). */
function resolveLiveReasoningStageLabel(
  entries: readonly ThreadRunProjectionMainFeedEntry[],
): string | undefined {
  let label: string | undefined;
  for (const entry of entries) {
    if (entry.kind !== "timeline" && entry.kind !== "agent-echo") {
      continue;
    }
    if (entry.item.eventType !== "thinking.delta" && entry.item.eventType !== "thinking.final") continue;
    const block = projectionItemToDetailBlock(entry.item);
    if (block?.kind !== "reasoning-stage") {
      continue;
    }
    const trimmed = block.label.trim();
    if (trimmed) {
      label = trimmed;
    }
  }
  return label;
}

function isRunningActionItem(item: ThreadRunProjectionTimelineItem): boolean {
  const block = projectionItemToDetailBlock(item);
  return block?.kind === "action" && block.lifecycle === "running";
}

function isRunningToolFeedEntry(entry: ThreadRunProjectionMainFeedEntry): boolean {
  if (entry.kind === "tool-group") {
    return entry.entries.some((child) => isRunningActionItem(child.item));
  }
  if (entry.kind !== "timeline" && entry.kind !== "agent-echo") {
    return false;
  }
  return isRunningActionItem(entry.item);
}

/**
 * The entry that owns the Feed's live slot: the newest content row.
 *
 * Deferred「正在思考」rows and Summary tips are skipped — they render as the active-tail
 * line instead of a row of their own, so they are never the slot's owner. What this
 * returns is what the next live state has to replace: the trailing tool aggregate.
 */
function resolveFeedLiveSlotEntry(
  entries: readonly ThreadRunProjectionMainFeedEntry[],
  requestSpansById: Map<string, ThreadRunProjectionSnapshot["requestSpans"][number]>,
): ThreadRunProjectionMainFeedEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (entry.kind === "timeline" || entry.kind === "agent-echo") {
      if (
        isDeferredThinkingStatusItem(entry.item, requestSpansById, true) ||
        (!isProjectionUserPromptItem(entry.item) && !projectionItemToDetailBlock(entry.item))
      ) {
        continue;
      }
    }
    return entry;
  }
  return undefined;
}

function isRunningContextCompactionFeedEntry(entry: ThreadRunProjectionMainFeedEntry): boolean {
  if (entry.kind !== "timeline" && entry.kind !== "agent-echo") {
    return false;
  }
  return entry.item.eventType === "context.compaction.started";
}

function RunLogActiveTail({
  stopping = false,
  label,
  writing = false,
}: {
  stopping?: boolean;
  /** Live Summary tip label; when waiting without tip, defaults to「正在思考」. */
  label?: string;
  /** The wait is the model writing a tool call — the tail is about to become a tool row. */
  writing?: boolean;
}) {
  // Single WaitingThinkingBlock instance: stopping > tip label > default「正在思考」.
  const statusLabel = stopping ? i18n.t("activity.stopping") : label?.trim() ? label.trim() : undefined;
  return (
    <div className="run-log-feed-entry run-log-feed-entry--tight run-log-active-tail">
      <WaitingThinkingBlock
        active
        {...(statusLabel ? { label: statusLabel } : {})}
        {...(writing && !stopping ? { spinner: true } : {})}
      />
    </div>
  );
}

function ThinkingBlock({
  text,
  streaming,
  pacing = true,
  startedAt,
  endedAt,
  durationMs: projectedDurationMs = 0,
}: {
  text: string;
  streaming?: boolean;
  pacing?: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}) {
  const thinkingRootRef = useRef<HTMLDivElement>(null);
  const thinkingBodyInnerRef = useRef<HTMLDivElement>(null);
  const notifyLayoutChange = useActivityFeedLayoutChange();
  const hasBody = text.trim().length > 0;
  const [revealing, setRevealing] = useState(false);
  const activelyStreaming = Boolean(streaming) || revealing;
  // Card path only (collapsed/expanded). Ephemeral never reaches here — projection
  // maps those rows to reasoning-stage tips first.
  const [displayMode] = useState<ThinkingDisplayMode>(() => readStoredThinkingDisplayPreferences().mode);
  const defaultExpanded = thinkingModeDefaultExpanded(displayMode);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [settling, setSettling] = useState(false);
  const wasActiveRef = useRef(activelyStreaming);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wantOpen = resolveThinkingExpanded({
    activelyStreaming,
    settling,
    userExpanded,
    defaultExpanded,
  });
  const preferenceDriven = isThinkingPreferenceDrivenExpand({
    activelyStreaming,
    settling,
    userExpanded,
  });
  const eagerMountBody = shouldEagerMountThinkingBody({
    activelyStreaming,
    settling,
    userExpanded,
  });
  const [displayOpen, setDisplayOpen] = useState(wantOpen);
  const [collapsing, setCollapsing] = useState(false);
  const [bodyMounted, setBodyMounted] = useState(eagerMountBody);
  const displayOpenRef = useRef(displayOpen);
  displayOpenRef.current = displayOpen;
  const measuredDurationMs = useTurnDurationMs(
    startedAt ?? "",
    endedAt,
    Boolean(startedAt) && activelyStreaming,
  );
  const durationMs = startedAt
    ? Math.max(measuredDurationMs, projectedDurationMs)
    : Math.max(0, projectedDurationMs);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    if (activelyStreaming) {
      clearHoldTimer();
      setSettling(false);
      setUserExpanded(null);
    } else if (wasActiveRef.current) {
      setUserExpanded(null);
      const prefersReducedMotion =
        typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const holdMs = resolveThinkingCollapseHoldMs(prefersReducedMotion);
      if (holdMs <= 0) {
        setSettling(false);
      } else {
        setSettling(true);
        clearHoldTimer();
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          setSettling(false);
        }, holdMs);
      }
    }
    wasActiveRef.current = activelyStreaming;
  }, [activelyStreaming, clearHoldTimer]);

  useEffect(() => () => clearHoldTimer(), [clearHoldTimer]);

  useLayoutEffect(() => {
    if (wantOpen) {
      setCollapsing(false);
      setDisplayOpen(true);
      return;
    }
    if (!displayOpenRef.current) {
      return;
    }
    const prefersReducedMotion =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setCollapsing(false);
      setDisplayOpen(false);
      return;
    }
    setCollapsing(true);
    const frame = requestAnimationFrame(() => {
      setDisplayOpen(false);
    });
    const timer = setTimeout(() => {
      setCollapsing(false);
    }, THINKING_COLLAPSE_ANIM_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [wantOpen]);

  const showDetails = hasBody && (displayOpen || collapsing);

  useLayoutEffect(() => {
    if (eagerMountBody) {
      setBodyMounted(true);
    }
  }, [eagerMountBody]);

  useEffect(() => {
    if (eagerMountBody || bodyMounted || !showDetails) {
      if (!showDetails && !eagerMountBody) {
        setBodyMounted(false);
      }
      return;
    }
    const rootEl = thinkingRootRef.current;
    if (!rootEl || typeof IntersectionObserver === "undefined") {
      return;
    }
    const scrollRoot = findThinkingFeedScrollRoot(rootEl);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setBodyMounted(true);
        }
      },
      {
        root: scrollRoot,
        // Prefetch slightly before fully visible so expand feels instant while scrolling.
        rootMargin: "120px 0px",
        threshold: 0,
      },
    );
    observer.observe(rootEl);
    return () => observer.disconnect();
  }, [bodyMounted, eagerMountBody, showDetails]);

  useLayoutEffect(() => {
    const options = resolveThinkingLayoutNotifyOptions({
      displayOpen,
      preferenceDriven,
    });
    notifyLayoutChange?.(options);
  }, [displayOpen, notifyLayoutChange, preferenceDriven]);

  useLayoutEffect(() => {
    if (!bodyMounted || !preferenceDriven) {
      return;
    }
    // Body arrived after preference expand — coalesce via scheduled scroll, not N× flush.
    notifyLayoutChange?.();
  }, [bodyMounted, notifyLayoutChange, preferenceDriven]);

  const stickThinkingBodyToBottom = useCallback(() => {
    const bodyInner = thinkingBodyInnerRef.current;
    if (!bodyInner) {
      return;
    }
    bodyInner.scrollTop = bodyInner.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    if (!activelyStreaming || !hasBody) {
      return;
    }
    stickThinkingBodyToBottom();
    const frame = requestAnimationFrame(() => stickThinkingBodyToBottom());
    return () => cancelAnimationFrame(frame);
  }, [activelyStreaming, hasBody, text, stickThinkingBodyToBottom]);

  useEffect(() => {
    if (!activelyStreaming || !hasBody) {
      return;
    }
    const bodyInner = thinkingBodyInnerRef.current;
    if (!bodyInner) {
      return;
    }
    const observer = new ResizeObserver(() => stickThinkingBodyToBottom());
    observer.observe(bodyInner);
    const body = bodyInner.querySelector(".run-log-thinking-body");
    if (body) {
      observer.observe(body);
    }
    return () => observer.disconnect();
  }, [activelyStreaming, hasBody, stickThinkingBodyToBottom]);

  if (streaming && !hasBody) {
    return <WaitingThinkingBlock active />;
  }

  if (!activelyStreaming && !settling && !(userExpanded ?? defaultExpanded) && !hasBody && !collapsing) {
    return null;
  }

  const isExpanded = displayOpen;
  const baseLabel = activelyStreaming ? i18n.t("activity.thinking") : i18n.t("activity.deepThinkingDone");
  // 秒数单独成 span：跟工具行的耗时一样是小字 faint 数字，而不是跟着 13px/500 的摘要走。
  const durationLabel = formatDuration(durationMs);

  return (
    <div
      ref={thinkingRootRef}
      className={[
        "run-log-thinking",
        activelyStreaming ? "streaming" : "",
        isExpanded ? "is-expanded" : "",
        collapsing ? "is-collapsing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className={[
          "run-log-thinking-trigger",
          activelyStreaming ? "is-running" : "",
          hasBody ? "is-expandable" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => {
          if (activelyStreaming || !hasBody) {
            return;
          }
          if (settling) {
            clearHoldTimer();
            setSettling(false);
            setUserExpanded(false);
            return;
          }
          setUserExpanded(!isExpanded);
        }}
        aria-expanded={hasBody ? isExpanded : undefined}
      >
        <Sparkles size={14} className="run-log-thinking-icon" aria-hidden />
        <span className="run-log-thinking-summary">
          {activelyStreaming ? <ShimmerText>{baseLabel}</ShimmerText> : baseLabel}
          {durationLabel ? <span className="run-log-thinking-elapsed">{durationLabel}</span> : null}
        </span>
        {hasBody ? (
          <ChevronRight
            size={15}
            className={`run-log-thinking-chevron${isExpanded ? " open" : ""}`}
            aria-hidden
          />
        ) : null}
      </button>
      {showDetails ? (
        <div className="run-log-thinking-details" aria-hidden={!isExpanded}>
          <div className="run-log-thinking-details-inner">
            <div
              className="run-log-thinking-body-inner"
              ref={thinkingBodyInnerRef}
              role="region"
              aria-label={i18n.t("activity.thinkingContent")}
            >
              {bodyMounted ? (
                <div className="run-log-thinking-body">
                  <StreamingMarkdownContent
                    text={text}
                    streaming={Boolean(streaming) && pacing}
                    onRevealStateChange={setRevealing}
                    className="markdown-content"
                  />
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Default-collapsed card for Codex item types Eco has not specialized yet. */
function UnknownItemBlock({
  itemType,
  phase,
  payload,
  streaming,
}: {
  itemType: string;
  phase?: "started" | "completed";
  payload?: string;
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const notifyLayoutChange = useActivityFeedLayoutChange();
  const hasBody = Boolean(payload?.trim());
  const activelyStreaming = Boolean(streaming) || phase === "started";
  const label = activelyStreaming
    ? i18n.t("activity.unknownItemRunning", { type: itemType })
    : i18n.t("activity.unknownItem", { type: itemType });

  useLayoutEffect(() => {
    notifyLayoutChange?.({ immediate: true });
  }, [expanded, notifyLayoutChange]);

  return (
    <div
      className={["run-log-unknown-item", activelyStreaming ? "streaming" : "", expanded ? "is-expanded" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className={[
          "run-log-unknown-item-trigger",
          activelyStreaming ? "is-running" : "",
          hasBody ? "is-expandable" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => {
          if (!hasBody) {
            return;
          }
          setExpanded((value) => !value);
        }}
        aria-expanded={hasBody ? expanded : undefined}
      >
        <CircleHelp size={14} className="run-log-unknown-item-icon" aria-hidden />
        <span className="run-log-unknown-item-summary">
          {activelyStreaming ? <ShimmerText>{label}</ShimmerText> : label}
        </span>
        {hasBody ? (
          <ChevronRight
            size={15}
            className={`run-log-unknown-item-chevron${expanded ? " open" : ""}`}
            aria-hidden
          />
        ) : null}
      </button>
      {expanded && hasBody ? (
        <div className="run-log-unknown-item-details">
          <pre
            className="run-log-unknown-item-payload"
            role="region"
            aria-label={i18n.t("activity.unknownItemPayload")}
          >
            {payload}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function UserPromptBlock({
  text,
  origin,
  images = [],
  className,
  anchorId,
  createdAt,
  rewindTarget,
  onRestorePrompt,
  historyRevision = 0,
  onLoadUserMessageEdit,
  onRewriteUserMessage,
  onForkMessage,
  forkDisabledReason,
  allowUserMessageRewrite = false,
}: {
  text: string;
  origin?: ConversationMessageOrigin;
  images?: readonly PromptImagePreview[];
  className?: string;
  anchorId?: string;
  createdAt?: string;
  rewindTarget?: ThreadActivityRewindTarget;
  onRestorePrompt?: RestorePromptHandler;
  historyRevision?: number;
  onLoadUserMessageEdit?: LoadUserMessageEditHandler;
  onRewriteUserMessage?: RewriteUserMessageHandler;
  onForkMessage?: ForkMessageHandler;
  forkDisabledReason?: string;
  allowUserMessageRewrite?: boolean;
}) {
  const asyncQuestionReplies = useMemo(() => parseCodexAsyncQuestionReplyText(text), [text]);
  const copyText = asyncQuestionReplies ? formatCodexAsyncQuestionReplySummary(asyncQuestionReplies) : text;
  const bodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editRequestRef = useRef(0);
  const previousTextRef = useRef(text);
  const [expanded, setExpanded] = useState(false);
  const [canToggle, setCanToggle] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(text);
  const [editImages, setEditImages] = useState<PromptImagePreview[]>(() => [...images]);
  const [editRevision, setEditRevision] = useState(historyRevision);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | undefined>();
  const [lightboxImage, setLightboxImage] = useState<{
    src: string;
    alt: string;
    label: string;
  } | null>(null);
  const closeLightbox = useCallback(() => setLightboxImage(null), []);
  const canEdit = Boolean(
    allowUserMessageRewrite && rewindTarget && onLoadUserMessageEdit && onRewriteUserMessage,
  );

  const makeEditImage = useCallback(
    (attachment: PromptImageAttachment, index: number): PromptImagePreview => {
      return {
        ...attachment,
        id: `edit_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
      };
    },
    [],
  );

  const cancelEdit = useCallback(() => {
    editRequestRef.current += 1;
    setEditing(false);
    setEditLoading(false);
    setEditSaving(false);
    setEditError(undefined);
    setEditText(text);
    setEditImages([...images]);
    setEditRevision(historyRevision);
  }, [historyRevision, images, text]);

  const beginEdit = useCallback(() => {
    if (!canEdit || !rewindTarget || !onLoadUserMessageEdit) {
      return;
    }
    const requestId = ++editRequestRef.current;
    setEditing(true);
    setEditText(text);
    setEditImages([...images]);
    setEditRevision(historyRevision);
    setEditError(undefined);
    setEditLoading(true);
    void onLoadUserMessageEdit(rewindTarget.activityLineId)
      .then((result) => {
        if (requestId !== editRequestRef.current) {
          return;
        }
        if (result.capability.status !== "ready") {
          setEditError(
            result.capability.reason ??
              i18n.t("activity.editUnavailable", {
                defaultValue: "此消息当前无法编辑",
              }),
          );
          return;
        }
        setEditText(result.text);
        setEditImages(result.attachments.map((attachment, index) => makeEditImage(attachment, index)));
        setEditRevision(result.historyRevision);
      })
      .catch((caught) => {
        if (requestId === editRequestRef.current) {
          setEditError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (requestId === editRequestRef.current) {
          setEditLoading(false);
        }
      });
  }, [canEdit, historyRevision, images, makeEditImage, onLoadUserMessageEdit, rewindTarget, text]);

  const appendEditImages = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) {
        return;
      }
      void Promise.all(files.map((file) => readImageFileAsAttachment(file))).then((loaded) => {
        const valid = loaded.filter((attachment): attachment is NonNullable<typeof attachment> =>
          Boolean(attachment),
        );
        setEditImages((current) => {
          const remaining = Math.max(0, COMPOSER_MAX_IMAGES - current.length);
          const next = valid.slice(0, remaining).map((attachment, index) => makeEditImage(attachment, index));
          if (next.length < files.length) {
            setEditError(
              i18n.t("activity.editImageUnavailable", {
                defaultValue: "部分图片无法添加，支持常见图片格式且单张不超过 5 MB",
              }),
            );
          }
          return next.length === 0 ? current : [...current, ...next];
        });
      });
    },
    [makeEditImage],
  );

  const handleEditPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = event.clipboardData?.items;
      if (!items?.length || editLoading || editSaving) {
        return;
      }
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }
      if (imageFiles.length === 0) {
        return;
      }
      event.preventDefault();
      appendEditImages(imageFiles);
    },
    [appendEditImages, editLoading, editSaving],
  );

  const submitEdit = useCallback(async () => {
    if (!rewindTarget || !onRewriteUserMessage || editLoading || editSaving) {
      return;
    }
    const prompt = editText.trim();
    if (!prompt && editImages.length === 0) {
      setEditError(i18n.t("activity.editEmptyMessage", { defaultValue: "消息不能为空" }));
      return;
    }
    setEditSaving(true);
    setEditError(undefined);
    try {
      await onRewriteUserMessage({
        activityLineId: rewindTarget.activityLineId,
        prompt,
        attachments: editImages.flatMap(({ mediaType, data, contentRef, byteLength }) =>
          data || contentRef
            ? [
                {
                  mediaType,
                  ...(data ? { data } : {}),
                  ...(contentRef ? { contentRef } : {}),
                  ...(byteLength !== undefined ? { byteLength } : {}),
                },
              ]
            : [],
        ),
        expectedHistoryRevision: editRevision,
      });
      setEditing(false);
    } catch (caught) {
      setEditError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEditSaving(false);
    }
  }, [editImages, editLoading, editRevision, editSaving, editText, onRewriteUserMessage, rewindTarget]);

  const handleEditKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!editSaving) {
          cancelEdit();
        }
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void submitEdit();
      }
    },
    [cancelEdit, editSaving, submitEdit],
  );

  useEffect(() => {
    if (!editing || editLoading) {
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    const length = textarea.value.length;
    textarea.setSelectionRange(length, length);
  }, [editLoading, editing]);

  useLayoutEffect(() => {
    if (previousTextRef.current === text) {
      return;
    }
    previousTextRef.current = text;
    editRequestRef.current += 1;
    setEditing(false);
    setEditLoading(false);
    setEditSaving(false);
    setEditError(undefined);
    setEditText(text);
    setEditImages([...images]);
    setEditRevision(historyRevision);
    setExpanded(false);
    setCanToggle(false);
  }, [historyRevision, images, text]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      setCanToggle(false);
      return;
    }
    if (expanded) {
      return;
    }

    const measure = () => {
      setCanToggle(body.scrollHeight > body.clientHeight + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [text, expanded]);

  const contentClassName = [
    "run-log-user-prompt-content",
    canToggle ? "has-toggle" : "",
    expanded ? "is-expanded" : "is-collapsed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={["run-log-user-prompt", className].filter(Boolean).join(" ")}
      {...(anchorId && { "data-user-message-anchor-id": anchorId })}
    >
      {origin && (
        <span className="run-log-user-prompt-origin">
          <Clock3 size={12} aria-hidden />
          {i18n.t("scheduling.messageOrigin")}
        </span>
      )}
      {editing ? (
        <div
          className="run-log-user-prompt-edit"
          role="group"
          aria-label={i18n.t("activity.editMessage", {
            defaultValue: "编辑消息",
          })}
          data-loading={editLoading ? "true" : undefined}
          data-saving={editSaving ? "true" : undefined}
        >
          {editImages.length > 0 ? (
            <div
              className="run-log-user-prompt-edit-attachments"
              aria-label={i18n.t("activity.userImages", {
                defaultValue: "消息图片",
              })}
            >
              {editImages.map((image, index) => {
                const alt = i18n.t("activity.userImageAlt", {
                  count: index + 1,
                });
                const src = `data:${image.mediaType};base64,${image.data}`;
                const openLabel = i18n.t("activity.userImageOpen", {
                  count: index + 1,
                });
                return (
                  <div key={image.id} className="run-log-user-prompt-edit-attachment">
                    <button
                      type="button"
                      className="run-log-user-prompt-edit-attachment-preview"
                      onClick={() => setLightboxImage({ src, alt, label: openLabel })}
                      aria-label={openLabel}
                      disabled={editLoading || editSaving}
                    >
                      <img src={src} alt={alt} loading="lazy" />
                    </button>
                    <button
                      type="button"
                      className="run-log-user-prompt-edit-attachment-remove"
                      onClick={() =>
                        setEditImages((current) => current.filter((entry) => entry.id !== image.id))
                      }
                      disabled={editLoading || editSaving}
                      aria-label={i18n.t("activity.removeImage", {
                        defaultValue: "删除图片",
                      })}
                      title={i18n.t("activity.removeImage", {
                        defaultValue: "删除图片",
                      })}
                    >
                      <X size={12} strokeWidth={ICON_STROKE} aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className="run-log-user-prompt-edit-textarea"
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            onPaste={handleEditPaste}
            onKeyDown={handleEditKeyDown}
            disabled={editLoading || editSaving}
            rows={2}
            spellCheck
            placeholder={i18n.t("activity.editPlaceholder", {
              defaultValue: "编辑消息…",
            })}
            aria-label={i18n.t("activity.messageContent", {
              defaultValue: "消息内容",
            })}
          />
          <div className="run-log-user-prompt-edit-bar">
            <div className="run-log-user-prompt-edit-meta">
              {editLoading ? (
                <span className="run-log-user-prompt-edit-status" role="status">
                  {i18n.t("activity.loadingMessage", {
                    defaultValue: "正在加载…",
                  })}
                </span>
              ) : editError ? (
                <span className="run-log-user-prompt-edit-error" role="alert">
                  {editError}
                </span>
              ) : editImages.length < COMPOSER_MAX_IMAGES ? (
                <span className="run-log-user-prompt-edit-hint">
                  {i18n.t("activity.editPasteHint", {
                    defaultValue: "粘贴添加图片",
                  })}
                </span>
              ) : null}
            </div>
            <div className="run-log-user-prompt-edit-actions">
              <button
                type="button"
                className="run-log-user-prompt-edit-action is-cancel"
                onClick={cancelEdit}
                disabled={editSaving}
              >
                {i18n.t("activity.cancelEdit", { defaultValue: "取消" })}
              </button>
              <button
                type="button"
                className="run-log-user-prompt-edit-action is-confirm"
                onClick={() => void submitEdit()}
                disabled={editLoading || editSaving}
              >
                {editSaving
                  ? i18n.t("activity.editSaving", { defaultValue: "发送中…" })
                  : i18n.t("activity.confirmEdit", { defaultValue: "发送" })}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className={contentClassName}>
          <div className="run-log-user-prompt-bubble">
            {images.length > 0 ? (
              <div className="run-log-user-prompt-images">
                {images.map((image, index) => {
                  const alt = i18n.t("activity.userImageAlt", {
                    count: index + 1,
                  });
                  const src = `data:${image.mediaType};base64,${image.data}`;
                  return (
                    <button
                      key={image.id}
                      type="button"
                      className="run-log-user-prompt-image"
                      onClick={() =>
                        setLightboxImage({
                          src,
                          alt,
                          label: i18n.t("activity.userImageOpen", {
                            count: index + 1,
                          }),
                        })
                      }
                      aria-label={i18n.t("activity.userImageOpen", {
                        count: index + 1,
                      })}
                    >
                      <img src={src} alt={alt} loading="lazy" />
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className={["run-log-user-prompt-body-wrap", expanded ? "expanded" : "collapsed"].join(" ")}>
              <div
                ref={bodyRef}
                className={["run-log-user-prompt-body", expanded ? "expanded" : "collapsed"].join(" ")}
              >
                {asyncQuestionReplies ? (
                  <ClarificationAnswersCard rows={asyncQuestionReplies} variant="user" />
                ) : (
                  <UserPromptBodyContent text={text} />
                )}
              </div>
              {canToggle && !expanded ? <div className="run-log-user-prompt-fade" aria-hidden /> : null}
            </div>
            {canToggle ? (
              <button
                type="button"
                className="run-log-user-prompt-expand"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
              >
                {expanded ? i18n.t("activity.collapse") : i18n.t("activity.expandFull")}
              </button>
            ) : null}
          </div>
        </div>
      )}
      {/* 用户消息的操作区只跟着「文本非空」走，不随会话进行状态隐藏：
          延迟挂载 meta 的策略只针对 agent 侧流式输出（turn final summary）。 */}
      <RunLogMessageMeta
        align="end"
        sticky={Boolean(onForkMessage && rewindTarget && !editing)}
        copyText={copyText}
        {...(createdAt ? { createdAt } : {})}
        {...(allowUserMessageRewrite &&
          onRestorePrompt &&
          rewindTarget &&
          !canEdit && {
            restorePrompt: {
              text,
              rewindTarget,
              onRestorePrompt,
            },
          })}
        {...(!editing && canEdit && { editUserMessage: { onEdit: beginEdit } })}
        {...(onForkMessage && rewindTarget && !editing ? {
          forkAction: {
            activityLineId: rewindTarget.activityLineId,
            expectedHistoryRevision: historyRevision,
            onFork: onForkMessage,
            ...(forkDisabledReason ? {disabledReason: forkDisabledReason} : {}),
          },
        } : {})}
      />

      {lightboxImage ? (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          title={lightboxImage.alt}
          dialogLabel={lightboxImage.label}
          onClose={closeLightbox}
        />
      ) : null}
    </article>
  );
}

function ClarificationAnswersCard({
  rows,
  variant,
  pending = false,
}: {
  rows: ClarificationHistoryRow[];
  pending?: boolean;
  variant?: "user";
}) {
  return (
    <div
      className={`clarification-answer-card${variant === "user" ? " clarification-answer-card--user" : ""}`}
      role="group"
      aria-label={i18n.t(pending ? "activity.clarificationQuestion" : "activity.clarificationAnswer")}
    >
      <div className="clarification-answer-header">
        <span className="clarification-answer-title">
          <CircleHelp
            className="clarification-answer-icon"
            size={ICON_SIZE.sm}
            strokeWidth={ICON_STROKE}
            aria-hidden
          />
          {i18n.t(pending ? "activity.clarificationQuestion" : "activity.clarificationAnswer")}
        </span>
      </div>
      <div className="clarification-answer-rows">
        {rows.map((row, index) => (
          <div key={index} className="clarification-answer-row">
            <div className="clarification-answer-question">{row.question}</div>
            {row.answer !== undefined ? <div className="clarification-answer-answer">{row.answer}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function SubagentMissionBlock({
  subagent,
  summary,
  prompt,
  modelByRole: _modelByRole,
  agentThemes,
  omitRoleLabel: _omitRoleLabel,
}: {
  subagent: string;
  summary: string;
  prompt?: string;
  modelByRole?: Record<string, string>;
  agentThemes?: RuntimeAgentThemes;
  omitRoleLabel?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const trimmedPrompt = prompt?.trim() ?? "";
  const trimmedSummary = summary.trim();
  const fullText = resolveMissionDisplayText(trimmedPrompt || trimmedSummary);

  return (
    <button
      type="button"
      className={`run-log-mission${expanded ? " is-expanded" : ""}`}
      data-role={normalizeAgentDisplayRole(subagent) ?? subagent}
      style={resolveSubagentRowThemeStyle(subagent, agentThemes)}
      onClick={() => setExpanded((value) => !value)}
      aria-expanded={expanded}
    >
      <div className="run-log-mission-head">
        <span className="run-log-mission-head-main">
          <span className="run-log-mission-tag">{i18n.t("activity.mission")}</span>
        </span>
        <ChevronDown size={16} className={`run-log-mission-chevron${expanded ? " open" : ""}`} aria-hidden />
      </div>
      {fullText ? (
        <ExpandableMissionText text={fullText} expanded={expanded} className="run-log-mission-preview" />
      ) : (
        <p className="run-log-mission-summary run-log-mission-summary-muted">
          {i18n.t("activity.waitingMission")}
        </p>
      )}
    </button>
  );
}

function ToolFailedBlock({
  tool,
  command,
  fileChange,
  error,
  recoveredResult,
  subagent,
  modelByRole,
  omitRoleLabel,
}: {
  tool: string;
  command?: string;
  fileChange?: { path?: string; fileName?: string };
  error?: string;
  recoveredResult?: Extract<ActivityDetailBlock, { kind: "tool-failed" }>["recoveredResult"];
  subagent?: string;
  modelByRole?: Record<string, string>;
  omitRoleLabel?: boolean;
}) {
  const isBash = tool.trim().toLowerCase() === "bash";

  if (!recoveredResult) {
    const label = summarizeFailedTool(tool, command, fileChange ? { fileChange } : undefined);
    return (
      <RunLogAction
        icon={iconForToolName(tool)}
        label={label}
        lifecycle="failed"
        {...(isBash && {
          bashRun: {
            title: label,
            ...(command && { command }),
            ...(error && { output: error }),
          },
        })}
        {...(!isBash && error && { error })}
        {...(subagent && { subagent })}
        {...(modelByRole && { modelByRole })}
        {...(omitRoleLabel !== undefined && { omitRoleLabel })}
      />
    );
  }

  return (
    <div className="run-log-tool-failed" role="status">
      {subagent && !omitRoleLabel ? (
        <span className="run-log-tool-failed-role">
          {formatRoleModelLabel(subagent, modelByRole?.[subagent])}
        </span>
      ) : null}
      <span className={`run-log-tool-failed-label${recoveredResult ? " is-recovered" : ""}`}>
        <span>
          {recoveredResult ? i18n.t("activity.patchRecovered") : summarizeFailedTool(tool, command)}
        </span>
        {!recoveredResult ? (
          <span className="run-log-tool-status-dot" title={i18n.t("activity.incomplete")} aria-hidden />
        ) : null}
      </span>
      {isBash && command ? (
        <RunLogBashTerminal command={command} />
      ) : command ? (
        <div className="run-log-tool-failed-command-wrap">
          <pre className="run-log-tool-failed-command">{command}</pre>
        </div>
      ) : null}
      {recoveredResult ? (
        <div className="run-log-tool-result-panel is-success">
          <div className="run-log-tool-result-header">
            <ShieldCheck size={14} aria-hidden />
            <span>{i18n.t("activity.noResidue")}</span>
          </div>
          <ul className="run-log-tool-result-files">
            {recoveredResult.files.map((file) => (
              <li key={`${file.status}:${file.path}`}>
                <span className="run-log-tool-result-file-status">{file.status}</span>
                <FileText size={13} aria-hidden />
                <code>{file.path}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : error && !isBash ? (
        <div className="run-log-tool-result-panel">
          <div className="run-log-tool-result-header">
            <Terminal size={14} aria-hidden />
            <span>{i18n.t("activity.commandOutput")}</span>
          </div>
          <pre className="run-log-tool-failed-error">{error}</pre>
        </div>
      ) : null}
    </div>
  );
}

function ApiErrorBlock({
  message,
  title: explicitTitle,
  statusCode,
  subagent,
  modelByRole,
  omitRoleLabel,
  onRetry,
}: {
  message: string;
  title?: string;
  statusCode?: number;
  subagent?: string;
  modelByRole?: Record<string, string>;
  omitRoleLabel?: boolean;
  onRetry?: () => void;
}) {
  const title =
    explicitTitle ??
    (statusCode !== undefined
      ? i18n.t("activity.connectionFailedHttp", { status: statusCode })
      : i18n.t("activity.connectionFailed"));

  return (
    <FeedErrorCard
      message={message}
      title={title}
      {...(subagent && !omitRoleLabel
        ? { context: formatRoleModelLabel(subagent, modelByRole?.[subagent]) }
        : {})}
      {...(onRetry ? { actionLabel: i18n.t("common.retry"), onAction: onRetry } : {})}
    />
  );
}

type ImageViewLoadState =
  | { status: "loading" }
  | {
      status: "ready";
      src: string;
      fileName: string;
      path: string;
    }
  | {
      status: "error";
      code?: import("../shared/ipc").ImageViewReadFailureCode | "bridge_unavailable";
      detail?: string;
    };

export function ImageViewBlock({
  imageView,
  output,
  lifecycle,
  subagent,
  modelByRole,
  omitRoleLabel,
}: {
  imageView: { path: string; eventId: string; prompt?: string };
  /** 视觉模型实际返回的文本，作为预览弹窗右侧的补充内容。 */
  output?: string;
  lifecycle?: ToolActionLifecycle;
  subagent?: string;
  modelByRole?: Record<string, string>;
  omitRoleLabel?: boolean;
}) {
  const [loadState, setLoadState] = useState<ImageViewLoadState>({
    status: "loading",
  });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const closeLightbox = useCallback(() => setLightboxOpen(false), []);
  const [retryToken, setRetryToken] = useState(0);
  const fallbackFileName = imageView.path.split(/[\\/]/u).at(-1) || imageView.path;
  const roleLabel =
    subagent && !omitRoleLabel ? formatRoleModelLabel(subagent, modelByRole?.[subagent]) : undefined;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setLoadState({ status: "loading" });
    setDetailsOpen(false);
    setLightboxOpen(false);
    const api = window.eco;
    if (!api) {
      setLoadState({ status: "error", code: "bridge_unavailable" });
      return () => {
        cancelled = true;
      };
    }
    void api
      .readImageView({ path: imageView.path })
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setLoadState({ status: "error", code: result.code });
          return;
        }
        const url = createImageObjectUrlFromBase64(result.mimeType, result.dataBase64);
        if (cancelled) {
          revokeImageObjectUrl(url);
          return;
        }
        objectUrl = url;
        setLoadState({
          status: "ready",
          src: objectUrl,
          fileName: result.fileName,
          path: result.path,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadState({
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
      revokeImageObjectUrl(objectUrl);
    };
  }, [imageView.eventId, imageView.path, retryToken]);

  const fileName = loadState.status === "ready" ? loadState.fileName : fallbackFileName;
  const revealInFolder = useCallback(() => {
    if (loadState.status !== "ready") return;
    const bridge = window.eco;
    if (!bridge?.revealImageInFolder) return;
    void bridge.revealImageInFolder({ path: loadState.path }).catch((error) => {
      console.warn("Failed to open the folder containing the image.", error);
    });
  }, [loadState]);
  const statusLabel =
    lifecycle === "running" ? i18n.t("activity.imageView.viewing") : i18n.t("activity.imageView.viewed");
  const previewAlt = i18n.t("activity.imageView.previewAlt", {
    name: fileName,
  });
  const analysisPanel = imageViewAnalysisPanel(imageView.prompt, output);

  return (
    <div className="run-log-image-view-wrap">
      {roleLabel ? <span className="run-log-action-role">{roleLabel}</span> : null}
      <article className="run-log-image-view" aria-busy={loadState.status === "loading"}>
        <RunLogCollapsibleActionTrigger
          className="run-log-image-view-summary"
          icon="images"
          label={lifecycle === "running" ? <ShimmerText>{statusLabel}</ShimmerText> : statusLabel}
          {...(lifecycle && { lifecycle })}
          expanded={detailsOpen}
          onClick={() => setDetailsOpen((value) => !value)}
        />

        {detailsOpen ? (
          <div className="run-log-image-view-body">
            {loadState.status === "loading" ? (
              <div className="run-log-image-view-state" aria-label={i18n.t("activity.imageView.loading")}>
                <RefreshCw size={18} className="run-log-image-view-spinner" aria-hidden />
                <span>{i18n.t("activity.imageView.loading")}</span>
              </div>
            ) : null}
            {loadState.status === "error" ? (
              <div className="run-log-image-view-state is-error" role="alert">
                <CircleAlert size={18} aria-hidden />
                <span className="run-log-image-view-error-copy">
                  <strong>{imageViewFailureLabel(loadState.code)}</strong>
                  {loadState.detail ? <span>{loadState.detail}</span> : null}
                </span>
                <button
                  type="button"
                  className="run-log-image-view-icon-button"
                  onClick={() => setRetryToken((value) => value + 1)}
                  title={i18n.t("common.retry")}
                  aria-label={i18n.t("common.retry")}
                >
                  <RefreshCw size={15} aria-hidden />
                </button>
              </div>
            ) : null}
            {loadState.status === "ready" ? (
              <button
                type="button"
                className="run-log-image-view-preview"
                onClick={() => setLightboxOpen(true)}
                aria-label={i18n.t("activity.imageView.open", {
                  name: fileName,
                })}
                title={fileName}
              >
                <img src={loadState.src} alt={previewAlt} />
              </button>
            ) : null}
          </div>
        ) : null}
      </article>

      {lightboxOpen && loadState.status === "ready" ? (
        <ImageLightbox
          src={loadState.src}
          alt={previewAlt}
          title={fileName}
          dialogLabel={i18n.t("activity.imageView.open", { name: fileName })}
          onOpenFolder={revealInFolder}
          onClose={closeLightbox}
          {...(analysisPanel && { sidePanel: analysisPanel })}
        />
      ) : null}
    </div>
  );
}

type ImageDisplayLoadState =
  | { status: "loading" }
  | {
      status: "ready";
      src: string;
      fileName: string;
      path: string;
    }
  | {
      status: "error";
      code?: import("../shared/image-display").ImageDisplayReadFailureCode | "bridge_unavailable";
      detail?: string;
    };

export function HtmlHostBlock({
  htmlHost,
  lifecycle,
  subagent,
  modelByRole,
  omitRoleLabel,
}: {
  htmlHost: {
    pageId: string;
    publicUrl: string;
    eventId: string;
    title?: string;
    expiresAt?: string;
    canExtend?: boolean;
  };
  lifecycle?: ToolActionLifecycle;
  subagent?: string;
  modelByRole?: Record<string, string>;
  omitRoleLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(lifecycle !== "running");
  const [opening, setOpening] = useState(false);
  const title = htmlHost.title?.trim() || i18n.t("activity.htmlHost.cardTitle");
  const roleLabel =
    subagent && !omitRoleLabel ? formatRoleModelLabel(subagent, modelByRole?.[subagent]) : undefined;
  const statusLabel =
    lifecycle === "running" ? i18n.t("activity.htmlHost.publishing") : i18n.t("activity.htmlHost.published");
  const expiresLabel = htmlHost.expiresAt
    ? i18n.t("activity.htmlHost.expiresAt", {
        time: htmlHost.expiresAt.replace("T", " ").slice(0, 19),
      })
    : undefined;

  useEffect(() => {
    if (lifecycle === "running") {
      setDetailsOpen(false);
      return;
    }
    setDetailsOpen(true);
  }, [htmlHost.eventId, lifecycle]);

  const openInBrowser = useCallback(() => {
    if (opening) return;
    setOpening(true);
    void openPublishedHtmlInBrowser(htmlHost.publicUrl).finally(() => setOpening(false));
  }, [htmlHost.publicUrl, opening]);

  return (
    <div className="run-log-html-host-wrap">
      {roleLabel ? <span className="run-log-action-role">{roleLabel}</span> : null}
      <article className="run-log-html-host" aria-busy={lifecycle === "running" || opening}>
        <RunLogCollapsibleActionTrigger
          className="run-log-html-host-summary"
          icon="browser"
          label={lifecycle === "running" ? <ShimmerText>{statusLabel}</ShimmerText> : statusLabel}
          {...(lifecycle && { lifecycle })}
          expanded={detailsOpen}
          onClick={() => setDetailsOpen((value) => !value)}
        />

        {detailsOpen ? (
          <div className="run-log-html-host-body">
            <button
              type="button"
              className="run-log-html-host-card"
              onClick={openInBrowser}
              disabled={opening || lifecycle === "running"}
              title={i18n.t("activity.htmlHost.openInBrowser")}
              aria-label={`${title} — ${i18n.t("activity.htmlHost.openInBrowser")}`}
            >
              <span className="run-log-html-host-card__icon" aria-hidden>
                <img
                  className="run-log-html-host-card__logo"
                  src="./splash-icon.png"
                  alt=""
                  width={20}
                  height={20}
                  draggable={false}
                />
              </span>
              <span className="run-log-html-host-card__body">
                <span className="run-log-html-host-card__title">{title}</span>
                <span className="run-log-html-host-card__meta">
                  {statusLabel}
                  {expiresLabel ? ` · ${expiresLabel}` : ""}
                </span>
              </span>
              <span className="run-log-html-host-card__hint" aria-hidden>
                <ExternalLink size={14} />
              </span>
            </button>
            <div className="run-log-html-host-actions">
              <button
                type="button"
                className="run-log-html-host-copy"
                onClick={() => {
                  void navigator.clipboard.writeText(htmlHost.publicUrl).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                <Copy size={14} aria-hidden />
                {copied ? i18n.t("activity.htmlHost.copied") : i18n.t("activity.htmlHost.copyLink")}
              </button>
            </div>
          </div>
        ) : null}
      </article>
    </div>
  );
}

export function ImageDisplayBlock({
  imageDisplay,
  lifecycle,
  subagent,
  modelByRole,
  omitRoleLabel,
  onOpenImageDisplayArtifact,
}: {
  imageDisplay: { artifactId: string; eventId: string; title?: string };
  lifecycle?: ToolActionLifecycle;
  subagent?: string;
  modelByRole?: Record<string, string>;
  omitRoleLabel?: boolean;
  onOpenImageDisplayArtifact?: OpenImageDisplayArtifactHandler;
}) {
  const [loadState, setLoadState] = useState<ImageDisplayLoadState>({
    status: "loading",
  });
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const closeLightbox = useCallback(() => setLightboxOpen(false), []);
  const [retryToken, setRetryToken] = useState(0);
  const fallbackFileName = imageDisplay.title?.trim() || imageDisplay.artifactId;
  const roleLabel =
    subagent && !omitRoleLabel ? formatRoleModelLabel(subagent, modelByRole?.[subagent]) : undefined;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setLoadState({ status: "loading" });
    setLightboxOpen(false);
    const api = window.eco;
    if (!api?.readImageDisplay) {
      setLoadState({ status: "error", code: "bridge_unavailable" });
      return () => {
        cancelled = true;
      };
    }
    void api
      .readImageDisplay({ artifactId: imageDisplay.artifactId })
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setLoadState({ status: "error", code: result.code });
          return;
        }
        const url = createImageObjectUrlFromBase64(result.mimeType, result.dataBase64);
        if (cancelled) {
          revokeImageObjectUrl(url);
          return;
        }
        objectUrl = url;
        setLoadState({
          status: "ready",
          src: objectUrl,
          fileName: result.fileName,
          path: result.path,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadState({
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
      revokeImageObjectUrl(objectUrl);
    };
  }, [imageDisplay.artifactId, imageDisplay.eventId, retryToken]);

  const fileName = loadState.status === "ready" ? loadState.fileName : fallbackFileName;
  const statusLabel =
    lifecycle === "running"
      ? i18n.t("activity.imageDisplay.viewing")
      : i18n.t("activity.imageDisplay.viewed");
  const previewAlt = i18n.t("activity.imageDisplay.previewAlt", {
    name: fileName,
  });
  const openInPanelLabel = i18n.t("task.imageDisplay.open");
  const revealInFolder = useCallback(() => {
    if (loadState.status !== "ready") return;
    const bridge = window.eco;
    if (!bridge?.revealImageInFolder) return;
    void bridge.revealImageInFolder({ path: loadState.path }).catch((error) => {
      console.warn("Failed to open the folder containing the image.", error);
    });
  }, [loadState]);

  return (
    <div className="run-log-image-view-wrap">
      {roleLabel ? <span className="run-log-action-role">{roleLabel}</span> : null}
      <article className="run-log-image-view" aria-busy={loadState.status === "loading"}>
        <div className="run-log-image-view-head">
          <RunLogCollapsibleActionTrigger
            className="run-log-image-view-summary"
            icon="images"
            label={lifecycle === "running" ? <ShimmerText>{statusLabel}</ShimmerText> : statusLabel}
            {...(lifecycle && { lifecycle })}
            expanded={detailsOpen}
            onClick={() => setDetailsOpen((value) => !value)}
          />
          {/* 折叠层只负责展开/折叠；打开工作面板需要显式点击这个按钮。 */}
          {onOpenImageDisplayArtifact ? (
            <button
              type="button"
              className="run-log-image-view-icon-button run-log-image-view-panel-trigger"
              onClick={() => onOpenImageDisplayArtifact(imageDisplay.artifactId)}
              aria-label={openInPanelLabel}
              title={openInPanelLabel}
            >
              <PanelRight size={14} aria-hidden />
            </button>
          ) : null}
        </div>

        {detailsOpen ? (
          <div className="run-log-image-view-body">
            {loadState.status === "loading" ? (
              <div className="run-log-image-view-state" aria-label={i18n.t("activity.imageDisplay.loading")}>
                <RefreshCw size={18} className="run-log-image-view-spinner" aria-hidden />
                <span>{i18n.t("activity.imageDisplay.loading")}</span>
              </div>
            ) : null}
            {loadState.status === "error" ? (
              <div className="run-log-image-view-state is-error" role="alert">
                <CircleAlert size={18} aria-hidden />
                <span className="run-log-image-view-error-copy">
                  <strong>{imageDisplayFailureLabel(loadState.code)}</strong>
                  {loadState.detail ? <span>{loadState.detail}</span> : null}
                </span>
                <button
                  type="button"
                  className="run-log-image-view-icon-button"
                  onClick={() => setRetryToken((value) => value + 1)}
                  title={i18n.t("common.retry")}
                  aria-label={i18n.t("common.retry")}
                >
                  <RefreshCw size={15} aria-hidden />
                </button>
              </div>
            ) : null}
            {loadState.status === "ready" ? (
              <button
                type="button"
                className="run-log-image-view-preview"
                onClick={() => setLightboxOpen(true)}
                aria-label={i18n.t("activity.imageDisplay.open", {
                  name: fileName,
                })}
                title={fileName}
              >
                <img src={loadState.src} alt={previewAlt} />
              </button>
            ) : null}
          </div>
        ) : null}
      </article>

      {lightboxOpen && loadState.status === "ready" ? (
        <ImageLightbox
          src={loadState.src}
          alt={previewAlt}
          title={fileName}
          dialogLabel={i18n.t("activity.imageDisplay.open", { name: fileName })}
          onOpenFolder={revealInFolder}
          onClose={closeLightbox}
        />
      ) : null}
    </div>
  );
}

type ImageViewFailureCode = Extract<ImageViewLoadState, { status: "error" }>["code"];

function imageViewFailureLabel(code: ImageViewFailureCode): string {
  switch (code) {
    case "invalid_path":
      return i18n.t("activity.imageView.error.invalidPath");
    case "not_found":
      return i18n.t("activity.imageView.error.notFound");
    case "symbolic_link":
      return i18n.t("activity.imageView.error.symbolicLink");
    case "not_file":
      return i18n.t("activity.imageView.error.notFile");
    case "too_large":
      return i18n.t("activity.imageView.error.tooLarge");
    case "unsupported_type":
      return i18n.t("activity.imageView.error.unsupportedType");
    case "bridge_unavailable":
      return i18n.t("activity.imageView.error.bridgeUnavailable");
    default:
      return i18n.t("activity.imageView.error.readFailed");
  }
}

type ImageDisplayFailureCode = Extract<ImageDisplayLoadState, { status: "error" }>["code"];

function imageDisplayFailureLabel(code: ImageDisplayFailureCode): string {
  switch (code) {
    case "invalid_artifact":
      return i18n.t("activity.imageDisplay.error.invalidArtifact");
    case "not_found":
      return i18n.t("activity.imageDisplay.error.notFound");
    case "too_large":
      return i18n.t("activity.imageDisplay.error.tooLarge");
    case "unsupported_type":
      return i18n.t("activity.imageDisplay.error.unsupportedType");
    case "bridge_unavailable":
      return i18n.t("activity.imageDisplay.error.bridgeUnavailable");
    default:
      return i18n.t("activity.imageDisplay.error.readFailed");
  }
}

function RunLogAction({
  icon,
  label,
  displayLabelOverride,
  lifecycle,
  startedAt,
  durationMs,
  elapsedInline,
  bashRun,
  fileChange,
  webSearch,
  toolOutput,
  details,
  error,
  subagent,
  modelByRole,
  omitRoleLabel,
  forceDetailsExpanded = false,
  onActivate,
}: {
  icon: ActivityActionIcon;
  label: string;
  displayLabelOverride?: string;
  lifecycle?: ToolActionLifecycle;
  /** 工具调用开始时间（行事件/插入时间）；running 行据此显示实时耗时。 */
  startedAt?: string;
  /** Measured duration of a settled lifecycle row, retained after reopening. */
  durationMs?: number;
  /** Render the elapsed time inside the label flow (right after the text) instead of at the row end. */
  elapsedInline?: boolean;
  bashRun?: import("../shared/activity-display").BashRunCardDisplay;
  fileChange?: import("../shared/activity-display").FileChangeCardDisplay;
  webSearch?: import("../shared/activity-display").WebSearchCardDisplay;
  toolOutput?: string;
  details?: ReactNode;
  error?: string;
  subagent?: string;
  modelByRole?: Record<string, string>;
  omitRoleLabel?: boolean;
  forceDetailsExpanded?: boolean;
  onActivate?: () => void;
}) {
  const isTerminal = icon === "terminal";
  const [expanded, setExpanded] = useState(false);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [canExpand, setCanExpand] = useState(false);
  // Live elapsed time for a running tool row; 0 (never ticking) when the row is settled
  // or carries no start time. Displayed only past TOOL_ELAPSED_MIN_VISIBLE_MS, except for
  // inline rows (context compaction), which count up from the first whole second.
  const runningElapsedMs = useTurnDurationMs(
    startedAt ?? "",
    undefined,
    startedAt !== undefined && lifecycle === "running",
  );
  const elapsedLabel =
    lifecycle === "running"
      ? elapsedInline || runningElapsedMs > TOOL_ELAPSED_MIN_VISIBLE_MS
        ? formatDuration(runningElapsedMs)
        : ""
      : durationMs !== undefined
        ? formatDuration(durationMs)
        : "";
  const subagentRole = subagent?.trim() ? subagent : undefined;
  const showRoleLabel =
    subagentRole !== undefined &&
    !omitRoleLabel &&
    !activityLabelIncludesAgentRole(subagentRole, label, {
      modelId: modelByRole?.[subagentRole],
    });
  const roleLabel =
    showRoleLabel && subagentRole
      ? formatRoleModelLabel(subagentRole, modelByRole?.[subagentRole])
      : undefined;
  const displayLabel =
    displayLabelOverride ?? bashRun?.title ?? fileChange?.fileName ?? label;
  const hasHeavyDetails = Boolean(
    bashRun?.command || bashRun?.output || fileChange || webSearch || error || toolOutput || details,
  );
  const detailsExpanded = forceDetailsExpanded || expanded;
  const canToggleDetails = !forceDetailsExpanded && (hasHeavyDetails || (isTerminal && canExpand));

  useLayoutEffect(() => {
    if (bashRun || webSearch || !isTerminal || expanded) {
      return;
    }
    const measure = () => {
      const node = labelRef.current;
      const overflows =
        Boolean(label.includes("\n")) ||
        label.trim().length > 72 ||
        Boolean(node && node.scrollWidth > node.clientWidth + 1);
      setCanExpand(overflows);
    };
    measure();
    const node = labelRef.current;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [bashRun, webSearch, expanded, isTerminal, label]);

  const triggerClassName = [
    "run-log-action-trigger",
    lifecycle === "running" ? "is-running" : "",
    lifecycle === "approval-pending" ? "is-pending" : "",
    canToggleDetails ? "is-expandable" : "",
    detailsExpanded ? "is-expanded" : "",
    fileChange ? "is-file-change" : "",
    webSearch ? "is-web-search" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const row = (
    <>
      <RunLogActionIcon icon={icon} {...(lifecycle && { lifecycle })} />
      <span ref={labelRef} className="run-log-action-label">
        {icon === "context" && lifecycle === "running" ? (
          <ShimmerText>{displayLabel}</ShimmerText>
        ) : (
          displayLabel
        )}
        {elapsedInline && elapsedLabel ? (
          <span className="run-log-action-elapsed run-log-action-elapsed--inline">{elapsedLabel}</span>
        ) : null}
      </span>
      {elapsedLabel && !elapsedInline ? (
        <span className="run-log-action-meta run-log-action-elapsed">{elapsedLabel}</span>
      ) : null}
      {lifecycle === "failed" ? (
        <span className="run-log-tool-status-dot" title={i18n.t("activity.incomplete")} aria-hidden />
      ) : null}
      {fileChange && !detailsExpanded && (fileChange.additions > 0 || fileChange.deletions > 0) ? (
        <span className="run-log-file-change-card-stats run-log-action-file-stats">
          {fileChange.additions > 0 ? <span className="stat-add">+{fileChange.additions}</span> : null}
          {fileChange.deletions > 0 ? <span className="stat-del">-{fileChange.deletions}</span> : null}
        </span>
      ) : null}
      {webSearch?.statusText && !detailsExpanded ? (
        <span className="run-log-action-meta run-log-web-search-status-pill">{webSearch.statusText}</span>
      ) : null}
      {bashRun?.meta ? <span className="run-log-action-meta">{bashRun.meta}</span> : null}
      {webSearch?.meta && !bashRun?.meta ? (
        <span className="run-log-action-meta">{webSearch.meta}</span>
      ) : null}
      {canToggleDetails ? (
        <ChevronDown
          size={14}
          className={`run-log-action-chevron${detailsExpanded ? " open" : ""}`}
          aria-hidden
        />
      ) : null}
    </>
  );

  if (bashRun) {
    return (
      <div className="run-log-action run-log-action--with-card run-log-action--bash-card">
        {roleLabel ? (
          <span className="run-log-action-role run-log-action--bash-card-role">{roleLabel}</span>
        ) : null}
        <div className="run-log-action-main run-log-feed-surface">
          {canToggleDetails ? (
            <button
              type="button"
              className={`${triggerClassName} run-log-feed-surface-header`}
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={detailsExpanded}
              title={detailsExpanded ? undefined : bashRun.title}
            >
              {row}
            </button>
          ) : (
            <div className={`${triggerClassName} run-log-feed-surface-header`}>{row}</div>
          )}
          {detailsExpanded ? (
            <div className="run-log-action-card-detail run-log-feed-surface-body">
              <RunLogBashTerminal
                {...(bashRun.command && { command: bashRun.command })}
                {...(bashRun.output && { output: bashRun.output })}
              />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (fileChange) {
    return (
      <div className="run-log-action run-log-action--with-card run-log-action--file-change-card">
        {roleLabel ? <span className="run-log-action-role">{roleLabel}</span> : null}
        <div className="run-log-action-main">
          {canToggleDetails ? (
            <button
              type="button"
              className={triggerClassName}
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={detailsExpanded}
              title={detailsExpanded ? undefined : fileChange.fileName}
            >
              {row}
            </button>
          ) : (
            <div className={triggerClassName}>{row}</div>
          )}
          {detailsExpanded ? (
            <div className="run-log-action-card-detail">
              <RunLogFileChangeCard display={fileChange} {...(lifecycle && { lifecycle })} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={["run-log-action", isTerminal ? "run-log-action--terminal" : ""].filter(Boolean).join(" ")}
    >
      {roleLabel ? <span className="run-log-action-role">{roleLabel}</span> : null}
      <div className="run-log-action-main">
        {canToggleDetails || onActivate ? (
          <button
            type="button"
            className={triggerClassName}
            onClick={onActivate ?? (() => setExpanded((value) => !value))}
            {...(canToggleDetails && { "aria-expanded": detailsExpanded })}
            title={detailsExpanded ? undefined : label}
          >
            {row}
          </button>
        ) : (
          <div className={triggerClassName}>{row}</div>
        )}
        {webSearch && detailsExpanded ? (
          <div className="run-log-feed-surface run-log-web-search-detail run-log-action-card-detail">
            <div className="run-log-feed-surface-body">
              <RunLogWebSearchDetail display={webSearch} {...(lifecycle ? { lifecycle } : {})} />
            </div>
          </div>
        ) : null}
        {detailsExpanded ? details : null}
        {error && detailsExpanded ? (
          <div className="run-log-tool-result-panel">
            <div className="run-log-tool-result-header">
              <Terminal size={14} aria-hidden />
              <span>{i18n.t("activity.commandOutput")}</span>
            </div>
            <pre className="run-log-tool-failed-error">{error}</pre>
          </div>
        ) : toolOutput && detailsExpanded ? (
          <div className="run-log-tool-result-panel">
            <div className="run-log-tool-result-header">
              <Terminal size={14} aria-hidden />
              <span>{i18n.t("activity.commandOutput")}</span>
            </div>
            <pre className="run-log-tool-failed-error">{toolOutput}</pre>
          </div>
        ) : isTerminal && canExpand && detailsExpanded ? (
          <div className="run-log-action-detail-shell open">
            <div className="run-log-action-detail-inner">
              <pre className="run-log-action-detail">{label}</pre>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Expanded body only — outer shell is already one feed-surface card. */
function RunLogWebSearchDetail({
  display,
  lifecycle,
}: {
  display: import("../shared/activity-display").WebSearchCardDisplay;
  lifecycle?: ToolActionLifecycle;
}) {
  const status =
    display.statusText ||
    (lifecycle === "running"
      ? i18n.t("activity.webSearch.searching")
      : lifecycle === "failed"
        ? i18n.t("activity.webSearch.failed")
        : undefined);

  return (
    <div className="run-log-web-search-detail-body">
      <div className="run-log-web-search-detail-row">
        <span className="run-log-web-search-detail-label">
          {display.kind === "fetch"
            ? i18n.t("activity.webSearch.fetchKicker")
            : i18n.t("activity.webSearch.queryLabel")}
        </span>
        <span className="run-log-web-search-detail-value">{display.query}</span>
      </div>
      {status ? (
        <div className="run-log-web-search-detail-row">
          <span className="run-log-web-search-detail-label">{i18n.t("activity.webSearch.statusLabel")}</span>
          <span className="run-log-web-search-detail-value is-muted">{status}</span>
        </div>
      ) : null}
      {display.actionLabel ? (
        <div className="run-log-web-search-detail-row">
          <span className="run-log-web-search-detail-label">{i18n.t("activity.webSearch.actionLabel")}</span>
          <span className="run-log-web-search-detail-value is-muted">{display.actionLabel}</span>
        </div>
      ) : null}
      {display.url ? (
        <div className="run-log-web-search-detail-row">
          <span className="run-log-web-search-detail-label">URL</span>
          {isHttpishHref(display.url) ? (
            <a
              className="run-log-web-search-detail-value is-url"
              href={display.url}
              title={display.url}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                dispatchBrowserLinkOpen(display.url!);
              }}
            >
              {display.url}
            </a>
          ) : (
            <span className="run-log-web-search-detail-value is-url" title={display.url}>
              {display.url}
            </span>
          )}
        </div>
      ) : null}
      {display.queries && display.queries.length > 1 ? (
        <div className="run-log-web-search-detail-row">
          <span className="run-log-web-search-detail-label">{i18n.t("activity.webSearch.queriesLabel")}</span>
          <ul className="run-log-web-search-detail-queries">
            {display.queries.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {display.provider ? (
        <div className="run-log-web-search-detail-row">
          <span className="run-log-web-search-detail-label">
            {i18n.t("activity.webSearch.providerLabel")}
          </span>
          <span className="run-log-web-search-detail-value is-muted">{display.provider}</span>
        </div>
      ) : null}
      {display.results && display.results.length > 0 ? (
        <div className="run-log-web-search-detail-row run-log-web-search-detail-results-row">
          <span className="run-log-web-search-detail-label">{i18n.t("activity.webSearch.resultsLabel")}</span>
          <ol className="run-log-web-search-detail-results">
            {display.results.map((entry, index) => (
              <li key={`${entry.url || entry.title}-${index}`} className="run-log-web-search-detail-result">
                <span className="run-log-web-search-detail-result-title">
                  {entry.title || entry.url || i18n.t("activity.webSearch.untitledResult")}
                </span>
                {entry.url ? (
                  isHttpishHref(entry.url) ? (
                    <a
                      className="run-log-web-search-detail-result-url"
                      href={entry.url}
                      title={`${i18n.t("markdown.html.openInBrowser")}: ${entry.url}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        dispatchBrowserLinkOpen(entry.url);
                      }}
                    >
                      {entry.url}
                    </a>
                  ) : (
                    <span className="run-log-web-search-detail-result-url" title={entry.url}>
                      {entry.url}
                    </span>
                  )
                ) : null}
                {entry.description ? (
                  <span className="run-log-web-search-detail-result-desc">{entry.description}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {display.note ? <p className="run-log-web-search-detail-note">{display.note}</p> : null}
    </div>
  );
}

function RunLogFileChangeCard({
  display,
  lifecycle,
}: {
  display: import("../shared/activity-display").FileChangeCardDisplay;
  lifecycle?: ToolActionLifecycle;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsedLineLimit = 6;
  const previewLines = expanded ? display.previewLines : display.previewLines.slice(0, collapsedLineLimit);

  return (
    <button
      type="button"
      className={[
        "run-log-file-change-card",
        lifecycle === "running" ? "is-running" : "",
        expanded ? "is-expanded" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => setExpanded((value) => !value)}
      aria-expanded={expanded}
    >
      <div className="run-log-file-change-card-header">
        <span className="run-log-file-change-card-title">{display.fileName}</span>
        {!expanded && (display.additions > 0 || display.deletions > 0) ? (
          <span className="run-log-file-change-card-stats">
            {display.additions > 0 ? <span className="stat-add">+{display.additions}</span> : null}
            {display.deletions > 0 ? <span className="stat-del">-{display.deletions}</span> : null}
          </span>
        ) : null}
      </div>
      <div className="run-log-file-change-card-divider" aria-hidden />
      <div className="run-log-file-change-card-preview-shell">
        <div className="run-log-file-change-card-preview">
          {previewLines.map((line, index) => (
            <div
              key={`${line.kind}:${index}:${line.text.slice(0, 24)}`}
              className={[
                "run-log-file-change-line",
                line.kind === "add" ? "is-add" : "",
                line.kind === "remove" ? "is-remove" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <code>{line.text || " "}</code>
            </div>
          ))}
        </div>
      </div>
    </button>
  );
}

function RunLogBashTerminal({ command, output }: { command?: string; output?: string }) {
  return (
    <div className="run-log-bash-terminal">
      {command ? <RunLogBashCommand command={command} /> : null}
      {output ? <RunLogBashOutput output={output} /> : null}
    </div>
  );
}

function RunLogBashCommand({ command }: { command: string }) {
  return (
    <div className="run-log-bash-command" onWheel={scrollBashOutputFromCommand}>
      <span className="run-log-bash-prompt" aria-hidden>
        $
      </span>
      <pre className="run-log-bash-command-text">{command}</pre>
      <button
        type="button"
        className="run-log-bash-copy"
        onClick={(event) => {
          event.stopPropagation();
          copyRunLogMessageText(command);
        }}
        aria-label={i18n.t("activity.copyBash")}
        title={i18n.t("activity.copyCommand")}
      >
        <Copy size={13} aria-hidden />
      </button>
    </div>
  );
}

function RunLogBashOutput({ output }: { output: string }) {
  return (
    <div className="run-log-bash-output-wrap">
      <div className="run-log-bash-output-actions">
        <button
          type="button"
          className="run-log-bash-copy run-log-bash-output-copy"
          onClick={(event) => {
            event.stopPropagation();
            copyRunLogMessageText(output);
          }}
          aria-label={i18n.t("activity.copyCommandOutput")}
          title={i18n.t("activity.copyOutput")}
        >
          <Copy size={13} aria-hidden />
        </button>
      </div>
      <pre className="run-log-bash-output">{output}</pre>
    </div>
  );
}

const approvalLifecycleStatusIcons = {
  "approval-pending": Shield,
  "approval-approved": ShieldCheck,
  "approval-rejected": ShieldAlert,
} as const;

type ApprovalLifecycle = keyof typeof approvalLifecycleStatusIcons;

function isApprovalLifecycle(lifecycle: ToolActionLifecycle): lifecycle is ApprovalLifecycle {
  return lifecycle in approvalLifecycleStatusIcons;
}

function lifecycleStatusLabel(lifecycle: ToolActionLifecycle): string {
  switch (lifecycle) {
    case "approval-pending":
      return i18n.t("activity.lifecycle.pending");
    case "approval-approved":
      return i18n.t("activity.lifecycle.approved");
    case "approval-rejected":
      return i18n.t("activity.lifecycle.rejected");
    case "running":
      return i18n.t("activity.lifecycle.running");
    case "completed":
      return i18n.t("activity.lifecycle.completed");
    case "failed":
      return i18n.t("activity.lifecycle.failed");
  }
}

const actionIcons = {
  search: Search,
  file: FileText,
  read: BookOpen,
  image: ImageIcon,
  images: Images,
  audio: Volume2,
  browser: AppWindow,
  edit: Pencil,
  terminal: Terminal,
  agent: Bot,
  context: Minimize2,
  network: Globe2,
  computer: Monitor,
  code: Code,
  tool: Wrench,
} as const;

function approvalStatusBadgeClass(lifecycle: ApprovalLifecycle): string {
  switch (lifecycle) {
    case "approval-pending":
      return "is-pending";
    case "approval-approved":
      return "is-approved";
    case "approval-rejected":
      return "is-rejected";
  }
}

function RunLogActionIcon({
  icon,
  lifecycle,
}: {
  icon: ActivityActionIcon;
  lifecycle?: ToolActionLifecycle;
}) {
  const Icon = actionIcons[icon];
  const approvalLifecycle = lifecycle && isApprovalLifecycle(lifecycle) ? lifecycle : undefined;
  const StatusIcon = approvalLifecycle ? approvalLifecycleStatusIcons[approvalLifecycle] : undefined;
  const statusLabel = approvalLifecycle ? lifecycleStatusLabel(approvalLifecycle) : undefined;
  return (
    <span className="run-log-action-icon-wrap" aria-hidden>
      <Icon size={14} className="run-log-action-icon" />
      {StatusIcon && approvalLifecycle ? (
        <span
          className={["run-log-action-status-badge", approvalStatusBadgeClass(approvalLifecycle)].join(" ")}
          title={statusLabel}
        >
          <StatusIcon size={8} className="run-log-action-status-icon" strokeWidth={2.5} />
        </span>
      ) : null}
    </span>
  );
}

function RunLogCollapsibleActionTrigger({
  icon,
  label,
  lifecycle,
  expanded,
  onClick,
  className,
}: {
  icon: ActivityActionIcon;
  label: ReactNode;
  lifecycle?: ToolActionLifecycle;
  expanded: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={[
        "run-log-tool-group-trigger",
        lifecycle === "running" ? "is-running" : "",
        lifecycle === "approval-pending" ? "is-pending" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
      aria-expanded={expanded}
    >
      <RunLogActionIcon icon={icon} {...(lifecycle && { lifecycle })} />
      <span className="run-log-tool-group-summary">{label}</span>
      <ChevronRight
        size={15}
        className={`run-log-tool-group-chevron${expanded ? " open" : ""}`}
        aria-hidden
      />
    </button>
  );
}

function RunLogNarrative({
  text,
  createdAt,
  showMessageMeta = false,
  stickyMessageMeta = false,
  streaming,
  pacing = true,
  subagent,
  compact,
  modelByRole,
  usageByRole,
  omitSubagentBadge,
  requestSpan,
  item,
  onForkMessage,
  forkDisabledReason,
  historyRevision = 0,
}: {
  text: string;
  createdAt?: string;
  showMessageMeta?: boolean;
  stickyMessageMeta?: boolean;
  streaming?: boolean;
  pacing?: boolean;
  subagent?: string;
  compact?: boolean;
  modelByRole?: Record<string, string>;
  usageByRole?: Record<string, ThreadUsageSnapshot>;
  omitSubagentBadge?: boolean;
  requestSpan?: ThreadRunProjectionRequestSpan;
  item?: ThreadRunProjectionTimelineItem;
  onForkMessage?: ForkMessageHandler;
  forkDisabledReason?: string;
  historyRevision?: number;
}) {
  const usage = subagent ? usageByRole?.[subagent] : undefined;
  const hasBody = text.trim().length > 0;
  const showSubagentBadge = subagent && !omitSubagentBadge;
  const showBody = hasBody || !streaming;
  const showFinalMessageMeta = showMessageMeta && hasBody && !streaming;
  const messageId = item?.metadata?.conversationV2MessageId;
  const forkAction: MessageForkAction | undefined =
    onForkMessage && typeof messageId === "string" && item?.scope !== "agent"
      ? {
          activityLineId: messageId,
          expectedHistoryRevision: historyRevision,
          onFork: onForkMessage,
          ...(forkDisabledReason ? { disabledReason: forkDisabledReason } : {}),
        }
      : undefined;
  const showStickyMessageMeta = showFinalMessageMeta && (stickyMessageMeta || Boolean(forkAction));
  const waitingEmpty = Boolean(streaming) && !hasBody;
  const clarificationRows = !streaming ? (item?.metadata?.clarificationRows as ClarificationHistoryRow[] | undefined) ?? parseClarificationAnswersSummary(text) : null;
  const worktreeMergeSummary = !streaming ? parseWorktreeMergeMessage(text) : null;

  if (clarificationRows) {
    return <ClarificationAnswersCard rows={clarificationRows} pending={item?.metadata?.liveType === "clarification.requested"} />;
  }
  if (worktreeMergeSummary) {
    return <WorkspaceChangesCard summary={worktreeMergeSummary} />;
  }

  return (
    <div
      className={[
        "run-log-narrative",
        compact ? "compact" : "",
        showStickyMessageMeta ? "run-log-narrative--sticky-final" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {showSubagentBadge ? (
        <span className="run-log-subagent-badge">
          {formatRoleModelLabel(subagent, modelByRole?.[subagent])}
          {usage ? (
            <span className="run-log-usage-badge">
              {formatUsageBadge({
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheCreationTokens: usage.cacheCreationTokens,
              })}
            </span>
          ) : null}
        </span>
      ) : waitingEmpty ? (
        <WaitingThinkingBlock active {...(requestSpan && { requestSpan })} />
      ) : null}
      {showBody ? (
        <div className="run-log-narrative-body">
          <StreamingMarkdownContent
            text={text}
            {...(streaming !== undefined && {
              streaming: Boolean(streaming) && pacing,
            })}
          />
        </div>
      ) : null}
      {showFinalMessageMeta ? (
        <RunLogMessageMeta
          align="start"
          copyText={text}
          {...(item && { readAloud: { entryId: item.id, sourceText: text } })}
          {...(forkAction && { forkAction })}
          sticky={showStickyMessageMeta}
          {...(createdAt && { createdAt })}
          {...(item
            ? {
                trailing: (
                  <TokenSpeedBadge item={item} streamedText={text} {...(requestSpan && { requestSpan })} />
                ),
              }
            : {})}
        />
      ) : null}
    </div>
  );
}
