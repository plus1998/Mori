import { describe, expect, test } from "bun:test";
import {
  applyClaudeRunTerminal,
  resolveClaudeRunAttemptFromTerminalState,
} from "../src/main/claude-run-terminal";

describe("applyClaudeRunTerminal last-wins", () => {
  test("later turn replaces earlier terminal for the same Query", () => {
    let state = applyClaudeRunTerminal({ kind: "running" }, { status: "completed" });
    state = applyClaudeRunTerminal(state, { status: "failed", error: "turn 2" });
    expect(resolveClaudeRunAttemptFromTerminalState(state, new AbortController().signal)).toEqual({
      ok: false,
      reason: "turn 2",
    });
  });

  test("failed unstarted terminals keep the unstarted flag", () => {
    const state = applyClaudeRunTerminal(
      { kind: "running" },
      { status: "failed", error: "Error: RetriableError: [resource_exhausted] Error", unstarted: true },
    );
    expect(resolveClaudeRunAttemptFromTerminalState(state, new AbortController().signal)).toEqual({
      ok: false,
      reason: "Error: RetriableError: [resource_exhausted] Error",
      unstarted: true,
    });
  });

  test("abort signal still wins over last completed terminal", () => {
    const state = applyClaudeRunTerminal({ kind: "running" }, { status: "completed" });
    const controller = new AbortController();
    controller.abort();
    expect(resolveClaudeRunAttemptFromTerminalState(state, controller.signal)).toEqual({
      ok: false,
      reason: "cancelled by user",
      aborted: true,
    });
  });

  test("preserves an explicit abort reason for quota-driven interruption", () => {
    const state = applyClaudeRunTerminal({ kind: "running" }, { status: "completed" });
    const controller = new AbortController();
    controller.abort("ChatGPT subscription usage limit exceeded");
    expect(resolveClaudeRunAttemptFromTerminalState(state, controller.signal)).toEqual({
      ok: false,
      reason: "ChatGPT subscription usage limit exceeded",
      aborted: true,
    });
  });
});
