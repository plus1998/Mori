import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MoriAssistantSnapshot } from "../shared/mori-assistant";
import { MoriWechatTyping } from "./mori-assistant-wechat-typing";

const BASE = "https://ilinkai.weixin.qq.com";
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
interface WechatMessage {
  id: string;
  userId: string;
  contextToken: string;
  text: string;
  status: "queued" | "running" | "done" | "failed";
  error?: string;
}
interface WechatOutbox {
  id: string;
  userId: string;
  contextToken: string;
  text: string;
  error?: string;
}
interface WechatState {
  token?: string;
  baseUrl?: string;
  userId?: string;
  cursor: string;
  inbox: WechatMessage[];
  outbox: WechatOutbox[];
}

export function validateWechatBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "ilinkai.weixin.qq.com" && !url.hostname.endsWith(".weixin.qq.com")) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("微信返回了不受信任的服务器地址。");
  return url.origin;
}

export function parseWechatJson(raw: string): Record<string, unknown> {
  // Message IDs are opaque integers and can exceed Number.MAX_SAFE_INTEGER.
  const value = JSON.parse(
    raw.replace(/("(?:message_id|msg_id|svr_id)"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"'),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("微信返回了无效的响应。");
  return value;
}

export class MoriAssistantWechat {
  private state: WechatState = { cursor: "", inbox: [], outbox: [] };
  private writes: Promise<void> = Promise.resolve();
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private draining = false;
  private enabled = false;
  private generation = 0;
  private drainWork: Promise<void> | undefined;
  private binding: AbortController | undefined;
  private typing: MoriWechatTyping | undefined;
  private waitingForInput = false;
  private feedbackError: string | undefined;
  status: MoriAssistantSnapshot["wechat"] = { status: "disconnected" };
  constructor(
    private readonly file: string,
    private readonly deps: {
      changed(): void;
      receive(text: string, id: string): Promise<string>;
      respondIfPending?(text: string): Promise<boolean>;
    },
  ) {}

  async load(): Promise<void> {
    try {
      const state = JSON.parse(await fs.readFile(this.file, "utf8")) as WechatState;
      if (!Array.isArray(state.inbox) || !Array.isArray(state.outbox) || typeof state.cursor !== "string")
        throw new Error("微信连接状态文件无效，原文件已保留。");
      if (state.baseUrl) validateWechatBaseUrl(state.baseUrl);
      this.state = state;
      for (const message of this.state.inbox)
        if (message.status === "running") {
          message.status = "failed";
          message.error = "应用退出中断了处理；为避免重复执行任务，请重新发送指令。";
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private save(): Promise<void> {
    const content = JSON.stringify(this.state);
    const work = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, content, { mode: 0o600 });
        await fs.rename(temp, this.file);
      } finally {
        await fs.rm(temp, { force: true });
      }
    });
    this.writes = work.catch(() => {});
    return work;
  }

  private update(status: MoriAssistantSnapshot["wechat"]): void {
    this.status = { ...status };
    delete this.status.feedbackError;
    if (this.feedbackError) this.status.feedbackError = this.feedbackError;
    this.deps.changed();
  }

  private async api(
    endpoint: string,
    body?: unknown,
    signal?: AbortSignal,
    login = false,
    loginBase = BASE,
    timeoutMs = 45_000,
    connection: Pick<WechatState, "token" | "baseUrl"> = this.state,
  ): Promise<Record<string, unknown>> {
    const uint = randomBytes(4).readUInt32BE(0).toString();
    const response = await fetch(`${login ? loginBase : (connection.baseUrl ?? BASE)}${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(uint).toString("base64"),
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String(0x00020408),
        ...(!login && connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`微信请求失败（HTTP ${response.status}）。`);
    const value = parseWechatJson(await response.text());
    if (
      (value.ret !== undefined && typeof value.ret !== "number") ||
      (value.errcode !== undefined && typeof value.errcode !== "number")
    )
      throw new Error("微信返回了无效的状态码。");
    if (
      (typeof value.ret === "number" && value.ret !== 0) ||
      (typeof value.errcode === "number" && value.errcode !== 0)
    )
      throw new Error(
        `微信返回错误 ${value.ret || value.errcode}：${typeof value.errmsg === "string" ? value.errmsg : "请求未成功"}`,
      );
    return value;
  }

  async bind(): Promise<void> {
    this.binding?.abort();
    const binding = new AbortController();
    this.binding = binding;
    const result = await this.api(
      "/ilink/bot/get_bot_qrcode?bot_type=3",
      { local_token_list: [] },
      binding.signal,
      true,
    );
    if (typeof result.qrcode !== "string" || typeof result.qrcode_img_content !== "string")
      throw new Error("微信未返回有效二维码。");
    this.update({ status: "waiting", qrContent: result.qrcode_img_content });
    void this.waitForLogin(result.qrcode, binding).catch((error) => {
      if (!binding.signal.aborted)
        this.update({ status: "error", error: error instanceof Error ? error.message : String(error) });
    });
  }

  private async waitForLogin(qrcode: string, binding: AbortController): Promise<void> {
    const deadline = Date.now() + 180_000;
    let loginBase = BASE;
    while (!binding.signal.aborted && Date.now() < deadline) {
      const result = await this.api(
        `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        undefined,
        binding.signal,
        true,
        loginBase,
      );
      if (result.status === "confirmed") {
        if (typeof result.bot_token !== "string" || typeof result.ilink_user_id !== "string")
          throw new Error("扫码成功但微信登录凭据不完整。");
        this.controller?.abort();
        await this.loop;
        await this.stopTyping();
        this.feedbackError = undefined;
        this.generation += 1;
        this.state = {
          token: result.bot_token,
          userId: result.ilink_user_id,
          baseUrl: validateWechatBaseUrl(typeof result.baseurl === "string" ? result.baseurl : loginBase),
          cursor: "",
          inbox: [],
          outbox: [],
        };
        await this.save();
        this.update({ status: "connected" });
        if (this.enabled) this.start();
        return;
      }
      if (result.status === "expired") throw new Error("二维码已过期，请重新生成。");
      if (result.status === "need_verifycode")
        throw new Error("微信要求输入验证码，第一版暂不支持此验证方式，请重新扫码。");
      if (result.status === "scaned_but_redirect" || result.status === "binded_redirect") {
        if (typeof result.redirect_host !== "string" || !result.redirect_host)
          throw new Error("微信登录重定向缺少目标地址。");
        loginBase = validateWechatBaseUrl(
          result.redirect_host.startsWith("https://")
            ? result.redirect_host
            : `https://${result.redirect_host}`,
        );
      }
      await pause(1000, binding.signal);
    }
    if (!binding.signal.aborted) throw new Error("二维码等待超时，请重新生成。");
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (enabled && this.state.token) this.start();
    else if (!enabled) {
      await this.stopTyping();
      this.controller?.abort();
      await this.loop;
      this.update({ status: "disconnected" });
    }
  }

  setWaitingForInput(waiting: boolean): void {
    this.waitingForInput = waiting;
    this.typing?.setWaiting(waiting);
  }

  private async stopTyping(): Promise<void> {
    const typing = this.typing;
    this.typing = undefined;
    await typing?.stop();
  }

  private start(): void {
    if (this.loop) return;
    const controller = new AbortController();
    this.controller = controller;
    this.loop = this.poll(controller).finally(() => {
      this.loop = undefined;
    });
    void this.loop.catch((error) =>
      this.update({ status: "error", error: error instanceof Error ? error.message : String(error) }),
    );
  }

  private async poll(controller: AbortController): Promise<void> {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const data = await this.api(
          "/ilink/bot/getupdates",
          {
            get_updates_buf: this.state.cursor,
            base_info: { channel_version: "2.4.8", bot_agent: "Mori/1" },
          },
          controller.signal,
        );
        // iLink may omit the zero-valued ret field, including on successful polls.
        if (
          (data.msgs !== undefined && !Array.isArray(data.msgs)) ||
          (data.get_updates_buf !== undefined && typeof data.get_updates_buf !== "string") ||
          (data.ret === undefined && !Array.isArray(data.msgs) && typeof data.get_updates_buf !== "string")
        )
          throw new Error("微信返回了无效的消息拉取结果。");
        const msgs = Array.isArray(data.msgs) ? data.msgs : [];
        for (const raw of msgs) {
          const msg = raw as {
            message_id?: string | number;
            msg_id?: string | number;
            from_user_id?: string;
            context_token?: string;
            item_list?: Array<{
              type: number;
              text_item?: { text?: string };
              voice_item?: { text?: string };
            }>;
          };
          const messageId = msg.message_id ?? msg.msg_id;
          if (
            !msg.from_user_id ||
            msg.from_user_id !== this.state.userId ||
            !msg.context_token ||
            messageId === undefined
          )
            continue;
          const id = String(messageId);
          if (this.state.inbox.some((item) => item.id === id)) continue;
          const text = (msg.item_list ?? [])
            .map((item) => item.text_item?.text ?? item.voice_item?.text ?? "")
            .filter(Boolean)
            .join("\n");
          this.state.inbox.push({
            id,
            userId: msg.from_user_id,
            contextToken: msg.context_token,
            text: text || "[此消息没有可处理的文字]",
            status: "queued",
          });
        }
        if (typeof data.get_updates_buf === "string" && data.get_updates_buf)
          this.state.cursor = data.get_updates_buf;
        await this.save(); // Cursor and inbound queue are committed together before processing.
        if (this.draining && this.deps.respondIfPending) {
          for (const message of this.state.inbox) {
            if (message.status !== "queued") continue;
            if (await this.deps.respondIfPending(message.text)) {
              message.status = "done";
              await this.save();
              break;
            }
          }
        }
        this.update({ status: "connected" });
        failures = 0;
        this.drainWork ??= this.drain().finally(() => {
          this.drainWork = undefined;
        });
        await this.flushOutbox();
      } catch (error) {
        if (controller.signal.aborted) break;
        this.update({ status: "error", error: error instanceof Error ? error.message : String(error) });
        failures += 1;
        await pause(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), controller.signal);
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const generation = this.generation;
    try {
      for (const message of this.state.inbox) {
        if (message.status !== "queued" || !this.enabled) continue;
        message.status = "running";
        await this.save();
        if (generation !== this.generation) return;
        const connection = this.state;
        const typing =
          this.enabled && message.text !== "[此消息没有可处理的文字]"
            ? new MoriWechatTyping({
                userId: message.userId,
                contextToken: message.contextToken,
                request: (endpoint, body, signal, timeoutMs) =>
                  this.api(endpoint, body, signal, false, BASE, timeoutMs, connection),
                report: (error) => {
                  if (generation !== this.generation) return;
                  this.feedbackError = error;
                  this.update(this.status);
                },
              })
            : undefined;
        this.typing = typing;
        typing?.setWaiting(this.waitingForInput);
        let cleanup: Promise<void> | undefined;
        try {
          const reply =
            message.text === "[此消息没有可处理的文字]"
              ? "第一版支持文字和微信已转写的语音，请发送文字说明任务。"
              : await this.deps.receive(message.text, message.id);
          cleanup = typing?.stop();
          if (generation !== this.generation) return;
          if (!reply.trim()) throw new Error("助手没有生成可发送的文字回复，请在桌面端检查任务状态。");
          this.state.outbox.push({
            id: `mori-${message.id}`,
            userId: message.userId,
            contextToken: message.contextToken,
            text: reply,
          });
          message.status = "done";
        } catch (error) {
          cleanup = typing?.stop();
          if (generation !== this.generation) return;
          message.status = "failed";
          message.error = error instanceof Error ? error.message : String(error);
          this.state.outbox.push({
            id: `mori-error-${message.id}`,
            userId: message.userId,
            contextToken: message.contextToken,
            text: `Mori 处理未完成：${message.error}`,
          });
        } finally {
          // Stop renewal immediately, but never hold the reply behind presence cleanup.
          cleanup ??= typing?.stop();
          void cleanup?.then(() => {
            if (this.typing === typing) this.typing = undefined;
          });
        }
        await this.save();
        await this.flushOutbox();
        // A previous cancel must not clear the next message's typing state.
        await cleanup;
      }
    } catch (error) {
      this.update({ status: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.draining = false;
    }
  }

  private sending = false;
  private async flushOutbox(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.state.outbox.length && this.enabled && this.state.token) {
        const message = this.state.outbox[0];
        if (!message) break;
        await this.api("/ilink/bot/sendmessage", {
          msg: {
            from_user_id: "",
            to_user_id: message.userId,
            client_id: message.id,
            message_type: 2,
            message_state: 2,
            context_token: message.contextToken,
            item_list: [{ type: 1, text_item: { text: message.text } }],
          },
          base_info: { channel_version: "2.4.8", bot_agent: "Mori/1" },
        });
        this.state.outbox.shift();
        await this.save();
      }
    } catch (error) {
      this.update({
        status: "error",
        error: `微信结果发送失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.sending = false;
    }
  }

  async disconnect(): Promise<void> {
    this.binding?.abort();
    this.generation += 1;
    await this.setEnabled(false);
    this.state = { cursor: "", inbox: [], outbox: [] };
    this.feedbackError = undefined;
    this.update({ status: "disconnected" });
    await this.save();
  }

  get canNotify(): boolean {
    return Boolean(this.state.token && this.state.inbox.length && this.enabled);
  }

  async enqueueNotification(text: string, messageId: string | undefined, id: string): Promise<void> {
    const original = messageId
      ? this.state.inbox.find((item) => item.id === messageId)
      : this.state.inbox.at(-1);
    if (!original || !this.state.token) throw new Error("没有可回复的微信会话，请先从微信向 Mori 发消息。");
    const latest = this.state.inbox.findLast((item) => item.userId === original.userId) ?? original;
    if (!this.state.outbox.some((item) => item.id === id))
      this.state.outbox.push({ id, userId: original.userId, contextToken: latest.contextToken, text });
    await this.save();
    await this.flushOutbox();
  }

  async close(): Promise<void> {
    this.binding?.abort();
    await this.setEnabled(false);
    await this.drainWork;
    await this.writes;
  }
}
