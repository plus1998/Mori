import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  countDiffFileStats,
  GitDiffViewer,
  parseDiff,
  resolveDiffLanguage,
} from "../src/renderer/GitDiffViewer";
import {
  buildDiffDocFromFile,
  buildDiffDocFromPatch,
  collectDiffLineTexts,
  diffFilePath,
} from "../src/renderer/prosemirror/diff-from-patch";
import { buildDiffTree } from "../src/renderer/WorkspaceDiffFileTree";

const typescriptPatch = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1 +1 @@",
  "-const value: number = 1;",
  "+const value: number = 2;",
].join("\n");

test("resolveDiffLanguage maps common review file extensions", () => {
  expect(resolveDiffLanguage("src/App.tsx")).toBe("tsx");
  expect(resolveDiffLanguage("scripts/release.sh")).toBe("shell");
  expect(resolveDiffLanguage("README.md")).toBe("markdown");
  expect(resolveDiffLanguage("assets/logo.bin")).toBeUndefined();
});

test("GitDiffViewer renders the structured hunk review shell", () => {
  const html = renderToStaticMarkup(
    createElement(GitDiffViewer, {
      patch: typescriptPatch,
      selectedPath: "src/example.ts",
      originalContent: "const value: number = 1;\n",
      currentContent: "const value: number = 2;\n",
      additions: 1,
      deletions: 1,
    }),
  );

  expect(html).toContain("workspace-diff-file-toolbar");
  expect(html).toContain("workspace-diff-file-toolbar-path");
  expect(html).toContain("src/example.ts");
  expect(html).toContain("diff-stat-add");
  expect(html).toContain("workspace-diff-code-scroll");
  expect(html).toContain("pm-diff-viewer");
  expect(html).toContain("workspace-diff-code-editor");
  expect(html).toContain("pm-diff-line is-delete");
  expect(html).toContain("pm-diff-line is-insert");
  expect(html).toContain("const value: number = 1;");
  expect(html).toContain("const value: number = 2;");
  expect(html).not.toContain("pm-diff-line-marker");
  expect(html).not.toContain("workspace-diff-view-segmented");
  expect(html).not.toContain("workspace-diff-code-loading");
});

test("countDiffFileStats counts inserted and deleted rows", () => {
  const files = parseDiff(typescriptPatch);
  expect(countDiffFileStats(files[0]!)).toEqual({ additions: 1, deletions: 1 });
});

test("review parser decodes C-quoted UTF-8 and preserves spaces in Git paths", () => {
  const unicode = typescriptPatch.replaceAll("a/src/example.ts", '"a/\\346\\265\\213\\350\\257\\225\\tfile.ts"').replaceAll("b/src/example.ts", '"b/\\346\\265\\213\\350\\257\\225\\tfile.ts"');
  const quoted = parseDiff(unicode)[0];
  expect(quoted && diffFilePath(quoted)).toBe("测试\tfile.ts");
  const spaced = parseDiff(typescriptPatch.replaceAll("src/example.ts", "src/file with spaces.ts"))[0];
  expect(spaced && diffFilePath(spaced)).toBe("src/file with spaces.ts");
});

test("buildDiffDocFromPatch filters selected path and encodes insert/delete lines", () => {
  const multi = [
    typescriptPatch,
    "diff --git a/other.ts b/other.ts",
    "index 1111111..2222222 100644",
    "--- a/other.ts",
    "+++ b/other.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");

  const selected = buildDiffDocFromPatch(multi, "src/example.ts");
  expect(selected).not.toBeNull();
  const rows = collectDiffLineTexts(selected!);
  expect(rows).toEqual([
    { kind: "delete", text: "const value: number = 1;" },
    { kind: "insert", text: "const value: number = 2;" },
  ]);

  const missing = buildDiffDocFromPatch(multi, "nope.ts");
  expect(missing).toBeNull();
});

test("buildDiffDocFromFile round-trips line attrs via schema nodes", () => {
  const file = parseDiff(typescriptPatch)[0]!;
  expect(diffFilePath(file)).toBe("src/example.ts");
  const doc = buildDiffDocFromFile(file);
  expect(doc.childCount).toBe(1);
  const lines = collectDiffLineTexts(doc);
  expect(lines.some((row) => row.kind === "delete")).toBe(true);
  expect(lines.some((row) => row.kind === "insert")).toBe(true);
});

test("file browser code editor keeps configurable code font size", () => {
  const styles = readFileSync(new URL("../src/renderer/workspace-file-browser.css", import.meta.url), "utf8");

  expect(styles).toContain(".workspace-file-browser__editor .cm-content");
  expect(styles).toContain("font-size: var(--code-font-size, 13px);");
});

test("buildDiffTree includes only changed files and expands every directory", () => {
  const tree = buildDiffTree([
    {
      path: "src/app/main.ts",
      additions: 2,
      deletions: 1,
      status: "modified",
      originalContent: "",
      currentContent: "",
    },
    {
      path: "src/styles.css",
      additions: 1,
      deletions: 0,
      status: "modified",
      originalContent: "",
      currentContent: "",
    },
  ]);

  expect(tree.items["file:src/app/main.ts"]?.filePath).toBe("src/app/main.ts");
  expect(tree.items["file:README.md"]).toBeUndefined();
  expect(tree.expandedItems).toEqual(["__workspace-diff-root__", "directory:src", "directory:src/app"]);
});

test("buildDiffTree collapses single-child directories", () => {
  const tree = buildDiffTree([
    {
      path: "apps/desktop/src/a.ts",
      additions: 1,
      deletions: 0,
      status: "untracked",
      originalContent: "",
      currentContent: "a",
    },
  ]);

  expect(tree.items["directory:apps"]?.data).toBe("apps/desktop/src");
  expect(tree.items["directory:apps/desktop"]).toBeUndefined();
  expect(tree.items["directory:apps"]?.children).toEqual(["file:apps/desktop/src/a.ts"]);
});
