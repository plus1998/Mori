import { Fragment, type Node as PMNode } from "prosemirror-model";
import { parentDirectory } from "./workspace-file-browser-logic";

export interface MarkdownLocalImageContext {
  workspacePath: string;
  /** Absolute path of the markdown file being previewed. */
  filePath: string;
}

export interface WorkspaceImageReadResult {
  kind: string;
  mimeType?: string;
  base64?: string;
  url?: string;
  content?: string;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:/.test(value);
}

/** Collapse `.` / `..` while preserving a Windows drive or leading `/`. */
export function normalizePathSegments(pathValue: string): string {
  const normalized = normalizeSlashes(pathValue);
  const windows = isWindowsPath(normalized);
  const parts = normalized.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === ".") continue;
    if (part === "..") {
      const prev = out[out.length - 1];
      if (prev && prev !== "" && !/^[A-Za-z]:$/i.test(prev)) {
        out.pop();
      }
      continue;
    }
    if (part === "" && out.length > 0) continue;
    out.push(part);
  }
  let result = out.join("/");
  if (!windows && normalized.startsWith("/") && !result.startsWith("/")) {
    result = `/${result}`;
  }
  return result;
}

export function isPathInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const workspace = normalizeSlashes(workspacePath).replace(/\/+$/, "") || "/";
  const target = normalizeSlashes(targetPath).replace(/\/+$/, "") || targetPath;
  const win = isWindowsPath(workspace);
  const left = win ? workspace.toLowerCase() : workspace;
  const right = win ? target.toLowerCase() : target;
  return right === left || right.startsWith(`${left}/`);
}

export function isSkippableImageSrc(src: string): boolean {
  const value = src.trim();
  if (!value) return true;
  return /^(?:https?:|data:|blob:|eco-file:|file:|mailto:)/i.test(value) || value.startsWith("//");
}

export function stripImageSrcDecorations(src: string): string {
  let value = src.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep raw
  }
  const hash = value.indexOf("#");
  if (hash >= 0) value = value.slice(0, hash);
  const query = value.indexOf("?");
  if (query >= 0) value = value.slice(0, query);
  return value.trim();
}

/**
 * Resolve a markdown/HTML image src to an absolute workspace file path.
 * Relative paths are against the markdown file directory (GitHub-like).
 * Leading `/` paths that are not under the workspace are treated as workspace-root relative.
 */
export function resolveMarkdownImagePath(
  workspacePath: string,
  markdownFilePath: string,
  rawSrc: string,
): string | undefined {
  if (isSkippableImageSrc(rawSrc)) return undefined;
  const src = stripImageSrcDecorations(rawSrc);
  if (!src) return undefined;

  const workspace = normalizeSlashes(workspacePath).replace(/\/+$/, "");
  const mdDir = parentDirectory(normalizeSlashes(markdownFilePath));

  let candidate: string;
  if (/^[A-Za-z]:[\\/]/.test(src) || src.startsWith("\\\\")) {
    candidate = normalizePathSegments(src);
  } else if (src.startsWith("/")) {
    const asAbsolute = normalizePathSegments(src);
    candidate = isPathInsideWorkspace(workspace, asAbsolute)
      ? asAbsolute
      : normalizePathSegments(`${workspace}/${src.replace(/^\/+/, "")}`);
  } else {
    candidate = normalizePathSegments(`${mdDir}/${src}`);
  }

  if (!isPathInsideWorkspace(workspace, candidate)) return undefined;
  return candidate;
}

const HTML_IMG_SRC_RE = /\bsrc\s*=\s*(["'])(.*?)\1/i;

export function extractHtmlImageSrcs(html: string): string[] {
  const srcs: string[] = [];
  const tagRe = /<img\b[^>]*>/gi;
  for (const match of html.matchAll(tagRe)) {
    const tag = match[0] ?? "";
    const srcMatch = tag.match(HTML_IMG_SRC_RE);
    if (srcMatch?.[2]) srcs.push(srcMatch[2]);
  }
  return srcs;
}

export function collectLocalImageSrcs(doc: PMNode): string[] {
  const found = new Set<string>();

  const visit = (node: PMNode) => {
    if (node.type.name === "image") {
      const src = String(node.attrs.src ?? "");
      if (src && !isSkippableImageSrc(src)) found.add(src);
    }
    if (node.type.name === "html_block" || node.type.name === "html_inline") {
      for (const src of extractHtmlImageSrcs(String(node.attrs.html ?? ""))) {
        if (src && !isSkippableImageSrc(src)) found.add(src);
      }
    }
    node.forEach((child) => visit(child));
  };

  visit(doc);
  return [...found];
}

export function rewriteHtmlImageSrcs(html: string, urlBySrc: ReadonlyMap<string, string>): string {
  if (urlBySrc.size === 0) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) =>
    tag.replace(HTML_IMG_SRC_RE, (full, quote: string, src: string) => {
      const next = urlBySrc.get(src);
      return next ? `src=${quote}${next}${quote}` : full;
    }),
  );
}

export function rewriteLocalImageSrcs(doc: PMNode, urlBySrc: ReadonlyMap<string, string>): PMNode {
  if (urlBySrc.size === 0) return doc;

  if (doc.type.name === "image") {
    const src = String(doc.attrs.src ?? "");
    const next = urlBySrc.get(src);
    return next ? doc.type.create({ ...doc.attrs, src: next }, doc.content, doc.marks) : doc;
  }

  if (doc.type.name === "html_block" || doc.type.name === "html_inline") {
    const html = String(doc.attrs.html ?? "");
    const nextHtml = rewriteHtmlImageSrcs(html, urlBySrc);
    if (nextHtml === html) return doc;
    return doc.type.create({ ...doc.attrs, html: nextHtml }, doc.content, doc.marks);
  }

  if (doc.childCount === 0) return doc;

  const children: PMNode[] = [];
  let changed = false;
  doc.forEach((child) => {
    const next = rewriteLocalImageSrcs(child, urlBySrc);
    if (next !== child) changed = true;
    children.push(next);
  });
  return changed ? doc.copy(Fragment.fromArray(children)) : doc;
}

export function dataUrlFromWorkspaceFile(file: WorkspaceImageReadResult): string | undefined {
  if (file.kind === "image" && file.url) return file.url;
  if (file.kind === "image" && file.base64 && file.mimeType) {
    return `data:${file.mimeType};base64,${file.base64}`;
  }
  // SVG is stored as UTF-8 text by the workspace reader.
  if (file.mimeType === "image/svg+xml" && typeof file.content === "string") {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(file.content)))}`;
  }
  const nameLooksSvg =
    typeof file.content === "string" &&
    /^\s*(?:<\?xml\b[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(file.content);
  if (file.kind === "text" && nameLooksSvg && typeof file.content === "string") {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(file.content)))}`;
  }
  return undefined;
}

export async function resolveLocalImageDataUrls(input: {
  workspacePath: string;
  markdownFilePath: string;
  srcs: readonly string[];
  readFile: (request: {
    workspacePath: string;
    filePath: string;
  }) => Promise<WorkspaceImageReadResult>;
}): Promise<Map<string, string>> {
  const urlBySrc = new Map<string, string>();
  const uniqueSrcs = [...new Set(input.srcs)];
  await Promise.all(
    uniqueSrcs.map(async (src) => {
      const absolute = resolveMarkdownImagePath(input.workspacePath, input.markdownFilePath, src);
      if (!absolute) return;
      try {
        const file = await input.readFile({
          workspacePath: input.workspacePath,
          filePath: absolute,
        });
        const dataUrl = dataUrlFromWorkspaceFile(file);
        if (dataUrl) urlBySrc.set(src, dataUrl);
      } catch {
        // Leave original src; broken image is visible and honest.
      }
    }),
  );
  return urlBySrc;
}
