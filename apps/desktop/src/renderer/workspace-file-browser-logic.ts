export type WorkspaceEntryKind = "directory" | "file";

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  size?: number;
}

export interface WorkspaceTreeItem {
  index: string;
  data: string;
  children?: string[];
  isFolder: boolean;
  entry?: WorkspaceEntry;
}

export interface WorkspacePathSegment {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
}

export function itemIndex(item: { index: string | number }): string {
  return String(item.index);
}

export function basename(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export function parentDirectory(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  if (separator <= 0) return normalized.slice(0, Math.max(separator, 1)) || normalized;
  return normalized.slice(0, separator);
}

export function workspacePathSegments(workspacePath: string, filePath: string): WorkspacePathSegment[] {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized || (value.startsWith("/") ? "/" : normalized);
  };
  const root = normalize(workspacePath);
  const target = normalize(filePath);
  if (!root || !target) return [];
  const windowsPath = /^[A-Za-z]:\//.test(root);
  const comparableRoot = windowsPath ? root.toLowerCase() : root;
  const comparableTarget = windowsPath ? target.toLowerCase() : target;
  if (comparableTarget === comparableRoot) {
    return [{ name: basename(root) || root, path: root, kind: "directory" }];
  }
  const rootPrefix = root === "/" ? root : `${root}/`;
  const comparablePrefix = windowsPath ? rootPrefix.toLowerCase() : rootPrefix;
  if (!comparableTarget.startsWith(comparablePrefix)) return [];

  const relativeSegments = target.slice(rootPrefix.length).split("/").filter(Boolean);
  let currentPath = root;
  return [
    { name: basename(root) || root, path: root, kind: "directory" as const },
    ...relativeSegments.map((name, index) => {
      currentPath = currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
      return {
        name,
        path: currentPath,
        kind: index === relativeSegments.length - 1 ? ("file" as const) : ("directory" as const),
      };
    }),
  ];
}

export function fileExtension(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

const languageByExtension: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  sql: "sql",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function languageForFile(filePath: string): string | undefined {
  return languageByExtension[fileExtension(filePath)];
}

export function clampTargetLine(line: number | undefined, lineCount: number): number | undefined {
  if (line === undefined || lineCount < 1) return undefined;
  return Math.min(Math.max(Math.floor(line), 1), lineCount);
}

export function clampTargetColumn(column: number | undefined, lineLength: number): number | undefined {
  if (column === undefined) return undefined;
  return Math.min(Math.max(Math.floor(column), 1), Math.max(lineLength, 1));
}

export function joinWorkspacePath(...parts: string[]): string {
  if (parts.length === 0) return "";
  const first = parts[0]!;
  const prefix = first.startsWith("/") ? "/" : "";
  const joined = parts
    .join("/")
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/");
  return prefix + joined;
}

export function ancestorDirectories(workspacePath: string, filePath: string): string[] {
  const root = workspacePath.replace(/[\\/]+$/, "");
  const relative = filePath.slice(root.length).replace(/^[/\\]+/, "");
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  segments.pop();
  return segments.map((_, index) => joinWorkspacePath(root, ...segments.slice(0, index + 1)));
}

/**
 * Directories a manual refresh must re-read: the workspace root first, then every
 * expanded directory exactly once (the root is never duplicated).
 */
export function collectRefreshDirectories(workspacePath: string, expandedItems: string[]): string[] {
  return [workspacePath, ...new Set(expandedItems.filter((item) => item !== workspacePath))];
}

export function mergeWorkspaceEntries(
  items: Record<string, WorkspaceTreeItem>,
  directoryPath: string,
  entries: WorkspaceEntry[],
): Record<string, WorkspaceTreeItem> {
  const next = { ...items };
  const children = entries
    .slice()
    .sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name),
    )
    .map((entry) => entry.path);
  next[directoryPath] = {
    ...(next[directoryPath] ?? {
      index: directoryPath,
      data: basename(directoryPath),
      isFolder: true,
    }),
    children,
  };
  for (const entry of entries) {
    const item: WorkspaceTreeItem = {
      index: entry.path,
      data: entry.name,
      isFolder: entry.kind === "directory",
      entry,
    };
    if (entry.kind === "directory") item.children = next[entry.path]?.children ?? [];
    next[entry.path] = item;
  }
  return next;
}

export function buildWorkspaceRoot(workspacePath: string): Record<string, WorkspaceTreeItem> {
  return {
    [workspacePath]: {
      index: workspacePath,
      data: basename(workspacePath),
      children: [],
      isFolder: true,
    },
  };
}
