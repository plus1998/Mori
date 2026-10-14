import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const desktopRoot = join(import.meta.dir, "../src");
const clientRoots = [
  join(desktopRoot, "preload"),
  join(desktopRoot, "renderer"),
  join(import.meta.dir, "../../mobile/lib"),
];
const remoteRegistryPath = join(import.meta.dir, "../../../packages/shared/src/remote-command-registry.ts");
const migrationScriptPath = join(import.meta.dir, "../scripts/conversation-v2-migrate.ts");

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.(?:ts|tsx|dart)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function sourceText(root: string): string {
  return sourceFiles(root)
    .map((path) => `${relative(root, path)}\n${readFileSync(path, "utf8")}`)
    .join("\n");
}

test("production runtime has no legacy thread-event write callsite", () => {
  const hits = sourceFiles(join(desktopRoot, "main")).flatMap((path) => {
    const lines = readFileSync(path, "utf8").split("\n");
    return lines
      .map((line, index) => ({ path, line, number: index + 1 }))
      .filter(({ line }) => /\.appendThreadRunEvent\s*\(/.test(line));
  });

  expect(hits).toEqual([]);
});

test("desktop and mobile clients do not expose retired V1 conversation APIs", () => {
  const retired = [
    "getThreadRunProjection",
    "getThreadRunProjectionDetail",
    "getThreadUsageSnapshot",
    "listSubagentSessions",
    "listSubagentMetrics",
    "listThreadTodos",
    "listThreadActivity",
    "thread:activity-list",
    "thread:usage-ledger-events-list",
    "reportThreadProjectionFocus",
    "thread:projection-focus-report",
  ];
  const clients = clientRoots.map(sourceText).join("\n");

  for (const identifier of retired) {
    expect(clients).not.toContain(identifier);
  }
});

test("desktop and mobile production clients have no legacy continuation entry point", () => {
  const clients = clientRoots.map(sourceText).join("\n");
  expect(clients).not.toContain("continueThread");
  expect(clients).not.toContain("thread:continue");
  expect(clients).not.toContain("threadContinue");

  const renderer = readFileSync(join(desktopRoot, "renderer/App.tsx"), "utf8");
  const helperStart = renderer.indexOf("async function sendConversationV2Continuation");
  const helperEnd = renderer.indexOf("async function retryFailedRequest", helperStart);
  expect(helperStart).toBeGreaterThanOrEqual(0);
  expect(helperEnd).toBeGreaterThan(helperStart);
  const helper = renderer.slice(helperStart, helperEnd);
  expect(helper).toContain("updateThreadRuntimeConfig");
  expect(helper).toContain("conversationV2SendMessage");
  expect(helper).toContain("clientCommandId");
  expect((renderer.match(/sendConversationV2Continuation\(/g) ?? []).length).toBeGreaterThanOrEqual(3);

  const mobileSession = readFileSync(
    join(import.meta.dir, "../../mobile/lib/features/threads/thread_session_screen.dart"),
    "utf8",
  );
  expect(mobileSession).toContain("v2Controller.sendMessage");
  expect(mobileSession).toContain("refusing legacy continuation");
});

test("remote command registry does not advertise retired continuation or V1 projection reads", () => {
  const registry = readFileSync(remoteRegistryPath, "utf8");
  for (const identifier of [
    'command("thread:continue"',
    'command("thread:activity-list"',
    'command("thread:get-usage-snapshot"',
    'command("thread:run-projection-get"',
    'command("thread:run-projection-detail-get"',
    'command("thread:subagent-sessions-list"',
    'command("thread:todo-list"',
  ]) {
    expect(registry).not.toContain(identifier);
  }
  expect(registry).toContain('command("conversation:send-message"');
  expect(registry).toContain('command("conversation:sync"');
  expect(registry).toContain('command("conversation:tools-page"');
});

test("prompt image reads require a scoped V2 content authorization check", () => {
  const main = readFileSync(join(desktopRoot, "main/index.ts"), "utf8");
  const start = main.indexOf("registerDesktopCommand(IPC_CHANNELS.promptImageReadChunk");
  const end = main.indexOf("registerDesktopCommand(IPC_CHANNELS.promptImageRelease", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = main.slice(start, end);
  expect(body).toContain("contextKey");
  expect(body).toContain("isPromptImageContentRefAuthorized");
  expect(body).toContain("CONVERSATION_V2_ERROR.integrityFailure");
});

test("V2-only runtime does not load or maintain the transitional feed skeleton", () => {
  const main = readFileSync(join(desktopRoot, "main/index.ts"), "utf8");
  expect(main).not.toContain("onThreadRunEventAppended(maintainThreadFeedSkeletonFromEvent)");
  expect(main).not.toContain("maintainThreadFeedSkeletonFromEvent");
  expect(main).not.toContain("buildThreadFeedSkeletonHydrationContext");
  expect(main).not.toContain('from "./legacy-feed-skeleton-store"');
  const start = main.indexOf("function scheduleThreadRunProjectionUpdated");
  expect(start).toBeGreaterThanOrEqual(0);
  const body = main.slice(start, start + 500);
  expect(body).toContain("durable conversation writer");
  expect(body).not.toContain("conversationStore.getThreadFeedSkeleton");
});

test("V2-only runtime has no transient local stream projection path", () => {
  const main = readFileSync(join(desktopRoot, "main/index.ts"), "utf8");
  const ingestion = readFileSync(join(desktopRoot, "main/sdk-stream-activity-ingestion.ts"), "utf8");
  const bridge = readFileSync(join(desktopRoot, "main/sdk-stream-activity.ts"), "utf8");
  const renderer = readFileSync(join(desktopRoot, "renderer/App.tsx"), "utf8");
  const ipc = readFileSync(join(desktopRoot, "shared/ipc.ts"), "utf8");

  for (const source of [main, ingestion, bridge, renderer, ipc]) {
    expect(source).not.toContain("onLocalStreamUpdate");
    expect(source).not.toContain("thread.local_stream_updated");
    expect(source).not.toContain("ThreadLocalStreamUpdate");
  }
  expect(sourceFiles(join(desktopRoot, "renderer"))).not.toContain(
    join(desktopRoot, "renderer/local-stream-projection.ts"),
  );
});

test("desktop activity entry is V2-only and has no projection fallback props", () => {
  const activityView = readFileSync(join(desktopRoot, "renderer/ActivityLogView.tsx"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const app = readFileSync(join(desktopRoot, "renderer/App.tsx"), "utf8");
  const propsStart = activityView.indexOf("export interface ActivityLogViewProps");
  const propsEnd = activityView.indexOf("}\n\nfunction conversationV2MessageToTimelineItem", propsStart);
  expect(propsStart).toBeGreaterThanOrEqual(0);
  expect(propsEnd).toBeGreaterThan(propsStart);
  const props = activityView.slice(propsStart, propsEnd);
  expect(props).toContain("conversationV2?: ConversationV2RendererState");
  expect(props).not.toContain("projection?");
  expect(props).not.toContain("viewModel?");

  const activityStart = activityView.indexOf("export const ActivityLogView");
  const activityEnd = activityView.indexOf(
    "function ConversationV2ProjectionActivityLogViewImpl",
    activityStart,
  );
  expect(activityStart).toBeGreaterThanOrEqual(0);
  expect(activityEnd).toBeGreaterThan(activityStart);
  const activityEntry = activityView.slice(activityStart, activityEnd);
  // The shared projection remains gated by V2 state; it cannot revive a V1 feed.
  expect(activityEntry).toMatch(/props\.conversationV2\s*\?\s*reconcileActivityProjectionThreadStatus/);
  expect(activityEntry).toContain("buildConversationV2OnlyProjection");
  expect(activityEntry).not.toContain("props.projection");
  expect(activityEntry).not.toContain("props.viewModel");

  const lazyFeedStart = app.indexOf("<LazyActivityLogView");
  const lazyFeedEnd = app.indexOf("/>", lazyFeedStart);
  expect(lazyFeedStart).toBeGreaterThanOrEqual(0);
  expect(lazyFeedEnd).toBeGreaterThan(lazyFeedStart);
  const lazyFeed = app.slice(lazyFeedStart, lazyFeedEnd);
  expect(lazyFeed).toContain("conversationV2");
  expect(lazyFeed).not.toContain("projection:");
  expect(lazyFeed).not.toContain("viewModel:");
});

test("desktop production keeps fresh databases V2-only and permits legacy lazy migration", () => {
  const main = readFileSync(join(desktopRoot, "main/index.ts"), "utf8");
  const store = readFileSync(join(desktopRoot, "main/conversation-store.ts"), "utf8");
  expect(main).toContain('freshStorageMode: "v2_only"');
  expect(main).toContain("requiredStorageMode: null");
  expect(store).toContain('freshStorageMode: otherOptions.freshStorageMode ?? "v2_only"');
  expect(store).toContain("requiredStorageMode === null");
});

test("desktop production migrates a legacy conversation when its V2 data is first requested", () => {
  const main = readFileSync(join(desktopRoot, "main/index.ts"), "utf8");
  const store = readFileSync(join(desktopRoot, "main/conversation-store.ts"), "utf8");
  const migrator = readFileSync(join(desktopRoot, "main/conversation-v2-legacy-migration.ts"), "utf8");
  expect(main).toContain("conversationStore.conversationV2LegacyMigrator()");
  expect(main).toContain('logUpstream("conversation.v1-lazy-migration.completed"');
  expect(main).toContain("recoverableThreads");
  expect(store).toContain("requiredStorageMode?: ConversationV2StorageMode | null");
  expect(migrator).toContain("hasResumableMigration(conversationId: string)");
  expect(store).toContain("CONVERSATION_V2_ERROR.migrationIncomplete");
});

test("SDK replay fixtures cannot recreate the legacy conversation schema", () => {
  const replay = readFileSync(join(desktopRoot, "main/sdk-agent-events-replay.ts"), "utf8");
  const roundReplay = readFileSync(join(desktopRoot, "feed-replay/conversation-round-replay.ts"), "utf8");
  expect(replay).toContain('freshStorageMode: "v2_only"');
  expect(replay).toContain('requiredStorageMode: "v2_only"');
  expect(roundReplay).toContain('freshStorageMode: "v2_only"');
  expect(roundReplay).toContain('requiredStorageMode: "v2_only"');
});

test("maintenance cutover audits every retired V1 conversation table", () => {
  const migration = readFileSync(migrationScriptPath, "utf8");
  for (const table of [
    "thread_activity",
    "thread_coder_todos",
    "thread_pending_plans",
    "thread_run_events",
    "thread_user_messages",
    "thread_pending_followups",
    "thread_feed_skeleton",
    "thread_metrics_snapshots",
    "thread_agent_instances",
    "thread_subagent_sessions",
    "thread_subagent_metrics",
    "thread_run_attempts",
    "thread_usage_ledger_events",
  ]) {
    expect(migration).toContain(`"${table}"`);
  }
});

test("V2-only retry gating reads V2 history and progress facts", () => {
  const main = readFileSync(join(desktopRoot, "main/index.ts"), "utf8");
  const start = main.indexOf("async function retryThreadFromFailedRequest");
  const end = main.indexOf("async function getWorkspaceChangeStatus", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = main.slice(start, end);
  expect(body).toContain("requireConversationV2Thread(input.threadId)");
  expect(body).toContain("v2.head(input.threadId).historyRevision");
  expect(body).toContain("resolveNonRewindRetryUserMessage(");
  const retry = readFileSync(join(desktopRoot, "main/conversation-nonrewind-retry-command.ts"), "utf8");
  expect(retry).toContain("v2.hasRetryBlockingProgress(threadId, identity)");
  expect(retry).toContain("listUserMessages(threadId)");
  expect(retry).toContain("拒绝读取旧消息表");
  expect(body).not.toContain("buildCurrentThreadRunProjection");
});

test("V2-only history editing uses V2 revision and rejects preview-only attachments", () => {
  const main = readFileSync(join(desktopRoot, "main/index.ts"), "utf8");
  const start = main.indexOf("async function getThreadUserMessageEdit");
  const end = main.indexOf("async function retryThreadFromFailedRequest", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = main.slice(start, end);
  expect(body).toContain("requireConversationV2Thread(threadId)");
  expect(body).toContain("v2.head(threadId).historyRevision");
  expect(body).toContain("missing_durable_attachment");
  expect(body).toContain("requireConversationV2Thread(threadId)");
});

test("V2-only projection reads validate the stream before touching the legacy cache", () => {
  const store = readFileSync(join(desktopRoot, "main/conversation-store.ts"), "utf8");
  const start = store.indexOf("  listThreadRunEventsForProjection(");
  const end = store.indexOf("  listProjectionEventCacheThreadIds(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = store.slice(start, end);
  expect(body.indexOf("const v2Only = this.isV2OnlyStorage();")).toBeGreaterThanOrEqual(0);
  expect(body.indexOf("this.requireV2RunStream(threadId)")).toBeLessThan(
    body.indexOf("const cached = v2Only ? undefined : this.projectionEventCache.get(threadId);"),
  );
  expect(body).toContain("if (!v2Only) {");
});
