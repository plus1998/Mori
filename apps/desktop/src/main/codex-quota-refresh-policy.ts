import { CODEX_QUOTA_REFRESH_MS, hasUnrefreshedCodexQuotaReset } from "../shared/codex-quota-refresh";
import type { OpenAIAccountQuota, OpenAIAccountQuotaRefreshState } from "../shared/openai-account";
import { isCodexReauthenticationRequired } from "./codex-reauthentication";

export type QuotaRefreshReason = "manual" | "usage" | "switch" | "reset";
interface RefreshState extends OpenAIAccountQuotaRefreshState {
  failures: number;
  credentials: string;
  upstreamRetryAt: number;
}

/** Per-account policy shared by every UI and background entry point. No timers or network here. */
export class CodexQuotaRefreshPolicy {
  private readonly states = new Map<string, RefreshState>();

  constructor(private readonly now: () => number = Date.now) {}

  state(accountId: string, credentials: string): OpenAIAccountQuotaRefreshState | undefined {
    const state = this.states.get(accountId);
    if (!state || state.credentials !== credentials) return undefined;
    const { attemptedAt, retryAt, error, authRequired } = state;
    return {
      attemptedAt,
      ...(retryAt ? { retryAt } : {}),
      ...(error ? { error } : {}),
      ...(authRequired ? { authRequired } : {}),
    };
  }

  check(
    accountId: string,
    credentials: string,
    quota: OpenAIAccountQuota | undefined,
    reason: QuotaRefreshReason,
  ): "query" | "cached" | "skip" {
    const state = this.states.get(accountId);
    const current = state?.credentials === credentials ? state : undefined;
    const now = this.now();
    if (reason === "reset" && (!quota || !hasUnrefreshedCodexQuotaReset(quota, now))) return "skip";
    if (reason !== "manual" && reason !== "reset" && quota && now - quota.fetchedAt < CODEX_QUOTA_REFRESH_MS)
      return "cached";
    if (current && current.upstreamRetryAt > now) throw new Error(current.error || "额度服务要求稍后重试。");
    if (reason !== "manual" && current) {
      if (current.authRequired || (current.retryAt ?? 0) > now)
        throw new Error(current.error || "额度自动刷新冷却中，请稍后重试。");
      if (now - current.attemptedAt < CODEX_QUOTA_REFRESH_MS) return "skip";
    }
    if (reason === "reset" && quota && now - quota.fetchedAt < CODEX_QUOTA_REFRESH_MS) return "skip";
    return "query";
  }

  begin(accountId: string, credentials: string): void {
    const previous = this.states.get(accountId);
    this.states.set(accountId, {
      credentials,
      attemptedAt: this.now(),
      failures: previous?.credentials === credentials ? previous.failures : 0,
      upstreamRetryAt: 0,
    });
  }

  succeed(accountId: string, credentials: string): void {
    this.states.set(accountId, { credentials, attemptedAt: this.now(), failures: 0, upstreamRetryAt: 0 });
  }

  fail(accountId: string, credentials: string, error: unknown, displayMessage?: string): void {
    const previous = this.states.get(accountId);
    const failures = (previous?.credentials === credentials ? previous.failures : 0) + 1;
    const now = this.now();
    const message = displayMessage ?? (error instanceof Error ? error.message : String(error));
    const authRequired = isCodexReauthenticationRequired(error);
    const upstreamRetryAt = readQuotaRetryAt(error, now);
    const delay = (failures === 1 ? 5 : failures === 2 ? 15 : 30) * 60_000;
    this.states.set(accountId, {
      credentials,
      failures,
      attemptedAt: now,
      error: message,
      authRequired,
      upstreamRetryAt,
      retryAt: Math.max(now + delay, upstreamRetryAt),
    });
  }

  forget(accountId: string): void {
    this.states.delete(accountId);
  }
}

/** Honor explicit upstream Retry-After when the transport exposes it. */
export function readQuotaRetryAt(error: unknown, now: number): number {
  if (!error || typeof error !== "object") return 0;
  const record = error as {
    data?: { retryAfter?: unknown; retry_after?: unknown; headers?: Record<string, unknown> };
    message?: string;
  };
  const raw =
    record.data?.headers?.["retry-after"] ??
    record.data?.retryAfter ??
    record.data?.retry_after ??
    record.message?.match(/retry[- ]after\s*[:=]\s*(\d+(?:\.\d+)?)/iu)?.[1];
  if (typeof raw !== "string" && typeof raw !== "number") return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1_000;
  const date = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(date) ? Math.max(now, date) : 0;
}
