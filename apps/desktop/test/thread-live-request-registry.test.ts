import { expect, test } from "bun:test";
import { resolveLiveRequestIdForEvent } from "../src/main/thread-live-request-coordinator";
import { ThreadLiveRequestRegistry } from "../src/main/thread-live-request-registry";

test("beginRequest returns immutable snapshot that matches the registry entry", () => {
  const registry = new ThreadLiveRequestRegistry();
  const begun = registry.beginRequest("thr_1", {
    role: "coder",
    agentId: "agent_a",
    emitTimelineActivity: false,
  });

  expect(begun.role).toBe("coder");
  expect(begun.agentId).toBe("agent_a");
  expect(begun.emitTimelineActivity).toBe(false);
  expect(begun.requestId).toBe(begun.logicalRequestId);

  const entry = registry.findEntryByLogicalId("thr_1", begun.logicalRequestId);
  expect(entry).toBeDefined();
  expect(entry?.logicalRequestId).toBe(begun.logicalRequestId);
  expect(entry?.role).toBe(begun.role);
  expect(entry?.agentId).toBe(begun.agentId);
  expect(entry?.emitTimelineActivity).toBe(begun.emitTimelineActivity);
});

test("ThreadLiveRequestRegistry resolve by agentId is fail closed for duplicate agentId", () => {
  const registry = new ThreadLiveRequestRegistry();
  registry.beginRequest("thr_1", { role: "coder", agentId: "agent_a" });
  registry.beginRequest("thr_1", { role: "coder", agentId: "agent_a" });

  expect(registry.resolve("thr_1", { role: "coder", agentId: "agent_a" })).toBeUndefined();
});

test("ThreadLiveRequestRegistry resolve by agentId only when agentId is provided", () => {
  const registry = new ThreadLiveRequestRegistry();
  const requestA = registry.beginRequest("thr_1", { role: "coder", agentId: "agent_a" }).logicalRequestId;
  registry.beginRequest("thr_1", { role: "coder", agentId: "agent_b" });

  expect(registry.resolve("thr_1", { role: "coder", agentId: "agent_a" })).toBe(requestA);
  expect(registry.resolve("thr_1", { role: "coder", agentId: "agent_b" })).toMatch(/^req_/);
  expect(registry.resolve("thr_1", { role: "coder", agentId: "agent_missing" })).toBeUndefined();
});

test("ThreadLiveRequestRegistry does not resolve same-role subagents by role alone", () => {
  const registry = new ThreadLiveRequestRegistry();
  registry.beginRequest("thr_1", { role: "coder", agentId: "agent_a" });
  registry.beginRequest("thr_1", { role: "coder", agentId: "agent_b" });

  expect(registry.resolve("thr_1", { role: "coder" })).toBeUndefined();
});

test("ThreadLiveRequestRegistry does not fall back to the last active request", () => {
  const registry = new ThreadLiveRequestRegistry();
  registry.beginRequest("thr_1", { role: "coder", agentId: "agent_a" });
  const lastRequestId = registry.beginRequest("thr_1", {
    role: "reviewer",
    agentId: "agent_b",
  }).logicalRequestId;

  expect(registry.resolve("thr_1", { role: "explorer" })).toBeUndefined();
  expect(registry.resolve("thr_1", {})).toBeUndefined();
  expect(registry.resolve("thr_1", { role: "coder" })).toBeUndefined();
  expect(lastRequestId).toMatch(/^req_/);
});

test("ThreadLiveRequestRegistry resolves main-thread role scope without agentId when exactly one", () => {
  const registry = new ThreadLiveRequestRegistry();
  registry.beginRequest("thr_1", { role: "main" });
  registry.beginRequest("thr_1", { role: "coder", agentId: "agent_a" });

  expect(registry.resolve("thr_1", { role: "main" })).toMatch(/^req_/);
  expect(registry.resolve("thr_1", { role: "coder" })).toBeUndefined();
});

test("ThreadLiveRequestRegistry prefers in-flight planner when sequential tool-loop requests overlap", () => {
  const registry = new ThreadLiveRequestRegistry();
  const first = registry.beginRequest("thr_1", { role: "main" });
  const second = registry.beginRequest("thr_1", { role: "main" });

  expect(registry.resolve("thr_1", { role: "main" })).toBe(first.logicalRequestId);
  expect(first.logicalRequestId).not.toBe(second.logicalRequestId);
});

test("ThreadLiveRequestRegistry prefers newest planner once prior upstream id is recorded", () => {
  const registry = new ThreadLiveRequestRegistry();
  const first = registry.beginRequest("thr_1", { role: "main" });
  registry.recordProviderRequestIdByLogicalId("thr_1", first.logicalRequestId, "msg_first");
  const second = registry.beginRequest("thr_1", { role: "main" });

  expect(registry.resolve("thr_1", { role: "main" })).toBe(second.logicalRequestId);
});

test("ThreadLiveRequestRegistry records provider request id metadata without changing logical id", () => {
  const registry = new ThreadLiveRequestRegistry();
  const begun = registry.beginRequest("thr_1", { role: "main" });
  const recorded = registry.recordProviderRequestIdByLogicalId(
    "thr_1",
    begun.logicalRequestId,
    "msgreq_provider_123",
  );

  expect(recorded).toBe(true);
  const entry = registry.findEntryByLogicalId("thr_1", begun.logicalRequestId);
  expect(entry?.logicalRequestId).toBe(begun.logicalRequestId);
  expect(entry?.providerRequestId).toBe("msgreq_provider_123");
});

test("ThreadLiveRequestRegistry clears ended requests by logical id only", () => {
  const registry = new ThreadLiveRequestRegistry();
  const begun = registry.beginRequest("thr_1", { role: "coder", agentId: "agent_a" });
  registry.recordProviderRequestIdByLogicalId("thr_1", begun.logicalRequestId, "msgreq_provider");
  registry.endRequest("thr_1", begun.logicalRequestId);
  expect(registry.resolve("thr_1", { role: "coder", agentId: "agent_a" })).toBeUndefined();

  const begun2 = registry.beginRequest("thr_1", { role: "main" });
  registry.endRequest("thr_1", begun2.logicalRequestId);
  expect(registry.listActive("thr_1")).toHaveLength(0);
});

test("ThreadLiveRequestRegistry keeps role-only and agent-scoped coder requests separate", () => {
  const registry = new ThreadLiveRequestRegistry();
  const subagentRequestId = registry.beginRequest("thr_1", {
    role: "coder",
    agentId: "agent_a",
  }).logicalRequestId;

  const unattributedRequestId = registry.beginRequest("thr_1", { role: "coder" }).logicalRequestId;

  expect(registry.resolve("thr_1", { role: "coder", agentId: "agent_a" })).toBe(subagentRequestId);
  expect(registry.resolve("thr_1", { role: "coder" })).toBe(unattributedRequestId);
});

test("ThreadLiveRequestRegistry provider metadata on one entry does not touch concurrent entries", () => {
  const registry = new ThreadLiveRequestRegistry();
  const first = registry.beginRequest("thr_1", { role: "coder" });
  const second = registry.beginRequest("thr_1", { role: "coder" });

  registry.recordProviderRequestIdByLogicalId("thr_1", first.logicalRequestId, "provider_a");

  expect(registry.findEntryByLogicalId("thr_1", first.logicalRequestId)?.providerRequestId).toBe(
    "provider_a",
  );
  expect(registry.findEntryByLogicalId("thr_1", second.logicalRequestId)?.providerRequestId).toBeUndefined();
  expect(registry.listActive("thr_1")).toHaveLength(2);
});

test("concurrent entries with same provider request id remain independently addressable", () => {
  const registry = new ThreadLiveRequestRegistry();
  const first = registry.beginRequest("thr_1", { role: "coder" });
  const second = registry.beginRequest("thr_1", { role: "coder" });
  registry.recordProviderRequestIdByLogicalId("thr_1", first.logicalRequestId, "shared_provider");
  registry.recordProviderRequestIdByLogicalId("thr_1", second.logicalRequestId, "shared_provider");

  registry.endRequest("thr_1", first.logicalRequestId);
  expect(registry.listActive("thr_1")).toHaveLength(1);
  expect(registry.listActive("thr_1")[0]?.logicalRequestId).toBe(second.logicalRequestId);
});

test("resolveLiveRequestIdForEvent prefers in-flight planner when same-role requests overlap", () => {
  const registry = new ThreadLiveRequestRegistry();
  const first = registry.beginRequest("thr_1", { role: "main" });
  registry.beginRequest("thr_1", { role: "main" });

  expect(
    resolveLiveRequestIdForEvent(registry, "thr_1", {
      type: "message.delta",
      role: "main",
      stream: true,
    }),
  ).toBe(first.logicalRequestId);
});

test("ThreadLiveRequestRegistry listActive snapshots open requests", () => {
  const registry = new ThreadLiveRequestRegistry();
  const plannerRequest = registry.beginRequest("thr_1", { role: "main" });
  const coderRequest = registry.beginRequest("thr_1", { role: "coder", agentId: "agent_a" });

  expect(registry.listActive("thr_1").map((entry) => entry.logicalRequestId)).toEqual([
    plannerRequest.logicalRequestId,
    coderRequest.logicalRequestId,
  ]);

  registry.endRequest("thr_1", plannerRequest.logicalRequestId);
  expect(registry.listActive("thr_1")).toHaveLength(1);
  expect(registry.listActive("thr_1")[0]?.logicalRequestId).toBe(coderRequest.logicalRequestId);
});
