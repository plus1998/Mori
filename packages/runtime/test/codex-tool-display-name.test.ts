import { expect, test } from "bun:test";
import { CodexEventAdapter, type CodexThreadRunEventInput } from "../src/codex-event-adapter.js";
import { codexToolDisplayName } from "../src/codex-tool-display-name.js";

const ECO_THREAD = "thr_tool_write_eco";
const CODEX_THREAD = "thr_tool_write_codex";

test("the announced name matches the card Codex opens for that call", () => {
  // `apply_patch` is the only custom tool Codex sends, and its app-server turns the call into a
  // `fileChange` item. The writing label must name that card, not the wire function.
  const events: CodexThreadRunEventInput[] = [];
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: (id) => (id === CODEX_THREAD ? ECO_THREAD : id),
    recordThreadRunEvent: (event) => events.push(event),
  });
  adapter.dispatch("item/started", {
    threadId: CODEX_THREAD,
    turnId: "turn_1",
    item: { id: "call_1", type: "fileChange", changes: [{ path: "/tmp/eco.md" }] },
  });

  const cardName = events.find((event) => event.eventType === "tool.started")?.metadata?.tool;
  expect((cardName as { name?: string } | undefined)?.name).toBe("Edit");
  expect(codexToolDisplayName("apply_patch")).toBe(cardName && (cardName as { name: string }).name);
});

test("a name Codex never sends is shown as it is, not guessed at", () => {
  expect(codexToolDisplayName("mcp__eco_mcp__search_tools")).toBe("mcp__eco_mcp__search_tools");
  expect(codexToolDisplayName("some_future_tool")).toBe("some_future_tool");
  expect(codexToolDisplayName("  shell  ")).toBe("Bash");
});
