import { expect, test } from "bun:test";
import { createElement } from "react";
import {
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

test("Feed audio links the actual tool ID, stays collapsed and does not fetch unrelated artifacts", () => {
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
  // The collapsed Feed card is the audio bar only; transcript and style wait for a click.
  expect(markup).not.toContain(artifact.text);
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
  expect(markup).toContain("在文件浏览器中播放");
  expect(markup).toContain("在文件夹中显示");
  // The transcript renders once; the duplicate 朗读文本 disclosure used to repeat it.
  expect(markup.split(doubao.text).length - 1).toBe(1);
});

test("compact cards show only the audio bar; details appear after expanding", () => {
  const compact = renderLocalized(createElement(TtsArtifactPlayer, { artifact, compact: true }), "zh-CN");
  // Collapsed: the bar plus its disclosure control, and nothing else.
  expect(compact).toContain('class="tts-artifact-bar"');
  expect(compact).toContain('aria-expanded="false"');
  expect(compact).toContain('aria-label="详情"');
  expect(compact).not.toContain(artifact.text);
  expect(compact).not.toContain(artifact.parameters.voice);
  expect(compact).not.toContain(artifact.parameters.style);
  // Full (the artifact tab) keeps everything visible without a click.
  const full = renderLocalized(createElement(TtsArtifactPlayer, { artifact }), "zh-CN");
  expect(full).toContain(artifact.text);
  expect(full).toContain(artifact.parameters.voice);
  expect(full).toContain(artifact.parameters.style);
  expect(full).not.toContain('class="tts-artifact-bar"');
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
  const markup = renderLocalized(
    createElement(TtsSettingsPanel, {
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
    }),
    "zh-CN",
  );
  expect(markup).toContain("语音生成");
  expect(markup).toContain("gemini-3.8-flash-tts");
  expect(markup).toContain("https://custom.example/v1beta");
  expect(markup).not.toContain("图片编辑");
  expect(normalizeIntegrationsEnabled({ tts: true, browser: false })).toEqual({ tts: true, browser: false });
  expect(resolveActionKind({ toolName: "mcp__eco_tts__create_speech" }).kind).toBe("speechCreate");
  expect(
    formatActionLine(
      { resolved: resolveActionKind({ toolName: "create_speech" }), phase: "done" },
      (key) => key,
    ),
  ).toBe("activity.done.speechCreate");
});
