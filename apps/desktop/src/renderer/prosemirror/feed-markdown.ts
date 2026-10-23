import MarkdownIt from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import { defaultMarkdownParser, MarkdownParser, schema as markdownSchema } from "prosemirror-markdown";
import { Fragment, type Mark, type NodeSpec, type Node as PMNode, Schema } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import type { NodeViewConstructor } from "prosemirror-view";
import { buildHtmlDataNavigateUrl } from "../../shared/browser";
import { dispatchBrowserHtmlOpen, dispatchBrowserLinkOpen, isHttpishHref } from "../browser-link";
import { copyTextToClipboard } from "../clipboard";
import { i18n } from "../i18n";
import { attachLightboxZoom, formatLightboxZoomPercent } from "../lightbox-zoom";
import { copyMermaidAsImage, copyMermaidAsMarkdown } from "../markdown-mermaid-clipboard";
import { repairMarkdown } from "../markdown-repair";
import {
  copyTableAsHtml,
  copyTableAsImage,
  copyTableAsMarkdown,
  downloadTableAsCsv,
  downloadTableAsExcel,
} from "../markdown-table-clipboard";
import { getMaterialIconUrl, resolveMaterialIconName } from "../material-file-icon";
import {
  dispatchWorkspaceFileReference,
  formatWorkspaceFileReferenceLabel,
  linkifyWorkspaceFileReferences,
  parseWorkspaceFileReferenceHref,
  type WorkspaceFileReference,
} from "../workspace-file-reference";
import {
  countHtmlLines,
  extractHtmlDocumentTitle,
  htmlBlockToDOM,
  htmlInlineToDOM,
  installHtmlContainerStitch,
  isHtmlLang,
} from "./html-block";
import {
  isMermaidLang,
  type MermaidAppTheme,
  mountMermaidSvgForFeed,
  observeAppTheme,
  readAppTheme,
  recallMermaidFeedHeight,
  renderMermaidSvg,
} from "./mermaid-block";

export { isHtmlLang } from "./html-block";
export { isMermaidLang } from "./mermaid-block";

function fileRefTitle(reference: WorkspaceFileReference): string {
  if (reference.line !== undefined) {
    return `${reference.path}:${reference.line}${
      reference.column !== undefined ? `:${reference.column}` : ""
    }`;
  }
  return reference.path;
}

export function fileRefHref(reference: WorkspaceFileReference, href?: string): string {
  if (href?.startsWith("eco-file:")) return href;
  if (href && parseWorkspaceFileReferenceHref(href)) return href;
  const base = reference.path;
  if (reference.line !== undefined) {
    return `${base}:${reference.line}${reference.column !== undefined ? `:${reference.column}` : ""}`;
  }
  return base;
}

function fileRefToDOM(node: PMNode) {
  const reference: WorkspaceFileReference = {
    path: String(node.attrs.path),
    ...(node.attrs.line != null ? { line: Number(node.attrs.line) } : {}),
    ...(node.attrs.column != null ? { column: Number(node.attrs.column) } : {}),
  };
  const href = String(node.attrs.href || fileRefHref(reference));
  const iconName = resolveMaterialIconName(reference.path);
  const iconUrl = getMaterialIconUrl(iconName);
  return [
    "a",
    {
      href,
      class: "markdown-file-ref",
      title: fileRefTitle(reference),
      "data-eco-file": "1",
    },
    [
      "img",
      {
        class: "markdown-file-ref__icon",
        src: iconUrl,
        alt: "",
        width: "14",
        height: "14",
        draggable: "false",
        "aria-hidden": "true",
      },
    ],
    ["span", { class: "markdown-file-ref__label" }, formatWorkspaceFileReferenceLabel(reference)],
  ] as const;
}

/**
 * Prefer at most ~2 header lines: min-width ≈ half the unwrapped measure.
 * Wide tables then overflow and scroll instead of crushing headers to 3+ lines.
 * CJK counts as ~2 `ch` so half-width stays honest for mixed text.
 */
export function markdownTableHeaderMinWidthCh(text: string): number {
  let units = 0;
  for (const ch of text.trim()) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    units += wide ? 2 : 1;
  }
  return Math.min(28, Math.max(4, Math.ceil(units / 2)));
}

function tableHeaderDomAttrs(node: PMNode): Record<string, string | number> {
  return {
    colspan: node.attrs.colspan,
    rowspan: node.attrs.rowspan,
    style: `min-width:${markdownTableHeaderMinWidthCh(node.textContent)}ch`,
  };
}

const feedTableNodes: Record<string, NodeSpec> = {
  table: {
    content: "table_row+",
    group: "block",
    isolating: true,
    parseDOM: [{ tag: "table" }],
    toDOM() {
      return ["table", { class: "markdown-table" }, ["tbody", 0]];
    },
  },
  table_row: {
    content: "(table_cell | table_header)*",
    parseDOM: [{ tag: "tr" }],
    toDOM() {
      return ["tr", 0];
    },
  },
  table_cell: {
    content: "inline*",
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
    },
    isolating: true,
    parseDOM: [
      {
        tag: "td",
        getAttrs(dom: HTMLElement | string) {
          if (typeof dom === "string") return false;
          return {
            colspan: Number(dom.getAttribute("colspan") || 1),
            rowspan: Number(dom.getAttribute("rowspan") || 1),
          };
        },
      },
    ],
    toDOM(node: PMNode) {
      return [
        "td",
        {
          colspan: node.attrs.colspan,
          rowspan: node.attrs.rowspan,
        },
        0,
      ];
    },
  },
  table_header: {
    content: "inline*",
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
    },
    isolating: true,
    parseDOM: [
      {
        tag: "th",
        getAttrs(dom: HTMLElement | string) {
          if (typeof dom === "string") return false;
          return {
            colspan: Number(dom.getAttribute("colspan") || 1),
            rowspan: Number(dom.getAttribute("rowspan") || 1),
          };
        },
      },
    ],
    toDOM(node: PMNode) {
      return ["th", tableHeaderDomAttrs(node), ["span", { class: "markdown-table-th" }, 0]];
    },
  },
};

export const feedMarkdownSchema: Schema = new Schema({
  nodes: markdownSchema.spec.nodes.append(feedTableNodes).append({
    // Raw HTML from markdown-it (`html: true`) — same idea as GitHub/GFM HTML passthrough.
    html_block: {
      group: "block",
      atom: true,
      selectable: true,
      attrs: {
        html: { default: "" },
      },
      parseDOM: [
        {
          tag: "div.markdown-html-block",
          getAttrs(dom) {
            if (!(dom instanceof HTMLElement)) return false;
            return { html: dom.innerHTML };
          },
        },
      ],
      toDOM(node: PMNode) {
        return htmlBlockToDOM(String(node.attrs.html ?? ""));
      },
    },
    html_inline: {
      inline: true,
      group: "inline",
      atom: true,
      selectable: true,
      attrs: {
        html: { default: "" },
      },
      parseDOM: [
        {
          tag: "span.markdown-html-inline",
          getAttrs(dom) {
            if (!(dom instanceof HTMLElement)) return false;
            return { html: dom.innerHTML };
          },
        },
      ],
      toDOM(node: PMNode) {
        return htmlInlineToDOM(String(node.attrs.html ?? ""));
      },
    },
    file_ref: {
      inline: true,
      atom: true,
      group: "inline",
      selectable: false,
      attrs: {
        path: {},
        line: { default: null },
        column: { default: null },
        href: { default: "" },
      },
      toDOM: fileRefToDOM,
      parseDOM: [
        {
          tag: "a.markdown-file-ref",
          getAttrs(dom) {
            if (!(dom instanceof HTMLElement)) return false;
            const href = dom.getAttribute("href") ?? "";
            const reference = parseWorkspaceFileReferenceHref(href);
            if (!reference) return false;
            return {
              path: reference.path,
              line: reference.line ?? null,
              column: reference.column ?? null,
              href,
            };
          },
        },
      ],
    },
  }),
  marks: markdownSchema.spec.marks
    .update("link", {
      attrs: {
        href: {},
        title: { default: null },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs(dom: HTMLElement | string) {
            if (typeof dom === "string") return false;
            const href = dom.getAttribute("href");
            if (
              !href ||
              parseWorkspaceFileReferenceHref(href) ||
              dom.classList.contains("markdown-file-ref")
            ) {
              return false;
            }
            return {
              href,
              title: dom.getAttribute("title"),
            };
          },
        },
      ],
      toDOM(mark: Mark) {
        return [
          "a",
          {
            href: mark.attrs.href,
            title: mark.attrs.title,
            target: "_blank",
            rel: "noreferrer noopener",
          },
          0,
        ];
      },
    })
    .update("code", {
      excludes: "_",
      parseDOM: [
        {
          tag: "code",
          preserveWhitespace: "full",
          getAttrs(dom: HTMLElement | string) {
            if (typeof dom === "string") return false;
            // Fenced / block code uses <pre><code>, not the inline mark.
            if (dom.closest("pre")) return false;
            return null;
          },
        },
      ],
      toDOM() {
        return ["code", { class: "markdown-inline-code" }, 0];
      },
    })
    .addToEnd("strikethrough", {
      parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
      toDOM() {
        return ["del", 0];
      },
    }),
});

// Default markdown-it (not commonmark-only) so GFM tables / strikethrough work.
const tokenizer = MarkdownIt({
  html: true,
  breaks: true,
  linkify: false,
});
// CommonMark flanking rules miss emphasis like **中文。**后续 (commonmark-spec#650).
tokenizer.use(markdownItCjkFriendly);
installHtmlContainerStitch(tokenizer);

export const feedMarkdownParser = new MarkdownParser(
  feedMarkdownSchema,
  tokenizer as unknown as ConstructorParameters<typeof MarkdownParser>[1],
  {
    ...defaultMarkdownParser.tokens,
    softbreak: { node: "hard_break" },
    table: { block: "table" },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: "table_row" },
    th: { block: "table_header" },
    td: { block: "table_cell" },
    s: { mark: "strikethrough" },
    html_block: {
      node: "html_block",
      getAttrs: (tok: { content?: string }) => ({ html: tok.content ?? "" }),
    },
    html_inline: {
      node: "html_inline",
      getAttrs: (tok: { content?: string }) => ({ html: tok.content ?? "" }),
    },
  },
);

function createFileRefNode(reference: WorkspaceFileReference, href?: string): PMNode {
  const fileRefType = feedMarkdownSchema.nodes.file_ref;
  if (!fileRefType) {
    throw new Error("feedMarkdownSchema missing file_ref node");
  }
  return fileRefType.create({
    path: reference.path,
    line: reference.line ?? null,
    column: reference.column ?? null,
    href: fileRefHref(reference, href),
  });
}

function linkMarkToFileRef(mark: Mark): PMNode | null {
  if (mark.type.name !== "link") return null;
  const href = String(mark.attrs.href ?? "");
  const reference = parseWorkspaceFileReferenceHref(href);
  if (!reference) return null;
  return createFileRefNode(reference, href);
}

/** Convert file-path link marks and bare path text into `file_ref` atoms (skip code marks). */
function rewriteFileReferences(node: PMNode): PMNode {
  if (node.type.name === "code_block") {
    return node;
  }
  if (node.isTextblock) {
    const pieces: PMNode[] = [];
    node.forEach((child) => {
      if (!child.isText) {
        pieces.push(rewriteFileReferences(child));
        return;
      }
      if (child.marks.some((mark) => mark.type.name === "code")) {
        pieces.push(child);
        return;
      }
      const link = child.marks.find((mark) => mark.type.name === "link");
      if (link) {
        const fileRef = linkMarkToFileRef(link);
        if (fileRef) {
          pieces.push(fileRef);
          return;
        }
        pieces.push(child);
        return;
      }
      const parts = linkifyWorkspaceFileReferences(child.text ?? "");
      if (!parts.some((part) => part.type === "link")) {
        pieces.push(child);
        return;
      }
      for (const part of parts) {
        if (part.type === "text") {
          if (part.value.length > 0) {
            pieces.push(feedMarkdownSchema.text(part.value, child.marks));
          }
        } else {
          pieces.push(createFileRefNode(part.reference));
        }
      }
    });
    return node.copy(Fragment.fromArray(pieces));
  }
  if (node.childCount === 0 || node.isLeaf) {
    return node;
  }
  const children: PMNode[] = [];
  node.forEach((child) => {
    children.push(rewriteFileReferences(child));
  });
  return node.copy(Fragment.fromArray(children));
}

export function createFeedMarkdownDoc(text: string): PMNode {
  const source = repairMarkdown(text);
  let doc: PMNode;
  try {
    doc = feedMarkdownParser.parse(source);
  } catch {
    doc = feedMarkdownSchema.node("doc", null, [
      feedMarkdownSchema.node(
        "paragraph",
        null,
        source.length > 0 ? [feedMarkdownSchema.text(source)] : undefined,
      ),
    ]);
  }
  return rewriteFileReferences(doc);
}

/** A top-level Markdown block with its source range, from the real tokenizer. */
export interface FeedMarkdownBlockRange {
  start: number;
  end: number;
}

/**
 * Top-level block ranges of `text` as the tokenizer sees them.
 *
 * Streaming rendering needs to know which part of a growing response can no
 * longer change. The line-oriented scan in `streaming-markdown-partition` is a
 * cheap approximation and misses constructs whose block structure spans lines
 * in non-obvious ways (GFM tables without a leading pipe, setext headings,
 * lists that merge across a blank line). The tokenizer's `map` is authoritative,
 * so the doc builder uses it to decide what is safe to freeze.
 */
export function feedMarkdownBlockRanges(text: string): FeedMarkdownBlockRange[] {
  if (!text) {
    return [];
  }
  let tokens: Array<{ level: number; map: [number, number] | null }>;
  try {
    tokens = tokenizer.parse(text, {}) as unknown as Array<{ level: number; map: [number, number] | null }>;
  } catch {
    return [];
  }

  // Line offsets once, so each token map lookup is O(1) instead of a rescan.
  const lineOffsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      lineOffsets.push(i + 1);
    }
  }
  const offsetOfLine = (lineIndex: number): number => {
    if (lineIndex <= 0) {
      return 0;
    }
    return lineIndex < lineOffsets.length ? lineOffsets[lineIndex]! : text.length;
  };

  const ranges: FeedMarkdownBlockRange[] = [];
  for (const token of tokens) {
    // Only level-0 block tokens carry a source line range; nested inline tokens
    // are level 1+ and would duplicate their parent's range.
    if (token.level !== 0 || !token.map) {
      continue;
    }
    const start = offsetOfLine(token.map[0]);
    const end = offsetOfLine(token.map[1]);
    if (end > start) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function serializeInline(node: PMNode): string {
  if (node.type.name === "file_ref") {
    const reference: WorkspaceFileReference = {
      path: String(node.attrs.path),
      ...(node.attrs.line != null ? { line: Number(node.attrs.line) } : {}),
      ...(node.attrs.column != null ? { column: Number(node.attrs.column) } : {}),
    };
    const href = escapeHtml(String(node.attrs.href || fileRefHref(reference)));
    const title = escapeHtml(fileRefTitle(reference));
    const iconName = resolveMaterialIconName(reference.path);
    const iconUrl = escapeHtml(getMaterialIconUrl(iconName));
    const label = escapeHtml(formatWorkspaceFileReferenceLabel(reference));
    return (
      `<a href="${href}" class="markdown-file-ref" title="${title}" data-eco-file="1">` +
      `<img class="markdown-file-ref__icon" src="${iconUrl}" alt="" width="14" height="14" draggable="false" aria-hidden="true"/>` +
      `<span class="markdown-file-ref__label">${label}</span>` +
      `</a>`
    );
  }
  if (node.type.name === "hard_break") {
    return "<br/>";
  }
  if (node.type.name === "html_inline") {
    return String(node.attrs.html ?? "");
  }
  if (node.isText) {
    let text = escapeHtml(node.text ?? "");
    for (const mark of node.marks) {
      if (mark.type.name === "code") {
        text = `<code class="markdown-inline-code">${text}</code>`;
      } else if (mark.type.name === "strong") {
        text = `<strong>${text}</strong>`;
      } else if (mark.type.name === "em") {
        text = `<em>${text}</em>`;
      } else if (mark.type.name === "strikethrough") {
        text = `<del>${text}</del>`;
      } else if (mark.type.name === "link") {
        const href = escapeHtml(String(mark.attrs.href ?? ""));
        text =
          `<a href="${href}"` +
          (mark.attrs.title ? ` title="${escapeHtml(String(mark.attrs.title))}"` : "") +
          ` target="_blank" rel="noreferrer noopener">${text}</a>`;
      }
    }
    return text;
  }
  let out = "";
  node.forEach((child) => {
    out += serializeInline(child);
  });
  return out;
}

function serializeCodeBlock(node: PMNode): string {
  const language = (String(node.attrs.params ?? "").trim() || "text").toLowerCase();
  const code = escapeHtml(node.textContent);
  const mermaidClass = isMermaidLang(language) ? " markdown-code-block--mermaid" : "";
  const htmlClass = isHtmlLang(language) ? " markdown-code-block--html" : "";
  if (isHtmlLang(language)) {
    const title = extractHtmlDocumentTitle(node.textContent) ?? i18n.t("markdown.html.cardTitle");
    const lineCount = countHtmlLines(node.textContent);
    return (
      `<div class="markdown-code-block${htmlClass}">` +
      `<button type="button" class="markdown-html-card" disabled>` +
      `<span class="markdown-html-card__title">${escapeHtml(title)}</span>` +
      `<span class="markdown-html-card__meta">${escapeHtml(i18n.t("markdown.html.lineCount", { count: lineCount }))}</span>` +
      `</button>` +
      `</div>`
    );
  }
  return (
    `<div class="markdown-code-block${mermaidClass}">` +
    `<div class="markdown-code-block__toolbar">` +
    `<span class="markdown-code-block__language">${escapeHtml(language)}</span>` +
    `<div class="markdown-code-block__actions"></div>` +
    `</div>` +
    `<pre class="markdown-pre"><code class="language-${escapeHtml(language)}">${code}</code></pre>` +
    `</div>`
  );
}

function serializeTable(node: PMNode): string {
  let body = "";
  node.forEach((row) => {
    body += "<tr>";
    row.forEach((cell) => {
      const isHeader = cell.type.name === "table_header";
      const tag = isHeader ? "th" : "td";
      const colspan = Number(cell.attrs.colspan || 1);
      const rowspan = Number(cell.attrs.rowspan || 1);
      const attrs =
        (colspan > 1 ? ` colspan="${colspan}"` : "") +
        (rowspan > 1 ? ` rowspan="${rowspan}"` : "") +
        (isHeader ? ` style="min-width:${markdownTableHeaderMinWidthCh(cell.textContent)}ch"` : "");
      body += isHeader
        ? `<${tag}${attrs}><span class="markdown-table-th">${serializeInline(cell)}</span></${tag}>`
        : `<${tag}${attrs}>${serializeInline(cell)}</${tag}>`;
    });
    body += "</tr>";
  });
  return `<table class="markdown-table"><tbody>${body}</tbody></table>`;
}

function serializeBlock(node: PMNode): string {
  switch (node.type.name) {
    case "paragraph":
      return `<p>${serializeInline(node)}</p>`;
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1));
      return `<h${level}>${serializeInline(node)}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote>${serializeChildren(node)}</blockquote>`;
    case "code_block":
      return serializeCodeBlock(node);
    case "bullet_list":
      return `<ul>${serializeChildren(node)}</ul>`;
    case "ordered_list":
      return `<ol>${serializeChildren(node)}</ol>`;
    case "list_item":
      return `<li>${serializeChildren(node)}</li>`;
    case "horizontal_rule":
      return `<hr/>`;
    case "table":
      return serializeTable(node);
    case "image": {
      const src = escapeHtml(String(node.attrs.src ?? ""));
      const alt = escapeHtml(String(node.attrs.alt ?? ""));
      const title = node.attrs.title ? ` title="${escapeHtml(String(node.attrs.title))}"` : "";
      return `<img src="${src}" alt="${alt}"${title}/>`;
    }
    case "html_block":
      return String(node.attrs.html ?? "");
    default:
      return serializeChildren(node);
  }
}

function serializeChildren(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    out += child.isInline ? serializeInline(child) : serializeBlock(child);
  });
  return out;
}

/** DOM-less HTML for SSR / renderToStaticMarkup tests. */
export function renderFeedMarkdownHtml(text: string): string {
  if (!text.trim()) return "";
  const doc = createFeedMarkdownDoc(text);
  return serializeChildren(doc);
}

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const WRAP_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M3 12h15"/><path d="M3 18h18"/><path d="m19 9 3 3-3 3"/></svg>';
const EXPAND_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/></svg>';
const TABLE_COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const TABLE_DOWNLOAD_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';
const CLOSE_PREVIEW_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';
const OPEN_PREVIEW_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
const HTML_GLOBE_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';
const HTML_OPEN_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
const LIGHTBOX_CLOSE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const ZOOM_IN_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
const ZOOM_OUT_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"/></svg>';
const ZOOM_RESET_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

function createActionButton(label: string, iconHtml: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "markdown-code-block__action";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.innerHTML = iconHtml;
  btn.addEventListener("mousedown", (event) => event.preventDefault());
  return btn;
}

function dismissMarkdownLightbox(root?: Element | null): void {
  const el = root ?? document.querySelector(".markdown-lightbox");
  if (!el) return;
  const cleanup = (el as HTMLElement & { __ecoLightboxCleanup?: () => void }).__ecoLightboxCleanup;
  if (cleanup) {
    cleanup();
    return;
  }
  el.remove();
}

function openMarkdownLightbox(options: {
  title: string;
  ariaLabel: string;
  bodyHtml: string;
  bodyClassName?: string;
  zoomable?: boolean;
}): void {
  dismissMarkdownLightbox();

  const backdrop = document.createElement("div");
  backdrop.className = "markdown-lightbox";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", options.ariaLabel);

  const content = document.createElement("div");
  content.className = "markdown-lightbox__content";

  const bar = document.createElement("div");
  bar.className = "markdown-lightbox__bar";
  const title = document.createElement("span");
  title.textContent = options.title;

  const closeBtn = createActionButton(i18n.t("common.close"), LIGHTBOX_CLOSE_ICON);
  closeBtn.classList.add("markdown-lightbox__close");

  const stage = document.createElement("div");
  stage.className = [
    "markdown-lightbox__stage",
    options.bodyClassName ? options.bodyClassName : "",
    options.zoomable ? "lightbox-zoom-stage" : "",
  ]
    .filter(Boolean)
    .join(" ");

  let zoom: ReturnType<typeof attachLightboxZoom> | null = null;
  let zoomPercentBtn: HTMLButtonElement | null = null;
  let zoomCanvas: HTMLDivElement | null = null;
  let zoomOutBtn: HTMLButtonElement | null = null;
  let zoomInBtn: HTMLButtonElement | null = null;
  let resetBtn: HTMLButtonElement | null = null;

  if (options.zoomable) {
    const controls = document.createElement("div");
    controls.className = "lightbox-zoom-controls";

    zoomOutBtn = createActionButton(i18n.t("lightbox.zoomOut"), ZOOM_OUT_ICON);
    zoomOutBtn.classList.add("markdown-lightbox__close");
    zoomInBtn = createActionButton(i18n.t("lightbox.zoomIn"), ZOOM_IN_ICON);
    zoomInBtn.classList.add("markdown-lightbox__close");
    zoomPercentBtn = createActionButton(i18n.t("lightbox.zoomReset"), "");
    zoomPercentBtn.classList.add("lightbox-zoom-percent");
    zoomPercentBtn.textContent = "100%";
    resetBtn = createActionButton(i18n.t("lightbox.zoomReset"), ZOOM_RESET_ICON);
    resetBtn.classList.add("markdown-lightbox__close");

    controls.append(zoomOutBtn, zoomPercentBtn, zoomInBtn, resetBtn, closeBtn);
    bar.append(title, controls);

    zoomCanvas = document.createElement("div");
    zoomCanvas.className = "lightbox-zoom-canvas";
    zoomCanvas.innerHTML = options.bodyHtml;
    stage.append(zoomCanvas);
  } else {
    bar.append(title, closeBtn);
    stage.innerHTML = options.bodyHtml;
  }

  content.append(bar, stage);
  backdrop.append(content);
  document.body.append(backdrop);

  // Attach after mount so stage has real layout size (Mermaid fit needs clientWidth).
  if (options.zoomable && zoomCanvas) {
    zoom = attachLightboxZoom({
      stage,
      canvas: zoomCanvas,
      onChange: (transform) => {
        if (zoomPercentBtn) {
          zoomPercentBtn.textContent = formatLightboxZoomPercent(transform.scale);
        }
      },
    });

    zoomOutBtn?.addEventListener("click", (event) => {
      event.preventDefault();
      zoom?.zoomOut();
    });
    zoomInBtn?.addEventListener("click", (event) => {
      event.preventDefault();
      zoom?.zoomIn();
    });
    zoomPercentBtn?.addEventListener("click", (event) => {
      event.preventDefault();
      zoom?.reset();
    });
    resetBtn?.addEventListener("click", (event) => {
      event.preventDefault();
      zoom?.reset();
    });
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    zoom?.destroy();
    zoom = null;
    delete (backdrop as HTMLElement & { __ecoLightboxCleanup?: () => void }).__ecoLightboxCleanup;
    backdrop.remove();
    window.removeEventListener("keydown", onKeyDown);
  };
  (backdrop as HTMLElement & { __ecoLightboxCleanup?: () => void }).__ecoLightboxCleanup = close;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close();
      return;
    }
    if (!zoom) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom.zoomIn();
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoom.zoomOut();
    } else if (event.key === "0") {
      event.preventDefault();
      zoom.reset();
    }
  };
  closeBtn.addEventListener("click", (event) => {
    event.preventDefault();
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  window.addEventListener("keydown", onKeyDown);
}

function openMermaidLightbox(svgHtml: string): void {
  openMarkdownLightbox({
    title: "mermaid",
    ariaLabel: i18n.t("markdown.mermaid.expand"),
    bodyHtml: svgHtml,
    zoomable: true,
  });
}

function openTableLightbox(tableHtml: string): void {
  openMarkdownLightbox({
    title: i18n.t("markdown.table.label"),
    ariaLabel: i18n.t("markdown.table.expand"),
    bodyHtml: tableHtml,
    bodyClassName: "markdown-lightbox__stage--table",
  });
}

function createCodeBlockToolbar(
  lang: string,
  getSource: () => string,
  options?: {
    wrap?: boolean;
    mermaidActions?: boolean;
    getMermaidSvg?: () => string;
  },
) {
  const toolbar = document.createElement("div");
  toolbar.className = "markdown-code-block__toolbar";

  const language = document.createElement("span");
  language.className = "markdown-code-block__language";
  language.textContent = lang;

  const actions = document.createElement("div");
  actions.className = "markdown-code-block__actions";

  let wrapBtn: HTMLButtonElement | null = null;
  let expandBtn: HTMLButtonElement | null = null;
  let previewBtn: HTMLButtonElement | null = null;
  let closeCopyMenu: (() => void) | null = null;

  if (options?.wrap) {
    const copyBtn = createActionButton(i18n.t("common.copy"), COPY_ICON);
    copyBtn.addEventListener("click", (event) => {
      event.preventDefault();
      void copyTextToClipboard(getSource()).then((ok) => {
        if (!ok) return;
        copyBtn.innerHTML = CHECK_ICON;
        window.setTimeout(() => {
          copyBtn.innerHTML = COPY_ICON;
        }, 1400);
      });
    });
    wrapBtn = createActionButton(i18n.t("markdown.code.wrap"), WRAP_ICON);
    actions.append(wrapBtn, copyBtn);
  } else if (options?.mermaidActions) {
    expandBtn = createActionButton(i18n.t("markdown.mermaid.expand"), EXPAND_ICON);
    previewBtn = createActionButton(i18n.t("markdown.mermaid.closePreview"), CLOSE_PREVIEW_ICON);

    const copyWrap = document.createElement("div");
    copyWrap.className = "markdown-mermaid-copy-wrap";

    const copyBtn = createActionButton(i18n.t("markdown.mermaid.copy"), COPY_ICON);
    copyBtn.classList.add("markdown-mermaid-copy-trigger");
    copyBtn.setAttribute("aria-haspopup", "menu");
    copyBtn.setAttribute("aria-expanded", "false");

    const menu = document.createElement("div");
    menu.className = "markdown-mermaid-copy-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const getSvg = options.getMermaidSvg ?? (() => "");
    const menuItems: Array<{
      labelKey: string;
      run: () => Promise<boolean>;
    }> = [
      {
        labelKey: "markdown.mermaid.copyMarkdown",
        run: () => copyMermaidAsMarkdown(getSource()),
      },
      {
        labelKey: "markdown.mermaid.copyImage",
        run: async () => {
          let svg = getSvg().trim();
          if (!svg) {
            try {
              svg = await renderMermaidSvg(getSource());
            } catch {
              return false;
            }
          }
          return copyMermaidAsImage(svg);
        },
      },
    ];

    for (const item of menuItems) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "markdown-mermaid-copy-menu__item";
      btn.setAttribute("role", "menuitem");
      btn.textContent = i18n.t(item.labelKey);
      btn.addEventListener("mousedown", (event) => event.preventDefault());
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void item.run().then((ok) => {
          closeCopyMenu?.();
          if (!ok) {
            copyBtn.title = i18n.t("markdown.mermaid.copyFailed");
            window.setTimeout(() => {
              copyBtn.title = i18n.t("markdown.mermaid.copy");
            }, 1600);
            return;
          }
          copyBtn.innerHTML = CHECK_ICON;
          window.setTimeout(() => {
            copyBtn.innerHTML = COPY_ICON;
          }, 1400);
        });
      });
      menu.append(btn);
    }

    const onPointerDownOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || copyWrap.contains(target)) return;
      closeCopyMenu?.();
    };

    closeCopyMenu = () => {
      menu.hidden = true;
      copyWrap.classList.remove("is-open");
      copyBtn.setAttribute("aria-expanded", "false");
      window.removeEventListener("pointerdown", onPointerDownOutside, true);
    };

    const openCopyMenu = () => {
      menu.hidden = false;
      copyWrap.classList.add("is-open");
      copyBtn.setAttribute("aria-expanded", "true");
      window.addEventListener("pointerdown", onPointerDownOutside, true);
    };

    copyBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu.hidden) openCopyMenu();
      else closeCopyMenu?.();
    });

    copyWrap.append(copyBtn, menu);
    actions.append(expandBtn, previewBtn, copyWrap);
  } else {
    const copyBtn = createActionButton(i18n.t("common.copy"), COPY_ICON);
    copyBtn.addEventListener("click", (event) => {
      event.preventDefault();
      void copyTextToClipboard(getSource()).then((ok) => {
        if (!ok) return;
        copyBtn.innerHTML = CHECK_ICON;
        window.setTimeout(() => {
          copyBtn.innerHTML = COPY_ICON;
        }, 1400);
      });
    });
    actions.append(copyBtn);
  }

  toolbar.append(language, actions);
  return { toolbar, language, wrapBtn, expandBtn, previewBtn, closeCopyMenu };
}

function createTableNodeView(): {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  update: (updated: PMNode) => boolean;
  destroy: () => void;
} {
  const wrap = document.createElement("div");
  wrap.className = "markdown-table-block";

  const scroll = document.createElement("div");
  scroll.className = "markdown-table-scroll";
  const table = document.createElement("table");
  table.className = "markdown-table";
  const tbody = document.createElement("tbody");
  table.append(tbody);
  scroll.append(table);

  const actions = document.createElement("div");
  actions.className = "markdown-table-actions";

  const expandBtn = createActionButton(i18n.t("markdown.table.expand"), EXPAND_ICON);
  expandBtn.classList.add("markdown-table-action");

  type TableMenuItem = {
    labelKey: string;
    run: () => boolean | Promise<boolean>;
  };

  const createTableActionMenu = (options: {
    wrapClassName: string;
    triggerLabelKey: string;
    triggerIcon: string;
    failedLabelKey: string;
    items: readonly TableMenuItem[];
  }) => {
    const menuWrap = document.createElement("div");
    menuWrap.className = options.wrapClassName;

    const trigger = createActionButton(i18n.t(options.triggerLabelKey), options.triggerIcon);
    trigger.classList.add("markdown-table-action", "markdown-table-menu-trigger");
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");

    const menu = document.createElement("div");
    menu.className = "markdown-table-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    let closePeerMenus: (() => void) | null = null;

    const closeMenu = () => {
      menu.hidden = true;
      menuWrap.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
      window.removeEventListener("pointerdown", onPointerDownOutside, true);
    };

    const openMenu = () => {
      closePeerMenus?.();
      menu.hidden = false;
      menuWrap.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
      window.addEventListener("pointerdown", onPointerDownOutside, true);
    };

    const onPointerDownOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || menuWrap.contains(target)) return;
      closeMenu();
    };

    for (const item of options.items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "markdown-table-menu__item";
      btn.setAttribute("role", "menuitem");
      btn.textContent = i18n.t(item.labelKey);
      btn.addEventListener("mousedown", (event) => event.preventDefault());
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void Promise.resolve(item.run()).then((ok) => {
          closeMenu();
          if (!ok) {
            trigger.title = i18n.t(options.failedLabelKey);
            window.setTimeout(() => {
              trigger.title = i18n.t(options.triggerLabelKey);
            }, 1600);
            return;
          }
          trigger.innerHTML = CHECK_ICON;
          window.setTimeout(() => {
            trigger.innerHTML = options.triggerIcon;
          }, 1400);
        });
      });
      menu.append(btn);
    }

    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu.hidden) openMenu();
      else closeMenu();
    });

    menuWrap.append(trigger, menu);
    return {
      wrap: menuWrap,
      closeMenu,
      setClosePeerMenus(fn: () => void) {
        closePeerMenus = fn;
      },
    };
  };

  const copyMenu = createTableActionMenu({
    wrapClassName: "markdown-table-menu-wrap markdown-table-copy-wrap",
    triggerLabelKey: "markdown.table.copy",
    triggerIcon: TABLE_COPY_ICON,
    failedLabelKey: "markdown.table.copyFailed",
    items: [
      {
        labelKey: "markdown.table.copyMarkdown",
        run: () => copyTableAsMarkdown(table),
      },
      {
        labelKey: "markdown.table.copyHtml",
        run: () => copyTableAsHtml(table),
      },
      {
        labelKey: "markdown.table.copyImage",
        run: () => copyTableAsImage(table),
      },
    ],
  });

  const downloadMenu = createTableActionMenu({
    wrapClassName: "markdown-table-menu-wrap markdown-table-download-wrap",
    triggerLabelKey: "markdown.table.download",
    triggerIcon: TABLE_DOWNLOAD_ICON,
    failedLabelKey: "markdown.table.downloadFailed",
    items: [
      {
        labelKey: "markdown.table.downloadCsv",
        run: () => downloadTableAsCsv(table),
      },
      {
        labelKey: "markdown.table.downloadExcel",
        run: () => downloadTableAsExcel(table),
      },
    ],
  });

  copyMenu.setClosePeerMenus(() => downloadMenu.closeMenu());
  downloadMenu.setClosePeerMenus(() => copyMenu.closeMenu());

  const closeAllMenus = () => {
    copyMenu.closeMenu();
    downloadMenu.closeMenu();
  };

  expandBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeAllMenus();
    openTableLightbox(table.outerHTML);
  });

  actions.append(expandBtn, copyMenu.wrap, downloadMenu.wrap);
  wrap.append(scroll, actions);

  return {
    dom: wrap,
    contentDOM: tbody,
    update(updated) {
      return updated.type.name === "table";
    },
    destroy() {
      closeAllMenus();
      dismissMarkdownLightbox();
    },
  };
}

export type MermaidFeedViewPlan = "source" | "deferred" | "cached-svg" | "render";

/**
 * Distance ahead of the feed viewport at which a Mermaid diagram is rendered.
 * Rendering before the diagram is on screen keeps scroll smooth.
 */
export const MERMAID_FEED_RENDER_AHEAD_PX = 480;

/**
 * Distance from the feed viewport at which a rendered diagram releases its SVG.
 * Deliberately far past the render margin: one shared boundary makes a diagram
 * mount and release again every time the user wobbles around it, and each
 * release drops the SVG plus its ResizeObserver. The feed scroller is roughly
 * one 620px screen, so this keeps every diagram within about four screens
 * mounted; the virtualizer window is the real bound on how many stay alive.
 */
export const MERMAID_FEED_RELEASE_BEYOND_PX = 2_400;

/**
 * Decide how a feed Mermaid block paints itself.
 *
 * A block that leaves the viewport releases its heavyweight SVG but keeps the
 * cached markup so expand/copy still work from the toolbar. That cached markup
 * must be re-mounted when the block scrolls back in; treating the released state
 * as "already rendered" left every released diagram stuck on its placeholder.
 */
export function planMermaidFeedView(input: {
  hasSource: boolean;
  previewOpen: boolean;
  visible: boolean;
  hasCachedSvg: boolean;
}): MermaidFeedViewPlan {
  if (!input.previewOpen || !input.hasSource) return "source";
  if (!input.visible) return "deferred";
  return input.hasCachedSvg ? "cached-svg" : "render";
}

function createMermaidCodeBlockNodeView(node: PMNode): {
  dom: HTMLElement;
  contentDOM: null;
  update: (updated: PMNode) => boolean;
  destroy: () => void;
} {
  const wrap = document.createElement("div");
  wrap.className = "markdown-code-block markdown-code-block--mermaid";

  let source = node.textContent;
  let previewOpen = true;
  let lastSvg = "";

  const { toolbar, language, expandBtn, previewBtn, closeCopyMenu } = createCodeBlockToolbar(
    "mermaid",
    () => source,
    {
      mermaidActions: true,
      getMermaidSvg: () => lastSvg,
    },
  );
  language.textContent = "mermaid";

  const body = document.createElement("div");
  body.className = "markdown-mermaid";
  body.setAttribute("aria-busy", "true");

  wrap.append(toolbar, body);

  let disposed = false;
  let renderToken = 0;
  let renderTimer: number | undefined;
  let visible = typeof IntersectionObserver === "undefined";
  let visibilityObserver: IntersectionObserver | undefined;
  let releaseObserver: IntersectionObserver | undefined;
  let visibilitySetupFrame: number | undefined;
  let theme: MermaidAppTheme = readAppTheme();

  const syncPreviewButton = () => {
    if (!previewBtn) return;
    const label = previewOpen
      ? i18n.t("markdown.mermaid.closePreview")
      : i18n.t("markdown.mermaid.openPreview");
    previewBtn.setAttribute("aria-label", label);
    previewBtn.title = label;
    previewBtn.innerHTML = previewOpen ? CLOSE_PREVIEW_ICON : OPEN_PREVIEW_ICON;
    previewBtn.classList.toggle("is-active", !previewOpen);
    if (expandBtn) {
      expandBtn.disabled = !previewOpen || !lastSvg;
      expandBtn.classList.toggle("is-disabled", expandBtn.disabled);
    }
  };

  const showSource = (message?: string) => {
    body.classList.toggle("is-error", Boolean(message));
    body.removeAttribute("aria-busy");
    body.replaceChildren();
    if (message) {
      const err = document.createElement("div");
      err.className = "markdown-mermaid__error";
      err.textContent = `${i18n.t("markdown.mermaid.renderError")}: ${message}`;
      body.append(err);
    }
    const pre = document.createElement("pre");
    pre.className = "markdown-pre markdown-mermaid__source";
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = source;
    pre.appendChild(code);
    body.append(pre);
  };

  const showSvg = (svg: string) => {
    body.classList.remove("is-error");
    body.removeAttribute("aria-busy");
    mountMermaidSvgForFeed(body, svg, source);
  };

  /**
   * Height this diagram already occupied, read from the shared cache rather
   * than a local copy: the first render records it here and every later
   * release has to see it.
   */
  const reservedHeightPx = () => recallMermaidFeedHeight(source);

  const reservedBox = (className: string, label?: string) => {
    const box = document.createElement("div");
    box.className = className;
    const reserved = reservedHeightPx();
    if (reserved > 0) {
      box.style.minHeight = `${reserved}px`;
    }
    if (label) {
      box.textContent = label;
    } else {
      box.setAttribute("aria-hidden", "true");
    }
    return box;
  };

  const showDeferredPreview = () => {
    body.classList.remove("is-error");
    body.removeAttribute("aria-busy");
    body.replaceChildren(reservedBox("markdown-mermaid__deferred", i18n.t("markdown.mermaid.deferred")));
  };

  const render = () => {
    const hasSource = source.trim().length > 0;
    const plan = planMermaidFeedView({
      hasSource,
      previewOpen,
      visible,
      hasCachedSvg: lastSvg.length > 0,
    });
    // Any in-flight Mermaid render belongs to an older view state.
    const token = ++renderToken;
    if (plan === "source") {
      if (!hasSource) lastSvg = "";
      showSource();
      syncPreviewButton();
      return;
    }
    if (plan === "deferred") {
      showDeferredPreview();
      return;
    }
    if (plan === "cached-svg") {
      showSvg(lastSvg);
      syncPreviewButton();
      return;
    }
    const currentSource = source;
    const currentTheme = theme;
    body.classList.remove("is-error");
    body.setAttribute("aria-busy", "true");
    // Hold the known height while the diagram renders. A diagram that is
    // already painted keeps its SVG, so a theme switch never flashes blank.
    if (!body.querySelector(".markdown-mermaid__paint")) {
      body.replaceChildren(reservedBox("markdown-mermaid__reserved"));
    }
    void renderMermaidSvg(currentSource, currentTheme)
      .then((svg) => {
        if (disposed || token !== renderToken) return;
        lastSvg = svg;
        if (previewOpen) showSvg(svg);
        syncPreviewButton();
      })
      .catch((error: unknown) => {
        if (disposed || token !== renderToken) return;
        lastSvg = "";
        const message = error instanceof Error ? error.message : String(error);
        showSource(message || "unknown error");
        previewOpen = false;
        syncPreviewButton();
      });
  };

  const scheduleRender = () => {
    if (renderTimer !== undefined) {
      window.clearTimeout(renderTimer);
    }
    renderTimer = window.setTimeout(() => {
      renderTimer = undefined;
      render();
    }, 160);
  };

  const setVisible = (next: boolean) => {
    if (next === visible) return;
    visible = next;
    if (visible) {
      // render() re-mounts the cached SVG or renders it for the first time.
      if (previewOpen) scheduleRender();
    } else if (previewOpen) {
      // Keep the source and toolbar, but release the heavyweight SVG and
      // its ResizeObserver while the diagram is far outside the viewport.
      renderToken += 1;
      if (renderTimer !== undefined) {
        window.clearTimeout(renderTimer);
        renderTimer = undefined;
      }
      showDeferredPreview();
    }
  };

  const setupVisibilityObserver = (attempt = 0) => {
    if (disposed || visibilityObserver) return;

    // A ProseMirror node view is constructed before its DOM node is attached.
    // Waiting until it is connected is required so that closest() finds the
    // real scrolling feed instead of falling back to the browser viewport.
    if (!wrap.isConnected && attempt < 10) {
      visibilitySetupFrame = window.requestAnimationFrame(() => {
        visibilitySetupFrame = undefined;
        setupVisibilityObserver(attempt + 1);
      });
      return;
    }

    const root = wrap.closest<HTMLElement>(".activity-messages");
    // Two margins, not one: a single boundary makes a diagram mount and release
    // again whenever the user wobbles around it. Render only once the diagram is
    // about to enter the viewport, but keep it mounted until it is a screen or
    // two away, so scroll jitter and short trips stay free.
    const margin = (px: number) => ({ root, rootMargin: `${px}px 0px`, threshold: 0 });
    visibilityObserver = new IntersectionObserver((entries) => {
      // Only the enter direction is meaningful here; leaving is handled below.
      if (entries[0]?.isIntersecting) setVisible(true);
    }, margin(MERMAID_FEED_RENDER_AHEAD_PX));
    releaseObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry && !entry.isIntersecting) setVisible(false);
    }, margin(MERMAID_FEED_RELEASE_BEYOND_PX));
    visibilityObserver.observe(wrap);
    releaseObserver.observe(wrap);
    render();
  };

  // Chromium only recomputes IntersectionObserver targets while the window is
  // being rendered. Callbacks stop arriving while the app is occluded,
  // minimized, or on another Space, so a diagram first seen in those conditions
  // would keep its placeholder. The native visibilitychange/focus events make
  // both observers re-report the current intersection once rendering resumes.
  const resyncObservedVisibility = () => {
    if (disposed || !visibilityObserver || document.visibilityState !== "visible") return;
    for (const observer of [visibilityObserver, releaseObserver]) {
      if (!observer) continue;
      observer.unobserve(wrap);
      observer.observe(wrap);
    }
  };
  document.addEventListener("visibilitychange", resyncObservedVisibility);
  window.addEventListener("focus", resyncObservedVisibility);

  if (typeof IntersectionObserver !== "undefined") {
    setupVisibilityObserver();
  }

  expandBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    if (!previewOpen || !lastSvg) return;
    openMermaidLightbox(lastSvg);
  });

  previewBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    previewOpen = !previewOpen;
    render();
  });

  if (typeof IntersectionObserver === "undefined") {
    render();
  }
  const stopTheme = observeAppTheme((next) => {
    if (next === theme) return;
    theme = next;
    // The cached markup was painted with the previous theme.
    lastSvg = "";
    scheduleRender();
  });

  return {
    dom: wrap,
    contentDOM: null,
    update(updated) {
      if (updated.type.name !== "code_block") return false;
      if (!isMermaidLang(updated.attrs.params)) return false;
      const nextSource = updated.textContent;
      if (nextSource === source) return true;
      source = nextSource;
      lastSvg = "";
      scheduleRender();
      return true;
    },
    destroy() {
      disposed = true;
      if (visibilitySetupFrame !== undefined) {
        window.cancelAnimationFrame(visibilitySetupFrame);
        visibilitySetupFrame = undefined;
      }
      document.removeEventListener("visibilitychange", resyncObservedVisibility);
      window.removeEventListener("focus", resyncObservedVisibility);
      visibilityObserver?.disconnect();
      releaseObserver?.disconnect();
      if (renderTimer !== undefined) {
        window.clearTimeout(renderTimer);
        renderTimer = undefined;
      }
      closeCopyMenu?.();
      stopTheme();
      dismissMarkdownLightbox();
    },
  };
}

function openHtmlPreviewInBrowser(html: string): void {
  const dataUrl = buildHtmlDataNavigateUrl(html);
  if (dataUrl) {
    dispatchBrowserLinkOpen(dataUrl);
    return;
  }
  dispatchBrowserHtmlOpen(html);
}

function syncHtmlCardContent(
  card: HTMLButtonElement,
  titleEl: HTMLElement,
  metaEl: HTMLElement,
  html: string,
): void {
  const title = extractHtmlDocumentTitle(html) ?? i18n.t("markdown.html.cardTitle");
  const lineCount = countHtmlLines(html);
  titleEl.textContent = title;
  metaEl.textContent = i18n.t("markdown.html.lineCount", { count: lineCount });
  card.title = i18n.t("markdown.html.openInBrowser");
  card.setAttribute("aria-label", `${title} — ${i18n.t("markdown.html.openInBrowser")}`);
}

function createHtmlCodeBlockNodeView(node: PMNode): {
  dom: HTMLElement;
  contentDOM: null;
  update: (updated: PMNode) => boolean;
} {
  const wrap = document.createElement("div");
  wrap.className = "markdown-code-block markdown-code-block--html";

  let source = node.textContent;

  const card = document.createElement("button");
  card.type = "button";
  card.className = "markdown-html-card";

  const icon = document.createElement("span");
  icon.className = "markdown-html-card__icon";
  icon.innerHTML = HTML_GLOBE_ICON;

  const body = document.createElement("span");
  body.className = "markdown-html-card__body";

  const titleEl = document.createElement("span");
  titleEl.className = "markdown-html-card__title";

  const metaEl = document.createElement("span");
  metaEl.className = "markdown-html-card__meta";

  const hint = document.createElement("span");
  hint.className = "markdown-html-card__hint";
  hint.innerHTML = HTML_OPEN_ICON;

  body.append(titleEl, metaEl);
  card.append(icon, body, hint);
  syncHtmlCardContent(card, titleEl, metaEl, source);

  card.addEventListener("click", (event) => {
    event.preventDefault();
    openHtmlPreviewInBrowser(source);
  });

  wrap.append(card);

  return {
    dom: wrap,
    contentDOM: null,
    update(updated) {
      if (updated.type.name !== "code_block") return false;
      if (!isHtmlLang(updated.attrs.params)) return false;
      const nextSource = updated.textContent;
      if (nextSource === source) return true;
      source = nextSource;
      syncHtmlCardContent(card, titleEl, metaEl, source);
      return true;
    },
  };
}

function createPlainCodeBlockNodeView(node: PMNode): {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  update: (updated: PMNode) => boolean;
} {
  const wrap = document.createElement("div");
  wrap.className = "markdown-code-block";

  const lang = (String(node.attrs.params ?? "").trim() || "text").toLowerCase();
  let wrapping = false;

  const pre = document.createElement("pre");
  pre.className = "markdown-pre";
  const code = document.createElement("code");
  if (lang) code.className = `language-${lang}`;
  pre.appendChild(code);

  const { toolbar, language, wrapBtn } = createCodeBlockToolbar(lang, () => code.textContent ?? "", {
    wrap: true,
  });

  if (wrapBtn) {
    wrapBtn.addEventListener("mousedown", (event) => event.preventDefault());
    wrapBtn.addEventListener("click", (event) => {
      event.preventDefault();
      wrapping = !wrapping;
      wrap.classList.toggle("is-wrap", wrapping);
      wrapBtn.classList.toggle("is-active", wrapping);
      const label = wrapping ? i18n.t("markdown.code.unwrap") : i18n.t("markdown.code.wrap");
      wrapBtn.setAttribute("aria-label", label);
      wrapBtn.title = label;
    });
  }

  wrap.append(toolbar, pre);

  return {
    dom: wrap,
    contentDOM: code,
    update(updated) {
      if (updated.type.name !== "code_block") return false;
      if (isMermaidLang(updated.attrs.params)) return false;
      if (isHtmlLang(updated.attrs.params)) return false;
      const nextLang = (String(updated.attrs.params ?? "").trim() || "text").toLowerCase();
      language.textContent = nextLang;
      code.className = nextLang ? `language-${nextLang}` : "";
      return true;
    },
  };
}

function createCodeBlockNodeView(): NodeViewConstructor {
  return (node) => {
    if (isMermaidLang(node.attrs.params)) {
      return createMermaidCodeBlockNodeView(node);
    }
    if (isHtmlLang(node.attrs.params)) {
      return createHtmlCodeBlockNodeView(node);
    }
    return createPlainCodeBlockNodeView(node);
  };
}

export function createFeedMarkdownPlugins(): Plugin[] {
  return [
    new Plugin({
      props: {
        nodeViews: {
          code_block: createCodeBlockNodeView(),
          table: () => createTableNodeView(),
        },
        handleDOMEvents: {
          click(_view, event) {
            const target = event.target;
            if (!(target instanceof Element)) return false;
            const anchor = target.closest("a");
            if (!(anchor instanceof HTMLAnchorElement)) return false;
            const href = anchor.getAttribute("href") ?? "";
            const reference = parseWorkspaceFileReferenceHref(href);
            if (reference) {
              event.preventDefault();
              dispatchWorkspaceFileReference(reference);
              return true;
            }
            if (anchor.classList.contains("markdown-file-ref")) {
              return false;
            }
            if (isHttpishHref(href)) {
              event.preventDefault();
              dispatchBrowserLinkOpen(href);
              return true;
            }
            return false;
          },
        },
        attributes: {
          class: "ProseMirror pm-feed-markdown-doc",
        },
      },
    }),
  ];
}

export const FEED_MARKDOWN_PLUGINS = createFeedMarkdownPlugins();
