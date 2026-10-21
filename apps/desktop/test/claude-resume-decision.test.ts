import { describe, expect, test } from "bun:test";
import { decideClaudeResume, snapshotClaudeResumeRoutes } from "../src/main/claude-resume-decision";
import type { RuntimeRoleRouteConfig } from "../src/shared/ipc";

function route(
  partial: Partial<RuntimeRoleRouteConfig> & Pick<RuntimeRoleRouteConfig, "role" | "providerId" | "modelId">,
): RuntimeRoleRouteConfig {
  return {
    role: partial.role,
    providerId: partial.providerId,
    modelId: partial.modelId,
    ...(partial.apiCompat ? { apiCompat: partial.apiCompat } : {}),
    ...(partial.thinkingEffort ? { thinkingEffort: partial.thinkingEffort } : {}),
  };
}

describe("decideClaudeResume", () => {
  const baseRoutes = snapshotClaudeResumeRoutes([
    route({ role: "main", providerId: "p1", modelId: "m1", apiCompat: "anthropic" }),
  ]);

  test("unchanged routes resume", () => {
    expect(
      decideClaudeResume({
        sessionId: "sess_1",
        previousRoutes: baseRoutes,
        nextRoutes: baseRoutes,
        sessionCwd: "/tmp/ws",
        nextCwd: "/tmp/ws",
        sessionCwdExists: true,
      }),
    ).toEqual({ kind: "resume", sessionId: "sess_1" });
  });

  test("a pending clear preserves explicit initialization intent and still validates cwd", () => {
    const input = {
      sessionId: "reset-id",
      nextRoutes: baseRoutes,
      sessionCwd: "/tmp/ws",
      nextCwd: "/tmp/ws",
      sessionCwdExists: true,
      resetPending: true,
    };
    expect(decideClaudeResume(input)).toEqual({ kind: "resume", sessionId: "reset-id", resetPending: true });
    expect(decideClaudeResume({ ...input, sessionCorrupt: true })).toMatchObject({ kind: "reject" });
    expect(decideClaudeResume({ ...input, nextCwd: "/tmp/other" })).toMatchObject({ kind: "reject" });
  });

  test("model/provider switch resumes", () => {
    const next = snapshotClaudeResumeRoutes([
      route({ role: "main", providerId: "p2", modelId: "m2", apiCompat: "anthropic" }),
    ]);
    expect(
      decideClaudeResume({
        sessionId: "sess_1",
        previousRoutes: baseRoutes,
        nextRoutes: next,
        sessionCwd: "/tmp/ws",
        nextCwd: "/tmp/ws",
        sessionCwdExists: true,
      }),
    ).toEqual({ kind: "resume", sessionId: "sess_1" });
  });

  test("apiCompat change still resumes (Gateway translates; SDK stays on /messages)", () => {
    const next = snapshotClaudeResumeRoutes([
      route({
        role: "main",
        providerId: "p1",
        modelId: "m1",
        apiCompat: "openai_responses",
      }),
    ]);
    expect(
      decideClaudeResume({
        sessionId: "sess_1",
        previousRoutes: baseRoutes,
        nextRoutes: next,
        sessionCwd: "/tmp/ws",
        nextCwd: "/tmp/ws",
        sessionCwdExists: true,
      }),
    ).toEqual({ kind: "resume", sessionId: "sess_1" });
  });

  test("cwd change rejects resume", () => {
    expect(
      decideClaudeResume({
        sessionId: "sess_1",
        previousRoutes: baseRoutes,
        nextRoutes: baseRoutes,
        sessionCwd: "/tmp/ws",
        nextCwd: "/tmp/other",
        sessionCwdExists: true,
      }),
    ).toMatchObject({ kind: "reject" });
  });

  test("missing cwd rejects resume", () => {
    expect(
      decideClaudeResume({
        sessionId: "sess_1",
        previousRoutes: baseRoutes,
        nextRoutes: baseRoutes,
        sessionCwd: "/tmp/ws",
        nextCwd: "/tmp/ws",
        sessionCwdExists: false,
      }),
    ).toMatchObject({ kind: "reject" });
  });

  test("corrupt session rejects", () => {
    expect(
      decideClaudeResume({
        sessionId: "sess_1",
        previousRoutes: baseRoutes,
        nextRoutes: baseRoutes,
        sessionCwd: "/tmp/ws",
        nextCwd: "/tmp/ws",
        sessionCwdExists: true,
        sessionCorrupt: true,
      }),
    ).toMatchObject({ kind: "reject" });
  });

  test("modelId with colon still resumes across provider drift", () => {
    const withColon = snapshotClaudeResumeRoutes([
      route({
        role: "main",
        providerId: "p1",
        modelId: "org/model:v1",
        apiCompat: "anthropic",
      }),
    ]);
    const switchedProvider = snapshotClaudeResumeRoutes([
      route({
        role: "main",
        providerId: "p2",
        modelId: "org/model:v2",
        apiCompat: "anthropic",
      }),
    ]);
    expect(
      decideClaudeResume({
        sessionId: "sess_1",
        previousRoutes: withColon,
        nextRoutes: switchedProvider,
        sessionCwd: "/tmp/ws",
        nextCwd: "/tmp/ws",
        sessionCwdExists: true,
      }),
    ).toEqual({ kind: "resume", sessionId: "sess_1" });
  });
});
