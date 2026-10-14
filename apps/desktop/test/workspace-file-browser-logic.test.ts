import { expect, test } from "bun:test";
import fs from "node:fs";
import {
  ancestorDirectories,
  basename,
  buildWorkspaceRoot,
  clampTargetColumn,
  clampTargetLine,
  collectRefreshDirectories,
  fileExtension,
  itemIndex,
  languageForFile,
  mergeWorkspaceEntries,
  parentDirectory,
  workspacePathSegments,
} from "../src/renderer/workspace-file-browser-logic";
import { i18nCatalogs } from "../src/shared/i18n-catalogs";

test("normalizes tree item indexes for controlled tree state", () => {
  expect(itemIndex({ index: "/repo/src" })).toBe("/repo/src");
  expect(itemIndex({ index: 42 })).toBe("42");
});

test("keeps WorkspaceFileBrowser translation keys in both catalogs", () => {
  const source = [
    "../src/renderer/WorkspaceFileBrowser.tsx",
    "../src/renderer/WorkspaceFileViewer.tsx",
    "../src/renderer/WorkspaceFilePreview.tsx",
    "../src/renderer/SubagentTaskDrawer.tsx",
  ]
    .map((relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), "utf8"))
    .join("\n");
  const keys = [...source.matchAll(/t\("([^"]+)"/g)]
    .map((match) => match[1])
    .filter(
      (key): key is string =>
        key?.startsWith("fileBrowser.") === true || key?.startsWith("fileViewer.") === true,
    );
  const uniqueKeys = [...new Set(keys)];

  for (const key of uniqueKeys) {
    expect(
      i18nCatalogs["zh-CN"].translation[key as keyof (typeof i18nCatalogs)["zh-CN"]["translation"]],
    ).toBeDefined();
    expect(
      i18nCatalogs["en-US"].translation[key as keyof (typeof i18nCatalogs)["en-US"]["translation"]],
    ).toBeDefined();
  }
});

test("derives common file language and extension", () => {
  expect(fileExtension("/repo/src/App.TSX")).toBe("tsx");
  expect(languageForFile("/repo/src/App.TSX")).toBe("tsx");
  expect(languageForFile("/repo/README")).toBeUndefined();
  // language-data 的 C++ 名为 "C++"、alias "cpp"；需 matchLanguageName，不能只用 name.toLowerCase()
  expect(languageForFile("/repo/src/main.cpp")).toBe("cpp");
  expect(languageForFile("/repo/include/util.h")).toBe("cpp");
});

test("CodeMirror language-data resolves mapped extensions including C++", async () => {
  const { languages } = await import("@codemirror/language-data");
  const { LanguageDescription } = await import("@codemirror/language");

  const resolve = (filePath: string) => {
    const byFilename = LanguageDescription.matchFilename(languages, filePath);
    if (byFilename) return byFilename.name;
    const mapped = languageForFile(filePath);
    if (!mapped) return undefined;
    return LanguageDescription.matchLanguageName(languages, mapped, true)?.name;
  };

  expect(resolve("/repo/src/App.tsx")).toBe("TSX");
  expect(resolve("/repo/src/main.ts")).toBe("TypeScript");
  expect(resolve("/repo/src/main.cpp")).toBe("C++");
  expect(resolve("/repo/include/util.h")).toBe("C");
  // 旧实现 languages.find(item => names.includes(item.name.toLowerCase())) 对 cpp 会匹配失败
  expect(languages.find((item) => ["cpp"].includes(item.name.toLowerCase()))?.name).toBeUndefined();
  expect(LanguageDescription.matchLanguageName(languages, "cpp", true)?.name).toBe("C++");
});

test("clamps target lines to the document", () => {
  expect(clampTargetLine(0, 4)).toBe(1);
  expect(clampTargetLine(9, 4)).toBe(4);
  expect(clampTargetLine(2.9, 4)).toBe(2);
  expect(clampTargetLine(undefined, 4)).toBeUndefined();
});

test("clamps target columns to the selected line", () => {
  expect(clampTargetColumn(0, 8)).toBe(1);
  expect(clampTargetColumn(20, 8)).toBe(8);
  expect(clampTargetColumn(4.9, 8)).toBe(4);
  expect(clampTargetColumn(undefined, 8)).toBeUndefined();
});

test("builds and merges a sorted lazy tree", () => {
  const root = "/repo";
  const items = mergeWorkspaceEntries(buildWorkspaceRoot(root), root, [
    { name: "z.ts", path: "/repo/z.ts", kind: "file" },
    { name: "src", path: "/repo/src", kind: "directory" },
  ]);
  expect(items[root]?.children).toEqual(["/repo/src", "/repo/z.ts"]);
  expect(items["/repo/src"]?.isFolder).toBe(true);
});

test("returns ancestor directories in loading order", () => {
  expect(ancestorDirectories("/repo", "/repo/src/lib/file.ts")).toEqual(["/repo/src", "/repo/src/lib"]);
  expect(basename("/repo/")).toBe("repo");
});

test("collects every expanded directory once for a manual refresh, root first", () => {
  expect(collectRefreshDirectories("/repo", ["/repo", "/repo/src", "/repo/src/lib"])).toEqual([
    "/repo",
    "/repo/src",
    "/repo/src/lib",
  ]);
  // The root is re-read even when nothing is expanded, and never listed twice.
  expect(collectRefreshDirectories("/repo", [])).toEqual(["/repo"]);
  expect(collectRefreshDirectories("/repo", ["/repo", "/repo"])).toEqual(["/repo"]);
});

test("builds clickable workspace breadcrumb hierarchy", () => {
  expect(workspacePathSegments("/repo", "/repo/apps/desktop/App.tsx")).toEqual([
    { name: "repo", path: "/repo", kind: "directory" },
    { name: "apps", path: "/repo/apps", kind: "directory" },
    { name: "desktop", path: "/repo/apps/desktop", kind: "directory" },
    { name: "App.tsx", path: "/repo/apps/desktop/App.tsx", kind: "file" },
  ]);
  expect(workspacePathSegments("C:\\Repo", "c:\\repo\\src\\App.tsx").at(-1)).toEqual({
    name: "App.tsx",
    path: "C:/Repo/src/App.tsx",
    kind: "file",
  });
  expect(workspacePathSegments("/", "/src/App.tsx")).toEqual([
    { name: "/", path: "/", kind: "directory" },
    { name: "src", path: "/src", kind: "directory" },
    { name: "App.tsx", path: "/src/App.tsx", kind: "file" },
  ]);
  expect(workspacePathSegments("/repo", "/outside/file.ts")).toEqual([]);
  expect(parentDirectory("/repo/src/App.tsx")).toBe("/repo/src");
});
