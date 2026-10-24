import { expect, test } from "bun:test";
import { createElement } from "react";
import {
  OpenTtsArtifactContext,
  readTtsToolUseId,
  TtsArtifactPlayer,
  TtsArtifactsContext,
  TtsFeedArtifacts,
} from "../src/renderer/TtsArtifactPlayer";
import { TtsSettingsPanel } from "../src/renderer/TtsSettingsPanel";
import { formatActionLine, resolveActionKind } from "../src/shared/feed-action-kind";
import { normalizeIntegrationsEnabled } from "../src/shared/integrations";
import type { TtsArtifact } from "../src/shared/tts";
import { renderLocalized } from "./i18n-test";

const artifact: TtsArtifact = {
  id: "audio-1",
  threadId: "a",
  toolUseId: "tool-a",
  status: "completed",
  text: "你好，欢迎回来。",
  parameters: { voice: "Kore", style: "温柔，略慢" },
  provider: "gemini",
  profileName: "Gemini",
  model: "gemini-3.8-flash-tts",
  workspacePath: "/tmp",
  generationRoot: "/tmp",
  audio: [{ absolutePath: "/tmp/test.wav", relativePath: "test.wav", mimeType: "audio/wav", bytes: 52 }],
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:01.000Z",
};

test("Feed audio links the actual tool ID and shows a transcript excerpt without generation details", () => {
  const id = readTtsToolUseId({
    metadata: { tool: { name: "mcp__eco_tts__create_speech", toolUseId: "tool-a" } },
  });
  expect(id).toBe("tool-a");
  const markup = renderLocalized(
    createElement(
      TtsArtifactsContext.Provider,
      { value: [artifact] },
      createElement(TtsFeedArtifacts, { toolUseIds: [id!] }),
    ),
    "zh-CN",
  );
  expect(markup).toContain("播放语音");
  expect(markup).toContain('class="tts-artifact-bar"');
  expect(markup).toContain('class="tts-artifact-transcript-preview"');
  expect(markup).toContain(artifact.text);
  expect(markup).not.toContain(artifact.parameters.style);
  const unmatched = renderLocalized(
    createElement(
      TtsArtifactsContext.Provider,
      { value: [artifact] },
      createElement(TtsFeedArtifacts, { toolUseIds: ["tool-b"] }),
    ),
    "zh-CN",
  );
  expect(unmatched).toBe("");
});

test("failed speech is visibly failed without a player and retains the provider error", () => {
  const markup = renderLocalized(
    createElement(TtsArtifactPlayer, {
      artifact: {
        ...artifact,
        status: "failed",
        audio: [],
        errorCode: "auth_failed",
        errorMessage: "Provider rejected API key",
      },
    }),
    "zh-CN",
  );
  expect(markup).toContain("生成失败");
  expect(markup).toContain("Provider rejected API key");
  expect(markup).not.toContain("播放语音");
});

test("Doubao cards keep the full voice ID on its own row and offer in-app playback", () => {
  const doubao: TtsArtifact = {
    ...artifact,
    provider: "doubao",
    model: "seed-tts-2.0",
    parameters: { voice: "zh_female_qingxinnvsheng_uranus_bigtts", style: "请用轻快、自然的语气朗读" },
    audio: [
      {
        absolutePath: "/tmp/doubao.mp3",
        relativePath: ".eco/generated-audio/thread-1/doubao.mp3",
        mimeType: "audio/mpeg",
        bytes: 37485,
      },
    ],
  };
  const markup = renderLocalized(createElement(TtsArtifactPlayer, { artifact: doubao }), "zh-CN");
  // The ID is emitted verbatim; CSS ellipsis (not a mid-word break) handles narrow panels.
  expect(markup).toContain('class="tts-artifact-voice" title="zh_female_qingxinnvsheng_uranus_bigtts"');
  expect(markup).toContain("seed-tts-2.0");
  expect(markup).toContain("打开音频");
  expect(markup).toContain("在文件夹中显示");
  // The transcript renders once; the duplicate 朗读文本 disclosure used to repeat it.
  expect(markup.split(doubao.text).length - 1).toBe(1);
});

test("compact cards show playback progress and open details in the sidebar without inline expansion", () => {
  const compact = renderLocalized(
    createElement(
      OpenTtsArtifactContext.Provider,
      { value: () => {} },
      createElement(TtsArtifactPlayer, { artifact, compact: true }),
    ),
    "zh-CN",
  );
  expect(compact).toContain('class="tts-artifact-bar"');
  expect(compact).not.toContain("aria-expanded");
  expect(compact).toContain('type="range"');
  expect(compact).toContain('aria-label="播放进度"');
  expect(compact).toContain("0:00 / --:--");
  expect(compact).not.toContain("controls=");
  expect(compact).toContain('aria-label="详情"');
  expect(compact).not.toContain(artifact.text);
  expect(compact).not.toContain(artifact.parameters.voice);
  expect(compact).not.toContain(artifact.parameters.style);
  // Full (the artifact tab) keeps everything visible without a click.
  const full = renderLocalized(createElement(TtsArtifactPlayer, { artifact }), "zh-CN");
  expect(full).toContain(artifact.text);
  expect(full).toContain(artifact.parameters.voice);
  expect(full).toContain(artifact.parameters.style);
  expect(full).toContain('class="tts-artifact-bar"');
  // A failed generation still reports itself on the collapsed bar.
  const failed = renderLocalized(
    createElement(TtsArtifactPlayer, {
      artifact: {
        ...artifact,
        status: "failed",
        audio: [],
        errorCode: "auth_failed",
        errorMessage: "Invalid X-Api-Key",
      },
      compact: true,
    }),
    "zh-CN",
  );
  expect(failed).toContain("生成失败");
  expect(failed).toContain("auth_failed: Invalid X-Api-Key");
  expect(failed).not.toContain(artifact.text);
});

test("settings expose the Gemini model and custom Base URL; integration selection preserves TTS", () => {
  const panel = createElement(TtsSettingsPanel, {
    settings: {
      enabled: false,
      activeProfileId: "p1",
      profiles: [
        {
          id: "p1",
          name: "Gemini TTS",
          provider: "gemini",
          model: "gemini-3.8-flash-tts",
          baseUrl: "https://custom.example/v1beta",
          hasApiKey: false,
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
        },
      ],
      apiKeyEncryptionAvailable: true,
    },
    onChange: () => {},
    onError: () => {},
  });
  const markup = renderLocalized(panel, "zh-CN");
  expect(markup).toContain("语音合成");
  expect(markup).toContain("gemini-3.8-flash-tts");
  expect(markup).toContain("https://custom.example/v1beta");
  expect(markup).not.toContain("图片编辑");
  const englishMarkup = renderLocalized(panel, "en-US");
  expect(englishMarkup).toContain("Speech Generation");
  expect(englishMarkup).toContain("Provider profiles");
  expect(englishMarkup).toContain("Add profile");
  expect(englishMarkup).toContain("1 profile");
  expect(englishMarkup).toContain("1 active");
  expect(englishMarkup).toContain("In use");
  expect(englishMarkup).not.toMatch(/[\u3400-\u9fff]/u);
  expect(normalizeIntegrationsEnabled({ tts: true, browser: false })).toEqual({ tts: true, browser: false });
  expect(resolveActionKind({ toolName: "mcp__eco_tts__create_speech" }).kind).toBe("speechCreate");
  expect(
    formatActionLine(
      { resolved: resolveActionKind({ toolName: "create_speech" }), phase: "done" },
      (key) => key,
    ),
  ).toBe("activity.done.speechCreate");
});
