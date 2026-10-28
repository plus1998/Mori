import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const rendererDir = new URL("../src/renderer/", import.meta.url);
const styles = readFileSync(new URL("styles.css", rendererDir), "utf8");
const moriStyles = readFileSync(new URL("mori-assistant.css", rendererDir), "utf8");
const moriPanel = readFileSync(new URL("MoriAssistant.tsx", rendererDir), "utf8");

function ruleBody(source: string, selector: string): string[] {
  const pattern = new RegExp(
    `(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "g",
  );
  return [...source.matchAll(pattern)].map((match) => match[2] ?? "");
}

/** Every `.spinning` declaration block in a stylesheet, with its containing media query. */
function spinningRules(source: string) {
  const pattern = /([^{}\n][^{}\n]*\.spinning[^{}\n]*)\{([^}]*)\}/g;
  return [...source.matchAll(pattern)].map((match) => ({
    selector: (match[1] ?? "").trim(),
    body: match[2] ?? "",
    reducedMotion: insideReducedMotion(source, match.index ?? 0),
  }));
}

function insideReducedMotion(source: string, index: number): boolean {
  const media = "@media (prefers-reduced-motion: reduce)";
  let cursor = 0;
  while (true) {
    const start = source.indexOf(media, cursor);
    if (start === -1 || start > index) return false;
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          if (index < i) return true;
          cursor = i + 1;
          break;
        }
      }
    }
  }
}

test("`.spinning` is a self-contained utility, not an ancestor-scoped one", () => {
  // Regression: `.spinning` was only animated under a handful of containers
  // (`.send-button`, `.settings-icon-button`, …), so spinners rendered anywhere
  // else — notably the Mori assistant dialog — sat frozen.
  const base = ruleBody(styles, ".spinning");
  expect(base).toHaveLength(1);
  expect(base[0]).toContain("animation: eco-spin");
  expect(base[0]).toContain("infinite");

  // The keyframes it points at must actually rotate a full turn.
  const keyframes = styles.match(/@keyframes eco-spin \{[^}]*\}/s)?.[0] ?? "";
  expect(keyframes).toContain("transform: rotate(360deg)");
});

test("no stylesheet freezes a `.spinning` icon outside reduced-motion opt-outs", () => {
  const freezing = [...spinningRules(styles), ...spinningRules(moriStyles)].filter(
    (rule) => /animation:\s*none/.test(rule.body) && !rule.reducedMotion,
  );
  expect(freezing.map((rule) => rule.selector)).toEqual([]);
});

test("Mori assistant spinners inherit the shared rotation", () => {
  // The dialog's save/answer/stop/send icons and its activity line all rely on `.spinning`,
  // and the dialog sheet never redeclares the utility itself.
  expect(moriPanel).toContain('className="spinning"');
  expect(spinningRules(moriStyles)).toEqual([]);

  // Duration overrides only tune speed — they never gate the animation.
  const durationOnly = spinningRules(styles).filter((rule) => rule.body.includes("animation-duration"));
  expect(durationOnly.length).toBeGreaterThan(0);
  for (const rule of durationOnly) expect(rule.body).not.toContain("animation: none");
});
