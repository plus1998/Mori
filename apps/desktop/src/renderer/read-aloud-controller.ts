import type {
  ReadAloudEngine,
  ReadAloudReadInput,
  ReadAloudReadResult,
  ReadAloudSegmentInput,
  ReadAloudSegmentResult,
  ReadAloudStartInput,
  ReadAloudStartResult,
} from "../shared/tts";

export interface ReadAloudTransport {
  startReadAloud(input: ReadAloudStartInput): Promise<ReadAloudStartResult>;
  synthesizeReadAloudSegment(input: ReadAloudSegmentInput): Promise<ReadAloudSegmentResult>;
  readReadAloudChunk(input: ReadAloudReadInput): Promise<ReadAloudReadResult>;
  cancelReadAloud(requestId: string): Promise<void>;
}
export interface ReadAloudPlayer {
  play(bytes: Uint8Array, mimeType: string, onStarted: () => void): Promise<void>;
  speak(text: string, onStarted: () => void): Promise<void>;
  stop(): void;
}
export interface ReadAloudSnapshot {
  state: "idle" | "preparing" | "speaking" | "failed";
  engine: ReadAloudEngine;
  autoRead: boolean;
  threadId?: string;
  entryId?: string;
  error?: string;
}

export class ReadAloudController {
  private snapshot: ReadAloudSnapshot;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private requestId: string | undefined;
  constructor(
    private readonly transport: () => ReadAloudTransport,
    private readonly player: ReadAloudPlayer,
    initial: { engine?: ReadAloudEngine; autoRead?: boolean } = {},
  ) {
    this.snapshot = {
      state: "idle",
      engine: initial.engine ?? "online",
      autoRead: initial.autoRead ?? false,
    };
  }
  getSnapshot = (): ReadAloudSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  setEngine(engine: ReadAloudEngine): void {
    this.stop();
    this.update({ engine });
  }
  setAutoRead(autoRead: boolean): void {
    if (!autoRead) this.stop();
    this.update({ autoRead });
  }
  stop(): void {
    ++this.generation;
    this.player.stop();
    const requestId = this.requestId;
    this.requestId = undefined;
    if (requestId)
      void this.transport()
        .cancelReadAloud(requestId)
        .catch(() => {
          /* Already stopped locally; server tasks also expire. */
        });
    this.snapshot = { state: "idle", engine: this.snapshot.engine, autoRead: this.snapshot.autoRead };
    this.emit();
  }
  async speak(threadId: string, entryId: string, sourceText: string): Promise<void> {
    this.stop();
    const generation = this.generation;
    const active = () => this.generation === generation;
    const ensureActive = () => {
      if (!active()) throw new Error("朗读已停止。");
    };
    const onStarted = () => {
      if (active()) this.update({ state: "speaking" });
    };
    this.update({ state: "preparing", threadId, entryId });
    try {
      if (this.snapshot.engine === "system") {
        await this.player.speak(sourceText, onStarted);
      } else {
        const api = this.transport();
        const requestId = crypto.randomUUID();
        this.requestId = requestId;
        const result = await api.startReadAloud({ requestId, threadId, entryId, sourceText });
        ensureActive();
        if (
          result.requestId !== requestId ||
          !Number.isSafeInteger(result.segmentCount) ||
          result.segmentCount < 1
        )
          throw new Error("朗读任务响应无效。");
        const prepare = async (index: number) => {
          const meta = await api.synthesizeReadAloudSegment({ requestId, index });
          ensureActive();
          if (
            !Number.isSafeInteger(meta.totalBytes) ||
            meta.totalBytes < 1 ||
            meta.totalBytes > 64 * 1024 * 1024 ||
            !["audio/mpeg", "audio/wav"].includes(meta.mimeType)
          )
            throw new Error("朗读音频响应无效。");
          const bytes = new Uint8Array(meta.totalBytes);
          let offset = 0;
          while (offset < bytes.length) {
            const chunk = await api.readReadAloudChunk({
              requestId,
              index,
              offset,
              length: Math.min(65536, bytes.length - offset),
            });
            ensureActive();
            const data = Uint8Array.from(atob(chunk.dataBase64), (char) => char.charCodeAt(0));
            if (
              chunk.offset !== offset ||
              chunk.totalBytes !== bytes.length ||
              chunk.mimeType !== meta.mimeType ||
              chunk.chunkBytes !== data.length ||
              data.length < 1 ||
              data.length > Math.min(65536, bytes.length - offset)
            )
              throw new Error("朗读音频分块不完整或顺序无效。");
            bytes.set(data, offset);
            offset += data.length;
          }
          return { bytes, mimeType: meta.mimeType };
        };
        let pending = prepare(0);
        for (let index = 0; index < result.segmentCount; index++) {
          this.update({ state: "preparing" });
          const audio = await pending;
          ensureActive();
          if (index + 1 < result.segmentCount) {
            pending = prepare(index + 1);
            void pending.catch((error) => {
              if (active()) this.fail(error, threadId, entryId);
            });
          }
          await this.player.play(audio.bytes, audio.mimeType, onStarted);
          ensureActive();
        }
      }
      if (active()) this.stop();
    } catch (error) {
      if (active()) this.fail(error, threadId, entryId);
    }
  }
  private fail(error: unknown, threadId: string, entryId: string): void {
    this.stop();
    this.update({
      state: "failed",
      threadId,
      entryId,
      error:
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "")
          : String(error),
    });
  }
  private update(patch: Partial<ReadAloudSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface AutoReadCandidate {
  id: string;
  text: string;
  runId?: string;
}
/** A stopped history update alone can never trigger audio. */
export class ReadAloudAutoReadTracker {
  private threadId: string | undefined;
  private baseline: string | undefined;
  private readonly observedRuns = new Set<string>();
  observe(
    threadId: string,
    running: boolean,
    candidate: AutoReadCandidate | undefined,
    enabled: boolean,
    runningRunId?: string,
  ): AutoReadCandidate | undefined {
    if (threadId !== this.threadId || !enabled) {
      this.threadId = threadId;
      this.baseline = candidate?.id;
      this.observedRuns.clear();
      if (enabled && running && runningRunId) this.observedRuns.add(runningRunId);
      return;
    }
    if (running && runningRunId) this.observedRuns.add(runningRunId);
    if (
      candidate &&
      candidate.id !== this.baseline &&
      candidate.text.trim() &&
      candidate.runId &&
      this.observedRuns.delete(candidate.runId)
    ) {
      this.baseline = candidate.id;
      return candidate;
    }
    if (!this.observedRuns.size) this.baseline = candidate?.id;
  }
}
