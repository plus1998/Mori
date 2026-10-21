import { buildThreadRunProjectionViewModel } from "../../src/renderer/conversation-v2-projection-view";
import { buildThreadRunTurnFeedSections } from "../../src/renderer/conversation-v2-turn-feed";
import type { ThreadRunProjectionSnapshot } from "../../src/shared/ipc";

/**
 * The Feed's rendered shape, shared by every differential test.
 *
 * One definition, because the harness itself is a place bugs hide: the first version of
 * this file read a turn section's rows from `entries` when the renderer keeps them in
 * `processEntries`, so every row comparison was an empty-array comparison that always
 * passed. Two copies of the shape function would have let that happen twice.
 *
 * A row's identity is what it says, which role wrote it and when it happened. Text alone
 * missed the provider's own role disappearing (the Feed picks a turn's final output by
 * `role === "main"`), and it missed a row landing at the wrong time — which is what
 * puts a message between the two tools of its own turn.
 */
export interface RowShape {
  text: string;
  role?: string;
  at?: string;
  /**
   * The tool call this row reports, when it reports one. Two calls to the same tool are
   * otherwise indistinguishable (`Tool: Read` twice), and "did this row move or did it
   * vanish" cannot be answered without the call's identity.
   */
  callId?: string;
  /**
   * The row's own event type for a tool row (`tool.started` / `tool.completed` /
   * `tool.failed`): the two renderers word an outcome differently, so the outcome is
   * compared as the state it is rather than as a word in a sentence.
   */
  status?: string;
  /**
   * The turn's own output row, which the Feed draws after its process rows whatever their
   * times are — the answer belongs at the bottom of the turn. Tagged so the row list keeps
   * the distinction and the two chains can be compared on *which* row they chose for it.
   */
  final?: true;
}

export type FeedShape = ReturnType<typeof feedShape>;

export function feedShape(projection: ThreadRunProjectionSnapshot) {
  const viewModel = buildThreadRunProjectionViewModel(projection);
  const sections = buildThreadRunTurnFeedSections(viewModel.mainFeedEntries, projection);
  return {
    sections: sections.map((section) =>
      section.kind === "turn"
        ? { kind: section.kind, entries: collectEntryShapes(section) }
        : { kind: section.kind, rows: collectEntryShapes(section) },
    ),
    // The cards, as the Feed renders them. `projection.agents` is not the same thing: it
    // also carries the attempt's main agent, which the Feed filters out, so comparing it
    // reports differences no user can see (and hides the ones they can).
    cards: viewModel.subagentCards.map((card) => ({
      key: card.key,
      // The agent's identity, not the card's DOM key: the key is each renderer's own
      // business, the identity is the fact both ends are given.
      agentId: card.agent.agentId,
      role: card.agent.role,
      kind: card.agent.kind,
      status: card.agent.status,
      missionText: card.missionText,
      // The call that spawned the agent, when the log recorded one: the Feed draws the spawn
      // row as the card rather than as a row of its own, so this is where that row went.
      parentToolUseId: card.agent.parentToolUseId ?? null,
      taskName: card.agent.taskName ?? null,
      running: card.running,
      // Lifecycle rows carry an empty body in the legacy chain; they render nothing, so
      // the card's content is what has to match. A tool row inside a card is reduced the
      // same way a main-feed tool row is: the two chains word the same call differently on
      // purpose (the provider's description vs the structured input), and comparing the
      // wording would drown the differences that matter, such as a row under the wrong
      // agent or at the wrong time.
      timeline: card.agent.timeline
        .map((item) => rowShape(item))
        .filter((row): row is RowShape => row !== undefined),
    })),
    attempts: projection.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      status: attempt.status,
    })),
  };
}

/**
 * Flattens a section into the rows it renders, in order — the order the Feed draws them:
 * a turn's process rows, then its final entry.
 */
export function collectEntryShapes(section: unknown): RowShape[] {
  if (!section || typeof section !== "object") return [];
  const record = section as {
    kind?: unknown;
    entry?: unknown;
    processEntries?: readonly unknown[];
    finalEntry?: unknown;
  };
  if (record.kind === "turn") {
    const process = (record.processEntries ?? []).flatMap((entry) => entryShapes(entry));
    if (record.finalEntry === undefined) return process;
    // Tagged: it is drawn last by design, so it is compared by *what* it is, not by where
    // the order walk would place it (see `RowShape.final`).
    return [...process, ...entryShapes(record.finalEntry).map((row) => ({ ...row, final: true as const }))];
  }
  return entryShapes(record.entry);
}

interface TimelineItemShape {
  text?: unknown;
  eventType?: unknown;
  role?: unknown;
  at?: unknown;
  metadata?: { conversationV2ToolCallId?: unknown; tool?: { toolUseId?: unknown } };
}

/** One rendered item, reduced to the identity a reader can see. */
export function rowShape(item: TimelineItemShape): RowShape | undefined {
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (!text) return undefined;
  const isTool = typeof item.eventType === "string" && item.eventType.startsWith("tool.");
  const v2ToolCallId = item.metadata?.conversationV2ToolCallId;
  const legacyToolUseId = item.metadata?.tool?.toolUseId;
  const callId =
    typeof v2ToolCallId === "string" && v2ToolCallId.trim()
      ? v2ToolCallId.trim()
      : typeof legacyToolUseId === "string" && legacyToolUseId.trim()
        ? legacyToolUseId.trim()
        : undefined;
  return {
    text: isTool ? toolRowIdentity(text) : normalizeRowText(text),
    ...(typeof item.role === "string" && item.role.trim() ? { role: item.role } : {}),
    ...(typeof item.at === "string" && item.at.trim() ? { at: item.at } : {}),
    ...(callId ? { callId } : {}),
    ...(isTool ? { status: item.eventType } : {}),
  };
}

function entryShapes(entry: unknown): RowShape[] {
  if (!entry || typeof entry !== "object") return [];
  const record = entry as {
    text?: unknown;
    item?: TimelineItemShape;
    children?: readonly unknown[];
    entries?: readonly unknown[];
  };
  if (typeof record.text === "string" && record.text.trim()) {
    return [{ text: normalizeRowText(record.text) }];
  }
  // Items carry their text on `item`; a tool row is reduced to the call it names.
  if (typeof record.item === "object" && record.item !== null) {
    const shape = rowShape(record.item as TimelineItemShape);
    if (shape) return [shape];
  }
  const nested = record.children ?? record.entries ?? [];
  return nested.flatMap((child) => entryShapes(child));
}

/**
 * A tool row's own prose, reduced to the call it names and how it ended.
 *
 * The two chains word a tool row differently on purpose: the legacy row keeps the text the
 * provider wrote (`Tool: Bash · <the model's description>`), while V2 derives the label from
 * the structured input (`Tool: Bash · <the command>`) and from the row's state (`tool.failed`
 * instead of a `Tool failed:` sentence). Both name the same call and both end the same way —
 * that part is compared — while the wording is tracked separately in
 * `docs/plans/feed-regression-test-plan.md`.
 */
export function toolRowIdentity(text: string): string {
  const tool = text.match(/^(Tool|工具(?:调用)?)\s*[:：]\s*([\w.-]+)/i);
  if (!tool) return text;
  const outcome = /\b(failed|failure)\b/i.test(text)
    ? " failed"
    : /\b(denied|rejected)\b/i.test(text)
      ? " denied"
      : "";
  return `${tool[1]}: ${tool[2]}${outcome}`;
}

function normalizeRowText(text: string): string {
  return text.trim().startsWith("Tool:") ? toolRowIdentity(text) : text;
}

/** Rows a section renders, whatever kind of section it is. */
export function sectionRows(section: FeedShape["sections"][number]): RowShape[] {
  return "entries" in section ? section.entries : section.rows;
}

/**
 * The prompt row a chain draws more than once: same text, same role, same time.
 *
 * The legacy merged Feed drew the prompt as the section that opens the turn *and* again as
 * a process row inside it. V2 draws it once. A baseline with a known defect has to be
 * pinned as the reason for such a difference, or the next reader cannot tell it from a
 * regression V2 introduced.
 */
export function duplicatedPromptRows(shape: FeedShape): RowShape[] {
  const seen = new Set<string>();
  const duplicates: RowShape[] = [];
  for (const section of shape.sections) {
    for (const row of sectionRows(section)) {
      if (row.role !== "user") continue;
      const key = `${row.text}\u0000${row.at ?? ""}`;
      if (seen.has(key)) duplicates.push(row);
      seen.add(key);
    }
  }
  return duplicates;
}

/**
 * The same shape with the times inside agent cards removed.
 *
 * Card order is not compared against the old chain: it positions rows the read models
 * supply by "nearest surviving sibling", which is an approximation by construction — the
 * approximation V2 replaces. Card *membership* is compared (a row under the wrong agent is
 * a real defect) and card *order* is checked against the clock by `outOfOrderRows`.
 */
export function withoutCardTimes(shape: FeedShape): FeedShape {
  return {
    ...shape,
    cards: shape.cards.map((card) => ({
      ...card,
      timeline: card.timeline.map((row) => ({ ...row, at: undefined })),
    })),
  };
}

/** Rows that are out of order against their own recorded times. */
export function outOfOrderRows(rows: readonly RowShape[], label: string): string[] {
  const out: string[] = [];
  let previous: string | undefined;
  for (const row of rows) {
    const at = row.at;
    if (!at) continue;
    if (previous !== undefined && at < previous) {
      out.push(`${label}: ${at} after ${previous} (${rowIdentity(row)})`);
    }
    previous = at;
  }
  return out;
}

/** A row's identity across the two chains: the call it names, else its role and text. */
export function rowIdentity(row: RowShape): string {
  return row.callId ?? `${row.role ?? "-"}|${row.text}`;
}

/**
 * The same shape with provider notices left as what they say.
 *
 * A notice (the recorder's `api.error` row) is a row the old merged chain duplicates and
 * cannot place: its legacy row is drawn at the turn's start — the legacy projection
 * positions an anchorless row there — *and* the V2 notice message is merged in beside it,
 * because the merge does not recognise the legacy row as one V2 already holds. V2 keeps one
 * row per notice at the row's own recorded time; that is asserted in
 * `conversation-v2-projection-parity.test.ts`, next to the comparison that has to look past
 * the old chain's copy.
 */
export function withoutNoticeTimes(shape: FeedShape): FeedShape {
  return {
    ...shape,
    sections: shape.sections.map((section) => {
      const rows = sectionRows(section).map((row) => ({ ...row, at: undefined }));
      return "entries" in section ? { ...section, entries: rows } : { ...section, rows };
    }),
  };
}

/**
 * The same shape with the old chain's repeated notice rows removed (one row per text).
 *
 * Only for the old side of a comparison: V2 drawing one notice twice is a defect, and this
 * would hide it.
 */
export function withoutDuplicatedNotices(shape: FeedShape, noticeTexts: ReadonlySet<string>): FeedShape {
  const seen = new Set<string>();
  return {
    ...shape,
    sections: shape.sections.map((section) => {
      const rows = sectionRows(section).filter((row) => {
        if (!noticeTexts.has(row.text)) return true;
        if (seen.has(row.text)) return false;
        seen.add(row.text);
        return true;
      });
      return "entries" in section ? { ...section, entries: rows } : { ...section, rows };
    }),
  };
}

/** The same shape with every repeated prompt row removed. */
export function withoutDuplicatedPromptRows(shape: FeedShape): FeedShape {
  const seen = new Set<string>();
  return {
    ...shape,
    sections: shape.sections.map((section) => {
      const rows = sectionRows(section).filter((row) => {
        if (row.role !== "user") return true;
        const key = `${row.text}\u0000${row.at ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return "entries" in section ? { ...section, entries: rows } : { ...section, rows };
    }),
  };
}
