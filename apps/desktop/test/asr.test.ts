import { expect, test } from "bun:test";
import { createElement } from "react";
import {
  asrRequestPath,
  buildAsrRequestBody,
  buildAsrTranscriptionsFormData,
  transcribeAsr,
} from "../src/main/asr-client";
import {
  DEFAULT_ASR_API_MODE,
  normalizeAsrApiMode,
  normalizeAsrEndpoint,
} from "../src/main/asr-settings-store";
import {
  createAsrCleanupOnce,
  isAsrComposerConfigured,
  isAsrInputDeviceConstraintError,
  mapAsrAnalyserRmsToLevel,
  reportAsrError,
  resolveAsrErrorMessage,
  resolveAsrMediaRecorderError,
  shouldAnimateWaveform,
} from "../src/renderer/AsrRecorder";
import {
  AsrSettingsPanel,
  isAsrProfileDraftDirty,
  profileStatusLine,
  resolveAsrLoadErrorDetail,
} from "../src/renderer/AsrSettingsPanel";
import { isAsrAsyncTokenCurrent, nextAsrAsyncToken } from "../src/renderer/asr-async-token";
import { encodePcm16Wav, wavToBase64 } from "../src/renderer/asr-audio";
import { mergeAsrTextAtSelection } from "../src/renderer/asr-composer";
import {
  audioConstraintsForInputDevice,
  isAsrInputDeviceAvailable,
  toAsrInputDevices,
} from "../src/renderer/asr-input-devices";
import {
  ASR_WAV_DATA_URL_PREFIX,
  asrDataUrlByteLength,
  MAX_ASR_DATA_URL_BYTES,
} from "../src/shared/asr-limits";
import { i18nCatalogs } from "../src/shared/i18n-catalogs";
import {
  PROVIDER_BRAND_IDS,
  PROVIDER_BRAND_LOGOS,
  resolveProviderBrandLogo,
} from "../src/shared/provider-brand-logo";
import { renderLocalized } from "./i18n-test";

test("starts waveform animation only for an active non-busy recording", () => {
  expect(shouldAnimateWaveform(true, false, false)).toBe(true);
  expect(shouldAnimateWaveform(false, false, false)).toBe(false);
  expect(shouldAnimateWaveform(true, true, false)).toBe(false);
  expect(shouldAnimateWaveform(true, false, true)).toBe(false);
});

test("maps analyser RMS with graduated volume levels", () => {
  expect(mapAsrAnalyserRmsToLevel(0)).toBe(0);
  expect(mapAsrAnalyserRmsToLevel(-1)).toBe(0);
  const quiet = mapAsrAnalyserRmsToLevel(0.02);
  const normal = mapAsrAnalyserRmsToLevel(0.06);
  const loud = mapAsrAnalyserRmsToLevel(0.12);
  expect(quiet).toBeCloseTo(0.16, 5);
  expect(normal).toBeCloseTo(0.48, 5);
  expect(loud).toBeCloseTo(0.96, 5);
  expect(loud).toBeGreaterThan(normal);
  expect(normal).toBeGreaterThan(quiet);
  expect(mapAsrAnalyserRmsToLevel(0.2)).toBe(1);
});

test("reports the original ASR error message and falls back for unknown errors", () => {
  const messages: string[] = [];
  reportAsrError(messages.push.bind(messages), new Error("transcribe service unavailable"), "录音失败");
  reportAsrError(messages.push.bind(messages), { reason: "unknown" }, "录音失败");
  expect(messages).toEqual(["transcribe service unavailable", "录音失败"]);
  expect(resolveAsrErrorMessage(new Error(""), "录音失败")).toBe("录音失败");
});

test("invalidates stale async ASR sessions", () => {
  const firstToken = nextAsrAsyncToken(0);
  const secondToken = nextAsrAsyncToken(firstToken);
  expect(isAsrAsyncTokenCurrent(firstToken, secondToken)).toBe(false);
  expect(isAsrAsyncTokenCurrent(secondToken, secondToken)).toBe(true);
  expect(isAsrAsyncTokenCurrent(secondToken, secondToken, false)).toBe(false);
});

test("reports MediaRecorder error details and cleans up only once", () => {
  expect(resolveAsrMediaRecorderError({ error: new Error("encoder failed") }, "录音失败")).toBe(
    "encoder failed",
  );
  expect(resolveAsrMediaRecorderError({ error: null }, "录音失败")).toBe("录音失败");
  let cleanupCount = 0;
  const cleanupOnce = createAsrCleanupOnce(() => {
    cleanupCount += 1;
  });
  cleanupOnce();
  cleanupOnce();
  expect(cleanupCount).toBe(1);
});

test("contains all visible ASR settings catalog keys in both locales", () => {
  const zh = i18nCatalogs["zh-CN"].translation;
  const en = i18nCatalogs["en-US"].translation;
  for (const key of [
    "asr.baseUrl",
    "asr.apiMode",
    "asr.apiModeChat",
    "asr.apiModeTranscriptions",
    "asr.pageSubtitle",
    "asr.subtitleChat",
    "asr.subtitleTranscriptions",
    "asr.contextPromptNoteTranscriptions",
    "asr.loadError",
    "asr.loadErrorUnknown",
    "asr.saveError",
    "asr.profiles",
    "asr.profileName",
    "asr.addProfile",
    "asr.profileCount",
    "asr.profileCountActiveSuffix",
    "asr.emptyTitle",
    "asr.emptyHint",
    "asr.editorSubtitle",
    "asr.editProfileAction",
    "asr.inactive",
    "asr.saving",
    "asr.setActive",
    "asr.deleteConfirm",
    "asr.inputDevice",
    "asr.systemDefault",
    "asr.inputDeviceUnavailable",
    "asr.error.inputDeviceUnavailable",
  ]) {
    expect(zh[key]).toBeTruthy();
    expect(en[key]).toBeTruthy();
  }
});

test("uses Voice Input as the title and reserves transcription wording for the protocol name", () => {
  const zh = i18nCatalogs["zh-CN"].translation;
  const en = i18nCatalogs["en-US"].translation;
  expect(zh["asr.title"]).toBe("语音输入");
  expect(en["asr.title"]).toBe("Voice Input");
  for (const [key, value] of Object.entries(en)) {
    if (!key.startsWith("asr.")) continue;
    expect(value.replaceAll("Audio Transcriptions", "").toLowerCase()).not.toContain("transcription");
  }
});

test("shows the composer voice button only after a usable profile and an input device are configured", () => {
  const profile = { id: "profile-1", model: "qwen3-asr-flash", hasApiKey: true };
  const configured = { profiles: [profile], activeProfileId: "profile-1", inputDeviceId: "mic-1" };
  expect(isAsrComposerConfigured(configured)).toBe(true);
  expect(isAsrComposerConfigured({ ...configured, inputDeviceId: undefined })).toBe(false);
  expect(isAsrComposerConfigured({ ...configured, inputDeviceId: "" })).toBe(false);
  expect(isAsrComposerConfigured({ profiles: [], activeProfileId: "", inputDeviceId: "mic-1" })).toBe(false);
  expect(isAsrComposerConfigured({ ...configured, activeProfileId: "profile-missing" })).toBe(false);
  expect(isAsrComposerConfigured({ ...configured, profiles: [{ ...profile, hasApiKey: false }] })).toBe(
    false,
  );
  expect(isAsrComposerConfigured({ ...configured, profiles: [{ ...profile, model: "  " }] })).toBe(false);
});

test("resolves vendor brand logos from name, then model, then protocol", () => {
  expect(resolveProviderBrandLogo({ name: "OpenAI 官方", model: "whatever" })?.iconSrc).toBe(
    "./provider-icons/openai.svg",
  );
  expect(resolveProviderBrandLogo({ name: "", model: "gpt-image-2" })?.brand).toBe("openai");
  expect(resolveProviderBrandLogo({ model: "gemini-2.5-flash-image" })?.iconSrc).toBe(
    "./agent-icons/gemini.png",
  );
  expect(resolveProviderBrandLogo({ model: "grok-4-image" })?.iconSrc).toBe("./agent-icons/grok.ico");
  // Vendor name wins over the model when both match different brands.
  expect(resolveProviderBrandLogo({ name: "Google AI Studio", model: "gpt-image-2" })?.brand).toBe("google");
  // Protocol and base URL are the fallbacks.
  expect(resolveProviderBrandLogo({ protocol: "openai_compatible" })?.brand).toBe("openai");
  expect(
    resolveProviderBrandLogo({ endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" })?.brand,
  ).toBe("bailian");
  expect(resolveProviderBrandLogo({ name: "百炼 API", model: "qwen3-asr-flash" })?.iconSrc).toBe(
    "./provider-icons/bailian.png",
  );
  expect(resolveProviderBrandLogo({ name: "DeepSeek" })?.iconSrc).toBe("./provider-icons/deepseek.ico");
  // Every advertised brand ships a real asset path.
  for (const brand of PROVIDER_BRAND_IDS) {
    expect(PROVIDER_BRAND_LOGOS[brand]).toMatch(/^\.\/(agent|provider)-icons\//);
  }
  // Unknown vendors stay unlabelled so the caller can keep its own icon.
  expect(resolveProviderBrandLogo({ name: "本地自建", model: "whisper-large" })).toBeUndefined();
  expect(resolveProviderBrandLogo({})).toBeUndefined();
});

test("renders an ASR settings load error detail or localized unknown fallback", () => {
  expect(resolveAsrLoadErrorDetail("database unavailable", "Unknown error")).toBe("database unavailable");
  expect(resolveAsrLoadErrorDetail("", "Unknown error")).toBe("Unknown error");
  expect(resolveAsrLoadErrorDetail(undefined, "Unknown error")).toBeUndefined();
});

test("detects dirty ASR drafts and builds compact profile status lines", () => {
  const work = {
    id: "profile-1",
    name: "Work",
    endpoint: "https://example.com/v1",
    apiMode: "chat_completions" as const,
    model: "custom-asr-model",
    systemPrompt: "",
    hasApiKey: true,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
  expect(
    isAsrProfileDraftDirty(
      {
        id: work.id,
        name: work.name,
        endpoint: work.endpoint,
        apiMode: work.apiMode,
        model: work.model,
        systemPrompt: work.systemPrompt,
        apiKey: "",
      },
      work,
    ),
  ).toBe(false);
  expect(
    isAsrProfileDraftDirty(
      {
        id: work.id,
        name: "Office",
        endpoint: work.endpoint,
        apiMode: work.apiMode,
        model: work.model,
        systemPrompt: work.systemPrompt,
        apiKey: "",
      },
      work,
    ),
  ).toBe(true);
  expect(
    isAsrProfileDraftDirty(
      {
        name: "",
        endpoint: "",
        apiMode: "chat_completions",
        model: "",
        systemPrompt: "",
        apiKey: "",
      },
      undefined,
    ),
  ).toBe(false);
  expect(profileStatusLine(work, { notSet: "Not set" })).toBe("Chat Completions · custom-asr-model");
  expect(profileStatusLine({ apiMode: "chat_completions", model: "  " }, { notSet: "Not set" })).toBe(
    "Chat Completions · Not set",
  );
});

test("renders voice profiles with active metadata and disables editing while busy", () => {
  const props = {
    snapshot: {
      profiles: [
        {
          id: "profile-1",
          name: "Work",
          endpoint: "https://example.com/v1",
          apiMode: "chat_completions" as const,
          model: "custom-asr-model",
          systemPrompt: "",
          hasApiKey: true,
          createdAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
        {
          id: "profile-2",
          name: "百炼 API",
          endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiMode: "chat_completions" as const,
          model: "qwen3-asr-flash",
          systemPrompt: "",
          hasApiKey: false,
          createdAt: "2026-08-03T01:00:00.000Z",
          updatedAt: "2026-08-03T01:00:00.000Z",
        },
      ],
      activeProfileId: "profile-1",
      apiKeyEncryptionAvailable: true,
    },
    onSave: async (input: { id?: string }) => ({
      ...input,
      id: input.id ?? "profile-1",
      name: "Work",
      endpoint: "https://example.com/v1",
      apiMode: "chat_completions" as const,
      model: "custom-asr-model",
      systemPrompt: "",
      hasApiKey: true,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    }),
    onDelete: async () => {},
    onActivate: async () => {},
    onInputDeviceChange: async () => {},
  };
  const markup = renderLocalized(createElement(AsrSettingsPanel, props), "en-US");
  expect(markup).toContain("<h1>Voice Input</h1>");
  expect(markup).toContain("Choose a microphone and manage the service profiles used for recording.");
  expect(markup).toContain("Microphone");
  expect(markup).toContain("System default");
  expect(markup).toContain("Voice profiles");
  expect(markup).toContain("2 profiles · 1 active");
  expect(markup).toContain("Add profile");
  expect(markup).toContain("Work");
  expect(markup).toContain("Chat Completions · custom-asr-model");
  // A saved key is the normal case and stays out of the card; only a missing key is surfaced.
  expect(markup).not.toContain("Key saved");
  expect(markup).toContain("Active");
  expect(markup).toContain("Not active");
  expect(markup).toContain("Set active");
  // The state chip is the activation control: active profile is pressed + disabled,
  // inactive profile stays clickable. No separate "Set active" button exists.
  expect(markup).toMatch(/asr-profile-state is-active"[^>]*aria-pressed="true"[^>]*disabled/);
  expect(markup).toMatch(/asr-profile-state"[^>]*aria-pressed="false"/);
  expect(markup).not.toContain("asr-profile-action-primary");
  expect(markup).toContain("Edit");
  expect(markup).toContain("Chat Completions · qwen3-asr-flash");
  expect(markup).toContain("No API key");
  // Brand marks come from the vendor name / model, not from a generic icon.
  expect(markup).toContain('src="./provider-icons/bailian.png"');
  expect(markup).toContain("asr-profile-card-actions");
  // The editor moved into a modal, so its fields stay out of the page markup.
  expect(markup).not.toContain('placeholder="qwen3-asr-flash"');
  expect(markup).not.toContain("Audio Transcriptions");
  const busyMarkup = renderLocalized(createElement(AsrSettingsPanel, { ...props, busy: true }), "en-US");
  expect(busyMarkup).toMatch(/class="settings-primary-button asr-add-button"[^>]*disabled/);
  expect(busyMarkup).toMatch(/asr-profile-action-secondary"[^>]*disabled/);
});

test("builds exact input constraints and never treats a missing saved device as available", () => {
  expect(audioConstraintsForInputDevice("")).toBe(true);
  expect(audioConstraintsForInputDevice("usb-mic")).toEqual({
    deviceId: { exact: "usb-mic" },
  });
  const devices = [
    { deviceId: "usb-mic", kind: "audioinput" as const },
    { deviceId: "camera", kind: "videoinput" as const },
  ];
  expect(isAsrInputDeviceAvailable("", devices)).toBe(true);
  expect(isAsrInputDeviceAvailable("usb-mic", devices)).toBe(true);
  expect(isAsrInputDeviceAvailable("missing-mic", devices)).toBe(false);
});

test("marks a saved input device unavailable instead of falling back to system default", () => {
  const markup = renderLocalized(
    createElement(AsrSettingsPanel, {
      snapshot: {
        profiles: [],
        activeProfileId: "",
        inputDeviceId: "missing-mic",
        apiKeyEncryptionAvailable: true,
      },
      onSave: async () => {
        throw new Error("not used");
      },
      onDelete: async () => {},
      onActivate: async () => {},
      onInputDeviceChange: async () => {},
    }),
    "en-US",
  );
  expect(markup).toContain("Saved device (unavailable)");
  expect(markup).toContain("The saved recording device is unavailable.");
  expect(markup).toContain('value="missing-mic" selected=""');
});

test("filters and labels enumerated audio inputs without inventing device IDs", () => {
  expect(
    toAsrInputDevices(
      [
        { deviceId: "mic-1", kind: "audioinput" as const, label: "Desk Mic" },
        { deviceId: "mic-2", kind: "audioinput" as const, label: "" },
        { deviceId: "camera", kind: "videoinput" as const, label: "Camera" },
        { deviceId: "", kind: "audioinput" as const, label: "" },
      ],
      (index) => `Microphone ${index}`,
    ),
  ).toEqual([
    { deviceId: "mic-1", label: "Desk Mic" },
    { deviceId: "mic-2", label: "Microphone 2" },
  ]);
});

test("recognizes missing and overconstrained media device errors", () => {
  expect(isAsrInputDeviceConstraintError(new DOMException("", "NotFoundError"))).toBe(true);
  expect(isAsrInputDeviceConstraintError(new DOMException("", "OverconstrainedError"))).toBe(true);
  expect(isAsrInputDeviceConstraintError(new DOMException("", "NotAllowedError"))).toBe(false);
  expect(isAsrInputDeviceConstraintError(new Error("missing"))).toBe(false);
});

test("normalizes ASR base URLs and accepts HTTP or HTTPS", () => {
  expect(normalizeAsrEndpoint("https://example.com/v1/chat/completions")).toBe("https://example.com/v1");
  expect(normalizeAsrEndpoint("https://example.com/v1/chat/completions?x=1#y")).toBe(
    "https://example.com/v1",
  );
  expect(normalizeAsrEndpoint("https://example.com/v1/chat/completions/chat/completions/")).toBe(
    "https://example.com/v1",
  );
  expect(normalizeAsrEndpoint("https://example.com/v1/audio/transcriptions")).toBe("https://example.com/v1");
  expect(normalizeAsrEndpoint("https://example.com/v1/audio/transcriptions/")).toBe("https://example.com/v1");
  expect(normalizeAsrEndpoint("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
  expect(normalizeAsrEndpoint("http://example.com/v1")).toBe("http://example.com/v1");
  expect(normalizeAsrEndpoint("http://192.168.1.10:8080/v1")).toBe("http://192.168.1.10:8080/v1");
  expect(() => normalizeAsrEndpoint("ftp://example.com/v1")).toThrow("HTTP 或 HTTPS");
});

test("normalizes ASR apiMode with chat_completions as the default", () => {
  expect(normalizeAsrApiMode(undefined)).toBe(DEFAULT_ASR_API_MODE);
  expect(normalizeAsrApiMode("chat_completions")).toBe("chat_completions");
  expect(normalizeAsrApiMode("audio_transcriptions")).toBe("audio_transcriptions");
  expect(normalizeAsrApiMode("whisper")).toBe("chat_completions");
  expect(asrRequestPath("chat_completions")).toBe("/chat/completions");
  expect(asrRequestPath("audio_transcriptions")).toBe("/audio/transcriptions");
});

test("merges ASR text once at the active composer selection", () => {
  expect(mergeAsrTextAtSelection("say hello", " world", 4, 9)).toEqual({
    prompt: "say world",
    cursor: 9,
  });
});

test("merges ASR text without keeping an empty-composer newline", () => {
  expect(mergeAsrTextAtSelection("\n", "你好", 1, 1)).toEqual({
    prompt: "你好",
    cursor: 2,
  });
  expect(mergeAsrTextAtSelection("", "你好", 0, 0)).toEqual({
    prompt: "你好",
    cursor: 2,
  });
});

/** Official Qwen ASR docs base64 sample prefix (Data URL example). */
const OFFICIAL_ASR_BASE64_SAMPLE =
  "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//PAxABQ/BXRbMPe4IQAhl9";

test("builds ASR chat completion body with official system content[{text}] shape", () => {
  const withPrompt = buildAsrRequestBody(
    {
      endpoint: "https://example.com/v1",
      apiMode: "chat_completions",
      model: "custom-asr-model",
      systemPrompt: "Names",
      apiKey: "secret",
    },
    OFFICIAL_ASR_BASE64_SAMPLE,
  );
  expect(withPrompt).toEqual({
    model: "custom-asr-model",
    messages: [
      { role: "system", content: [{ text: "Names" }] },
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: `${ASR_WAV_DATA_URL_PREFIX}${OFFICIAL_ASR_BASE64_SAMPLE}` },
          },
        ],
      },
    ],
    stream: false,
    asr_options: { enable_itn: false },
  });

  const withoutPrompt = buildAsrRequestBody(
    {
      endpoint: "https://example.com/v1",
      apiMode: "chat_completions",
      model: "qwen3-asr-flash",
      systemPrompt: "",
      apiKey: "secret",
    },
    OFFICIAL_ASR_BASE64_SAMPLE,
  );
  expect(withoutPrompt.messages).toEqual([
    {
      role: "user",
      content: [
        {
          type: "input_audio",
          input_audio: { data: `${ASR_WAV_DATA_URL_PREFIX}${OFFICIAL_ASR_BASE64_SAMPLE}` },
        },
      ],
    },
  ]);
});

test("transcribeAsr posts system prompt as content[{text}] with official base64 sample", async () => {
  let body: Record<string, unknown> | undefined;
  let url = "";
  const result = await transcribeAsr(
    {
      endpoint: "https://example.com/v1",
      apiMode: "chat_completions",
      model: "qwen3-asr-flash",
      systemPrompt: "热词：阿里云",
      apiKey: "secret",
    },
    { audioWavBase64: OFFICIAL_ASR_BASE64_SAMPLE },
    {
      fetch: async (input, init) => {
        url = String(input);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "欢迎使用阿里云" } }] }), {
          status: 200,
        });
      },
    },
  );
  expect(result).toEqual({ text: "欢迎使用阿里云" });
  expect(url).toBe("https://example.com/v1/chat/completions");
  expect(body?.messages).toEqual([
    { role: "system", content: [{ text: "热词：阿里云" }] },
    {
      role: "user",
      content: [
        {
          type: "input_audio",
          input_audio: { data: `${ASR_WAV_DATA_URL_PREFIX}${OFFICIAL_ASR_BASE64_SAMPLE}` },
        },
      ],
    },
  ]);
});

test("transcribeAsr posts multipart to /audio/transcriptions and parses text", async () => {
  let url = "";
  let contentType = "";
  let auth = "";
  let body: BodyInit | null | undefined;
  const result = await transcribeAsr(
    {
      endpoint: "https://api.openai.com/v1",
      apiMode: "audio_transcriptions",
      model: "whisper-1",
      systemPrompt: "technical terms",
      apiKey: "sk-test",
    },
    { audioWavBase64: OFFICIAL_ASR_BASE64_SAMPLE },
    {
      fetch: async (input, init) => {
        url = String(input);
        const headers = new Headers(init?.headers as HeadersInit | undefined);
        contentType = headers.get("content-type") ?? "";
        auth = headers.get("authorization") ?? "";
        body = init?.body;
        return new Response(JSON.stringify({ text: " hello whisper " }), { status: 200 });
      },
    },
  );
  expect(result.text).toBe("hello whisper");
  expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(auth).toBe("Bearer sk-test");
  expect(contentType).not.toContain("application/json");
  expect(body).toBeInstanceOf(FormData);
  const form = body as FormData;
  expect(form.get("model")).toBe("whisper-1");
  expect(form.get("prompt")).toBe("technical terms");
  expect(form.get("file")).toBeTruthy();
});

test("builds transcriptions FormData without prompt when systemPrompt is empty", () => {
  const form = buildAsrTranscriptionsFormData(
    {
      endpoint: "https://api.openai.com/v1",
      apiMode: "audio_transcriptions",
      model: "whisper-1",
      systemPrompt: "",
      apiKey: "secret",
    },
    OFFICIAL_ASR_BASE64_SAMPLE,
  );
  expect(form.get("model")).toBe("whisper-1");
  expect(form.get("prompt")).toBeNull();
});

test("parses ASR response and hides credentials from request assertions", async () => {
  let request: Request | undefined;
  const result = await transcribeAsr(
    {
      endpoint: "https://example.com/v1",
      apiMode: "chat_completions",
      model: "qwen3-asr-flash",
      systemPrompt: "",
      apiKey: "secret",
    },
    { audioWavBase64: "AQID" },
    {
      fetch: async (_input, init) => {
        request = new Request("https://example.com", init);
        return new Response(JSON.stringify({ choices: [{ message: { content: "你好" } }] }), { status: 200 });
      },
    },
  );
  expect(result.text).toBe("你好");
  expect(request?.headers.get("authorization")).toBe("Bearer secret");
});

test("rejects a Data URL at the 10 MB boundary in main", async () => {
  const maxValidBase64Length = MAX_ASR_DATA_URL_BYTES - ASR_WAV_DATA_URL_PREFIX.length - 2;
  const base64 = "A".repeat(maxValidBase64Length);
  expect(asrDataUrlByteLength(base64)).toBeLessThanOrEqual(MAX_ASR_DATA_URL_BYTES);
  await expect(
    transcribeAsr(
      {
        endpoint: "https://example.com/v1",
        apiMode: "chat_completions",
        model: "qwen3-asr-flash",
        systemPrompt: "",
        apiKey: "secret",
      },
      { audioWavBase64: `${base64}AAAA` },
      {
        fetch: async () => {
          throw new Error("fetch must not run");
        },
      },
    ),
  ).rejects.toThrow("录音数据无效");
});

test("writes PCM16 mono WAV with a RIFF header", () => {
  const wav = encodePcm16Wav(new Float32Array([0, 1, -1]));
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  expect(wav.byteLength).toBe(50);
  expect(wavToBase64(wav)).toBeTruthy();
});
