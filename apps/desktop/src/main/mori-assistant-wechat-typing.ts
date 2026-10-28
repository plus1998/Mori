// Protocol reference: @tencent-weixin/openclaw-weixin@2.4.8,
// src/api/{api,types}.ts and src/messaging/process-message.ts.
// This is native presence, never a chat message or a durable outbox item.
interface TypingOptions {
  delayMs: number;
  intervalMs: number;
  maxDurationMs: number;
  requestTimeoutMs: number;
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
    },
    options: Partial<TypingOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.deadline = setTimeout(() => {
      deps.report("本轮微信输入状态已达到 10 分钟上限并停止；任务仍可继续，请在桌面查看进度。");
      void this.stop();
    }, this.options.maxDurationMs);
    this.resume();
  }

  setWaiting(waiting: boolean): void {
    if (this.closed || this.waiting === waiting) return;
    this.waiting = waiting;
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
    return this.deps.request(endpoint, body, signal, this.options.requestTimeoutMs);
  }

  private async run(signal: AbortSignal): Promise<void> {
    let ticket: string | undefined;
    let attempted = false;
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
      while (!signal.aborted) {
        // A timed out/aborted start may have reached WeChat: always cancel it.
        attempted = true;
        await this.request("/ilink/bot/sendtyping", this.body(ticket, 1), signal);
        if (signal.aborted) return;
        this.deps.report(undefined);
        await pause(this.options.intervalMs, signal);
      }
    } catch {
      if (!signal.aborted) {
        this.closed = true;
        clearTimeout(this.deadline);
        this.deps.report("微信原生输入状态暂不可用；本轮已停止续期，文字回复不受影响。");
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

  stop(): Promise<void> {
    this.closed = true;
    clearTimeout(this.deadline);
    this.phase?.abort();
    return this.work;
  }
}
