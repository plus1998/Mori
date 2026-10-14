import type { ConversationDetailItem, ConversationSyncEffect } from "@eco/shared";
import {
  applyConversationV2Effects,
  installConversationV2Bootstrap,
} from "../../src/renderer/conversation-v2-renderer-state";
import type { ThreadRunProjectionRequestSpan, ThreadSummary } from "../../src/shared/ipc";
import {
  type FeedReplayEvent,
  type FeedReplayFixture,
  replayThreadStatus,
  validateReplayFixture,
} from "./types";

export interface ReplayPlayOptions {
  toSeq?: number;
  speed?: number;
  maxGapMs?: number;
  settleMs?: number;
}

export function isReplayBoundary(event: FeedReplayEvent): boolean {
  return (
    (event.effect.type === "message.create" && event.effect.message.role === "user") ||
    (event.effect.type === "run.upsert" && !["running", "queued"].includes(event.effect.run.status))
  );
}

/** Cursor-tagged paging cannot silently continue against a different playback snapshot. */
function pageItems<T>(
  items: T[],
  seq: number,
  options: { cursor?: string; limit?: number; maxBytes?: number } = {},
) {
  let offset = 0;
  if (options.cursor) {
    const match = /^replay:(\d+):(\d+)$/.exec(options.cursor);
    if (!match || Number(match[1]) !== seq)
      throw new Error("Replay paging cursor belongs to another checkpoint.");
    offset = Number(match[2]);
  }
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || offset > items.length)
    throw new Error("Invalid replay page size/cursor.");
  const selected: T[] = [];
  let bytes = 0;
  for (const item of items.slice(offset, offset + limit)) {
    const size = new TextEncoder().encode(JSON.stringify(item)).length;
    if (options.maxBytes !== undefined && bytes + size > options.maxBytes) {
      if (!selected.length)
        throw new Error("A replay item exceeds maxBytes; increase the requested page budget.");
      break;
    }
    selected.push(item);
    bytes += size;
  }
  const next = offset + selected.length;
  return {
    items: selected,
    hasMore: next < items.length,
    ...(next < items.length ? { nextCursor: `replay:${seq}:${next}` } : {}),
  };
}

export class FeedReplaySession {
  readonly listeners = new Set<(event: unknown) => void>();
  readonly fixture: FeedReplayFixture;
  state;
  thread: ThreadSummary;
  requestSpans: ThreadRunProjectionRequestSpan[] = [];
  index = 0;
  playing = false;
  private generation = 0;
  private configOverride?: ThreadSummary["runtimeConfig"];

  constructor(
    fixture: FeedReplayFixture,
    seq = 0,
    readonly onTime?: (at: number) => void,
  ) {
    validateReplayFixture(fixture);
    this.fixture = fixture;
    this.thread = {
      ...fixture.thread,
      title: `离线回放 · ${fixture.thread.title}`,
      status: "idle",
      prompt: "",
      message: "",
    };
    this.state = installConversationV2Bootstrap({
      protocolVersion: 2,
      storeEpoch: fixture.storeEpoch,
      conversationId: fixture.conversationId,
      snapshotSeq: 0,
      historyRevision: 0,
      messages: [],
      turns: [],
      runs: [],
      tools: [],
      agents: [],
      todos: [],
      details: [],
      hasOlder: false,
    });
    this.applyUntil(seq, false);
  }

  assertConversation(id: string): void {
    if (id !== this.fixture.conversationId)
      throw new Error(`Replay cannot access another conversation: ${id}`);
  }

  applyUntil(seq: number, notify = true): void {
    const last = this.fixture.events.at(-1)!.seq;
    if (!Number.isSafeInteger(seq) || seq < this.state.appliedSeq || seq > last) {
      throw new Error(`Invalid checkpoint ${seq}; reopen the iframe to rewind.`);
    }
    const batch: FeedReplayEvent[] = [];
    let next = this.index;
    while (next < this.fixture.events.length && this.fixture.events[next]!.seq <= seq)
      batch.push(this.fixture.events[next++]!);
    if (!batch.length) return;
    // Commit the reducer first. A rejected protocol event must not advance the playback cursor.
    const state = applyConversationV2Effects(this.state, batch);
    const runs = [...state.runs.values()].sort((a, b) => a.versionSeq - b.versionSeq);
    const active =
      runs.findLast((run) => run.status === "running") ?? runs.findLast((run) => run.status === "queued");
    const latest = active ?? runs.at(-1);
    const status = replayThreadStatus(latest?.status);
    this.state = state;
    this.index = next;
    for (const event of batch) {
      if (event.requestSpans) this.requestSpans = event.requestSpans;
    }
    this.onTime?.(batch.at(-1)!.at);
    const firstUser = [...state.messages.values()]
      .filter((message) => message.role === "user" && !message.isDeleted)
      .sort((a, b) => a.createdSeq - b.createdSeq)[0];
    this.thread = {
      ...this.thread,
      status,
      prompt: firstUser?.body ?? "",
      updatedAt: new Date(batch.at(-1)!.at).toISOString(),
      ...(this.configOverride ? { runtimeConfig: this.configOverride } : {}),
    };
    if (!notify) return;
    for (const event of batch) {
      this.emit({
        conversationId: this.fixture.conversationId,
        storeEpoch: this.fixture.storeEpoch,
        effect: {
          seq: event.seq,
          effectVersion: event.effectVersion,
          effectHash: event.effectHash,
          effect: event.effect,
        },
      });
      if (event.live) this.emit(event.live);
    }
    if (batch.some((event) => event.effect.type === "run.upsert")) {
      this.emit({
        type:
          status === "running" || status === "queued"
            ? "thread.running"
            : status === "failed"
              ? "thread.failed"
              : status === "idle"
                ? "thread.idle"
                : "thread.completed",
        threadId: this.fixture.conversationId,
        message: "",
      });
    }
  }

  emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }

  bootstrap() {
    return {
      protocolVersion: 2 as const,
      storeEpoch: this.fixture.storeEpoch,
      conversationId: this.fixture.conversationId,
      snapshotSeq: this.state.appliedSeq,
      historyRevision: this.state.historyRevision,
      messages: [...this.state.messages.values()],
      turns: [],
      runs: [...this.state.runs.values()],
      tools: [...this.state.tools.values()],
      agents: [...this.state.agents.values()],
      todos: [...this.state.todos.values()],
      details: [...this.state.details.values()],
      hasOlder: false,
    };
  }

  head() {
    return {
      protocolVersion: 2 as const,
      conversationId: this.fixture.conversationId,
      storeEpoch: this.fixture.storeEpoch,
      lastSeq: this.state.appliedSeq,
      historyRevision: this.state.historyRevision,
    };
  }

  sync(query: {
    conversationId: string;
    storeEpoch: string;
    afterSeq: number;
    throughSeq?: number;
    maxEvents?: number;
    maxBytes?: number;
  }) {
    this.assertConversation(query.conversationId);
    if (query.storeEpoch !== this.fixture.storeEpoch) throw new Error("Replay store epoch mismatch.");
    if (!Number.isSafeInteger(query.afterSeq) || query.afterSeq < 0 || query.afterSeq > this.state.appliedSeq)
      throw new Error("Replay sync cursor is ahead of the checkpoint.");
    const maxEvents = query.maxEvents ?? 512;
    const maxBytes = query.maxBytes ?? 2 * 1024 * 1024;
    if (
      !Number.isSafeInteger(maxEvents) ||
      maxEvents < 1 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      (query.throughSeq !== undefined &&
        (!Number.isSafeInteger(query.throughSeq) || query.throughSeq < query.afterSeq))
    ) {
      throw new Error("Invalid replay sync bounds/budget.");
    }
    const requestedThrough = Math.min(
      query.throughSeq ?? this.state.appliedSeq,
      query.afterSeq + maxEvents,
      this.state.appliedSeq,
    );
    const effects: ConversationSyncEffect[] = [];
    let bytes = 0;
    for (const { seq, effectVersion, effectHash, effect } of this.fixture.events.slice(
      query.afterSeq,
      requestedThrough,
    )) {
      const value = { seq, effectVersion, effectHash, effect };
      const size = new TextEncoder().encode(JSON.stringify(value)).length;
      if (bytes + size > maxBytes) {
        if (!effects.length) throw new Error("A replay effect exceeds maxBytes; increase the sync budget.");
        break;
      }
      effects.push(value);
      bytes += size;
    }
    const through = effects.at(-1)?.seq ?? query.afterSeq;
    return {
      ...this.head(),
      fromSeq: query.afterSeq + 1,
      throughSeq: through,
      headSeq: this.state.appliedSeq,
      hasMore: through < this.state.appliedSeq,
      effects,
    };
  }

  toolsPage(id: string, runId: string, options?: { cursor?: string; limit?: number; maxBytes?: number }) {
    this.assertConversation(id);
    const tools = [...this.state.tools.values()]
      .filter((tool) => tool.runId === runId)
      .sort((a, b) => a.createdSeq - b.createdSeq || a.toolCallId.localeCompare(b.toolCallId));
    const page = pageItems(tools, this.state.appliedSeq, options);
    return {
      ...this.head(),
      runId,
      readSeq: this.state.appliedSeq,
      tools: page.items,
      totalCount: tools.length,
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  detailsPage(
    id: string,
    runId: string,
    options?: {
      cursor?: string;
      limit?: number;
      maxBytes?: number;
      toolCallId?: string;
      agentInstanceId?: string;
    },
  ) {
    this.assertConversation(id);
    const byId = new Map(this.state.details);
    const matches = (item: ConversationDetailItem) =>
      item.runId === runId &&
      (!options?.toolCallId || item.toolCallId === options.toolCallId) &&
      (!options?.agentInstanceId || item.agentInstanceId === options.agentInstanceId);
    for (const item of this.fixture.detailItems.filter(matches)) {
      if (item.createdSeq > this.state.appliedSeq) continue;
      if (item.versionSeq > this.state.appliedSeq) {
        if (!byId.has(item.itemId))
          throw new Error(
            `Detail ${item.itemId} was saved after this checkpoint; its older body is not recorded.`,
          );
        continue;
      }
      const previous = byId.get(item.itemId);
      if (!previous || previous.versionSeq < item.versionSeq) byId.set(item.itemId, item);
    }
    const items = [...byId.values()]
      .filter(matches)
      .sort((a, b) => a.createdSeq - b.createdSeq || a.itemId.localeCompare(b.itemId));
    const page = pageItems(items, this.state.appliedSeq, options);
    return { ...this.head(), readSeq: this.state.appliedSeq, ...page };
  }

  nextUser() {
    return this.fixture.events
      .slice(this.index)
      .find((event) => event.effect.type === "message.create" && event.effect.message.role === "user");
  }

  send(request: { conversationId: string; text: string; clientCommandId: string }) {
    this.assertConversation(request.conversationId);
    if (this.playing) throw new Error("Pause playback before simulating Send.");
    const next = this.nextUser();
    if (!next || next.effect.type !== "message.create") throw new Error("No recorded user message remains.");
    if (request.text !== next.effect.message.body)
      throw new Error("Send text must exactly match the next recorded user message.");
    let through = next.seq;
    for (const event of this.fixture.events.slice(next.seq)) {
      if (isReplayBoundary(event)) break;
      if (event.effect.type === "run.upsert" && ["running", "queued"].includes(event.effect.run.status)) {
        through = event.seq;
        break;
      }
    }
    this.applyUntil(through);
    return {
      protocolVersion: 2,
      conversationId: this.fixture.conversationId,
      clientCommandId: request.clientCommandId,
      messageId: next.effect.message.messageId,
      turnId: next.effect.message.turnId,
    };
  }

  cancel(id: string) {
    this.assertConversation(id);
    if (this.playing) throw new Error("Pause playback before simulating Stop.");
    const active = [...this.state.runs.values()].findLast((run) =>
      ["running", "queued"].includes(run.status),
    );
    const next = this.fixture.events
      .slice(this.index)
      .find(
        (event) =>
          event.effect.type === "run.upsert" &&
          event.effect.run.status === "cancelled" &&
          event.effect.run.runId === active?.runId,
      );
    if (!next) throw new Error("The active run has no recorded cancellation ahead of this checkpoint.");
    this.applyUntil(next.seq);
    return { thread: { ...this.thread } };
  }

  updateConfig(request: { threadId: string; runtimeConfig: NonNullable<ThreadSummary["runtimeConfig"]> }) {
    this.assertConversation(request.threadId);
    this.configOverride = request.runtimeConfig;
    this.thread = { ...this.thread, runtimeConfig: request.runtimeConfig };
    return { thread: { ...this.thread } };
  }

  pause(): void {
    this.playing = false;
    this.generation++;
  }

  validatePlayOptions(options: ReplayPlayOptions = {}) {
    if (this.playing) throw new Error("Replay is already playing.");
    const to = options.toSeq ?? this.fixture.events.at(-1)!.seq;
    const speed = options.speed ?? 1;
    const maxGapMs = options.maxGapMs ?? 1000;
    const settleMs = options.settleMs ?? 350;
    if (
      !Number.isSafeInteger(to) ||
      to < this.state.appliedSeq ||
      to > this.fixture.events.length ||
      !Number.isFinite(speed) ||
      speed <= 0 ||
      !Number.isFinite(maxGapMs) ||
      maxGapMs < 0 ||
      !Number.isFinite(settleMs) ||
      settleMs < 0
    ) {
      throw new Error("Invalid replay sequence/speed/timing options.");
    }
    return { to, speed, maxGapMs, settleMs };
  }

  async play(
    options: ReplayPlayOptions = {},
    onBoundary?: (event: FeedReplayEvent, phase: "before" | "after") => void,
  ) {
    const { to, speed, maxGapMs, settleMs } = this.validatePlayOptions(options);
    const generation = ++this.generation;
    this.playing = true;
    try {
      while (this.index < to && this.playing && this.generation === generation) {
        const first = this.fixture.events[this.index]!;
        const previousAt = this.fixture.events[this.index - 1]?.at ?? first.at;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(maxGapMs, Math.max(16, (first.at - previousAt) / speed))),
        );
        if (!this.playing || this.generation !== generation) break;
        let end = this.index;
        while (
          end + 1 < to &&
          end - this.index < 511 &&
          !isReplayBoundary(this.fixture.events[end]!) &&
          this.fixture.events[end + 1]!.at <= first.at + 16 * speed
        )
          end++;
        const last = this.fixture.events[end]!;
        if (isReplayBoundary(last)) onBoundary?.(last, "before");
        this.applyUntil(last.seq);
        if (isReplayBoundary(last)) {
          await new Promise((resolve) => setTimeout(resolve, settleMs));
          if (this.generation === generation) onBoundary?.(last, "after");
        }
      }
    } finally {
      if (this.generation === generation) this.playing = false;
    }
    return { seq: this.state.appliedSeq, playing: this.playing };
  }
}
