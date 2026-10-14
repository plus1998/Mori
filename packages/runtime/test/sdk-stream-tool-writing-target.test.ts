import { expect, test } from "bun:test";
import { mapSdkMessageToEvents } from "../src/claude-agent-sdk";
import { createSdkStreamContext } from "../src/sdk-stream-events";

type Ctx = ReturnType<typeof createSdkStreamContext>;

/**
 * The SDK mapper answers a stream_event it does not turn into a fact with a raw
 * `message.delta` carrying the event, so these helpers look at the tool rows only.
 */
function toolStarted(events: ReturnType<typeof mapSdkMessageToEvents>) {
  return events
    .filter((event) => event.type === "tool.started")
    .map((event) => event.payload as Record<string, unknown>);
}

function startOf(ctx: Ctx, name: string, id: string) {
  return toolStarted(
    mapSdkMessageToEvents(
      {
        type: "stream_event",
        uuid: `u_start_${id}`,
        session_id: "sess",
        event: { type: "content_block_start", content_block: { type: "tool_use", name, id } },
      },
      "thr_1",
      ctx,
    ),
  );
}

function delta(ctx: Ctx, partialJson: string) {
  return toolStarted(
    mapSdkMessageToEvents(
      {
        type: "stream_event",
        uuid: `u_delta_${partialJson.length}`,
        session_id: "sess",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: partialJson },
        },
      },
      "thr_1",
      ctx,
    ),
  );
}

test("the arguments name the file while they are still being written", () => {
  // A Write call streams its arguments for seconds. The first fragment that closes the path
  // lets the Feed say which file, instead of only that a file is being written.
  const ctx = createSdkStreamContext();
  const started = startOf(ctx, "Write", "toolu_w");
  expect(started).toHaveLength(1);
  expect(started[0]?.tool_input_target).toBeUndefined();

  expect(delta(ctx, '{"file_path":"/tmp/eco')).toEqual([]);
  const named = delta(ctx, '.md","content":"hi"}');
  expect(named).toHaveLength(1);
  expect(named[0]?.tool_input_target).toBe("/tmp/eco.md");
  expect(named[0]?.streaming).toBe(true);
  expect(named[0]?.input_complete).toBeUndefined();
  expect(named[0]?.tool_name).toBe("Write");
});

test("a target is announced once, not once per fragment", () => {
  const ctx = createSdkStreamContext();
  startOf(ctx, "Bash", "toolu_b");
  const first = delta(ctx, '{"command":"wc -l /tmp/eco.md"');
  expect(first).toHaveLength(1);
  expect(first[0]?.tool_input_target).toBe("wc -l /tmp/eco.md");
  // The rest of the arguments stream on for a while; none of it re-announces the same target.
  expect(delta(ctx, ',"description":"count"')).toEqual([]);
  expect(delta(ctx, "}")).toEqual([]);
});

test("the next call is announced on its own account", () => {
  const ctx = createSdkStreamContext();
  startOf(ctx, "Write", "toolu_1");
  expect(delta(ctx, '{"file_path":"/tmp/a.md"}')).toHaveLength(1);
  mapSdkMessageToEvents(
    {
      type: "stream_event",
      uuid: "u_stop",
      session_id: "sess",
      event: { type: "content_block_stop" },
    },
    "thr_1",
    ctx,
  );
  startOf(ctx, "Write", "toolu_2");
  const second = delta(ctx, '{"file_path":"/tmp/b.md"}');
  expect(second).toHaveLength(1);
  expect(second[0]?.tool_input_target).toBe("/tmp/b.md");
});

test("arguments that name nothing say nothing", () => {
  const ctx = createSdkStreamContext();
  startOf(ctx, "mcp__eco_plan__finalize_plan", "toolu_plan");
  // A tool whose arguments have no path or command gets the plain placeholder and no more.
  expect(delta(ctx, '{"analysis":"done"')).toEqual([]);
  expect(delta(ctx, ',"plan":"ship it"}')).toEqual([]);
});
