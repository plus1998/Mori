import { expect, test } from "bun:test";
import { type AgentEvent, createAgentEvent, InMemoryEventStore } from "../../shared/src";
import type { AgentRuntimeDriver, AgentRuntimeRunInput, ThreadStartRequest } from "../src";
import { buildRoleModelMap, ThreadSupervisor } from "../src";

const request: ThreadStartRequest = {
  threadId: "thr_1",
  title: "实现路由",
  workspacePath: "/repo",
  prompt: "do work",
  routes: [
    {
      role: "main",
      primary: {
        id: "sonnet",
        provider: "anthropic",
        displayName: "Sonnet",
        baseUrl: "https://gateway.test",
        modelId: "claude-sonnet",
        capabilities: ["messages_api"],
        enabled: true,
      },
      fallbacks: [],
    },
  ],
  worktree: {
    workspacePath: "/repo",
    worktreePath: "/repo",
    branchName: "eco/thr_1",
  },
};

test("runs one worker per thread and stores emitted events", async () => {
  const store = new InMemoryEventStore();
  const driver: AgentRuntimeDriver = {
    async *run(): AsyncIterable<AgentEvent> {
      yield createAgentEvent({
        id: "evt_agent",
        threadId: "thr_1",
        agentId: "main",
        role: "main",
        type: "agent.started",
        payload: {},
      });
    },
  };

  const supervisor = new ThreadSupervisor(store, driver);
  const running = supervisor.startThread(request);

  expect(() => supervisor.startThread(request)).toThrow("already running");
  await running.done;

  expect(supervisor.isRunning("thr_1")).toBe(false);
  expect((await store.getThread("thr_1"))?.status).toBe("completed");
  expect((await store.listEvents("thr_1")).map((event) => event.id)).toContain("evt_agent");
});

test("cancels a running thread through the abort signal", async () => {
  const store = new InMemoryEventStore();
  let capturedInput: AgentRuntimeRunInput | undefined;
  const driver: AgentRuntimeDriver = {
    async *run(input): AsyncIterable<AgentEvent> {
      capturedInput = input;
      yield createAgentEvent({
        id: "evt_waiting",
        threadId: "thr_1",
        agentId: "main",
        role: "main",
        type: "agent.started",
        payload: {},
      });
    },
  };

  const supervisor = new ThreadSupervisor(store, driver);
  const running = supervisor.startThread(request);
  await running.cancel("stop");
  await running.done;

  expect(capturedInput?.signal.aborted).toBe(true);
  expect((await store.getThread("thr_1"))?.status).toBe("cancelled");
});

test("builds model map for Claude Agent SDK role prompts", () => {
  expect(buildRoleModelMap(request.routes)).toEqual({ main: "claude-sonnet" });
});
