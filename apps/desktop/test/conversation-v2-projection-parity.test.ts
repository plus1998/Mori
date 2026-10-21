import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { appendLegacyThreadRunEventToConversationV2 } from "../src/main/conversation-v2-legacy-adapter";
import { conversationV2RunEventForAttempt } from "../src/main/conversation-v2-run-events";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { buildThreadRunProjection } from "../src/main/conversation-v2-runtime-projection";
import type { AgentInstanceRecord, RunAttemptRecord } from "../src/main/usage-ledger";
import {
  buildConversationV2OnlyProjection,
  mergeConversationV2IntoProjection,
} from "../src/renderer/ActivityLogView";
import { installConversationV2Bootstrap } from "../src/renderer/conversation-v2-renderer-state";
import { isRetryableRequestFailureItem } from "../src/renderer/request-failure-retry";
import { buildThreadRunProjectionViewModel } from "../src/renderer/conversation-v2-projection-view";
import { buildThreadRunTurnFeedSections } from "../src/renderer/conversation-v2-turn-feed";
import type { ThreadRunProjectionSnapshot } from "../src/shared/ipc";
import type { ThreadRunEvent } from "../src/shared/thread-run-events";
import {
  duplicatedPromptRows,
  feedShape,
  outOfOrderRows,
  withoutCardTimes,
  withoutDuplicatedNotices,
  withoutDuplicatedPromptRows,
  withoutNoticeTimes,
} from "./support/feed-shape";

/**
 * The legacy projection's behaviour spec, replayed through V2 and compared.
 *
 * `conversation-v2-runtime-projection.test.ts` is where the Feed's behaviour is written down: it
 * drives the legacy builder with run events, attempts and agents and asserts what a
 * turn looks like. V2 replaced that builder, so the same scenarios have to hold on the
 * V2 chain (legacy row → event → read model → Feed projection). Asserting the two
 * against *each other* is what makes this a regression net rather than a second set of
 * hand-written expectations: a field V2 drops fails here even though nothing in the V2
 * code looks wrong, which is how the subagent-overflow and run-status bugs reached the
 * app while every per-layer test stayed green.
 *
 * These go through the production pipeline: the legacy adapter, the V2 store, the
 * renderer's bootstrap install and the projection the Feed draws from.
 */

const CONVERSATION_ID = "thr_v2_parity";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const NOW_MS = Date.parse("2026-01-01T00:00:05.000Z");

interface Scenario {
  attempts: RunAttemptRecord[];
  agents: AgentInstanceRecord[];
  events: ThreadRunEvent[];
}

function event(input: Partial<ThreadRunEvent> & { id: string; sequence: number }): ThreadRunEvent {
  return {
    id: input.id,
    threadId: CONVERSATION_ID,
    sequence: input.sequence,
    eventType: input.eventType ?? "message.delta",
    scope: input.scope ?? "main",
    streamState: input.streamState ?? "none",
    message: input.message ?? "",
    observedAt: input.observedAt ?? "2026-01-01T00:00:02.000Z",
    ...(input.role && { role: input.role }),
    ...(input.agentId && { agentId: input.agentId }),
    ...(input.parentAgentId && { parentAgentId: input.parentAgentId }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.requestId && { requestId: input.requestId }),
    ...(input.streamKey && { streamKey: input.streamKey }),
    ...(input.metadata && { metadata: input.metadata }),
  };
}

function agentInstance(input: Partial<AgentInstanceRecord> & { agentId: string }): AgentInstanceRecord {
  return {
    threadId: CONVERSATION_ID,
    agentId: input.agentId,
    role: input.role ?? "coder",
    kind: input.kind ?? "subagent",
    status: input.status ?? "active",
    runAttemptId: input.runAttemptId ?? "attempt_1",
    parentAgentId: input.parentAgentId ?? "main:attempt_1",
    startedAt: input.startedAt ?? "2026-01-01T00:00:01.000Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:01.000Z",
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
    ...(input.missionKey && { missionKey: input.missionKey }),
    ...(input.todoId && { todoId: input.todoId }),
    ...(input.endedAt && { endedAt: input.endedAt }),
  };
}

/** Builds the projection the old chain produces for the scenario. */
function legacyProjection(scenario: Scenario): ThreadRunProjectionSnapshot {
  return buildThreadRunProjection({
    threadId: CONVERSATION_ID,
    status: "running",
    attempts: scenario.attempts,
    agents: scenario.agents,
    events: scenario.events,
    nowMs: NOW_MS,
  });
}

/** The V2 read models a renderer holds for the scenario. */
function v2Session(scenario: Scenario): ConversationV2RendererState {
  const store = new ConversationV2Store(new DatabaseSync(":memory:"));
  store.initialize();
  store.ensureConversation(CONVERSATION_ID);
  for (const attempt of scenario.attempts) {
    store.append(
      conversationV2RunEventForAttempt({
        conversationId: CONVERSATION_ID,
        attemptId: attempt.attemptId,
        status: attempt.status,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        sourcePrefix: "test:run",
      }),
    );
  }
  // The scenario's `agents` mirror the legacy instance table, and a V2 store starts from
  // a registry seeded with exactly that table — `backfillAgentRegistry` does it on an
  // upgraded install. Seeding here keeps the two sides holding the same facts: without
  // it the V2 chain is asked to know an agent that no `agent.*` row ever recorded.
  for (const agent of scenario.agents) {
    store.seedAgentFromLegacyInstance({
      agentId: agent.agentId,
      conversationId: CONVERSATION_ID,
      role: agent.role,
      kind: agent.kind,
      status: agent.status,
      runId: agent.runAttemptId,
      parentAgentInstanceId: agent.parentAgentId,
      parentToolCallId: agent.parentToolUseId,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      mission: agent.missionKey,
      todoId: agent.todoId,
    });
  }
  for (const event of scenario.events) {
    appendLegacyThreadRunEventToConversationV2(store, event);
  }
  return installConversationV2Bootstrap(store.bootstrap(CONVERSATION_ID));
}

/** What the Feed renders today: V2 read models, plus the legacy extras. */
function v2Projection(scenario: Scenario): ThreadRunProjectionSnapshot {
  return buildConversationV2OnlyProjection(v2Session(scenario), {
    createdAt: CREATED_AT,
    status: "running",
  });
}

/**
 * What the Feed rendered before the read side moved to V2: the legacy projection with
 * V2 rows merged back into it.
 *
 * This is the baseline the comparison has to use, not the legacy projection alone. The
 * legacy Feed draws a *trimmed* turn — its skeleton keeps one narrative row and lets V2
 * fill the rest back in — so comparing full V2 content against the trimmed legacy view
 * reports a difference on every turn that ever had two narrative rows, while hiding the
 * one that matters (where the filled-back row lands).
 */
function legacyMergedProjection(scenario: Scenario): ThreadRunProjectionSnapshot {
  return mergeConversationV2IntoProjection(legacyProjection(scenario), v2Session(scenario));
}

/**
 * Compares the two chains on everything the old chain is authoritative about.
 *
 * Two normalizations, each for a defect or a limitation of the *old* chain, and each
 * asserted in its own right elsewhere in this suite (see
 * `docs/plans/feed-regression-test-plan.md` §4.16):
 *
 * - repeated prompt rows: the old merge drew the prompt twice per turn;
 * - times inside agent cards: the old chain positions read-model rows by "nearest
 *   surviving sibling", so its card order is an approximation. Here the cards are
 *   compared by membership, and V2's own card rows are checked against the clock.
 */
function expectParity(scenario: Scenario): void {
  const v2 = feedShape(v2Projection(scenario));
  const legacy = feedShape(legacyMergedProjection(scenario));
  if (process.env.PARITY_DEBUG) {
    console.log("V2=====", JSON.stringify(v2));
    console.log("LEGACY=", JSON.stringify(legacy));
  }
  for (const card of v2.cards) {
    expect(outOfOrderRows(card.timeline, `card ${card.key}`)).toEqual([]);
  }
  // A provider notice is a third class the old chain cannot answer for: it draws its own
  // `api.error` row at the turn's start and the merged V2 notice beside it. The rows are
  // compared for what they say; V2's own row times are asserted in the notice test below.
  const noticeTexts = new Set(
    scenario.events
      .filter((event) => event.eventType === "api.error")
      .map((event) => event.message.trim())
      .filter((message) => message.length > 0),
  );
  expect(withoutCardTimes(withoutNoticeTimes(v2, noticeTexts))).toEqual(
    withoutCardTimes(
      withoutDuplicatedNotices(
        withoutNoticeTimes(withoutDuplicatedPromptRows(legacy), noticeTexts),
        noticeTexts,
      ),
    ),
  );
}

const runningAttempt: RunAttemptRecord = {
  threadId: CONVERSATION_ID,
  attemptId: "attempt_1",
  phase: "execution",
  retryIndex: 0,
  status: "running",
  startedAt: CREATED_AT,
};

test("V2 matches the legacy Feed for a narrative/tool/final turn", () => {
  expectParity({
    attempts: [runningAttempt],
    agents: [],
    events: [
      event({
        id: "narrative",
        sequence: 1,
        role: "main",
        message: "looking at the service",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:01.000Z",
      }),
      event({
        id: "tool",
        sequence: 2,
        eventType: "tool.completed",
        role: "main",
        message: "Tool: Read · src/main.ts",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:03.000Z",
        metadata: {
          liveType: "tool.completed",
          tool: {
            name: "Read",
            detail: "src/main.ts",
            toolUseId: "toolu_read_1",
          },
        },
      }),
      event({
        id: "final",
        sequence: 3,
        eventType: "message.final",
        streamState: "finalized",
        role: "main",
        message: "done",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:04.000Z",
      }),
    ],
  });
});

test("V2 shows a provider failure notice as the row the reader had", () => {
  // The turn failed, and the reason is content: the legacy Feed draws the recorder's
  // `api.error` row with the provider's role and the notice text. V2 had no row for the
  // event at all, so a migrated conversation reported a failed turn with no reason in it.
  const scenario: Scenario = {
    attempts: [runningAttempt],
    agents: [],
    events: [
      event({
        id: "narrative",
        sequence: 1,
        role: "main",
        message: "looking at the service",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:01.000Z",
      }),
      event({
        id: "notice",
        sequence: 2,
        eventType: "api.error",
        role: "main",
        message: "【连接失败】HTTP 503：Upstream returned HTTP 503",
        runAttemptId: "attempt_1",
        requestId: "req_notice_1",
        observedAt: "2026-01-01T00:00:03.000Z",
        metadata: {
          liveType: "thread.api_error",
          apiError: { message: "Upstream returned HTTP 503", statusCode: 503 },
        },
      }),
      event({
        id: "notice_again",
        sequence: 3,
        eventType: "api.error",
        role: "main",
        message: "【连接失败】Upstream service temporarily unavailable",
        runAttemptId: "attempt_1",
        requestId: "req_notice_1",
        observedAt: "2026-01-01T00:00:04.000Z",
        metadata: {
          liveType: "thread.api_error",
          apiError: { message: "Upstream service temporarily unavailable" },
        },
      }),
    ],
  };

  expectParity(scenario);

  // The row is a notice, not agent speech: the Feed reads that from the event type and it is
  // what offers the reader a retry for the failed request.
  const notices = v2Projection(scenario).timeline.filter((item) => item.text.includes("【连接失败】"));
  expect(notices.map((item) => ({ eventType: item.eventType, role: item.role }))).toEqual([
    { eventType: "api.error", role: "main" },
    { eventType: "api.error", role: "main" },
  ]);
  expect(notices.map(isRetryableRequestFailureItem)).toEqual([true, true]);
  // One row per notice, at the time the log recorded it — not carried to the turn's start.
  expect(notices.map((item) => item.at)).toEqual(["2026-01-01T00:00:03.000Z", "2026-01-01T00:00:04.000Z"]);
});

test("V2 matches the legacy Feed for concurrent same-role subagents", () => {
  expectParity({
    attempts: [runningAttempt],
    agents: [
      agentInstance({
        agentId: "coder_a",
        parentToolUseId: "toolu_a",
        missionKey: "api",
      }),
      agentInstance({
        agentId: "coder_b",
        parentToolUseId: "toolu_b",
        missionKey: "ui",
      }),
    ],
    events: [
      event({
        id: "started_a",
        sequence: 1,
        eventType: "agent.started",
        scope: "agent",
        role: "coder",
        agentId: "coder_a",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:01.000Z",
        metadata: { lifecycle: "started", missionKey: "api" },
      }),
      event({
        id: "started_b",
        sequence: 2,
        eventType: "agent.started",
        scope: "agent",
        role: "coder",
        agentId: "coder_b",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:01.000Z",
        metadata: { lifecycle: "started", missionKey: "ui" },
      }),
      event({
        id: "read_a",
        sequence: 3,
        scope: "agent",
        role: "coder",
        agentId: "coder_a",
        message: "Read api.ts",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:02.000Z",
      }),
      event({
        id: "read_b",
        sequence: 4,
        scope: "agent",
        role: "coder",
        agentId: "coder_b",
        message: "Edit ui.ts",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:03.000Z",
      }),
    ],
  });
});

// The row carries no `agent_id`: its owner is only expressed structurally (agent scope
// plus the row's role), and the legacy chain resolves it — by the parent tool link the
// agent was spawned from, then by the single subagent of that role inside the attempt's
// window. V2 has to reach the same answer from the log, or the tool vanishes from the
// card and leaks into the main Feed.
test("V2 attributes an agent-scoped tool row by its role, like the legacy chain", () => {
  expectParity({
    attempts: [runningAttempt],
    agents: [agentInstance({ agentId: "explore_a", role: "explore" })],
    events: [
      event({
        id: "tool_read",
        sequence: 1,
        eventType: "tool.started",
        scope: "agent",
        role: "explore",
        message: "Tool: Read · src/main.ts",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:03.000Z",
        metadata: {
          liveType: "tool.started",
          tool: {
            name: "Read",
            detail: "src/main.ts",
            toolUseId: "toolu_read_1",
          },
        },
      }),
    ],
  });
});

test("V2 matches the legacy Feed when an agent is abandoned", () => {
  expectParity({
    attempts: [runningAttempt],
    agents: [agentInstance({ agentId: "explore_fail", role: "explore" })],
    events: [
      event({
        id: "started",
        sequence: 1,
        eventType: "agent.started",
        scope: "agent",
        role: "explore",
        agentId: "explore_fail",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:01.000Z",
      }),
      event({
        id: "abandoned",
        sequence: 2,
        eventType: "agent.abandoned",
        scope: "agent",
        role: "explore",
        agentId: "explore_fail",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:03.000Z",
      }),
    ],
  });
});

test("keeps one turn in one section and a subagent's tools off the main feed", () => {
  // Two symptoms from a real conversation: the same turn showed its「处理中」header
  // twice, and a subagent's tool row was drawn in the middle of the answer. Both come
  // from the main Feed seeing rows it cannot place: without a time, a turn's rows
  // collapse onto one instant and split into several sections; without an owner, an
  // agent-scoped row is treated as the main agent's.
  const scenario: Scenario = {
    attempts: [runningAttempt],
    agents: [agentInstance({ agentId: "coder_a" })],
    events: [
      event({
        id: "prompt",
        sequence: 1,
        eventType: "thread.status",
        role: "user",
        message: "查一下天气",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:00.500Z",
      }),
      event({
        id: "started",
        sequence: 2,
        eventType: "agent.started",
        scope: "agent",
        role: "coder",
        agentId: "coder_a",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:01.000Z",
      }),
      event({
        id: "narrative",
        sequence: 3,
        role: "main",
        message: "两个查询员已出发",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:02.000Z",
      }),
      event({
        id: "tool",
        sequence: 4,
        eventType: "tool.completed",
        scope: "agent",
        role: "coder",
        agentId: "coder_a",
        message: "Tool: Bash · curl wttr.in",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:03.000Z",
        metadata: {
          liveType: "tool.completed",
          tool: { name: "Bash", toolUseId: "toolu_bash", detail: "curl wttr.in" },
        },
      }),
    ],
  };
  const shape = feedShape(v2Projection(scenario));
  const legacy = feedShape(legacyMergedProjection(scenario));

  // The prompt is the one row the two chains count differently: the legacy merge drew it
  // as the section that opens the turn *and* again as a process row inside that turn, so
  // the reader saw their own question twice. V2 draws it once. The duplication is asserted
  // here rather than quietly normalized away — a baseline with a known defect has to be
  // pinned as the reason for the difference, or the next reader cannot tell it from a
  // regression V2 introduced.
  expect(duplicatedPromptRows(legacy)).toEqual([
    { text: "查一下天气", role: "user", at: "2026-01-01T00:00:00.500Z" },
  ]);
  expect(shape).toEqual(withoutDuplicatedPromptRows(legacy));

  const turns = shape.sections.filter((section) => section.kind === "turn");
  expect(turns).toHaveLength(1);
  const rendered = JSON.stringify(shape.sections);
  expect(rendered).not.toContain("curl wttr.in");
  // The subagent's tool is in its own card: the row that used to be drawn in the middle
  // of the main answer is still rendered, under the agent that ran it.
  expect(shape.cards[0]?.timeline.map((row) => row.callId)).toEqual(["toolu_bash"]);
});

test("V2 renders the same subagent card as the legacy chain", () => {
  expectParity({
    attempts: [runningAttempt],
    agents: [
      agentInstance({
        agentId: "01a0aa0f-6ab3-7b11-b62e-43db1faa45d0",
        role: "coder",
        missionKey: "gz_weather",
      }),
    ],
    events: [
      event({
        id: "agent_started",
        sequence: 1,
        eventType: "agent.started",
        scope: "agent",
        role: "coder",
        agentId: "01a0aa0f-6ab3-7b11-b62e-43db1faa45d0",
        runAttemptId: "attempt_1",
        observedAt: "2026-01-01T00:00:01.000Z",
        // The provider's own words for the task. The card's title and the line under it
        // are drawn from these, and outside V2 they only ever existed on this row.
        metadata: {
          taskName: "gz_weather",
          delegationSummary: "查询广州天气",
          delegationPrompt: "查询广州今天天气并给出穿衣建议",
        },
      }),
      event({
        id: "tool_search",
        sequence: 2,
        eventType: "tool.started",
        scope: "agent",
        role: "coder",
        agentId: "01a0aa0f-6ab3-7b11-b62e-43db1faa45d0",
        runAttemptId: "attempt_1",
        message: "Tool: WebSearch · 广州天气",
        observedAt: "2026-01-01T00:00:02.000Z",
        metadata: {
          tool: { toolUseId: "call_search", name: "WebSearch", input: { query: "广州天气" } },
        },
      }),
    ],
  });
});
