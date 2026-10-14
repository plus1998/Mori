import type { Highlighter, ThemedToken } from "shiki";
import type { DiffDisplayLine } from "./diff-display-lines";

export { resolveShikiLanguage } from "./diff-highlight-language";

function themeForApp(theme: "light" | "dark"): "github-light" | "github-dark" {
  return theme === "dark" ? "github-dark" : "github-light";
}

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterRetainCount = 0;
let highlighterReleaseTimer: ReturnType<typeof setTimeout> | undefined;
const SHIKI_RELEASE_DELAY_MS = 30_000;

export function getDiffHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki")
      .then(({ createHighlighter }) =>
        createHighlighter({
          themes: ["github-light", "github-dark"],
          langs: [],
        }),
      )
      .catch((error) => {
        highlighterPromise = null;
        throw error;
      });
  }
  return highlighterPromise;
}

export function retainDiffHighlighter(): void {
  highlighterRetainCount += 1;
  if (highlighterReleaseTimer) {
    clearTimeout(highlighterReleaseTimer);
    highlighterReleaseTimer = undefined;
  }
}

/** Dispose the shared highlighter after the last diff viewer unmounts. */
export function releaseDiffHighlighter(): void {
  highlighterRetainCount = Math.max(0, highlighterRetainCount - 1);
  if (highlighterRetainCount > 0) {
    return;
  }
  if (highlighterReleaseTimer) {
    clearTimeout(highlighterReleaseTimer);
  }
  highlighterReleaseTimer = setTimeout(() => {
    highlighterReleaseTimer = undefined;
    if (highlighterRetainCount > 0 || !highlighterPromise) {
      return;
    }
    const pending = highlighterPromise;
    highlighterPromise = null;
    void pending
      .then((highlighter) => {
        highlighter.dispose();
      })
      .catch(() => undefined);
  }, SHIKI_RELEASE_DELAY_MS);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function themedTokensToHtml(tokens: ThemedToken[]): string {
  if (tokens.length === 0) return "\u00a0";
  return (
    tokens
      .map((token) => {
        const color = token.color ? `color:${token.color}` : "";
        const fontStyle =
          token.fontStyle && token.fontStyle > 0
            ? [
                token.fontStyle & 1 ? "font-style:italic" : "",
                token.fontStyle & 2 ? "font-weight:bold" : "",
                token.fontStyle & 4 ? "text-decoration:underline" : "",
              ]
                .filter(Boolean)
                .join(";")
            : "";
        const style = [color, fontStyle].filter(Boolean).join(";");
        const content = escapeHtml(token.content);
        if (!style) return content || "";
        return `<span style="${style}">${content}</span>`;
      })
      .join("") || "\u00a0"
  );
}

async function resolveLoadedLanguage(highlighter: Highlighter, lang: string): Promise<string> {
  if (lang === "plaintext") return lang;
  const loaded = highlighter.getLoadedLanguages();
  if (loaded.includes(lang)) return lang;
  await highlighter.loadLanguage(lang as never);
  return lang;
}

function tokenLinesFromCode(
  highlighter: Highlighter,
  code: string,
  lang: string,
  theme: "github-light" | "github-dark",
): ThemedToken[][] {
  if (!code) return [];
  const result = highlighter.codeToTokens(code, { lang: lang as never, theme });
  return result.tokens;
}

/**
 * Highlight structured diff display lines like Codex:
 * tokenize deletion+context as the old side, insert+context as the new side,
 * then map tokenized lines back to the interleaved patch display.
 */
export async function highlightDiffDisplayLines(
  lines: DiffDisplayLine[],
  language: string,
  appTheme: "light" | "dark",
): Promise<(string | null)[]> {
  const htmls: (string | null)[] = lines.map(() => null);
  if (lines.length === 0) return htmls;

  const oldTexts: string[] = [];
  const oldToDisplay: number[] = [];
  const newTexts: string[] = [];
  const newToDisplay: number[] = [];

  lines.forEach((line, index) => {
    if (line.kind === "delete" || line.kind === "context") {
      oldTexts.push(line.text);
      oldToDisplay.push(index);
    }
    if (line.kind === "insert" || line.kind === "context") {
      newTexts.push(line.text);
      newToDisplay.push(index);
    }
  });

  {
    const highlighter = await getDiffHighlighter();
    const lang = await resolveLoadedLanguage(highlighter, language);
    const theme = themeForApp(appTheme);

    const oldTokenLines = tokenLinesFromCode(highlighter, oldTexts.join("\n"), lang, theme);
    const newTokenLines = tokenLinesFromCode(highlighter, newTexts.join("\n"), lang, theme);

    oldTokenLines.forEach((tokens, i) => {
      const displayIndex = oldToDisplay[i];
      if (displayIndex === undefined) return;
      const line = lines[displayIndex];
      if (!line) return;
      if (line.kind === "delete") {
        htmls[displayIndex] = themedTokensToHtml(tokens);
      } else if (line.kind === "context") {
        htmls[displayIndex] = themedTokensToHtml(tokens);
      }
    });

    newTokenLines.forEach((tokens, i) => {
      const displayIndex = newToDisplay[i];
      if (displayIndex === undefined) return;
      const line = lines[displayIndex];
      if (!line) return;
      if (line.kind === "insert" || line.kind === "context") {
        htmls[displayIndex] = themedTokensToHtml(tokens);
      }
    });
  }

  return htmls;
}
