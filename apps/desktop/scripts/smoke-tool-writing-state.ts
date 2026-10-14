/**
 * Smoke test: "the model is writing a tool call" survives the whole Eco pipeline.
 *
 * Real upstream relay → Eco's real Anthropic stream mapper → the real desktop activity
 * bridge → the real thread-run normalizer → the real projection → the real renderer
 * selector. Nothing is simulated except the request identity, so a green run means the
 * Feed can name that wait instead of reading an unmoving timeline as a stall.
 *
 *   ECO_SMOKE_BASE_URL=https://… ECO_SMOKE_API_KEY=sk-… \
 *     bun run apps/desktop/scripts/smoke-tool-writing-state.ts
 *
 * The PI leg (a real PI session streaming arguments fragment by fragment) lives in
 * `bun test packages/runtime/test/pi-tool-writing-smoke.test.ts`.
 */
import { createSdkStreamContext, mapSdkMessageToEvents } from "@eco/runtime/sdk";
import {
  buildThreadRunProjection,
  buildThreadRunProjectionRequestSpans,
} from "../src/main/conversation-v2-runtime-projection";
import { SdkStreamActivityBridge } from "../src/main/sdk-stream-activity";
import { buildThreadRunEventFromLiveEvent } from "../src/main/thread-run-event-normalizer";
import { resolveToolWritingIndicator, resolveToolWritingLabel } from "../src/renderer/tool-writing-indicator";
import type { ThreadRunEvent } from "../src/shared/ipc";

const BASE_URL = (process.env.ECO_SMOKE_BASE_URL ?? "").replace(/\/+$/, "");
const API_KEY = process.env.ECO_SMOKE_API_KEY ?? "";
const MODEL = process.env.ECO_SMOKE_MODEL ?? "deepseek-flash";
const THREAD_ID = "thr_smoke_tool_writing";
const REQUEST_ID = "req_smoke_1";
const TOOL_NAME = "Write";

if (!BASE_URL || !API_KEY) {
  console.error("ECO_SMOKE_BASE_URL and ECO_SMOKE_API_KEY are required.");
  process.exit(2);
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
  if (!ok) {
    failures.push(label);
  }
}

interface TimedEvent {
  at: number;
  event: Record<string, unknown>;
}

/** Stream a tool-calling completion from the relay and keep every raw event with its offset. */
async function readUpstream(): Promise<TimedEvent[]> {
  const t0 = Date.now();
  const response = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      authorization: `Bearer ${API_KEY}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      stream: true,
      messages: [
        {
          role: "user",
          content:
            "先用一句话说明你要做什么，然后调用 Write 创建 /tmp/smoke.md：" +
            "content 至少 40 行中文，包含 10 首俳句，不要省略。",
        },
      ],
      tools: [
        {
          name: TOOL_NAME,
          description: "Create or overwrite a text file.",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" }, content: { type: "string" } },
            required: ["file_path", "content"],
          },
        },
      ],
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`upstream ${response.status}: ${await response.text()}`);
  }

  const events: TimedEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (dataLine) {
        events.push({ at: Date.now() - t0, event: JSON.parse(dataLine.slice(5).trim()) });
      }
    }
  }
  return events;
}

const raw = await readUpstream();

// Upstream timeline: when text stopped, when the tool block opened, when its arguments finished.
let firstTextAt: number | undefined;
let lastTextAt: number | undefined;
let toolBlockIndex: number | undefined;
let toolBlockOpenAt: number | undefined;
let toolBlockClosedAt: number | undefined;
let argFragments = 0;
for (const { at, event } of raw) {
  const type = String(event.type);
  const delta = event.delta as Record<string, unknown> | undefined;
  if (type === "content_block_start") {
    const block = event.content_block as Record<string, unknown> | undefined;
    if (block?.type === "tool_use") {
      toolBlockIndex = typeof event.index === "number" ? event.index : 0;
      toolBlockOpenAt = at;
    }
  }
  if (type === "content_block_delta" && delta?.type === "text_delta") {
    firstTextAt ??= at;
    lastTextAt = at;
  }
  if (type === "content_block_delta" && delta?.type === "input_json_delta") {
    argFragments += 1;
  }
  if (type === "content_block_stop" && event.index === toolBlockIndex) {
    toolBlockClosedAt = at;
  }
}

console.log(`\n--- upstream (${MODEL} @ ${new URL(BASE_URL).host}) ---`);
console.log(`  text        ${String(firstTextAt).padStart(6)}ms → ${String(lastTextAt).padStart(6)}ms`);
console.log(
  `  tool block  ${String(toolBlockOpenAt).padStart(6)}ms (${TOOL_NAME}) → ${String(toolBlockClosedAt).padStart(6)}ms`,
);
console.log(`  arguments   ${argFragments} streamed fragments`);

// --- Drive the same wire through Eco's own pipeline. ---
const events: ThreadRunEvent[] = [];
let sequence = 0;
const bridge = new SdkStreamActivityBridge();
const streamContext = createSdkStreamContext();
const observed: Array<{ liveType: string; at: number }> = [];
const pipelineStart = Date.now();

for (const { event } of raw) {
  const mapped = mapSdkMessageToEvents(
    { type: "stream_event", uuid: "smoke-uuid", session_id: THREAD_ID, event },
    THREAD_ID,
    streamContext,
  );
  for (const agentEvent of mapped) {
    bridge.handleEvent(THREAD_ID, agentEvent, (_threadId, type, message, role, stream, agentId, extras) => {
      const runEvent = buildThreadRunEventFromLiveEvent({
        threadId: THREAD_ID,
        eventId: `smoke:${sequence}`,
        liveType: type,
        message,
        role,
        stream,
        observedAt: new Date().toISOString(),
        // Tool facts carry no request id in production either: the bridge keys them by
        // `tool:<callId>` and a call outlives the request that wrote it. Handing them a
        // request id here would let the projection look correct while the live app, whose
        // tool events have `request_id = NULL`, surfaces nothing.
        ...(role === "tool" ? {} : { requestId: REQUEST_ID }),
        ...(agentId && { agentId }),
        ...(extras?.tool && { tool: extras.tool }),
        ...(extras?.metadata && { metadata: extras.metadata }),
      });
      if (!runEvent) {
        return;
      }
      sequence += 1;
      observed.push({ liveType: type, at: Date.now() - pipelineStart });
      events.push({ ...runEvent, sequence });
    });
  }
}

console.log("\n--- Eco pipeline activities ---");
for (const entry of observed) {
  console.log(`  ${String(entry.at).padStart(6)}ms  ${entry.liveType}`);
}

// Project the run as it stood at each interesting moment: while writing, and once the real
// row landed. Events are replayed instantly here, so the *window* is measured upstream and
// the pipeline only has to carry the state across it.
const projection = buildThreadRunProjection({
  threadId: THREAD_ID,
  status: "running",
  attempts: [],
  agents: [],
  events,
});
const writingEvents = events.filter((event) => event.eventType === "tool.writing");
const windowMs =
  typeof toolBlockOpenAt === "number" && typeof toolBlockClosedAt === "number"
    ? toolBlockClosedAt - toolBlockOpenAt
    : undefined;
const writingIndex = events.findIndex((event) => event.eventType === "tool.writing");
const toolRowIndex = events.findIndex((event) => event.eventType === "tool.started");
const whileWriting = buildThreadRunProjection({
  threadId: THREAD_ID,
  status: "running",
  attempts: [],
  agents: [],
  events: events.slice(0, writingIndex + 1),
});
const settled = buildThreadRunProjection({
  threadId: THREAD_ID,
  status: "running",
  attempts: [],
  agents: [],
  events: events.slice(0, toolRowIndex + 1),
});
// The desktop Feed does not read the full projection: main derives request spans from the V2
// provider event index at read time (`getConversationV2ProjectionExtras`) and the renderer folds
// them in. Asserting only on `buildThreadRunProjection` is what previously hid the fact that the
// live path never received the state at all.
const liveSpans = buildThreadRunProjectionRequestSpans({
  events: events.slice(0, writingIndex + 1),
  threadStatus: "running",
  agents: [],
  historyComplete: true,
});
const writingIndicator = resolveToolWritingIndicator(liveSpans);
// …and again once the arguments have named the file, which is the state the user actually
// stares at for the seconds it takes a 200-line Write to stream.
const namedWritingIndex = events.findLastIndex((event) => event.eventType === "tool.writing");
const namedSpans = buildThreadRunProjectionRequestSpans({
  events: events.slice(0, namedWritingIndex + 1),
  threadStatus: "running",
  agents: [],
  historyComplete: true,
});
const namedIndicator = resolveToolWritingIndicator(namedSpans);
// The full projection is the replay/differential read path; main's read-time span derivation
// and the Feed's read path are the same function, so both must agree.
const projectionIndicator = resolveToolWritingIndicator(whileWriting.requestSpans);

console.log("\n--- verdict ---");
check(
  "upstream kept the tool call open while writing its arguments",
  Boolean(windowMs && windowMs > 200 && argFragments > 1),
  { windowMs, argFragments },
);
check(
  "the tool call started after the last visible text",
  typeof lastTextAt === "number" && typeof toolBlockOpenAt === "number" && toolBlockOpenAt >= lastTextAt,
  { lastTextAt, toolBlockOpenAt },
);
check(
  "Eco emitted the writing activity, and no more than the write and its target",
  writingEvents.length >= 1 && writingEvents.length <= 2,
  { activities: observed.map((entry) => entry.liveType) },
);
check("tool.writing names the tool", writingEvents[0]?.message === TOOL_NAME, writingEvents[0]?.message);
const lastWriting = writingEvents[writingEvents.length - 1];
const lastWritingMetadata = lastWriting?.metadata?.toolWriting as
  | { name?: string; kind?: string; target?: string }
  | undefined;
check(
  "the first fact says the type of thing being written",
  writingEvents[0]?.metadata?.toolWriting?.kind !== undefined,
  {
    metadata: writingEvents[0]?.metadata?.toolWriting,
  },
);
check(
  "the arguments then name the file being written",
  Boolean(lastWritingMetadata?.target),
  lastWritingMetadata,
);
check(
  "tool.writing is persisted but never becomes a Feed row",
  !projection.timeline.some((item) => item.eventType === "tool.writing"),
  { timeline: projection.timeline.map((item) => item.eventType) },
);
check(
  "the live span derivation main hands the renderer carries the writing state",
  Boolean(writingIndicator),
  writingIndicator,
);
check(
  "the replay projection carries the same writing state",
  projectionIndicator?.name === writingIndicator?.name,
  { projectionIndicator, writingIndicator },
);
const namedLabel = namedIndicator ? resolveToolWritingLabel(namedIndicator) : null;
check(
  "the target survives the whole pipeline and becomes the Feed label",
  Boolean(namedIndicator?.target) &&
    namedLabel?.key === "activity.writingFileTarget" &&
    namedLabel?.params.target === namedIndicator?.target,
  { indicator: namedIndicator, label: namedLabel },
);
check("the writing state is on the request that wrote the call", writingIndicator?.requestId === REQUEST_ID, {
  requestId: writingIndicator?.requestId,
  expected: REQUEST_ID,
});
check(
  "tool facts stay unkeyed, exactly as the live app writes them",
  events.filter((event) => event.role === "tool").every((event) => !event.requestId),
  {
    toolEvents: events.filter((event) => event.role === "tool").map((event) => event.eventType),
  },
);
check(
  "the writing state arrived before the real tool row",
  writingIndex >= 0 && toolRowIndex > writingIndex,
  { writingIndex, toolRowIndex },
);
check(
  "the writing state is dropped once the tool row lands",
  !resolveToolWritingIndicator(settled.requestSpans),
);

console.log(
  failures.length === 0
    ? '\nSMOKE OK — the Feed can name "writing a tool call" on this endpoint.\n'
    : `\nSMOKE FAILED — ${failures.length} check(s): ${failures.join("; ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
