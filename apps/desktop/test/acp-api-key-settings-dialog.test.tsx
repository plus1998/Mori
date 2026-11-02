import { expect, test } from "bun:test";
import { createElement } from "react";
import { AcpApiKeySettingsDialog } from "../src/renderer/AcpApiKeySettingsDialog";
import { DefaultAgentSettingsPanel } from "../src/renderer/DefaultAgentSettingsPanel";
import { renderLocalized } from "./i18n-test";

test("API key dialog renders input, hint, cancel and save", () => {
  const markup = renderLocalized(
    createElement(AcpApiKeySettingsDialog, {
      onSave: () => undefined,
      onClose: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain('id="acp-cursor-api-key"');
  expect(markup).toContain("用于无法浏览器登录的环境");
  expect(markup).toContain("取消");
  expect(markup).toContain("保存");
});

test("API key dialog pre-fills the current key", () => {
  const markup = renderLocalized(
    createElement(AcpApiKeySettingsDialog, {
      currentKey: "ck-test-123",
      onSave: () => undefined,
      onClose: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain('value="ck-test-123"');
});

test("panel shows API key entry with configured / not-set state", () => {
  const notSet = renderLocalized(
    createElement(DefaultAgentSettingsPanel, {
      defaultCoreKind: "acp",
      codexAvailable: true,
      onChange: () => undefined,
    }),
    "zh-CN",
  );
  expect(notSet).toContain("Cursor API Key");
  expect(notSet).toContain("未设置");

  const set = renderLocalized(
    createElement(DefaultAgentSettingsPanel, {
      defaultCoreKind: "acp",
      codexAvailable: true,
      acpCursorApiKeyConfigured: true,
      onChange: () => undefined,
    }),
    "zh-CN",
  );
  expect(set).toContain("已配置");
});

test("API key dialog shows cloud sync control when connected", () => {
  const markup = renderLocalized(
    createElement(AcpApiKeySettingsDialog, {
      centerServerSyncVisible: true,
      onSyncDomain: async () => ({
        domain: "defaultAgent",
        mode: "pull",
        settingsPushed: false,
        settingsPulled: false,
        secretsPushed: 0,
        secretsPulled: 1,
        syncedAt: "2026-01-01T00:00:00.000Z",
        vaultStatus: {
          hasVaultKey: true,
          state: "ready",
          hasPasswordWrap: true,
          needsPasswordWrap: false,
        },
      }),
      onSave: () => undefined,
      onClose: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("settings-sync-control");
  expect(markup).toContain("settings-sync-trigger");
});

test("panel routes key management to provider settings without the legacy single-key dialog", () => {
  const markup = renderLocalized(
    createElement(DefaultAgentSettingsPanel, {
      defaultCoreKind: "acp",
      codexAvailable: true,
      acpCursorApiKeyConfigured: true,
      onManageCursorApiKeys: () => undefined,
      onChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("Cursor API Key");
  expect(markup).toContain("已配置");
  expect(markup).not.toContain("acp-api-key-settings-modal");
});
