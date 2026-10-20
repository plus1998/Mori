import { createHash } from "node:crypto";
import { markdownToSpeechText, splitSpeechText } from "../shared/speech-text";
import {
  type ReadAloudReadInput,
  type ReadAloudReadResult,
  type ReadAloudSegmentInput,
  type ReadAloudSegmentResult,
  type ReadAloudStartInput,
  type ReadAloudStartResult,
  type ReadAloudStatus,
  TtsError,
} from "../shared/tts";
import { type SynthesizedSpeech, synthesizeSpeech } from "./tts-client";
import type { TtsStore } from "./tts-store";

const CHUNK_BYTES = 64 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;
const IDLE_MS = 2 * 60_000;
const CANCELLED_MS = 10 * 60_000;
type Config = ReturnType<TtsStore["getReadAloudConfig"]>;
interface Session {
  input: ReadAloudStartInput;
  config: Config;
  texts: string[];
  controller: AbortController;
  audio: Map<number, SynthesizedSpeech>;
  pending: Map<number, Promise<ReadAloudSegmentResult>>;
  touchedAt: number;
}

/** Ephemeral reader audio is separate from the durable Agent artifact store. */
export class TtsReadAloudService {
  private readonly sessions = new Map<string, Session>();
  private readonly cancelled = new Map<string, number>();
  private readonly cache = new Map<string, SynthesizedSpeech>();
  private cacheBytes = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: Pick<TtsStore, "getReadAloudConfig"> &
      Partial<Pick<TtsStore, "getReadAloudSettings">>,
    private readonly synthesize = synthesizeSpeech,
    private readonly cacheLimit = CACHE_BYTES,
  ) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref?.();
  }

  status(): ReadAloudStatus {
    const settings = this.store.getReadAloudSettings?.();
    const profile = settings?.profiles.find((entry) => entry.id === settings.profileId);
    const summary =
      profile && settings
        ? {
            profileId: profile.id,
            profileName: profile.name,
            voice: settings.voice,
            style: settings.style,
          }
        : {};
    try {
      const { config, voice, style } = this.store.getReadAloudConfig();
      return { available: true, profileId: config.profileId, profileName: config.profileName, voice, style };
    } catch (error) {
      return { ...summary, available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  start(input: ReadAloudStartInput): ReadAloudStartResult {
    this.validateId(input?.requestId);
    if (this.cancelled.has(input.requestId)) throw new TtsError("cancelled", "朗读已停止。");
    if (
      typeof input.threadId !== "string" ||
      !input.threadId.trim() ||
      typeof input.entryId !== "string" ||
      !input.entryId.trim() ||
      typeof input.sourceText !== "string" ||
      input.sourceText.length > 1024 * 1024
    ) {
      throw new TtsError("invalid_input", "朗读正文或会话参数无效（正文上限为 1 MiB 字符）。");
    }
    const existing = this.sessions.get(input.requestId);
    if (existing) {
      if (
        existing.input.threadId !== input.threadId ||
        existing.input.entryId !== input.entryId ||
        existing.input.sourceText !== input.sourceText
      )
        throw new TtsError("invalid_input", "朗读任务 ID 已被使用。");
      existing.touchedAt = Date.now();
      return { requestId: input.requestId, segmentCount: existing.texts.length };
    }
    const text = markdownToSpeechText(input.sourceText);
    if (!text) throw new TtsError("empty_text", "正文中没有可朗读的内容。");
    this.sweep();
    if (this.sessions.size >= 128) throw new TtsError("busy", "朗读任务过多，请稍后再试。");
    const config = this.store.getReadAloudConfig();
    const texts = splitSpeechText(text);
    this.sessions.set(input.requestId, {
      input: { ...input },
      config,
      texts,
      controller: new AbortController(),
      audio: new Map(),
      pending: new Map(),
      touchedAt: Date.now(),
    });
    return { requestId: input.requestId, segmentCount: texts.length };
  }

  async segment(input: ReadAloudSegmentInput): Promise<ReadAloudSegmentResult> {
    const session = this.requireSession(input?.requestId);
    this.validateIndex(session, input.index);
    const ready = session.audio.get(input.index);
    if (ready) return this.metadata(ready);
    const pending = session.pending.get(input.index);
    if (pending) return pending;
    if (session.audio.size + session.pending.size >= 2)
      throw new TtsError("busy", "每个朗读任务最多准备两段音频。");
    const task = this.generate(session, input.index);
    session.pending.set(input.index, task);
    try {
      return await task;
    } catch (error) {
      this.cancel(input.requestId);
      throw error;
    } finally {
      session.pending.delete(input.index);
    }
  }

  read(input: ReadAloudReadInput): ReadAloudReadResult {
    const session = this.requireSession(input?.requestId);
    this.validateIndex(session, input.index);
    const audio = session.audio.get(input.index);
    if (!audio) throw new TtsError("not_ready", "该段音频尚未准备好或已读取完成。");
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset >= audio.bytes.length ||
      !Number.isSafeInteger(input.length) ||
      input.length < 1 ||
      input.length > CHUNK_BYTES
    ) {
      throw new TtsError("invalid_range", "音频读取范围无效，每次最多读取 64 KiB。");
    }
    const data = audio.bytes.subarray(input.offset, input.offset + input.length);
    const result = {
      ...this.metadata(audio),
      offset: input.offset,
      chunkBytes: data.length,
      dataBase64: data.toString("base64"),
    };
    if (input.offset + data.length === audio.bytes.length) session.audio.delete(input.index);
    return result;
  }

  cancel(requestId: string): void {
    this.validateId(requestId);
    this.cancelled.set(requestId, Date.now());
    const session = this.sessions.get(requestId);
    session?.controller.abort();
    session?.audio.clear();
    this.sessions.delete(requestId);
  }

  close(): void {
    clearInterval(this.timer);
    for (const session of this.sessions.values()) session.controller.abort();
    this.sessions.clear();
    this.cancelled.clear();
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private async generate(session: Session, index: number): Promise<ReadAloudSegmentResult> {
    const { config, voice, style, version } = session.config;
    const text = session.texts[index];
    if (text === undefined) throw new TtsError("invalid_input", "朗读段号无效。");
    const key = createHash("sha256")
      .update(JSON.stringify([config, voice, style, version, text]))
      .digest("hex");
    let audio = this.cache.get(key);
    if (audio) {
      this.cache.delete(key);
      this.cache.set(key, audio);
    } else {
      audio = await this.synthesize({
        config,
        toolInput: { text, voice, style },
        signal: session.controller.signal,
      });
      if (session.controller.signal.aborted) throw new TtsError("cancelled", "朗读已停止。");
      if (audio.bytes.length <= this.cacheLimit) {
        // Another session may have populated this key during synthesis.
        const previous = this.cache.get(key);
        if (previous) {
          this.cacheBytes -= previous.bytes.length;
          this.cache.delete(key);
        }
        while (this.cacheBytes + audio.bytes.length > this.cacheLimit) {
          const oldest = this.cache.entries().next().value;
          if (oldest === undefined) break;
          this.cacheBytes -= oldest[1].bytes.length;
          this.cache.delete(oldest[0]);
        }
        this.cache.set(key, audio);
        this.cacheBytes += audio.bytes.length;
      }
    }
    if (session.controller.signal.aborted) throw new TtsError("cancelled", "朗读已停止。");
    session.audio.set(index, audio);
    session.touchedAt = Date.now();
    return this.metadata(audio);
  }

  private requireSession(requestId: string): Session {
    this.validateId(requestId);
    const session = this.sessions.get(requestId);
    if (!session)
      throw new TtsError(
        this.cancelled.has(requestId) ? "cancelled" : "expired",
        "朗读任务已停止或过期，请重新开始。",
      );
    session.touchedAt = Date.now();
    return session;
  }
  private validateId(value: unknown): asserts value is string {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(value))
      throw new TtsError("invalid_input", "朗读任务 ID 无效。");
  }
  private validateIndex(session: Session, index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.texts.length)
      throw new TtsError("invalid_input", "朗读段号无效。");
  }
  private metadata(audio: SynthesizedSpeech): ReadAloudSegmentResult {
    return { mimeType: audio.mimeType, totalBytes: audio.bytes.length };
  }
  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions)
      if (!session.pending.size && now - session.touchedAt > IDLE_MS) this.cancel(id);
    for (const [id, at] of this.cancelled) if (now - at > CANCELLED_MS) this.cancelled.delete(id);
  }
}
