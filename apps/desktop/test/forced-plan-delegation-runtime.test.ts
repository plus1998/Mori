import { afterEach, expect, test } from "bun:test";
import {
  armForcedPlanDelegation,
  buildForcedPlanDelegationHookConfig,
  confirmForcedPlanDelegationFromRuntimeEvent,
  confirmForcedPlanDelegationSpawn,
  forcedPlanDelegationStore,
  releaseForcedPlanDelegation,
  settleForcedPlanDelegation,
} from "../src/main/forced-plan-delegation-runtime";

const THREAD_ID = "forced-plan-runtime-test";

afterEach(() => releaseForcedPlanDelegation(THREAD_ID));

test("an Agent call rejected before SubagentStart remains armed for retry", () => {
  armForcedPlanDelegation({
    threadId: THREAD_ID,
    coreKind: "claude",
    target: { kind: "subagent", agentKey: "coder" },
    plan: "1. implement\n2. test",
  });
  const first = buildForcedPlanDelegationHookConfig(THREAD_ID);
  expect(first?.claimSpawn({ agentKey: "coder", toolUseId: "tu_rejected" })).toEqual({ ok: true });
  expect(forcedPlanDelegationStore.get(THREAD_ID)?.status).toBe("claimed");

  const settlement = settleForcedPlanDelegation(THREAD_ID, { ok: true });
  expect(settlement).toEqual({
    outcome: "failed",
    reason: "指定的子代理「coder」未能启动；已保留批准计划，可直接重试。",
  });
  expect(forcedPlanDelegationStore.get(THREAD_ID)?.status).toBe("armed");

  const retry = buildForcedPlanDelegationHookConfig(THREAD_ID);
  expect(retry?.canonicalTask).toContain("<approved_plan>\n1. implement\n2. test\n</approved_plan>");
  expect(retry?.claimSpawn({ agentKey: "eco_coder", toolUseId: "tu_retry" })).toEqual({ ok: true });
});

test("an errored Agent call before SubagentStart also remains armed", () => {
  armForcedPlanDelegation({
    threadId: THREAD_ID,
    coreKind: "claude",
    target: { kind: "subagent", agentKey: "coder" },
    plan: "implement",
  });
  buildForcedPlanDelegationHookConfig(THREAD_ID)?.claimSpawn({
    agentKey: "coder",
    toolUseId: "tu_rejected",
  });

  expect(settleForcedPlanDelegation(THREAD_ID, { ok: false, reason: "coder disabled" })).toEqual({
    outcome: "failed",
    reason: "coder disabled",
  });
  expect(forcedPlanDelegationStore.get(THREAD_ID)?.status).toBe("armed");
});

test("SubagentStart confirmation permits successful settlement", () => {
  armForcedPlanDelegation({
    threadId: THREAD_ID,
    coreKind: "claude",
    target: { kind: "subagent", agentKey: "coder" },
    plan: "implement",
  });
  const config = buildForcedPlanDelegationHookConfig(THREAD_ID);
  config?.claimSpawn({ agentKey: "coder", toolUseId: "tu_started" });
  config?.confirmSpawn?.({ agentKey: "eco_coder", toolUseIds: ["tu_started"] });

  expect(forcedPlanDelegationStore.get(THREAD_ID)?.status).toBe("spawned");
  expect(settleForcedPlanDelegation(THREAD_ID, { ok: true })).toEqual({ outcome: "completed" });
  expect(forcedPlanDelegationStore.get(THREAD_ID)).toBeUndefined();
});

test("a failed child remains failed when the parent reports the error and finishes normally", () => {
  armForcedPlanDelegation({
    threadId: THREAD_ID,
    coreKind: "pi",
    target: { kind: "subagent", agentKey: "coder" },
    plan: "printf eco_pk_subagent_ok",
  });
  confirmForcedPlanDelegationSpawn(THREAD_ID, {
    agentKey: "coder",
    toolUseIds: ["call_spawn"],
  });
  forcedPlanDelegationStore.fail(THREAD_ID, "Dynamic max output requires a resolved context window");

  expect(settleForcedPlanDelegation(THREAD_ID, { ok: true })).toEqual({
    outcome: "failed",
    reason: "Dynamic max output requires a resolved context window",
  });
  expect(forcedPlanDelegationStore.get(THREAD_ID)).toBeUndefined();
});

test("Claude SubagentStart without a parent tool id confirms the locked role", () => {
  armForcedPlanDelegation({
    threadId: THREAD_ID,
    coreKind: "claude",
    target: { kind: "subagent", agentKey: "coder" },
    plan: "implement",
  });
  const config = buildForcedPlanDelegationHookConfig(THREAD_ID);
  config?.claimSpawn({ agentKey: "coder", toolUseId: "call_spawn" });
  config?.confirmSpawn?.({ agentKey: "coder", toolUseIds: [] });

  expect(forcedPlanDelegationStore.get(THREAD_ID)?.status).toBe("spawned");
  expect(settleForcedPlanDelegation(THREAD_ID, { ok: true })).toEqual({ outcome: "completed" });
});

test("a host-observed start claims and confirms cores without SDK hooks", () => {
  armForcedPlanDelegation({
    threadId: THREAD_ID,
    coreKind: "codex",
    target: { kind: "subagent", agentKey: "coder" },
    plan: "implement",
  });

  confirmForcedPlanDelegationSpawn(THREAD_ID, {
    agentKey: "coder",
    toolUseIds: ["call_spawn"],
  });

  expect(forcedPlanDelegationStore.get(THREAD_ID)).toMatchObject({
    status: "spawned",
    spawnToolUseId: "call_spawn",
  });
});

test("only persisted started-agent events with a role and parent tool id confirm a Codex spawn", () => {
  armForcedPlanDelegation({
    threadId: THREAD_ID,
    coreKind: "codex",
    target: { kind: "subagent", agentKey: "coder" },
    plan: "implement",
  });

  confirmForcedPlanDelegationFromRuntimeEvent({
    eventType: "agent.started",
    threadId: THREAD_ID,
    role: "coder",
  });
  confirmForcedPlanDelegationFromRuntimeEvent({
    eventType: "agent.completed",
    threadId: THREAD_ID,
    role: "coder",
    parentToolUseId: "call_spawn",
  });
  confirmForcedPlanDelegationFromRuntimeEvent({
    eventType: "agent.started",
    threadId: THREAD_ID,
    role: "   ",
    parentToolUseId: "call_spawn",
  });
  expect(forcedPlanDelegationStore.get(THREAD_ID)?.status).toBe("armed");

  confirmForcedPlanDelegationFromRuntimeEvent({
    eventType: "agent.started",
    threadId: THREAD_ID,
    role: " coder ",
    parentToolUseId: " call_spawn ",
  });

  expect(forcedPlanDelegationStore.get(THREAD_ID)).toMatchObject({
    status: "spawned",
    spawnToolUseId: "call_spawn",
  });
});
