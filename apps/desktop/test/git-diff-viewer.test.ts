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
import { WorkspaceDiffPanel } from "../src/renderer/WorkspaceDiffDrawer";
import { buildDiffTree, filterDiffTreeItems } from "../src/renderer/WorkspaceDiffFileTree";
import {
  resolveWorkspaceDiffSelection,
  summarizeWorkspaceDiffFolder,
} from "../src/renderer/workspace-diff-paths";
import type { WorkspaceDiffResult } from "../src/shared/ipc";

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
  expect(tree.items["directory:src"]?.changedFileCount).toBe(2);
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
  expect(tree.items["directory:apps"]?.filePath).toBe("apps/desktop/src");
  expect(tree.items["directory:apps"]?.changedFileCount).toBe(1);
  expect(tree.items["directory:apps/desktop"]).toBeUndefined();
  expect(tree.items["directory:apps"]?.children).toEqual(["file:apps/desktop/src/a.ts"]);
  expect(tree.folderItemIds.get("apps/desktop")).toBe("directory:apps");
});

function changedFile(path: string, stats: Partial<WorkspaceDiffResult["files"][number]> = {}) {
  return {
    path,
    additions: 0,
    deletions: 0,
    status: "modified" as const,
    originalContent: "",
    currentContent: "",
    ...stats,
  };
}

test("a deleted file and a new directory at the same path select different rows and previews", () => {
  const files = [
    changedFile("src", { status: "deleted", deletions: 1 }),
    changedFile("src/main.ts", { status: "untracked", additions: 2 }),
  ];
  const diff: WorkspaceDiffResult = {
    workspacePath: "/repo",
    patch: "",
    patchTruncated: false,
    fileCount: 2,
    totalAdditions: 2,
    totalDeletions: 1,
    files,
  };
  const render = (kind: "directory" | "file") =>
    renderToStaticMarkup(createElement(WorkspaceDiffPanel, {
      diff,
      loading: false,
      selection: { kind, path: "src" },
      onSelectItem: () => undefined,
    }));

  const directory = render("directory");
  expect(directory).toMatch(/aria-selected="true"[^>]*data-tree-index="directory:src"/);
  expect(directory).toContain("workspace-diff-folder-summary__stats");

  const file = render("file");
  expect(file).toMatch(/aria-selected="true"[^>]*data-tree-index="file:src"/);
  expect(file).not.toContain("workspace-diff-folder-summary__stats");
});

test("search keeps the selected folder row and its total change count", () => {
  const files = [
    changedFile("src/app/main.ts", { additions: 2, deletions: 1 }),
    changedFile("src/styles.css", { additions: 1 }),
  ];
  const tree = buildDiffTree(files);
  const filteredItems = filterDiffTreeItems(tree.items, "main.ts");
  const folderId = tree.folderItemIds.get("src")!;

  expect(filteredItems[folderId]).toMatchObject({
    data: "src",
    changedFileCount: 2,
    children: ["directory:src/app"],
  });
  expect(filteredItems["file:src/styles.css"]).toBeUndefined();
  expect(summarizeWorkspaceDiffFolder(files, "src")).toEqual({ fileCount: 2, additions: 3, deletions: 1 });
});

test("Git paths preserve literal backslashes in folder totals and selection", () => {
  const files = [
    changedFile("src\\main.ts", { additions: 10, deletions: 3 }),
    changedFile("src/main.ts", { additions: 2 }),
    changedFile("src\\lib/utils.ts", { deletions: 1 }),
  ];

  expect(summarizeWorkspaceDiffFolder(files, "src")).toEqual({ fileCount: 1, additions: 2, deletions: 0 });
  expect(summarizeWorkspaceDiffFolder(files, "src\\lib")).toEqual({ fileCount: 1, additions: 0, deletions: 1 });
  expect(resolveWorkspaceDiffSelection(files, { kind: "file", path: "src\\main.ts" })).toEqual({
    kind: "file", path: "src\\main.ts",
  });
});

test("refresh keeps an existing folder selection even if the folder becomes part of a compact row", () => {
  const selection = { kind: "directory", path: "src" } as const;
  const files = [changedFile("src/app/main.ts")];
  const nextSelection = resolveWorkspaceDiffSelection(files, selection);
  const refreshedTree = buildDiffTree(files);

  expect(nextSelection).toEqual(selection);
  expect(refreshedTree.items[refreshedTree.folderItemIds.get(selection.path)!]?.data).toBe("src/app");
  expect(resolveWorkspaceDiffSelection([changedFile("src", { status: "deleted" })], selection)).toEqual({
    kind: "file", path: "src",
  });
});
