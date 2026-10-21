import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { i18nCatalogs } from "../src/shared/i18n-catalogs";

const desktopRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = path.join(desktopRoot, "src");
const catalogFile = path.join(sourceRoot, "shared/i18n-catalogs.ts");

/**
 * Every key the source asks for must exist in **both** locale catalogs.
 *
 * i18next falls back to the key itself when a lookup misses, so a typo — or a key added to only
 * one language — renders `common.clear` inside a tooltip instead of a word. The zh/en parity test
 * cannot catch that: it compares the two catalogs to each other, never to the call sites.
 */
// `this.deps.text(key)` is how a main-process class receives the catalog lookup (see
// `main/openai-account-assistant.ts`), so it counts as a call site like `mainText()`.
const TRANSLATION_CALL =
  /(?:^|[^\w$.])(?:[A-Za-z_$][\w$]*\.)?t\(\s*"([^"]+)"|translateCatalog\([^"']{0,60}?"([^"]+)"|mainText\([^"']{0,60}?"([^"]+)"|deps\.text\([^"']{0,60}?"([^"]+)"/g;

// Catalog keys are always dotted (`settings.models.addProvider`), which keeps a neighbouring
// literal such as `kind === "plan"` inside a translateCatalog() call from being read as a key.
const CATALOG_KEY_SHAPE = /^[a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/;

// `translateCatalog(locale, kind === "plan" ? "a.b" : "a.c")` picks the key inline; the primary
// pattern only reaches the condition, so both branches are collected separately.
const TERNARY_KEYS = /\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) {
      sourceFiles(file, out);
    } else if (/\.(ts|tsx)$/.test(name) && file !== catalogFile) {
      out.push(file);
    }
  }
  return out;
}

test("every translation key used in source exists in both locale catalogs", () => {
  const zhKeys = new Set(Object.keys(i18nCatalogs["zh-CN"].translation));
  const enKeys = new Set(Object.keys(i18nCatalogs["en-US"].translation));
  const missing: string[] = [];

  for (const file of sourceFiles(sourceRoot)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(TRANSLATION_CALL)) {
        const key = match[1] ?? match[2] ?? match[3] ?? match[4];
        if (!key || !CATALOG_KEY_SHAPE.test(key)) continue;
        checkKey(missing, file, index + 1, key, zhKeys, enKeys);
      }
      if (/\bt\(|translateCatalog\(|mainText\(|deps\.text\(/.test(line)) {
        for (const match of line.matchAll(TERNARY_KEYS)) {
          for (const key of [match[1], match[2]]) {
            if (!key || !CATALOG_KEY_SHAPE.test(key)) continue;
            checkKey(missing, file, index + 1, key, zhKeys, enKeys);
          }
        }
      }
    });
  }

  expect(missing).toEqual([]);
});

function checkKey(
  missing: string[],
  file: string,
  line: number,
  key: string,
  zhKeys: Set<string>,
  enKeys: Set<string>,
): void {
  // i18next plural lookup: `t("x.count", { count: n })` resolves to `x.count_one` / `x.count_other`
  // and the bare base key deliberately does not exist. Accept that shape, but only when *both*
  // plural forms are present in *both* locales — a half-converted key silently renders the key name.
  const pluralBase = ["zh-CN", "en-US"].every((locale) => {
    const keys = locale === "zh-CN" ? zhKeys : enKeys;
    return keys.has(`${key}_one`) && keys.has(`${key}_other`);
  });
  if (pluralBase && !zhKeys.has(key) && !enKeys.has(key)) return;

  const absent: string[] = [];
  if (!zhKeys.has(key)) absent.push("zh-CN");
  if (!enKeys.has(key)) absent.push("en-US");
  if (absent.length > 0) {
    missing.push(`${path.relative(desktopRoot, file)}:${line} "${key}" missing in ${absent.join(", ")}`);
  }
}
