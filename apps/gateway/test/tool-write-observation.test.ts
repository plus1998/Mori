import { describe, expect, test } from "bun:test";
import { GatewayToolWriteAnnouncer } from "../src/tool-write-observation";
import type { GatewayCodexTurnMetadata, GatewayToolWriteObservation } from "../src/types";

const CODEX_TURN: GatewayCodexTurnMetadata = {
  threadId: "thr_codex_1",
  turnId: "turn_1",
  requestKind: "turn",
};

function collect(turn: GatewayCodexTurnMetadata | "none" = CODEX_TURN) {
  const observed: GatewayToolWriteObservation[] = [];
  const logs: string[] = [];
  const announcer = new GatewayToolWriteAnnouncer(
    (observation) => {
      observed.push(observation);
    },
    turn === "none" ? undefined : turn,
    (message) => logs.push(message),
  );
  return { announcer, observed, logs };
}

function itemAdded(overrides: Record<string, unknown> = {}) {
  return {
    type: "response.output_item.added",
    item: { type: "custom_tool_call", name: "apply_patch", call_id: "call_1", ...overrides },
  };
}

function patchDelta(text: string, callId = "call_1") {
  return { type: "response.custom_tool_call_input.delta", call_id: callId, delta: text };
}

describe("tool write announcement", () => {
  test("the instant a tool item is added, before any argument arrives", () => {
    // Measured on the wire: the tool item is added 9ms after the last text item, while the
    // arguments that follow take 65.8s–125.3s. Anything later than this misses the window.
    const { announcer, observed } = collect();
    announcer.observeEvent(itemAdded());
    expect(observed).toHaveLength(1);
    expect(observed[0]?.codexThreadId).toBe("thr_codex_1");
    expect(observed[0]?.toolName).toBe("apply_patch");
    expect(observed[0]?.kind).toBe("file");
    expect(observed[0]?.target).toBeUndefined();
    expect(observed[0]?.turnId).toBe("turn_1");
  });

  test("the file is named as soon as the patch names it, and only once", () => {
    const { announcer, observed } = collect();
    announcer.observeEvent(itemAdded());
    announcer.observeEvent(patchDelta("*** Begin Patch\n*** Add File: /tmp/ec"));
    // Half a path is not a path: nothing is said until the path is whole.
    expect(observed).toHaveLength(1);
    announcer.observeEvent(patchDelta("o.md\n+line one\n"));
    expect(observed).toHaveLength(2);
    expect(observed[1]?.target).toBe("/tmp/eco.md");
    expect(observed[1]?.kind).toBe("file");
    expect(observed[1]?.toolName).toBe("apply_patch");
    // Further fragments do not repeat it.
    announcer.observeEvent(patchDelta("+line two\n"));
    announcer.observeEvent(patchDelta("+line three\n"));
    expect(observed).toHaveLength(2);
  });

  test("a shell call names its command when the JSON reaches it", () => {
    const { announcer, observed } = collect();
    announcer.observeEvent({
      type: "response.output_item.added",
      item: { type: "function_call", name: "shell", id: "fc_2", call_id: "call_2" },
    });
    expect(observed[0]?.kind).toBe("command");
    // The deltas name the call only by its item id — the way Codex's own stream does — so this
    // is the assertion that the fragments land on the call the start announced (`shell`, and
    // therefore kind `command`, not an anonymous call).
    announcer.observeEvent({
      type: "response.function_call_arguments.delta",
      item_id: "fc_2",
      delta: '{"command":"wc -l /tmp/eco',
    });
    expect(observed).toHaveLength(1);
    announcer.observeEvent({
      type: "response.function_call_arguments.delta",
      item_id: "fc_2",
      delta: '.md"}',
    });
    expect(observed[1]?.target).toBe("wc -l /tmp/eco.md");
    expect(observed[1]?.toolName).toBe("shell");
    expect(observed[1]?.kind).toBe("command");
  });

  test("a custom tool's input is named whenever the provider hands it over", () => {
    // lm-studio-style providers send the whole patch in one `custom_tool_call_input.delta`, so
    // there is no early fragment to read; the name still has to land on the right call.
    const { announcer, observed } = collect();
    announcer.observeEvent({
      type: "response.output_item.added",
      item: { type: "custom_tool_call", name: "apply_patch", id: "ctc_1", call_id: "call_1" },
    });
    announcer.observeEvent({
      type: "response.custom_tool_call_input.delta",
      item_id: "ctc_1",
      delta: "*** Begin Patch\n*** Add File: /tmp/eco.md\n+one\n*** End Patch\n",
    });
    expect(observed).toHaveLength(2);
    expect(observed[1]?.target).toBe("/tmp/eco.md");
    expect(observed[1]?.toolName).toBe("apply_patch");
    expect(observed[1]?.kind).toBe("file");
  });

  test("two calls in one response are told apart and announced separately", () => {
    const { announcer, observed } = collect();
    announcer.observeEvent(itemAdded({ call_id: "call_a" }));
    announcer.observeEvent(itemAdded({ call_id: "call_b" }));
    expect(observed.map((entry) => entry.callId)).toEqual(["call_a", "call_b"]);
  });

  test("a provider-side item with no tool name is still a write in progress", () => {
    // Codex reports a web search as an item with no function name. The Feed says something is
    // being built rather than showing a still timeline.
    const { announcer, observed } = collect();
    announcer.observeEvent({ type: "response.output_item.added", item: { type: "web_search_call" } });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.toolName).toBeUndefined();
    expect(observed[0]?.kind).toBe("tool");
  });

  test("non-tool items and unrelated deltas announce nothing", () => {
    const { announcer, observed } = collect();
    announcer.observeEvent({ type: "response.output_item.added", item: { type: "reasoning" } });
    announcer.observeEvent({ type: "response.output_item.added", item: { type: "message" } });
    announcer.observeEvent({
      type: "response.output_item.done",
      item: { type: "function_call", name: "shell" },
    });
    announcer.observeEvent({ type: "response.output_text.delta", delta: "hello" });
    expect(observed).toEqual([]);
  });

  test("a client that identifies no Codex thread is left alone", () => {
    // Everything else on this gateway already narrates its own tool calls; announcing here
    // would double up on that surface.
    const { announcer, observed } = collect("none");
    announcer.observeEvent(itemAdded());
    announcer.observeEvent(patchDelta("*** Add File: /tmp/eco.md\n"));
    expect(observed).toEqual([]);
  });

  test("an observer that throws is logged, never propagated into the stream", () => {
    const logs: string[] = [];
    const announcer = new GatewayToolWriteAnnouncer(
      () => {
        throw new Error("observer exploded");
      },
      CODEX_TURN,
      (message) => logs.push(message),
    );
    expect(() => announcer.observeEvent(itemAdded())).not.toThrow();
    expect(logs.some((line) => line.includes("observer exploded"))).toBe(true);
  });
});
