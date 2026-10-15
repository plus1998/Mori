import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConversationRun, type ConversationSyncEffect, stableHash } from "@eco/shared";
import { exportFeedReplay, writeReplayFixture } from "../scripts/feed-replay/export";
import { createReplayApi, type ReplayCall } from "../scripts/feed-replay/sandbox";
import { FeedReplaySession } from "../scripts/feed-replay/session";
import {
  type FeedReplayEvent,
  type FeedReplayFixture,
  validateReplayFixture,
} from "../scripts/feed-replay/types";
import type { ThreadRunEvent } from "../src/shared/ipc";

const id = "thr_replay_test";
const timestamp = "2026-10-01T00:00:00.000Z";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function event(
  seq: number,
  effect: ConversationSyncEffect["effect"] = { type: "noop", reason: "recorded source" },
): FeedReplayEvent {
  return {
    seq,
    at: Date.parse(timestamp) + seq * 100,
    eventType: "recorded",
    effectVersion: 1,
    effectHash: stableHash(effect),
    effect,
  };
}
function user(seq: number): FeedReplayEvent {
  return event(seq, {
    type: "message.create",
    message: {
      messageId: `message_${seq}`,
      conversationId: id,
      turnId: "turn_1",
      role: "user",
      channel: "answer",
      createdSeq: seq,
      versionSeq: seq,
      contentVersion: 0,
      body: "下一条录制消息",
      status: "final",
      isDeleted: false,
    },
  });
}
function run(seq: number, status: ConversationRun["status"], runId = "run_1"): FeedReplayEvent {
  return event(seq, {
    type: "run.upsert",
    run: {
      runId,
      conversationId: id,
      turnId: "turn_1",
      status,
      versionSeq: seq,
      timingQuality: "recorded",
      startedAt: timestamp,
    },
  });
}
function fixture(events: FeedReplayEvent[]): FeedReplayFixture {
  return {
    formatVersion: 1,
    protocolVersion: 2,
    exportedAt: timestamp,
    conversationId: id,
    storeEpoch: "epoch_test",
    thread: {
      id,
      title: "Replay test",
      prompt: "",
      workspacePath: "/test",
      status: "completed",
      message: "",
      createdAt: timestamp,
      updatedAt: timestamp,
      coreKind: "codex",
    },
    events,
    detailItems: [],
    coverage: ["Test capture"],
  };
}
function database(events: FeedReplayEvent[]) {
  const directory = mkdtempSync(join(tmpdir(), "eco-feed-replay-"));
  directories.push(directory);
  const path = join(directory, "recording.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,prompt TEXT,workspace_path TEXT,status TEXT,message TEXT,
      created_at TEXT,updated_at TEXT,core_kind TEXT,runtime_config_json TEXT);
    CREATE TABLE thread_core_sessions(thread_id TEXT,external_session_id TEXT);
    CREATE TABLE conversation_events_v2(conversation_id TEXT,seq INTEGER,store_epoch TEXT,occurred_at TEXT,type TEXT,payload_json TEXT,message_id TEXT);
    CREATE TABLE conversation_sync_effects_v2(conversation_id TEXT,seq INTEGER,effect_version INTEGER,effect_hash TEXT,effect_json TEXT);
    CREATE TABLE conversation_detail_items_v2(conversation_id TEXT,item_id TEXT,run_id TEXT,type TEXT,created_seq INTEGER,version_seq INTEGER,content TEXT);
  `);
  db.query("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,NULL)").run(
    id,
    "Replay test",
    "",
    "/test",
    "completed",
    "",
    timestamp,
    timestamp,
    "codex",
  );
  for (const item of events) {
    db.query(
      "INSERT INTO conversation_events_v2(conversation_id,seq,store_epoch,occurred_at,type,payload_json) VALUES(?,?,?,?,?,?)",
    ).run(id, item.seq, "epoch_test", new Date(item.at).toISOString(), item.eventType, "{}");
    db.query("INSERT INTO conversation_sync_effects_v2 VALUES(?,?,?,?,?)").run(
      id,
      item.seq,
      item.effectVersion,
      item.effectHash,
      JSON.stringify(item.effect),
    );
  }
  return { db, path, directory };
}

describe("replay export", () => {
  test("exports a consistent recording without changing the source database, and saves private artifacts", () => {
    const source = database([user(1), run(2, "running"), run(3, "completed")]);
    source.db.close();
    const before = readFileSync(source.path);
    const exported = exportFeedReplay(source.path, id);
    expect(readFileSync(source.path).equals(before)).toBe(true);
    expect(exported.events.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(exported.thread.coreKind).toBe("codex");
    const output = join(source.directory, "fixture.json");
    writeReplayFixture(output, exported);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(new FeedReplaySession(JSON.parse(readFileSync(output, "utf8")), 3).thread.status).toBe(
      "completed",
    );
  });

  test("missing databases, V2 prefixes, effects and invalid hashes fail explicitly", () => {
    const source = database([event(1), event(2)]);
    const missing = join(source.directory, "missing.sqlite");
    expect(() => exportFeedReplay(missing, id)).toThrow();
    expect(existsSync(missing)).toBe(false);
    source.db.query("UPDATE conversation_sync_effects_v2 SET effect_hash='wrong' WHERE seq=2").run();
    expect(() => exportFeedReplay(source.path, id)).toThrow("hash mismatch");
    source.db.query("DELETE FROM conversation_sync_effects_v2 WHERE seq=2").run();
    expect(() => exportFeedReplay(source.path, id)).toThrow("sequence 2");
    source.db.query("DELETE FROM conversation_events_v2 WHERE seq=1").run();
    expect(() => exportFeedReplay(source.path, id)).toThrow("sequence 2");
    source.db.close();
  });

  test("rebuilds production request spans, including cancellation followed by late tool-writing", () => {
    const source = database([run(1, "running"), event(2), event(3), event(4), run(5, "cancelled")]);
    const types = ["request.started", "request.cancelled", "tool.writing"] as const;
    for (const [index, type] of types.entries()) {
      const seq = index + 2;
      const recorded: ThreadRunEvent = {
        id: `source_${seq}`,
        threadId: id,
        sequence: seq,
        eventType: type,
        scope: "agent",
        streamState: "none",
        message: "sed source.ts",
        observedAt: timestamp,
        requestId: "request_1",
        runAttemptId: "run_1",
        metadata: {
          liveType: type,
          ...(type === "tool.writing"
            ? { toolWriting: { name: "Bash", kind: "command", target: "sed source.ts" } }
            : {}),
        },
      };
      source.db
        .query("UPDATE conversation_events_v2 SET payload_json=? WHERE seq=?")
        .run(JSON.stringify({ source: recorded }), seq);
    }
    const exported = exportFeedReplay(source.path, id);
    expect(exported.events[1]?.requestSpans?.[0]?.status).toBe("waiting_first_token");
    expect(exported.events[3]?.requestSpans?.[0]?.status).toBe("cancelled");
    expect(exported.events[3]?.requestSpans?.[0]?.writingTool).toBeUndefined();
    source.db.close();
  });

  test("resolves body-free provider receipts from message effects at the recorded sequence", () => {
    const message = user(2);
    if (message.effect.type !== "message.create") throw new Error("Expected message creation.");
    message.effect.message.role = "assistant";
    message.effect.message.channel = "thinking";
    message.effect.message.body = "";
    message.effectHash = stableHash(message.effect);
    const source = database([
      run(1, "running"),
      message,
      event(3),
      event(4, {
        type: "message.append",
        messageId: "message_2",
        baseContentVersion: 0,
        nextContentVersion: 1,
        delta: "已产生思考内容",
        versionSeq: 4,
      }),
      event(5),
    ]);
    const recorded = {
      id: "thinking-source",
      threadId: id,
      eventType: "thinking.delta",
      scope: "main",
      streamState: "streaming",
      observedAt: timestamp,
      requestId: "request_1",
    };
    source.db
      .query("UPDATE conversation_events_v2 SET payload_json=?,message_id=? WHERE seq=3")
      .run(JSON.stringify({ source: recorded }), "message_2");
    source.db.query("UPDATE conversation_events_v2 SET payload_json=?,message_id=? WHERE seq=5").run(
      JSON.stringify({
        source: {
          ...recorded,
          id: "thinking-final",
          eventType: "thinking.final",
          streamState: "finalized",
        },
      }),
      "message_2",
    );
    const exported = exportFeedReplay(source.path, id);
    expect(exported.events[2]?.requestSpans?.[0]?.pendingThinkingSince).toBe(timestamp);
    expect(exported.events[4]?.requestSpans?.[0]?.pendingThinkingSince).toBeUndefined();
    expect(exported.events[2]?.requestSpans?.[0]?.status).toBe("waiting_first_token");
    source.db.query("UPDATE conversation_events_v2 SET message_id='missing' WHERE seq=3").run();
    expect(() => exportFeedReplay(source.path, id)).toThrow("Missing source message");
    source.db.close();
  });
});

describe("replay session", () => {
  test("edited fixtures fail validation rather than masking a protocol or hash gap", () => {
    const recording = fixture([event(1)]);
    recording.events[0]!.effectHash = "tampered";
    expect(() => validateReplayFixture(recording)).toThrow("Invalid or non-contiguous");
    expect(() => validateReplayFixture({ ...recording, protocolVersion: 1 })).toThrow("no legacy fallback");
    expect(() => new FeedReplaySession(fixture([run(1, "unknown")]), 1)).toThrow(
      "Cannot reconstruct thread status",
    );
  });

  test("Send consumes the next exact message through its run start, without assuming fixed offsets", () => {
    const session = new FeedReplaySession(
      fixture([
        run(1, "completed"),
        user(2),
        event(3),
        event(4),
        event(5),
        event(6),
        run(7, "running", "run_2"),
        run(8, "completed", "run_2"),
      ]),
    );
    expect(() =>
      session.send({ conversationId: id, text: "arbitrary prompt", clientCommandId: "command" }),
    ).toThrow("exactly match");
    expect(session.index).toBe(0);
    const received: unknown[] = [];
    session.listeners.add((item) => received.push(item));
    const result = session.send({ conversationId: id, text: "下一条录制消息", clientCommandId: "command" });
    expect(result.messageId).toBe("message_2");
    expect(session.state.appliedSeq).toBe(7);
    expect(session.thread.status).toBe("running");
    expect(received).toHaveLength(8);
    expect(() => session.applyUntil(2)).toThrow("rewind");
    expect(() => session.bootstrap().messages[0]!.conversationId).not.toThrow();
  });

  test("Stop only consumes a recorded cancellation belonging to the active run", () => {
    const recording = fixture([
      run(1, "running"),
      run(2, "cancelled", "another_run"),
      event(3),
      run(4, "cancelled"),
    ]);
    const session = new FeedReplaySession(recording, 1);
    expect(session.cancel(id).thread.status).toBe("idle");
    expect(session.state.appliedSeq).toBe(4);
    const completed = new FeedReplaySession(fixture([run(1, "running"), run(2, "completed")]), 1);
    expect(() => completed.cancel(id)).toThrow("no recorded cancellation");
    expect(completed.state.appliedSeq).toBe(1);
  });

  test("pause invalidates a scheduled event batch, including a later restarted playback", async () => {
    const session = new FeedReplaySession(fixture([event(1), event(2), event(3)]), 1);
    const old = session.play({ maxGapMs: 40 });
    session.pause();
    const current = session.play({ toSeq: 2, maxGapMs: 0, settleMs: 0 });
    await Promise.all([old, current]);
    expect(session.state.appliedSeq).toBe(2);
    expect(session.playing).toBe(false);
    await expect(session.play({ speed: 0 })).rejects.toThrow("Invalid replay");
  });

  test("sync and reads cannot cross the conversation, epoch or checkpoint", () => {
    const session = new FeedReplaySession(fixture([user(1), event(2), run(3, "running")]), 2);
    expect(session.bootstrap().snapshotSeq).toBe(2);
    expect(
      session.sync({ conversationId: id, storeEpoch: "epoch_test", afterSeq: 0, maxEvents: 1 }),
    ).toMatchObject({ throughSeq: 1, hasMore: true });
    expect(() => session.sync({ conversationId: id, storeEpoch: "wrong", afterSeq: 0 })).toThrow(
      "epoch mismatch",
    );
    expect(() => session.sync({ conversationId: id, storeEpoch: "epoch_test", afterSeq: 3 })).toThrow(
      "ahead",
    );
    expect(() => session.toolsPage("other", "run_1")).toThrow("another conversation");
    expect(() =>
      session.sync({ conversationId: id, storeEpoch: "epoch_test", afterSeq: 0, maxEvents: 0 }),
    ).toThrow("budget");
    expect(() =>
      session.sync({ conversationId: id, storeEpoch: "epoch_test", afterSeq: 0, maxBytes: 1 }),
    ).toThrow("exceeds maxBytes");
    const first = session.sync({ conversationId: id, storeEpoch: "epoch_test", afterSeq: 0, maxEvents: 1 })
      .effects[0]!;
    const budget = new TextEncoder().encode(JSON.stringify(first)).length;
    expect(
      session.sync({ conversationId: id, storeEpoch: "epoch_test", afterSeq: 0, maxBytes: budget }),
    ).toMatchObject({ throughSeq: 1, hasMore: true });
  });

  test("detail bodies do not leak later versions, and paging cursors are checkpoint-bound", () => {
    const recording = fixture([event(1), event(2), event(3), event(4)]);
    recording.detailItems = [1, 2].map((number) => ({
      itemId: `item_${number}`,
      conversationId: id,
      runId: "run_1",
      type: "tool.output",
      createdSeq: 1,
      versionSeq: 2,
      content: `body ${number}`,
    }));
    const session = new FeedReplaySession(recording, 1);
    expect(() => session.detailsPage(id, "run_1")).toThrow("older body is not recorded");
    session.applyUntil(2);
    const page = session.detailsPage(id, "run_1", { limit: 1 });
    expect(page.items[0]?.content).toBe("body 1");
    expect(session.detailsPage(id, "run_1", { cursor: page.nextCursor! }).items[0]?.content).toBe("body 2");
    session.applyUntil(3);
    expect(() => session.detailsPage(id, "run_1", { cursor: page.nextCursor! })).toThrow(
      "another checkpoint",
    );
    expect(() => session.detailsPage(id, "run_1", { maxBytes: 1 })).toThrow("exceeds maxBytes");
    recording.detailItems.push({
      itemId: "future",
      conversationId: id,
      runId: "another",
      type: "tool.output",
      createdSeq: 4,
      versionSeq: 4,
    });
    expect(session.detailsPage(id, "another").items).toEqual([]);
  });
});

describe("native isolation", () => {
  test("explicit UI scenarios render a paused queue and terminal without native processes or input", async () => {
    const recording = fixture([event(1)]);
    recording.uiScenario = {
      terminalHeight: 280,
      pausedFollowUps: [{ id: "queued", threadId: id, prompt: "录制画面中的排队消息",
        status: "queued", priority: "normal", deliveryMode: "queued", createdAt: timestamp, updatedAt: timestamp }],
    };
    const session = new FeedReplaySession(recording);
    const forbidden = () => { throw new Error("Native must not execute"); };
    const api = createReplayApi({ spawnTerminal: forbidden, resizeTerminal: forbidden,
      listTerminalSessions: forbidden, writeTerminalInput: forbidden, onTerminalEvent: forbidden }, session, () => {});
    const call = (name: string, ...args: unknown[]) =>
      (api[name] as (...input: unknown[]) => Promise<any>)(...args);
    expect(session.thread.followUpQueuePaused).toBe(true);
    expect((await call("listThreadFollowUps", id)).followUps).toEqual(recording.uiScenario.pausedFollowUps);
    await expect(call("listThreadFollowUps", "other")).rejects.toThrow("another conversation");
    const terminals = await call("listTerminalSessions", { workspacePath: "/test" });
    expect(terminals).toHaveLength(1);
    await call("resizeTerminal", { sessionId: terminals[0].sessionId, cols: 80, rows: 24 });
    const output: unknown[] = [];
    const unsubscribe = (api.onTerminalEvent as (listener: (event: unknown) => void) => () => void)((event) => output.push(event));
    session.writeTerminalOutput("synthetic output\r\n");
    expect(output).toEqual([{ type: "output", sessionId: terminals[0].sessionId, data: "synthetic output\r\n" }]);
    unsubscribe();
    session.writeTerminalOutput("unsubscribed\r\n");
    expect(output).toHaveLength(1);
    await expect(call("writeTerminalInput", { sessionId: terminals[0].sessionId, data: "command" }))
      .rejects.toThrow("Native execution is blocked");
    recording.uiScenario.pausedFollowUps![0]!.threadId = "other";
    expect(() => validateReplayFixture(recording)).toThrow("paused follow-ups");
    recording.uiScenario = { terminalHeight: 0 };
    expect(() => validateReplayFixture(recording)).toThrow("terminal height");
  });

  test("Send/Stop are local; core probes, generation, writes and unknown get APIs never reach native", async () => {
    let nativeInvocations = 0;
    const forbidden = () => {
      nativeInvocations++;
      throw new Error("Native must not execute");
    };
    const calls: ReplayCall[] = [];
    const session = new FeedReplaySession(fixture([user(1), run(2, "running"), run(3, "cancelled")]));
    const api = createReplayApi(
      {
        platform: "darwin",
        conversationV2SendMessage: forbidden,
        cancelThread: forbidden,
        getCoreAvailability: forbidden,
        startThread: forbidden,
        deleteThread: forbidden,
        getAndSend: forbidden,
      },
      session,
      (call) => calls.push(call),
    );
    const call = (name: string, ...args: unknown[]) =>
      (api[name] as (...input: unknown[]) => Promise<unknown>)(...args);
    await call("getCoreAvailability");
    await call("conversationV2SendMessage", {
      conversationId: id,
      text: "下一条录制消息",
      clientCommandId: "cmd",
    });
    await call("cancelThread", id);
    for (const name of ["startThread", "deleteThread", "getAndSend"])
      await expect(call(name)).rejects.toThrow("Native execution is blocked");
    expect(nativeInvocations).toBe(0);
    expect(api.platform).toBe("darwin");
    expect(calls.filter((item) => item.kind === "blocked").map((item) => item.name)).toEqual([
      "startThread",
      "deleteThread",
      "getAndSend",
    ]);
  });

  test("only explicit environment reads are forwarded; native live events are unsubscribed", async () => {
    let reads = 0;
    let subscriptions = 0;
    const session = new FeedReplaySession(fixture([event(1)]));
    const calls: ReplayCall[] = [];
    const api = createReplayApi(
      {
        getModelSettings: () => {
          reads++;
          return { local: true };
        },
        onThreadEvent: () => {
          subscriptions++;
        },
        onBrowserState: () => {
          subscriptions++;
        },
      },
      session,
      (call) => calls.push(call),
    );
    expect(await (api.getModelSettings as () => Promise<unknown>)()).toEqual({ local: true });
    (api.onBrowserState as () => () => void)()();
    const unsubscribe = (api.onThreadEvent as (callback: (event: unknown) => void) => () => void)(() => {});
    expect(session.listeners.size).toBe(1);
    unsubscribe();
    expect(session.listeners.size).toBe(0);
    expect(reads).toBe(1);
    expect(subscriptions).toBe(0);
    expect(calls[0]?.kind).toBe("environment-read");
  });
});
