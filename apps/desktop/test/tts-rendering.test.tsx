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

test("Feed audio links the actual tool ID, shows transcript/style and does not fetch unrelated artifacts", () => {
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
  expect(markup).toContain(artifact.text);
  expect(markup).toContain(artifact.parameters.style);
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
