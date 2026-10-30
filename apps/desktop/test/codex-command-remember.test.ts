import { expect, test } from "bun:test";
import { ActiveRunRuntimeStateStore } from "../src/main/active-run-runtime-state";
import {
  CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL,
  type CodexApprovalBridgeDeps,
  handleCodexServerRequest,
  resolvePendingCodexBashApproval,
} from "../src/main/codex-approval-bridge";
import type { BashApprovalDecision, ThreadLiveEvent } from "../src/shared/ipc";

function fixture(mode: "always" | "auto") {
  const state = new ActiveRunRuntimeStateStore();
  const events: ThreadLiveEvent[] = [];
  let decision: BashApprovalDecision = "approved_remember_prefix";
  let reviews = 0;
  let requestId = 0;
  const deps: CodexApprovalBridgeDeps = {
    resolveEcoThreadId: (id) => id,
    getThread: () => ({ prompt: "Inspect the replay", workspacePath: "/repo" }),
    getWorktreePath: () => "/repo",
    getPlannerAgentId: () => "main",
    getRoutesJson: () => "[]",
    savePendingPlan: () => {},
    updateThreadStatus: () => {},
    getApprovalMode: () => mode,
    getBashRememberPrefixes: (id) => state.bashRememberPrefixes(id),
    rememberBashPrefix: (id, command) => state.rememberBashPrefix(id, command),
    reviewApproval: async () => {
      reviews++;
      return { action: "human_required", rationale: "SystemOne requires a human decision" };
    },
    emitThreadLive: (event) => {
      events.push(event);
      if (event.type === "bash_approval.requested" && event.bashApproval) {
        const id = event.bashApproval.toolUseId;
        queueMicrotask(() => resolvePendingCodexBashApproval(id, { decision }));
      }
    },
  };
  state.startRun("thread", { controller: new AbortController() });
  const command = "/bin/zsh -lc 'bun run cdp:snap'";
  return {
    deps,
    state,
    events,
    command,
    reviews: () => reviews,
    decide: (value: BashApprovalDecision) => {
      decision = value;
    },
    request: (input: Record<string, unknown> = {}) =>
      handleCodexServerRequest(deps, CODEX_COMMAND_EXECUTION_REQUEST_APPROVAL, {
        threadId: "thread",
        turnId: "turn",
        itemId: `remember-command-${++requestId}`,
        startedAtMs: 1,
        command,
        cwd: "/repo",
        ...input,
      }),
  };
}

for (const mode of ["always", "auto"] as const) {
  test(`Codex ${mode}: remember-prefix accepts now and skips later review only for the matching active run`, async () => {
    const f = fixture(mode);
    expect(await f.request()).toEqual({ decision: "accept" });
    expect(f.state.bashRememberPrefixes("thread")).toEqual([f.command]);
    const cards = f.events.length;
    const reviews = f.reviews();
    expect(await f.request()).toEqual({ decision: "accept" });
    expect(f.events).toHaveLength(cards);
    expect(f.reviews()).toBe(reviews);

    f.decide("denied");
    expect(await f.request({ command: "bun run cdp:click -- e12" })).toEqual({ decision: "decline" });
    expect(f.events).toHaveLength(cards + 1);
    f.state.startRun("other", { controller: new AbortController() });
    expect(await f.request({ threadId: "other" })).toEqual({ decision: "decline" });
    f.state.finishRun("thread");
    f.state.startRun("thread", { controller: new AbortController() });
    expect(await f.request()).toEqual({ decision: "decline" });
  });
}

test("one-time Codex approvals do not create remembered prefixes", async () => {
  const f = fixture("auto");
  f.decide("approved");
  expect(await f.request()).toEqual({ decision: "accept" });
  expect(await f.request()).toEqual({ decision: "accept" });
  expect(f.state.bashRememberPrefixes("thread")).toEqual([]);
  expect(f.reviews()).toBe(2);
});

test("remembered shell prefixes do not auto-approve separate network or unlabeled requests", async () => {
  const f = fixture("auto");
  f.state.rememberBashPrefix("thread", f.command);
  f.state.rememberBashPrefix("thread", "shell command");
  f.decide("denied");
  expect(await f.request({ networkApprovalContext: { host: "example.com", protocol: "https" } })).toEqual({
    decision: "decline",
  });
  expect(await f.request({ command: null })).toEqual({ decision: "decline" });
  expect(f.reviews()).toBe(2);
});
