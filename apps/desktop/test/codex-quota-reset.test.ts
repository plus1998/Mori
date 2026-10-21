import { expect, test } from "bun:test";
import { consumeCodexQuotaReset } from "../src/main/codex-quota-reset";

test("reset uses the native Codex method and caller's key, then re-reads actual limits", async () => {
  for (const outcome of ["reset", "alreadyRedeemed", "noCredit", "nothingToReset"]) {
    const calls: { method: string; params: unknown }[] = [];
    const client = {
      async request<T>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, params });
        return (method === "account/rateLimitResetCredit/consume" ? { outcome } : {}) as T;
      },
    };
    expect(await consumeCodexQuotaReset(client, "same-logical-attempt")).toEqual({ outcome });
    expect(calls).toEqual([
      { method: "account/rateLimitResetCredit/consume", params: { idempotencyKey: "same-logical-attempt" } },
      { method: "account/rateLimits/read", params: undefined },
    ]);
  }
});

test("unknown results and failed limit refreshes are errors instead of fabricated success", async () => {
  await expect(
    consumeCodexQuotaReset({ request: async <T>() => ({ outcome: "unknown" }) as T }, "key"),
  ).rejects.toThrow("未知");
  await expect(
    consumeCodexQuotaReset(
      {
        async request<T>(method: string): Promise<T> {
          if (method === "account/rateLimits/read") throw new Error("refresh failed after reset");
          return { outcome: "reset" } as T;
        },
      },
      "retained-key",
    ),
  ).rejects.toThrow("refresh failed after reset");
});
