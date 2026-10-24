import { expect, test } from "bun:test";
import i18next from "i18next";
import { i18nCatalogs } from "../src/shared/i18n-catalogs";

/**
 * English copy has no plural agreement unless the key carries `_one` / `_other`.
 *
 * i18next resolves `t("x.count", { count: n })` through `Intl.PluralRules`; when the suffixed forms
 * are missing it silently falls back to the base key, so every count renders plural:
 * `1 accounts`, `1 chats`, `1 lines`. Chinese is unaffected (a single plural category), which is
 * exactly why this class of bug survives review — the zh UI always looks correct.
 *
 * PLURAL_DEBT is a register, not a budget: delete an entry when you convert the key
 * (`key_one` / `key_other` in **both** locales, call site passes `count: number`), or reword the
 * English away from "number + noun". Adding a new "N <noun>" string without plural forms fails.
 */

// `{{count}} lines`, `{{total}} providers`, `{{rows}} rows` …
const COUNT_THEN_NOUN = /\{\{\s*([a-z][\w.]*)\s*\}\}\s+([a-z][a-z-]{2,}s)\b/u;

// Interpolations that are not counts — `{{name}} actions`, `{{version}} is available`.
const NON_COUNT_VARIABLES = new Set([
  "name",
  "label",
  "version",
  "key",
  "online",
  "local",
  "orchestration",
  "provider",
  "agent",
  "duration",
  "time",
  "id",
  "url",
  "path",
  "model",
  "title",
  "description",
  "reason",
  "status",
  "value",
  "type",
  "error",
  "message",
  "unit",
  "mode",
  "language",
  "locale",
  "size",
  "cost",
  "price",
  "percent",
]);

// Words that end in "s" but are mass nouns or function words — "1 news", "1 status" is not a count.
const NOT_A_PLURAL_NOUN = new Set([
  "news",
  "status",
  "progress",
  "across",
  "alias",
  "bias",
  "canvas",
  "plus",
  "less",
  "does",
  "bus",
  "gas",
  "business",
  "this",
  "thus",
]);

const PLURAL_DEBT: readonly string[] = [
  "activity.codemode.callCount",
  "activity.summary.agents",
  "activity.summary.browser",
  "activity.summary.commands",
  "activity.summary.computerUse",
  "activity.summary.createdTasks",
  "activity.summary.editedFiles",
  "activity.summary.images",
  "activity.summary.readFiles",
  "activity.summary.searched",
  "activity.summary.skills",
  "activity.summary.tools",
  "activity.summary.updatedTasks",
  "activity.summary.web",
  "activity.summary.writtenFiles",
  "agent.chip.mcp",
  "agent.chip.mcpTools",
  "app.running.resourceCount",
  "asr.profileCount",
  "codexSwitch.queryFailed",
  "composer.route.moreSubagents",
  "dialog.scripts.count",
  "dialog.stop.changedFiles",
  "fileBrowser.tableLimit",
  "git.conflict.description",
  "markdown.html.lineCount",
  "modelSpec.overrideCount",
  "scheduling.everyDays",
  "scheduling.everyHours",
  "scheduling.everyMinutes",
  "settings.center.syncStatus.summary.agentCount",
  "settings.center.syncStatus.summary.orchestrationCount",
  "settings.center.syncStatus.summary.profileCount",
  "settings.center.syncStatus.summary.scriptArgs",
  "settings.contextWindow.tokens",
  "settings.maxOutput.tokens",
  "settings.mcp.json.error.tooMany",
  "settings.mcp.json.validMany",
  "settings.mcp.passedWithTools",
  "settings.models.editor.rosterCountAria",
  "settings.models.resources.agentCount",
  "settings.skills.installs",
  "settings.storage.deletedCount",
  "settings.storage.threadCount",
  "subagentSettings.exported",
  "subagentSettings.imported",
  "subagentSettings.importedWithErrors",
  "task.imageDisplay.bytes",
  "terminal.autoClose",
  "thread.followUpQueueActive",
  "thread.projectSessionCount",
  "todo.count",
  "workspace.diff.editedFiles",
  "workspace.diff.fileCount",
  "workspaceGit.behind",
  "workspaceGit.confirmDiscardAll",
];

function hasPluralForms(key: string): boolean {
  return (["zh-CN", "en-US"] as const).every((locale) => {
    const catalog = i18nCatalogs[locale].translation;
    return `${key}_one` in catalog && `${key}_other` in catalog;
  });
}

test("en-US copy that interpolates a number before a noun carries plural forms", () => {
  const offenders: string[] = [];
  for (const [key, value] of Object.entries(i18nCatalogs["en-US"].translation)) {
    if (/_one$|_other$/u.test(key)) continue;
    const match = COUNT_THEN_NOUN.exec(value);
    if (!match) continue;
    if (NON_COUNT_VARIABLES.has(match[1])) continue;
    if (NOT_A_PLURAL_NOUN.has(match[2])) continue;
    if (hasPluralForms(key)) continue;
    offenders.push(key);
  }
  offenders.sort();

  const debt = new Set(PLURAL_DEBT);
  const unexpected = offenders.filter((key) => !debt.has(key));
  const stale = PLURAL_DEBT.filter((key) => !offenders.includes(key));

  // Two separate assertions so a fix that leaves a stale entry behind is still visible.
  expect(unexpected).toEqual([]);
  expect(stale).toEqual([]);
});

test("converted plural keys render singular for count=1 and plural above 1", async () => {
  const converted = [
    "app.running.displayCount",
    "app.running.pendingDisplayRestores",
    "settings.openaiAccounts.accountCount",
    "settings.models.providerCount",
    "settings.openaiAccounts.resetCredits",
    "settings.openaiAccounts.bulkImportPendingLines",
    "codexModels.reasoningLevels",
  ];

  const instances = {} as Record<string, ReturnType<typeof i18next.createInstance>>;
  for (const lng of ["en-US", "zh-CN"]) {
    const instance = i18next.createInstance();
    await instance.init({
      resources: i18nCatalogs,
      lng,
      fallbackLng: "en-US",
      supportedLngs: ["zh-CN", "en-US"],
      initImmediate: false,
      interpolation: { escapeValue: false },
      returnNull: false,
    });
    instances[lng] = instance;
  }

  for (const key of converted) {
    // A base key next to its plural forms lets a call site that forgets `count` render the wrong one.
    expect(key in i18nCatalogs["en-US"].translation).toBe(false);
    expect(key in i18nCatalogs["zh-CN"].translation).toBe(false);

    const en = instances["en-US"];
    const one = en.t(key, { count: 1 });
    const many = en.t(key, { count: 3 });
    expect(one).toContain("1");
    expect(many).toContain("3");
    expect(one).not.toBe(many);
    expect(one).not.toMatch(/\b\w{3,}s\b/u);
    expect(many).toMatch(/\b\w{3,}s\b/u);

    // Chinese does not inflect: only the interpolated number may differ.
    const zh = instances["zh-CN"];
    const strip = (value: string) => value.replace(/\d+/gu, "#");
    expect(strip(zh.t(key, { count: 1 }))).toBe(strip(zh.t(key, { count: 3 })));
  }
});
