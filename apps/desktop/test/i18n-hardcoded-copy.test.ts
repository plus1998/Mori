import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const desktopRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rendererRoot = path.join(desktopRoot, "src/renderer");

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/** JSX attributes whose literal value is read out by assistive tech or shown as a tooltip/hint. */
const UI_ATTRIBUTE_NAMES = new Set([
  "label",
  "title",
  "placeholder",
  "heading",
  "description",
  "tooltip",
  "aria-label",
  "emptyText",
  "helperText",
  "subtitle",
  "confirmText",
  "okText",
  "cancelText",
]);

/**
 * Existing hardcoded copy, per file. This is a **ratchet**: the numbers may only go down.
 *
 * A CJK JSX text node or a CJK UI-attribute literal never reaches `i18n-catalogs.ts`, so it renders
 * in Chinese no matter which locale the user picked. Every entry below is a screen that is still
 * wrong in en-US right now, not a state we accept: localizing a screen means deleting its entry or
 * lowering its number in the same change, and new code must never add one.
 */
const HARDCODED_COPY_BASELINE: Record<string, number> = {
  "src/renderer/TtsSettingsPanel.tsx": 15,
  "src/renderer/ImageGenerationSettingsPanel.tsx": 13,
  "src/renderer/CommitModelPricingCompact.tsx": 3,
  "src/renderer/ComposerPlanModeToggle.tsx": 3,
  "src/renderer/ApiCompatToggle.tsx": 2,
  "src/renderer/RoutePricingDisplay.tsx": 2,
  "src/renderer/agent-theme-color-field.tsx": 2,
  "src/renderer/ComposerSkillsSlashMenu.tsx": 1,
  "src/renderer/SubagentSettingsSection.tsx": 1,
  "src/renderer/components/CodexOAuthLogin.tsx": 1,
};

function rendererSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) {
      rendererSourceFiles(file, out);
    } else if (/\.tsx$/.test(file)) {
      out.push(file);
    }
  }
  return out;
}

function hardcodedCopy(sourceFile: string): string[] {
  const source = readFileSync(sourceFile, "utf8");
  const parsed = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: string[] = [];
  const lineOf = (position: number) => parsed.getLineAndCharacterOfPosition(position).line + 1;
  const relativePath = path.relative(desktopRoot, sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (text && CJK.test(text)) {
        findings.push(`${relativePath}:${lineOf(node.pos)} JSX text "${text.slice(0, 60)}"`);
      }
    }
    if (ts.isJsxAttribute(node) && node.initializer && UI_ATTRIBUTE_NAMES.has(node.name.getText())) {
      const initializer = node.initializer;
      const literal = ts.isStringLiteral(initializer)
        ? initializer.text
        : ts.isJsxExpression(initializer) &&
            initializer.expression &&
            ts.isStringLiteral(initializer.expression)
          ? initializer.expression.text
          : undefined;
      if (literal && CJK.test(literal)) {
        findings.push(`${relativePath}:${lineOf(node.pos)} ${node.name.getText()}="${literal.slice(0, 60)}"`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return findings;
}

test("renderer does not add new hardcoded copy outside the catalogs", () => {
  const regressions: string[] = [];
  const shrinkable: string[] = [];
  const scannedFiles = new Set<string>();

  for (const file of rendererSourceFiles(rendererRoot)) {
    const relativePath = path.relative(desktopRoot, file);
    const findings = hardcodedCopy(file);
    const allowed = HARDCODED_COPY_BASELINE[relativePath] ?? 0;
    if (findings.length > allowed) {
      regressions.push(
        `${relativePath}: ${findings.length} hardcoded strings (allowed ${allowed})\n  ${findings
          .slice(allowed, allowed + 10)
          .join("\n  ")}`,
      );
    } else if (findings.length < allowed) {
      shrinkable.push(`${relativePath}: ${findings.length} < baseline ${allowed}`);
    }
    scannedFiles.add(relativePath);
  }

  for (const relativePath of Object.keys(HARDCODED_COPY_BASELINE)) {
    if (!scannedFiles.has(relativePath)) {
      shrinkable.push(`${relativePath}: baseline entry points at a file that no longer has findings`);
    }
  }

  expect(regressions).toEqual([]);
  // Debt that has already been paid must be deleted from the baseline, otherwise the ratchet loosens.
  expect(shrinkable).toEqual([]);
});
