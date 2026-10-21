import { describe, expect, test } from "bun:test";
import { createModelAlias } from "../src/main/anthropic-proxy";
import {
  ClaudeBridgeBindingRegistry,
  globalClaudeBridgeBindingRegistry,
} from "../src/main/claude-bridge-binding";
import { decideClaudeResume, snapshotClaudeResumeRoutes } from "../src/main/claude-resume-decision";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import type { RuntimeRoleRouteConfig } from "../src/shared/ipc";
import { computeRouteFingerprint } from "../src/shared/route-fingerprint";

function provider(id: string): ProviderConfigSecret {
  return {
    id,
    name: id,
    baseUrl: "https://example.test",
    requestPath: "",
    version: "v1",
    defaultModel: "m",
    enabled: true,
    hasApiKey: true,
    apiKey: "k",
    createdAt: "",
    updatedAt: "",
  };
}

describe("Claude bridge lease / settle hardening", () => {
  test("once-style release does not underflow sibling inFlight leases", () => {
    const registry = new ClaudeBridgeBindingRegistry();
    const binding = registry.create({
      routes: [
        {
          role: "coder",
          provider: provider("p"),
          modelId: "m",
          aliasModelId: createModelAlias("coder", "p", "m"),
          apiCompat: "anthropic",
        },
      ],
    });
    expect(registry.acquire(binding)).toBe(true);
    expect(registry.acquire(binding)).toBe(true);
    expect(binding.inFlight).toBe(2);

    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      registry.release(binding);
    };
    releaseOnce();
    releaseOnce();
    expect(binding.inFlight).toBe(1);
  });

  test("trackSettle does not leave unhandled rejection when work rejects", async () => {
    const registry = new ClaudeBridgeBindingRegistry();
    const binding = registry.create({
      routes: [
        {
          role: "coder",
          provider: provider("p"),
          modelId: "m",
          aliasModelId: createModelAlias("coder", "p", "m"),
          apiCompat: "anthropic",
        },
      ],
    });
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      registry.trackSettle(binding, Promise.reject(new Error("usage failed")));
      await Bun.sleep(20);
      expect(rejections).toEqual([]);
      expect(binding.pendingSettles.size).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("close deletes binding even when usage observer rejects", async () => {
    const registry = new ClaudeBridgeBindingRegistry();
    const binding = registry.create({
      routes: [
        {
          role: "coder",
          provider: provider("p"),
          modelId: "m",
          aliasModelId: createModelAlias("coder", "p", "m"),
          apiCompat: "anthropic",
        },
      ],
    });
    registry.trackSettle(binding, Promise.reject(new Error("observer boom")));
    await registry.close(binding.bindingId);
    expect(registry.size()).toBe(0);
    expect(registry.getByBindingId(binding.bindingId)).toBeUndefined();
    expect(registry.getByCredential(binding.credential)).toBeUndefined();
  });
});

describe("resume fingerprint / apiCompat normalization", () => {
  test("apiCompat fingerprint drift still resumes (SDK always sees /messages)", () => {
    const previous = snapshotClaudeResumeRoutes([
      { role: "main", providerId: "p1", modelId: "m1", apiCompat: "anthropic" },
    ]);
    const next = snapshotClaudeResumeRoutes([
      {
        role: "main",
        providerId: "p1",
        modelId: "m1",
        apiCompat: "openai_responses",
      },
    ]);
    expect(previous.fingerprint).not.toBe(next.fingerprint);
    expect(
      decideClaudeResume({
        sessionId: "s1",
        previousRoutes: previous,
        nextRoutes: next,
        sessionCwd: "/tmp/a",
        nextCwd: "/tmp/a",
        sessionCwdExists: true,
      }),
    ).toEqual({ kind: "resume", sessionId: "s1" });
  });

  test("raw vs resolved apiCompat fingerprint mismatch does not block resume", () => {
    const rawThreadRoutes: RuntimeRoleRouteConfig[] = [{ role: "main", providerId: "p1", modelId: "m1" }];
    const resolvedRoutes: RuntimeRoleRouteConfig[] = [
      { role: "main", providerId: "p1", modelId: "m1", apiCompat: "anthropic" },
    ];
    const previous = snapshotClaudeResumeRoutes(resolvedRoutes);
    const nextRaw = snapshotClaudeResumeRoutes(rawThreadRoutes);
    expect(previous.fingerprint).not.toBe(nextRaw.fingerprint);
    expect(previous.fingerprint).toBe(computeRouteFingerprint(resolvedRoutes));
    expect(
      decideClaudeResume({
        sessionId: "s1",
        previousRoutes: previous,
        nextRoutes: nextRaw,
        sessionCwd: "/tmp/a",
        nextCwd: "/tmp/a",
        sessionCwdExists: true,
      }),
    ).toEqual({ kind: "resume", sessionId: "s1" });
  });
});

// Keep global registry clean for other files in the same process.
test("cleanup global binding registry", () => {
  globalClaudeBridgeBindingRegistry.clearAllForTests();
});
