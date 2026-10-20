import { afterEach, expect, test } from "bun:test";
import { TtsReadAloudService } from "../src/main/tts-read-aloud";
import { markdownToSpeechText, splitSpeechText } from "../src/shared/speech-text";
import {
  getRemoteCommandDefinition,
  validateRemoteCommandArgs,
} from "../../../packages/shared/src/remote-command-registry";
import cases from "../../../packages/shared/test/fixtures/speech-text.json";

const services: TtsReadAloudService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});
const input = (requestId = crypto.randomUUID(), sourceText = "你好，欢迎使用。") => ({
  requestId,
  threadId: "thread-1",
  entryId: "entry-1",
  sourceText,
});
function fixture(synthesize?: ConstructorParameters<typeof TtsReadAloudService>[1], limit?: number) {
  let calls = 0;
  const settings = {
    config: {
      profileId: "profile",
      profileName: "Profile",
      provider: "gemini" as const,
      baseUrl: "https://example.test",
      model: "model",
      apiKey: "secret",
    },
    voice: "Kore",
    style: "清晰",
    version: "1",
  };
  const service = new TtsReadAloudService(
    { getReadAloudConfig: () => structuredClone(settings) },
    synthesize ??
      (async () => {
        calls++;
        return { bytes: Buffer.alloc(80_000, 42), mimeType: "audio/wav" };
      }),
    limit,
  );
  services.push(service);
  return { service, settings, calls: () => calls };
}
test("markdown cleanup shares Mobile fixtures and Unicode chunks preserve every character", () => {
  for (const { source, expected } of cases) expect(markdownToSpeechText(source)).toBe(expected);
  const text = `${"你好😀！".repeat(170)}\n${"很长的单句😀".repeat(130)}`;
  const segments = splitSpeechText(text);
  expect(segments.join("")).toBe(text);
  for (const [index, segment] of segments.entries())
    expect(Array.from(segment).length).toBeLessThanOrEqual(index === 0 ? 160 : 400);
});
test("status never exposes secrets; reads are bounded and do not create artifacts", async () => {
  const { service } = fixture();
  expect(JSON.stringify(service.status())).not.toContain("secret");
  const request = input();
  expect(service.start(request).segmentCount).toBe(1);
  expect(
    service.start({
      sourceText: request.sourceText,
      entryId: request.entryId,
      threadId: request.threadId,
      requestId: request.requestId,
    }).segmentCount,
  ).toBe(1);
  await service.segment({ requestId: request.requestId, index: 0 });
  const first = service.read({ requestId: request.requestId, index: 0, offset: 0, length: 65536 });
  expect(first.chunkBytes).toBe(65536);
  expect(() => service.read({ requestId: request.requestId, index: 0, offset: 0, length: 65537 })).toThrow(
    "范围",
  );
  const last = service.read({ requestId: request.requestId, index: 0, offset: 65536, length: 65536 });
  expect(Buffer.from(first.dataBase64, "base64").length + Buffer.from(last.dataBase64, "base64").length).toBe(
    80_000,
  );
  expect(() => service.read({ requestId: request.requestId, index: 0, offset: 80_000, length: 1 })).toThrow();
});
test("completed audio caches across sessions, invalidates with settings, and evicts by byte budget", async () => {
  const { service, settings, calls } = fixture(undefined, 80_000);
  const a = input();
  service.start(a);
  await service.segment({ requestId: a.requestId, index: 0 });
  service.cancel(a.requestId);
  const b = input();
  service.start(b);
  await service.segment({ requestId: b.requestId, index: 0 });
  expect(calls()).toBe(1);
  service.cancel(b.requestId);
  settings.version = "2";
  const c = input();
  service.start(c);
  await service.segment({ requestId: c.requestId, index: 0 });
  expect(calls()).toBe(2);
  service.cancel(c.requestId);
  settings.version = "1";
  const d = input();
  service.start(d);
  await service.segment({ requestId: d.requestId, index: 0 });
  expect(calls()).toBe(3);
});
test("sessions snapshot settings, duplicate requests coalesce and other devices survive cancellation", async () => {
  let resolve!: (audio: { bytes: Buffer; mimeType: string }) => void;
  let calls = 0;
  let voice = "";
  const { service, settings } = fixture(async (request) => {
    calls++;
    voice = request.toolInput.voice;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const a = input();
  const b = input();
  service.start(a);
  service.start(b);
  settings.voice = "new";
  const first = service.segment({ requestId: a.requestId, index: 0 });
  const duplicate = service.segment({ requestId: a.requestId, index: 0 });
  expect(calls).toBe(1);
  expect(voice).toBe("Kore");
  service.cancel(b.requestId);
  resolve({ bytes: Buffer.from("audio"), mimeType: "audio/mpeg" });
  expect(await first).toEqual(await duplicate);
  expect(() => service.start(b)).toThrow("停止");
});
test("cancel before start and late provider completions cannot revive a task", async () => {
  let resolve!: (audio: { bytes: Buffer; mimeType: string }) => void;
  let signal: AbortSignal | undefined;
  const { service } = fixture(async (request) => {
    signal = request.signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const stopped = input();
  service.cancel(stopped.requestId);
  expect(() => service.start(stopped)).toThrow("停止");
  const a = input();
  service.start(a);
  const pending = service.segment({ requestId: a.requestId, index: 0 });
  service.cancel(a.requestId);
  expect(signal?.aborted).toBe(true);
  resolve({ bytes: Buffer.from("late"), mimeType: "audio/mpeg" });
  await expect(pending).rejects.toThrow("停止");
  expect(() => service.read({ requestId: a.requestId, index: 0, offset: 0, length: 1 })).toThrow("停止");
});
test("a failed segment stops the entire task without retrying or switching providers", async () => {
  let calls = 0;
  const { service } = fixture(async () => {
    calls++;
    throw new Error("429: rate limited");
  });
  const a = input();
  service.start(a);
  await expect(service.segment({ requestId: a.requestId, index: 0 })).rejects.toThrow("rate limited");
  expect(calls).toBe(1);
  expect(() => service.start(a)).toThrow("停止");
});
test("remote generation is execute-capable and payload validation rejects missing fields", () => {
  expect(getRemoteCommandDefinition("tts-read-aloud:segment")?.risk).toBe("execute");
  expect(validateRemoteCommandArgs("tts-read-aloud:start", [input()])).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("tts-read-aloud:read", [{ requestId: "id" }]).ok).toBe(false);
});
