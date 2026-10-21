import { expect, test } from "bun:test";
import { createElement } from "react";
import { i18n } from "../src/renderer/i18n";
import {
  coreDisplayName,
  runtimeCoreOptions,
  SidebarCoreSelector,
  visibleCoreOptions,
} from "../src/renderer/SidebarCoreSelector";
import type { AppLocale } from "../src/shared/locale";
import { renderLocalized } from "./i18n-test";

function renderSelector(locale: AppLocale, locked: boolean): string {
  return renderLocalized(
    createElement(SidebarCoreSelector, {
      coreKind: locked ? "codex" : "claude",
      locked,
      busy: false,
      codexAvailable: true,
      attentionItems: [],
      onChange: () => undefined,
      onOpenSearch: () => undefined,
      onSelectAttentionThread: () => undefined,
    }),
    locale,
  );
}

test("Cursor ACP display name is Cursor; ACP is a separate tag", async () => {
  const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
  try {
    await i18n.changeLanguage("zh-CN");
    expect(coreDisplayName("acp")).toBe("Cursor");
    await i18n.changeLanguage("en-US");
    expect(coreDisplayName("acp")).toBe("Cursor");
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});

test("Harness list never includes ACP; ACP lives in its own region", () => {
  expect(runtimeCoreOptions().some((option) => option.kind === "acp")).toBe(false);
  expect(visibleCoreOptions(true).some((option) => option.kind === "acp")).toBe(false);
  expect(visibleCoreOptions(false).map((option) => option.kind)).toEqual(["codex", "claude", "pi"]);
});

test("open menu partitions Harnesses and ACP as matching lists", () => {
  const markup = renderLocalized(
    createElement(SidebarCoreSelector, {
      coreKind: "claude",
      locked: false,
      busy: false,
      codexAvailable: true,
      cursorAvailable: false,
      cursorProbeLoading: false,
      initialMenuOpen: true,
      attentionItems: [],
      onChange: () => undefined,
      onOpenSearch: () => undefined,
      onSelectAttentionThread: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("Harness");
  expect(markup).toContain(">ACP<");
  expect(markup).toContain("sidebar-core-menu-region-label");
  expect(markup).toContain("sidebar-core-acp-tag");
  expect(markup).toContain("Cursor");
  expect(markup).not.toContain("启用 Cursor");
  expect(markup).not.toContain("重新检测");
  expect(markup).not.toContain('type="checkbox"');
  expect(markup).not.toContain("sidebar-core-acp-enable");
  expect(markup).not.toContain("运行核心");
  expect(markup).not.toContain("Cursor · ACP");
  expect(markup).toMatch(
    /sidebar-core-menu-region-label[\s\S]*Harness[\s\S]*sidebar-core-menu-region-label[\s\S]*>ACP</,
  );
  expect(markup).toContain("sidebar-core-menu-name");
  expect(markup).not.toMatch(/menuitemradio[\s\S]*Cursor[\s\S]*disabled/);
});

test("ACP Cursor row stays selectable when last probe failed", () => {
  const markup = renderLocalized(
    createElement(SidebarCoreSelector, {
      coreKind: "claude",
      locked: false,
      busy: false,
      codexAvailable: true,
      cursorAvailable: false,
      cursorUnavailableReason: "未找到 Cursor Agent CLI。",
      initialMenuOpen: true,
      attentionItems: [],
      onChange: () => undefined,
      onOpenSearch: () => undefined,
      onSelectAttentionThread: () => undefined,
    }),
    "zh-CN",
  );

  // The row is selectable because the reason is no longer a blocker, and the reason travels
  // as the row's tooltip (`title`, plus the hover tooltip the pointer user sees) instead of
  // being printed inside the row.
  expect(markup).toContain("未找到 Cursor Agent CLI。");
  expect(markup).not.toContain("先开启 Cursor 并完成配置检查。");
  expect(markup).toMatch(/title="未找到 Cursor Agent CLI。"/);
  expect(markup).not.toMatch(/menuitemradio[\s\S]*Cursor[\s\S]*disabled/);
});

test("locked ACP thread heading shows ACP tag when acpCoreVisible is false", async () => {
  const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
  try {
    await i18n.changeLanguage("zh-CN");
    const markup = renderLocalized(
      createElement(SidebarCoreSelector, {
        coreKind: "acp",
        locked: true,
        busy: false,
        codexAvailable: true,
        acpCoreVisible: false,
        attentionItems: [],
        onChange: () => undefined,
        onOpenSearch: () => undefined,
        onSelectAttentionThread: () => undefined,
      }),
      "zh-CN",
    );
    expect(markup).toContain("sidebar-core-heading-label");
    expect(markup).toContain("sidebar-core-acp-tag");
    expect(markup).toMatch(/sidebar-core-acp-tag[^>]*>ACP</);
    expect(markup).not.toContain("Cursor · ACP");
    expect(markup).not.toContain("外置");
    expect(markup).not.toContain("External");
    expect(markup).not.toContain('aria-haspopup="menu"');
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});

test("Core display names match the product labels in both locales", async () => {
  const previousLanguage = i18n.resolvedLanguage ?? i18n.language;
  try {
    expect(coreDisplayName("codex")).toBe("Codex");
    expect(coreDisplayName("claude")).toBe("Claude Code");

    await i18n.changeLanguage("zh-CN");
    expect(coreDisplayName(undefined)).toBe("Harness 未知");

    await i18n.changeLanguage("en-US");
    expect(coreDisplayName(undefined)).toBe("Unknown Harness");
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});

test("draft Core heading is switchable in both locales", () => {
  const chineseMarkup = renderSelector("zh-CN", false);
  const englishMarkup = renderSelector("en-US", false);

  expect(chineseMarkup).toContain("Claude Code");
  expect(chineseMarkup).toContain('aria-haspopup="menu"');
  expect(chineseMarkup).toContain('aria-expanded="false"');
  expect(chineseMarkup).toContain("lucide-chevron-down");
  expect(chineseMarkup).toContain('aria-label="搜索会话和项目"');
  expect(chineseMarkup).toContain('aria-label="需要关注的通知"');
  expect(chineseMarkup).toContain("lucide-bell");
  expect(englishMarkup).toContain('aria-label="Search threads and projects"');
  expect(englishMarkup).toContain('aria-label="Attention notifications"');
});

test("bound thread Core heading is read-only in both locales", () => {
  const chineseMarkup = renderSelector("zh-CN", true);
  const englishMarkup = renderSelector("en-US", true);

  expect(chineseMarkup).toContain("Codex");
  expect(chineseMarkup).not.toContain('aria-haspopup="menu"');
  expect(chineseMarkup).toContain('aria-label="搜索会话和项目"');
  expect(chineseMarkup).toContain('aria-label="需要关注的通知"');
  expect(englishMarkup).toContain('aria-label="Search threads and projects"');
  expect(englishMarkup).toContain('aria-label="Attention notifications"');
});

test("attention badge appears when items are present", () => {
  const markup = renderLocalized(
    createElement(SidebarCoreSelector, {
      coreKind: "claude",
      locked: false,
      busy: false,
      codexAvailable: true,
      attentionItems: [
        {
          id: "completed:t-1",
          threadId: "t-1",
          title: "完成任务",
          kind: "completed",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      onChange: () => undefined,
      onOpenSearch: () => undefined,
      onSelectAttentionThread: () => undefined,
    }),
    "zh-CN",
  );

  expect(markup).toContain("sidebar-core-attention-dot");
});
