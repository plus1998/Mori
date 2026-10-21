import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSpeechToWorkspace, normalizeTtsToolInput } from "../src/main/tts-client";
import type { TtsClientConfig } from "../src/main/tts-store";
import { TtsError } from "../src/shared/tts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export function wavFixture(): Buffer {
  const data = Buffer.alloc(52);
  data.write("RIFF");
  data.writeUInt32LE(44, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(8, 40);
  return data;
}
const speech = { text: "你好，欢迎回来。", voice: "Kore", style: "温暖、舒缓，句尾轻柔，略慢。" };
async function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  provider: TtsClientConfig["provider"] = "gemini",
) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => server.stop(true));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-tts-client-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const model =
    provider === "gemini"
      ? "gemini-3.8-flash-tts"
      : provider === "doubao"
        ? "seed-tts-2.0"
        : "google/gemini-3.8-flash-tts";
  const config: TtsClientConfig = {
    profileId: "test",
    profileName: "test",
    provider,
    baseUrl: `${server.url}custom/v1`,
    model,
    apiKey: "private-key",
  };
  return { config, generationRoot: root, threadDirectory: "thread-1234abcd", toolInput: speech };
}

test("Gemini 3.8 REST keeps style separate from transcript and writes WAV without double wrapping", async () => {
  let called = false;
  const wav = wavFixture();
  const input = await fixture(async (request) => {
    called = true;
    expect(new URL(request.url).pathname).toBe("/custom/v1/interactions");
    expect(request.headers.get("x-goog-api-key")).toBe("private-key");
    expect(request.headers.has("Authorization")).toBe(false);
    const body = await request.json();
    expect(body).toMatchObject({
      model: "gemini-3.8-flash-tts",
      generation_config: { speech_config: [{ voice: "Kore" }] },
      response_format: { type: "audio", mime_type: "audio/wav" },
      store: false,
    });
    expect(body.input[0].content[0]).toEqual({
      type: "text",
      text: speech.text,
      annotations: [{ type: "speech_metadata", style: speech.style }],
    });
    return Response.json({
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "audio", mime_type: "audio/wav", data: wav.toString("base64") }],
        },
      ],
    });
  });
  const result = await generateSpeechToWorkspace(input);
  expect(called).toBe(true);
  expect(result[0]?.relativePath).toStartWith(path.join(".eco", "generated-audio", input.threadDirectory));
  expect(await fs.readFile(result[0]!.absolutePath)).toEqual(wav);
  expect(result[0]?.mimeType).toBe("audio/wav");
});

test("OpenRouter-compatible speech uses the custom base URL, Bearer auth and instructions", async () => {
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]);
  const input = await fixture(async (request) => {
    expect(new URL(request.url).pathname).toBe("/custom/v1/audio/speech");
    expect(request.headers.get("Authorization")).toBe("Bearer private-key");
    expect(await request.json()).toEqual({
      model: "google/gemini-3.8-flash-tts",
      input: speech.text,
      voice: "Kore",
      instructions: speech.style,
      response_format: "mp3",
    });
    return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
  }, "openai_compatible");
  const result = await generateSpeechToWorkspace(input);
  expect(await fs.readFile(result[0]!.absolutePath)).toEqual(mp3);
  expect(result[0]?.absolutePath).toEndWith(".mp3");
});

test("Doubao TTS 2.0 posts the speaker and style instruction, then joins base64 SSE audio frames", async () => {
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const input = await fixture(async (request) => {
    expect(new URL(request.url).pathname).toBe("/custom/v1/api/v3/tts/unidirectional/sse");
    expect(request.headers.get("X-Api-Key")).toBe("private-key");
    expect(request.headers.get("X-Api-Resource-Id")).toBe("seed-tts-2.0");
    expect(request.headers.get("X-Api-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = await request.json();
    expect(body).toEqual({
      user: { uid: "eco-desktop" },
      req_params: {
        text: speech.text,
        speaker: speech.voice,
        audio_params: { format: "mp3", sample_rate: 24000 },
        additions: JSON.stringify({
          context_texts: [speech.style],
          disable_markdown_filter: true,
          disable_emoji_filter: true,
        }),
      },
    });
    const frames = [
      { code: 0, message: "", data: mp3.subarray(0, 6).toString("base64") },
      { code: 0, message: "", data: mp3.subarray(6).toString("base64") },
      { code: 0, message: "", data: null, sentence: { text: speech.text, words: [] } },
      { code: 20000000, message: "OK", data: null, usage: { text_words: 11 } },
    ];
    return new Response(frames.map((frame) => `event: 352\ndata: ${JSON.stringify(frame)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream", "x-tt-logid": "logid-7" },
    });
  }, "doubao");
  const result = await generateSpeechToWorkspace(input);
  const [audio] = result;
  if (!audio) throw new Error("Doubao returned no audio file record.");
  expect(await fs.readFile(audio.absolutePath)).toEqual(mp3);
  expect(audio.mimeType).toBe("audio/mpeg");
  expect(audio.absolutePath).toEndWith(".mp3");
});

test("Doubao stream codes map to Eco errors instead of writing partial audio", async () => {
  const cases: Array<{ frame: Record<string, unknown>; code: string; requestId?: string }> = [
    { frame: { code: 45002000, message: "TTS invalid speaker" }, code: "invalid_input" },
    {
      frame: { code: 45000000, message: "quota exceeded for types: concurrency" },
      code: "rate_limited",
      requestId: "logid-9",
    },
    { frame: { code: 55000000, message: "synthesis processing timeout" }, code: "provider_error" },
    {
      frame: { code: 55000000, message: "resource ID is mismatched with speaker related resource" },
      code: "invalid_input",
    },
  ];
  for (const { frame, code, requestId } of cases) {
    const input = await fixture(
      () =>
        new Response(
          `event: 352\ndata: {"code":0,"data":"AP8B"}\n\nevent: 153\ndata: ${JSON.stringify(frame)}\n\n`,
          {
            headers: {
              "content-type": "text/event-stream",
              ...(requestId ? { "x-tt-logid": requestId } : {}),
            },
          },
        ),
      "doubao",
    );
    let error: unknown;
    try {
      await generateSpeechToWorkspace(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TtsError);
    expect(error).toMatchObject({ code, requestId });
    expect(await fs.readdir(input.generationRoot)).toEqual([]);
  }
});

test("Doubao rejects a bad API Key delivered as an HTTP 200 failure frame", async () => {
  const input = await fixture(
    () =>
      new Response(
        'event: 153\ndata: {"reqid":"3f2a1b6c-7d4e-4a1b-9c2d-1e2f3a4b5c6d","code":45000010,"message":"Invalid X-Api-Key"}\n\n',
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      ),
    "doubao",
  );
  await expect(generateSpeechToWorkspace(input)).rejects.toMatchObject({
    code: "auth_failed",
    message: expect.stringContaining("Invalid X-Api-Key"),
    requestId: "3f2a1b6c-7d4e-4a1b-9c2d-1e2f3a4b5c6d",
  });
  expect(await fs.readdir(input.generationRoot)).toEqual([]);
});

test("Doubao responses without a terminal frame or without audio are rejected", async () => {
  for (const body of [
    'event: 352\ndata: {"code":0,"message":"","data":"AP8B"}\n\n',
    'event: 152\ndata: {"code":20000000,"message":"OK","data":null}\n\n',
  ]) {
    const input = await fixture(
      () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      "doubao",
    );
    await expect(generateSpeechToWorkspace(input)).rejects.toBeInstanceOf(TtsError);
    expect(await fs.readdir(input.generationRoot)).toEqual([]);
  }
});

test("provider errors retain status, request ID and message without retries or changing model", async () => {
  let calls = 0;
  const input = await fixture(() => {
    calls++;
    return Response.json(
      { error: { message: "Model unavailable" } },
      { status: 429, headers: { "x-request-id": "request-7" } },
    );
  });
  let error: unknown;
  try {
    await generateSpeechToWorkspace(input);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TtsError);
  expect(error).toMatchObject({
    code: "rate_limited",
    message: "Model unavailable",
    providerStatus: 429,
    requestId: "request-7",
  });
  expect(calls).toBe(1);
  expect(await fs.readdir(input.generationRoot)).toEqual([]);
});

test("rejects missing audio, invalid base64 and incorrect WAV instead of writing a fake artifact", async () => {
  for (const content of [
    [],
    [{ type: "audio", mime_type: "audio/wav", data: "!!!!" }],
    [{ type: "audio", mime_type: "audio/wav", data: Buffer.from("not an audio file").toString("base64") }],
  ]) {
    const input = await fixture(() => Response.json({ steps: [{ content }] }));
    await expect(generateSpeechToWorkspace(input)).rejects.toBeInstanceOf(TtsError);
    expect(await fs.readdir(input.generationRoot)).toEqual([]);
  }
});

test("does not accept JSON errors disguised as successful compatible speech responses", async () => {
  const input = await fixture(() => Response.json({ error: { message: "no audio" } }), "openai_compatible");
  await expect(generateSpeechToWorkspace(input)).rejects.toMatchObject({ code: "invalid_audio" });
});

test("cancellation aborts a response body that is still streaming", async () => {
  const controller = new AbortController();
  const input = await fixture(
    () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"steps":['));
            setTimeout(() => controller.abort(), 20);
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  await expect(generateSpeechToWorkspace({ ...input, signal: controller.signal })).rejects.toMatchObject({
    code: "cancelled",
  });
});

test("rejects unsupported parameters and path-like filenames", () => {
  for (const output_name of ["../escape", "a/b", "a\\b", ".", "a.mp3"])
    expect(() => normalizeTtsToolInput({ ...speech, output_name })).toThrow();
  expect(() => normalizeTtsToolInput({ ...speech, model: "other" } as never)).toThrow();
  expect(() => normalizeTtsToolInput({ ...speech, style: "" })).toThrow();
});

test("symlinked output directories cannot escape the generation root", async () => {
  const wav = wavFixture();
  const input = await fixture(() =>
    Response.json({
      steps: [{ content: [{ type: "audio", mime_type: "audio/wav", data: wav.toString("base64") }] }],
    }),
  );
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "eco-tts-external-"));
  cleanups.push(() => fs.rm(external, { recursive: true, force: true }));
  await fs.symlink(external, path.join(input.generationRoot, ".eco"), "dir");
  await expect(generateSpeechToWorkspace(input)).rejects.toMatchObject({ code: "invalid_output_path" });
  expect(await fs.readdir(external)).toEqual([]);
});
