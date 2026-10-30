import { createHash } from "node:crypto";

const appliedThreadConfigByClient = new WeakMap<object, Map<string, string>>();

export function fingerprintCodexThreadConfig(config: Record<string, unknown>): string {
  return createHash("sha256").update(stableConfigSerialization(config)).digest("hex");
}

export function recordAppliedCodexThreadConfig(
  client: object,
  threadId: string,
  config: Record<string, unknown>,
): void {
  const byThread = appliedThreadConfigByClient.get(client) ?? new Map<string, string>();
  byThread.set(threadId.trim(), fingerprintCodexThreadConfig(config));
  appliedThreadConfigByClient.set(client, byThread);
}

export function getAppliedCodexThreadConfigFingerprint(client: object, threadId: string): string | undefined {
  return appliedThreadConfigByClient.get(client)?.get(threadId.trim());
}

export function forgetAppliedCodexThreadConfig(client: object, threadId: string): void {
  appliedThreadConfigByClient.get(client)?.delete(threadId.trim());
}

export function isCodexThreadConfigApplied(
  client: object,
  threadId: string,
  config: Record<string, unknown>,
): boolean {
  return getAppliedCodexThreadConfigFingerprint(client, threadId) === fingerprintCodexThreadConfig(config);
}

/**
 * Copy an apply-proof only when the caller has independently verified that the
 * target uses the same config. `thread/fork` does not guarantee config inheritance;
 * submit its config explicitly and record a fresh proof after validating the response.
 */
export function transferAppliedCodexThreadConfig(
  client: object,
  fromThreadId: string,
  toThreadId: string,
): boolean {
  const from = fromThreadId.trim();
  const to = toThreadId.trim();
  if (!from || !to || from === to) {
    return false;
  }
  const fingerprint = getAppliedCodexThreadConfigFingerprint(client, from);
  if (!fingerprint) {
    return false;
  }
  const byThread = appliedThreadConfigByClient.get(client) ?? new Map<string, string>();
  byThread.set(to, fingerprint);
  appliedThreadConfigByClient.set(client, byThread);
  return true;
}

function stableConfigSerialization(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableConfigSerialization).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableConfigSerialization(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
