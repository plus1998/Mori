import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { GeneralSettingsPanel } from "../src/renderer/GeneralSettingsPanel";
import { NotificationPreferencesPanel } from "../src/renderer/NotificationPreferencesPanel";
import { renderLocalized } from "./i18n-test";

test("appearance settings renders theme and typography controls in Chinese", () => {
  const markup = renderLocalized(
    createElement(GeneralSettingsPanel, {
      theme: "system",
      onThemeChange: () => undefined,
      typography: { uiFontSize: 14, codeFontSize: 12 },
      onTypographyChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("外观");
  expect(markup).toContain("主题");
  expect(markup).toContain("UI 字号");
  expect(markup).toContain("代码字体大小");
  expect(markup).not.toContain("语言");
  expect(markup).not.toContain("模型吞吐");
  expect(markup).toContain("14<small>px</small>");
  expect(markup).toContain("12<small>px</small>");
  expect(markup).toContain('aria-label="减小UI 字号"');
  expect(markup).toContain('aria-label="增大代码字体大小"');
});

test("appearance settings renders English labels without language section", () => {
  const markup = renderLocalized(
    createElement(GeneralSettingsPanel, {
      theme: "light",
      onThemeChange: () => undefined,
      typography: { uiFontSize: 15, codeFontSize: 13 },
      onTypographyChange: () => undefined,
    }),
    "en-US",
  );

  expect(markup).toContain("Appearance");
  expect(markup).toContain("Theme");
  expect(markup).not.toContain("Language");
  expect(markup).toContain("UI font size");
  expect(markup).toContain('aria-label="Decrease UI font size"');
  expect(markup).not.toContain("Model throughput");
});

test("preferences panel puts language under the general section", () => {
  const markup = renderLocalized(
    createElement(NotificationPreferencesPanel, {
      settings: {
        turnCompletion: "unfocused",
        permissionEnabled: true,
        questionEnabled: true,
      },
      onSave: async () => undefined,
      localePreference: "system",
      onLocalePreferenceChange: () => undefined,
      cacheBreakTipsEnabled: true,
      onCacheBreakTipsEnabledChange: () => undefined,
      followUpDeliveryMode: "steer",
      onFollowUpDeliveryModeChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("常规");
  expect(markup).toContain("语言");
  expect(markup).toContain("跟随系统");
  expect(markup).toContain("简体中文");
  expect(markup).toContain("English");
  expect(markup).toContain("通知");
  expect(markup).toContain("显示");
  expect(markup).toContain("Cache break 提示");
  expect(markup).toContain("配置漂移、缓存失效、命中率骤降与长闲置时显示 prompt cache 提示。");
  expect(markup).toContain("跟进处理方式");
  expect(markup).toContain("加入队列");
  expect(markup).toContain("调整方向");
  expect(markup).toContain("默认审批模式");
  expect(markup).toContain("新建会话时 Composer 默认使用的执行审批档位。");
  expect(markup).toContain("请求批准");
  expect(markup).toContain("替我审批");
  expect(markup).toContain("完全访问");
  expect(markup).toContain("思考内容");
  expect(markup).toContain("生成时显示，完成后自动隐藏。");
  expect(markup).toContain(">折叠<");
  expect(markup).toContain(">展开<");

  const generalIdx = markup.indexOf('settings-section-label">常规<');
  const notificationsIdx = markup.indexOf('settings-section-label">通知<');
  const displayIdx = markup.indexOf('settings-section-label">显示<');
  const billingIdx = markup.indexOf("显示计费");
  const thinkingLabelIdx = markup.indexOf("<strong>思考内容</strong>");
  const cacheIdx = markup.indexOf("Cache break 提示");
  const tokenIdx = markup.indexOf("模型吞吐");
  expect(generalIdx).toBeGreaterThan(-1);
  expect(notificationsIdx).toBeGreaterThan(generalIdx);
  expect(displayIdx).toBeGreaterThan(notificationsIdx);
  expect(billingIdx).toBeGreaterThan(displayIdx);
  expect(tokenIdx).toBeGreaterThan(displayIdx);
  expect(thinkingLabelIdx).toBeGreaterThan(displayIdx);
  expect(cacheIdx).toBeGreaterThan(displayIdx);
  expect(thinkingLabelIdx).toBeGreaterThan(tokenIdx);
  expect(cacheIdx).toBeGreaterThan(thinkingLabelIdx);
});

test("preferences panel renders cache break tips in English", () => {
  const markup = renderLocalized(
    createElement(NotificationPreferencesPanel, {
      settings: {
        turnCompletion: "unfocused",
        permissionEnabled: true,
        questionEnabled: true,
      },
      onSave: async () => undefined,
      localePreference: "en-US",
      onLocalePreferenceChange: () => undefined,
      cacheBreakTipsEnabled: false,
      onCacheBreakTipsEnabledChange: () => undefined,
      followUpDeliveryMode: "queue",
      onFollowUpDeliveryModeChange: () => undefined,
    }),
    "en-US",
  );

  expect(markup).toContain("Cache break tips");
  expect(markup).toContain(
    "Show prompt-cache tips for config drift, cache invalidation, hit-rate drops, and long idle sessions.",
  );
  expect(markup).toContain("Follow-up handling");
  expect(markup).toContain("Queue");
  expect(markup).toContain("Steer");
  expect(markup).toContain("Default approval mode");
  expect(markup).toContain("Execution approval mode used by Composer for new sessions.");
  expect(markup).toContain("Request approval");
  expect(markup).toContain("Approve for me");
  expect(markup).toContain("Full access");
  expect(markup).toContain("Thinking content");
  expect(markup).toContain(
    "Visible while generating; hidden after it finishes.",
  );
  expect(markup).toContain(">Collapsed<");
  expect(markup).toContain(">Expanded<");
  expect(markup).toMatch(/type="checkbox"(?![^>]*checked)/);
});

test("preferences panel renders the Composer billing toggle", () => {
  const markup = renderLocalized(
    createElement(NotificationPreferencesPanel, {
      settings: {
        turnCompletion: "unfocused",
        permissionEnabled: true,
        questionEnabled: true,
      },
      onSave: async () => undefined,
      localePreference: "system",
      onLocalePreferenceChange: () => undefined,
      cacheBreakTipsEnabled: true,
      onCacheBreakTipsEnabledChange: () => undefined,
      followUpDeliveryMode: "steer",
      onFollowUpDeliveryModeChange: () => undefined,
      showBilling: false,
      onShowBillingChange: () => undefined,
      tokenSpeedMode: "throughput",
      onTokenSpeedModeChange: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("显示计费");
  expect(markup).toContain("在 Composer 中显示会话累计用量和费用。");
  expect(markup).toContain("模型吞吐");
  expect(markup).toContain("显示首字时间（TTFT）与总吞吐。");
  expect(markup).toContain(">隐藏<");
  expect(markup).toContain(">吞吐<");
  expect(markup).toContain(">详细<");
  expect(markup).toMatch(/aria-pressed="true"\s*>吞吐</);
  expect(markup).toMatch(/type="checkbox"[^>]*checked/);
});

test("general preferences panel renders the token speed segmented control, hidden by default", () => {
  const markup = renderLocalized(
    createElement(NotificationPreferencesPanel, {
      settings: {
        turnCompletion: "unfocused",
        permissionEnabled: true,
        questionEnabled: true,
      },
      onSave: async () => undefined,
      localePreference: "en-US",
      onLocalePreferenceChange: () => undefined,
      cacheBreakTipsEnabled: false,
      onCacheBreakTipsEnabledChange: () => undefined,
      followUpDeliveryMode: "queue",
      onFollowUpDeliveryModeChange: () => undefined,
    }),
    "en-US",
  );

  expect(markup).toContain("Display");
  expect(markup).toContain("Model throughput");
  expect(markup).toContain(
    "No speed info is shown.",
  );
  expect(markup).toContain(">Hidden<");
  expect(markup).toContain(">Throughput<");
  expect(markup).toContain(">Detailed<");
  expect(markup).toMatch(/aria-pressed="true"\s*>Hidden/);
  expect(markup).toMatch(/type="checkbox"(?![^>]*checked)/);
});

test("thinking content hint follows the selected display mode", () => {
  const renderWithMode = (mode: "ephemeral" | "collapsed" | "expanded") =>
    renderLocalized(
      createElement(NotificationPreferencesPanel, {
        settings: {
          turnCompletion: "unfocused",
          permissionEnabled: true,
          questionEnabled: true,
        },
        onSave: async () => undefined,
        localePreference: "system",
        onLocalePreferenceChange: () => undefined,
        cacheBreakTipsEnabled: false,
        onCacheBreakTipsEnabledChange: () => undefined,
        followUpDeliveryMode: "queue",
        onFollowUpDeliveryModeChange: () => undefined,
        thinkingDisplayMode: mode,
        onThinkingDisplayModeChange: () => undefined,
      }),
      "zh-CN",
    );
  expect(renderWithMode("ephemeral")).toContain("生成时显示，完成后自动隐藏。");
  expect(renderWithMode("collapsed")).toContain("完成后默认收起，可随时展开。");
  expect(renderWithMode("expanded")).toContain("完成后默认展开，可随时收起。");
});
test("settings sidebar uses the configurable UI font size", () => {
  const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

  expect(styles).toMatch(
    /\.settings-nav-back,\s*\.settings-nav-item\s*\{[^}]*font-size: var\(--ui-font-size\);/s,
  );
  expect(styles).toMatch(/\.settings-nav-search-input\s*\{[^}]*font-size: var\(--ui-font-size\);/s);
  expect(styles).toMatch(
    /\.settings-nav-group-label\s*\{[^}]*font-size: max\(10px, calc\(var\(--ui-font-size\) - 3px\)\);/s,
  );
});

test("settings open fully hides the primary sidebar", () => {
  const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

  expect(styles).toMatch(
    /\.shell\.shell-settings-open\s*>\s*\.codex-sidebar\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s,
  );
  expect(styles).toMatch(
    /html\[data-platform="darwin"\]\s*\.settings-nav,\s*html\[data-platform="darwin"\]\[data-window-focused="true"\]\s*\.settings-nav\s*\{[^}]*background:\s*transparent;/s,
  );
});
