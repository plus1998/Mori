// Protocol reference: @tencent-weixin/openclaw-weixin@2.4.8,
// src/api/{api,types}.ts and src/messaging/process-message.ts.
// This is native presence, never a chat message or a durable outbox item.
interface TypingOptions {
  delayMs: number;
  intervalMs: number;
  maxDurationMs: number;
  requestTimeoutMs: number;
}

export type WechatTypingDiagnostic = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
) => void;

// Only allow structured codes into diagnostics. Upstream error text can contain credentials.
export function wechatTypingFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "TimeoutError") return "timeout";
  if (error.name === "AbortError") return "aborted";
  const http = error.message.match(/^微信请求失败（HTTP (\d+)）/);
  if (http) return `HTTP ${http[1]}`;
  const api = error.message.match(/^微信返回错误 (-?\d+)：/);
  if (api) return `微信错误 ${api[1]}`;
  if (error.message === "No typing ticket") return "missing-ticket";
  return "network-or-invalid-response";
}

const DEFAULTS: TypingOptions = {
  delayMs: 1000,
  intervalMs: 5000,
  maxDurationMs: 10 * 60_000,
  requestTimeoutMs: 3000,
};

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

export class MoriWechatTyping {
  private readonly options: TypingOptions;
  private phase: AbortController | undefined;
  private work: Promise<void> = Promise.resolve();
  private readonly deadline: ReturnType<typeof setTimeout>;
  private closed = false;
  private waiting = false;

  constructor(
    private readonly deps: {
      userId: string;
      contextToken: string;
      request(
        endpoint: string,
        body: unknown,
        signal: AbortSignal,
        timeoutMs: number,
      ): Promise<Record<string, unknown>>;
      report(message: string | undefined): void;
      diagnostic?: WechatTypingDiagnostic;
    },
    options: Partial<TypingOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    deps.diagnostic?.("created", {
      delayMs: this.options.delayMs,
      maxDurationMs: this.options.maxDurationMs,
    });
    this.deadline = setTimeout(() => {
      deps.report("本轮微信输入状态已达到 10 分钟上限并停止；任务仍可继续，请在桌面查看进度。");
      void this.stop("timeout");
    }, this.options.maxDurationMs);
    this.resume();
  }

  setWaiting(waiting: boolean): void {
    if (this.closed || this.waiting === waiting) return;
    this.waiting = waiting;
    this.deps.diagnostic?.(waiting ? "paused" : "resumed", {});
    this.phase?.abort();
    if (!waiting) this.resume();
  }

  private resume(): void {
    const phase = new AbortController();
    this.phase = phase;
    // A previous phase must finish its cancel before a resumed phase can start.
    this.work = this.work.then(() => this.run(phase.signal));
  }

  private async request(
    endpoint: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const started = Date.now();
    const stage = endpoint.endsWith("/getconfig")
      ? "getconfig"
      : (body as { status: number }).status === 1
        ? "start-or-renew"
        : "cancel";
    try {
      const result = await this.deps.request(endpoint, body, signal, this.options.requestTimeoutMs);
      this.deps.diagnostic?.("request", {
        stage,
        result: "accepted",
        elapsedMs: Date.now() - started,
        ret: typeof result.ret === "number" ? result.ret : null,
        errcode: typeof result.errcode === "number" ? result.errcode : null,
        ...(stage === "getconfig"
          ? { hasTicket: typeof result.typing_ticket === "string" && Boolean(result.typing_ticket.trim()) }
          : {}),
      });
      return result;
    } catch (error) {
      this.deps.diagnostic?.("request", {
        stage,
        result: "failed",
        elapsedMs: Date.now() - started,
        reason: wechatTypingFailure(error),
        aborted: signal.aborted,
      });
      throw error;
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let ticket: string | undefined;
    let attempted = false;
    let stage = "获取输入凭据";
    try {
      await pause(this.options.delayMs, signal);
      if (signal.aborted) return;
      const config = await this.request(
        "/ilink/bot/getconfig",
        {
          ilink_user_id: this.deps.userId,
          context_token: this.deps.contextToken,
          base_info: { channel_version: "2.4.8", bot_agent: "Mori/1" },
        },
        signal,
      );
      if (signal.aborted) return;
      if (typeof config.typing_ticket !== "string" || !config.typing_ticket.trim())
        throw new Error("No typing ticket");
      ticket = config.typing_ticket;
      stage = "启动或续期";
      while (!signal.aborted) {
        // A timed out/aborted start may have reached WeChat: always cancel it.
        attempted = true;
        const started = Date.now();
        await this.request("/ilink/bot/sendtyping", this.body(ticket, 1), signal);
        if (signal.aborted) return;
        this.deps.report(undefined);
        await pause(Math.max(0, this.options.intervalMs - (Date.now() - started)), signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.closed = true;
        clearTimeout(this.deadline);
        this.deps.report(
          `微信原生输入状态${stage}失败（${wechatTypingFailure(error)}）；本轮已停止续期，文字回复不受影响。`,
        );
      }
    } finally {
      if (ticket && attempted) {
        // Independent bounded cancellation survives disabled/disconnected polling.
        // Retry once; never persist presence or replay it after restart.
        let cancelled = false;
        for (let attempt = 0; attempt < 2 && !cancelled; attempt++) {
          try {
            await this.request("/ilink/bot/sendtyping", this.body(ticket, 2), new AbortController().signal);
            cancelled = true;
          } catch {
            // Report only after the bounded retry; never leak the ticket.
          }
        }
        if (!cancelled)
          this.deps.report("微信输入状态取消失败，已停止续期；客户端消退时间由微信决定，文字回复不受影响。");
      }
    }
  }

  private body(ticket: string, status: 1 | 2): unknown {
    return {
      ilink_user_id: this.deps.userId,
      typing_ticket: ticket,
      status,
      base_info: { channel_version: "2.4.8", bot_agent: "Mori/1" },
    };
  }

  stop(reason = "completed"): Promise<void> {
    if (!this.closed) this.deps.diagnostic?.("stopped", { reason });
    this.closed = true;
    clearTimeout(this.deadline);
    this.phase?.abort();
    return this.work;
  }
}
