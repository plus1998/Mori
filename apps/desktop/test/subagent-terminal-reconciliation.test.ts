import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConversationStore } from "../src/main/conversation-store";
import { PROXY_PENDING_ATTRIBUTION_REASON } from "../src/main/proxy-usage-pending-settlement";
import {
  parseSubagentAssistantMessageIds,
  reconcileSubagentTerminalTranscript,
} from "../src/main/subagent-terminal-reconciliation";
import {
  type AgentInstanceRecord,
  buildUsageLedgerEventKey,
  InMemoryUsageLedger,
  type UsageLedgerEvent,
} from "../src/main/usage-ledger";
import {
  UsageLedgerCoordinator,
  type UsageLedgerCoordinatorStore,
} from "../src/main/usage-ledger-coordinator";

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

async function createLegacyStore(dbPath: string) {
  return createConversationStore(dbPath, {
    freshStorageMode: "legacy_compat",
    requiredStorageMode: "legacy_compat",
  });
}

test("parseSubagentAssistantMessageIds deduplicates exact assistant ids and reports malformed lines", () => {
  const parsed = parseSubagentAssistantMessageIds(
    [
      JSON.stringify({ type: "assistant", message: { id: "msg_a" } }),
      JSON.stringify({ type: "user", message: { id: "user_ignored" } }),
      JSON.stringify({ type: "assistant", message: { id: "msg_a" } }),
      "{not-json",
      JSON.stringify({ type: "assistant", message: { id: "msg_b" } }),
    ].join("\n"),
  );

  expect(parsed).toEqual({
    messageIds: ["msg_a", "msg_b"],
    duplicateMessageCount: 1,
    invalidLineNumbers: [4],
  });
});

test("terminal reconciliation binds every deduplicated message id and never invents identity", async () => {
  const bindings: Array<Record<string, unknown>> = [];
  const feedUpdates: Array<{ messageIds: readonly string[]; agentId: string }> = [];
  const diagnostics: Array<{ topic: string; fields: Record<string, unknown> }> = [];
  const result = await reconcileSubagentTerminalTranscript({
    threadId: "thr_terminal",
    agentId: "agent_general_terminal",
    role: "general-purpose",
    agentTranscriptPath: "/tmp/agent-general.jsonl",
    parentToolUseId: "call_general_terminal",
    readTranscript: async () =>
      [
        JSON.stringify({ type: "assistant", message: { id: "msg_terminal_a" } }),
        JSON.stringify({ type: "assistant", message: { id: "msg_terminal_a" } }),
        "invalid",
        JSON.stringify({ type: "assistant", message: { id: "msg_terminal_b" } }),
      ].join("\n"),
    bindMessageIdentity(binding) {
      bindings.push(binding);
      return 1;
    },
    attributeFeedEvents(messageIds, agentId) {
      feedUpdates.push({ messageIds, agentId });
      return 3;
    },
    logDiagnostic: (topic, fields) => diagnostics.push({ topic, fields }),
  });

  expect(result).toEqual({
    status: "partial_parse",
    messageIds: ["msg_terminal_a", "msg_terminal_b"],
    duplicateMessageCount: 1,
    invalidLineNumbers: [3],
    settledUsageCount: 2,
    attributedFeedEventCount: 3,
  });
  expect(bindings).toEqual([
    {
      messageId: "msg_terminal_a",
      agentId: "agent_general_terminal",
      role: "general-purpose",
      parentToolUseId: "call_general_terminal",
    },
    {
      messageId: "msg_terminal_b",
      agentId: "agent_general_terminal",
      role: "general-purpose",
      parentToolUseId: "call_general_terminal",
    },
  ]);
  expect(feedUpdates).toEqual([
    {
      messageIds: ["msg_terminal_a", "msg_terminal_b"],
      agentId: "agent_general_terminal",
    },
  ]);
  expect(diagnostics.at(-1)).toMatchObject({
    topic: "subagent.terminal_reconciliation",
    fields: {
      status: "partial_parse",
      invalidLineCount: 1,
      settledUsageCount: 2,
      attributedFeedEventCount: 3,
    },
  });
});

test("sidechain transcript settles pending authoritative proxy usage by message id", async () => {
  const ledger = new InMemoryUsageLedger();
  const store: UsageLedgerCoordinatorStore = {
    appendUsageLedgerEvent(event: UsageLedgerEvent) {
      return ledger.appendUsageEvent(event).inserted;
    },
    listUsageLedgerEvents(threadId: string) {
      return ledger.listUsageEvents(threadId);
    },
    listAgentInstances(threadId: string): AgentInstanceRecord[] {
      return ledger.listAgentInstances(threadId);
    },
    updateUsageLedgerEventAttribution(eventId, update) {
      return Boolean(ledger.updateUsageEventAttribution(eventId, update));
    },
  };
  const coordinator = new UsageLedgerCoordinator({
    store,
    metrics: { listEntries: () => [] },
    writeError: (message) => {
      throw new Error(message);
    },
  });
  const pendingEvent: UsageLedgerEvent = {
    id: "evt_sidechain_pending",
    idempotencyKey: buildUsageLedgerEventKey({
      threadId: "thr_sidechain_pending",
      source: "proxy",
      sourceEventId: "proxy:sidechain",
      usageKind: "request_final",
      modelId: "claude-sonnet",
    }),
    threadId: "thr_sidechain_pending",
    source: "proxy",
    sourceEventId: "proxy:sidechain",
    usageKind: "request_final",
    role: "general-purpose",
    sdkMessageId: "msg_sidechain_pending",
    modelId: "claude-sonnet",
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 50,
    cacheCreationTokens: 25,
    observedAt: "2026-07-10T00:00:00.000Z",
    attribution: {
      status: "pending",
      reason: PROXY_PENDING_ATTRIBUTION_REASON,
    },
  };
  coordinator.appendEvents([pendingEvent]);
  coordinator.registerProxyPendingAttribution("thr_sidechain_pending", {
    eventId: pendingEvent.id,
    requestKey: pendingEvent.sourceEventId,
    routeRole: "general-purpose",
    billingRole: "general-purpose",
    messageId: "msg_sidechain_pending",
    observedAt: pendingEvent.observedAt,
  });

  const result = await reconcileSubagentTerminalTranscript({
    threadId: "thr_sidechain_pending",
    agentId: "agent_sidechain_exact",
    role: "general-purpose",
    agentTranscriptPath: "/tmp/agent-sidechain.jsonl",
    readTranscript: async () =>
      JSON.stringify({ type: "assistant", message: { id: "msg_sidechain_pending" } }),
    bindMessageIdentity: (binding) => coordinator.bindProxyMessageIdentity("thr_sidechain_pending", binding),
    attributeFeedEvents: () => 0,
    logDiagnostic: () => {},
  });

  expect(result.settledUsageCount).toBe(1);
  expect(ledger.listUsageEvents("thr_sidechain_pending")[0]).toMatchObject({
    agentId: "agent_sidechain_exact",
    attribution: { status: "attributed", agentId: "agent_sidechain_exact" },
  });
});

test("missing sidechain transcript stays explicitly unresolved", async () => {
  let bindCount = 0;
  let feedCount = 0;
  const diagnostics: Array<{ topic: string; fields: Record<string, unknown> }> = [];
  const result = await reconcileSubagentTerminalTranscript({
    threadId: "thr_missing_terminal",
    agentId: "agent_missing_terminal",
    role: "general-purpose",
    bindMessageIdentity() {
      bindCount += 1;
      return 0;
    },
    attributeFeedEvents() {
      feedCount += 1;
      return 0;
    },
    logDiagnostic: (topic, fields) => diagnostics.push({ topic, fields }),
  });

  expect(result.status).toBe("missing_transcript_path");
  expect(bindCount).toBe(0);
  expect(feedCount).toBe(0);
  expect(diagnostics.at(-1)).toMatchObject({
    topic: "subagent.terminal_reconciliation",
    fields: { status: "missing_transcript_path", messageCount: 0 },
  });
});

test.skipIf(!sqliteAvailable)(
  "conversation store attributes historical Feed rows only by exact sdk message id",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-terminal-feed-"));
    const store = await createLegacyStore(path.join(dir, "eco.sqlite"));
    store.saveThread({
      id: "thr_terminal_feed",
      title: "Terminal feed",
      prompt: "test",
      workspacePath: "/tmp/project",
      status: "running",
      message: "",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    store.saveSdkSession("thr_terminal_feed", "session_planner", "/tmp/project");
    store.upsertAgentInstance({
      threadId: "thr_terminal_feed",
      agentId: "agent_general_feed",
      role: "general-purpose",
      kind: "subagent",
      status: "active",
      parentAgentId: "planner_agent",
      parentToolUseId: "call_exact_feed",
      startedAt: "2026-07-10T00:00:00.500Z",
      updatedAt: "2026-07-10T00:00:00.500Z",
    });
    store.appendThreadRunEvent({
      id: "tre:feed:a",
      threadId: "thr_terminal_feed",
      eventType: "message.final",
      scope: "agent",
      role: "coder",
      agentId: "agent_wrong_feed",
      parentAgentId: "planner_wrong",
      parentToolUseId: "call_wrong_feed",
      streamState: "finalized",
      message: "A",
      metadata: {
        sdkMessageId: "msg_feed_a",
        parentToolUseId: "call_wrong_feed",
        parent_tool_use_id: "call_wrong_feed",
      },
      observedAt: "2026-07-10T00:00:01.000Z",
    });
    store.appendThreadRunEvent({
      id: "tre:feed:b",
      threadId: "thr_terminal_feed",
      eventType: "thinking.final",
      scope: "main",
      role: "thinking",
      streamState: "finalized",
      message: "B",
      metadata: { sdkMessageId: "msg_feed_b" },
      observedAt: "2026-07-10T00:00:02.000Z",
    });
    store.appendThreadRunEvent({
      id: "tre:feed:other",
      threadId: "thr_terminal_feed",
      eventType: "message.final",
      scope: "main",
      role: "main",
      streamState: "finalized",
      message: "Other",
      metadata: { sdkMessageId: "msg_other" },
      observedAt: "2026-07-10T00:00:03.000Z",
    });

    const conflicts: Array<{
      eventId: string;
      messageId: string;
      existingAgentId: string;
      incomingAgentId: string;
    }> = [];
    expect(
      store.attributeThreadRunEventsBySdkMessageIds(
        "thr_terminal_feed",
        ["msg_feed_a", "msg_feed_b", "msg_feed_a"],
        "agent_general_feed",
        (conflict) => conflicts.push(conflict),
      ),
    ).toBe(2);
    expect(conflicts).toEqual([
      {
        eventId: "tre:feed:a",
        messageId: "msg_feed_a",
        existingAgentId: "agent_wrong_feed",
        incomingAgentId: "agent_general_feed",
      },
    ]);
    expect(
      store.attributeThreadRunEventsBySdkMessageIds(
        "thr_terminal_feed",
        ["msg_feed_a", "msg_feed_b"],
        "agent_general_feed",
      ),
    ).toBe(0);

    const events = store.listThreadRunEvents("thr_terminal_feed");
    expect(events.find((event) => event.id === "tre:feed:a")).toMatchObject({
      scope: "agent",
      role: "general-purpose",
      agentId: "agent_general_feed",
      parentAgentId: "planner_agent",
      parentToolUseId: "call_exact_feed",
      metadata: {
        sdkMessageId: "msg_feed_a",
        parentToolUseId: "call_exact_feed",
        parent_tool_use_id: "call_exact_feed",
      },
    });
    expect(events.find((event) => event.id === "tre:feed:b")).toMatchObject({
      scope: "agent",
      role: "thinking",
      agentId: "agent_general_feed",
      parentAgentId: "planner_agent",
      parentToolUseId: "call_exact_feed",
      metadata: {
        sdkMessageId: "msg_feed_b",
        parentToolUseId: "call_exact_feed",
        parent_tool_use_id: "call_exact_feed",
      },
    });
    expect(events.find((event) => event.id === "tre:feed:other")).toMatchObject({
      scope: "main",
      role: "main",
    });
  },
);
