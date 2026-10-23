import { expect, test } from "bun:test";
import {
  createFeedMarkdownDoc,
  isMermaidLang,
  markdownTableHeaderMinWidthCh,
  renderFeedMarkdownHtml,
} from "../src/renderer/prosemirror/feed-markdown";

test("createFeedMarkdownDoc models paragraphs, code fences, and file refs", () => {
  const doc = createFeedMarkdownDoc(
    ["hello", "", "```ts", "const x = 1", "```", "", "See /tmp/a.ts:2"].join("\n"),
  );
  const types: string[] = [];
  doc.descendants((node) => {
    types.push(node.type.name);
  });
  expect(types).toContain("paragraph");
  expect(types).toContain("code_block");
  expect(types).toContain("file_ref");
});

test("createFeedMarkdownDoc recognizes @file attachment tokens", () => {
  const doc = createFeedMarkdownDoc("Please inspect @file{/tmp/report.md}");
  let fileRefPath: string | undefined;
  doc.descendants((node) => {
    if (node.type.name === "file_ref") {
      fileRefPath = String(node.attrs.path);
    }
  });
  expect(fileRefPath).toBe("/tmp/report.md");
});

test("createFeedMarkdownDoc models GFM tables and blockquotes", () => {
  const doc = createFeedMarkdownDoc(
    ["> quoted", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "~~old~~"].join("\n"),
  );
  const types: string[] = [];
  const marks: string[] = [];
  doc.descendants((node) => {
    types.push(node.type.name);
    for (const mark of node.marks) marks.push(mark.type.name);
  });
  expect(types).toContain("blockquote");
  expect(types).toContain("table");
  expect(types).toContain("table_header");
  expect(types).toContain("table_cell");
  expect(marks).toContain("strikethrough");
});

test("renderFeedMarkdownHtml keeps external links and fenced language labels", () => {
  const html = renderFeedMarkdownHtml("[Docs](https://example.com)\n\n```json\n{}\n```");
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain("markdown-code-block__language");
  expect(html).toContain(">json<");
});

test("inline code mark uses markdown-inline-code class in the document model", () => {
  const doc = createFeedMarkdownDoc("use `foo` here");
  let saw = false;
  doc.descendants((node) => {
    if (!node.isText) return;
    if (node.marks.some((m) => m.type.name === "code")) {
      saw = true;
      expect(node.text).toBe("foo");
    }
  });
  expect(saw).toBe(true);
  const html = renderFeedMarkdownHtml("use `foo` here");
  expect(html).toContain('class="markdown-inline-code"');
  expect(html).toContain(">foo<");
});

test("renders CJK emphasis beside punctuation without inserting spaces", () => {
  const cases: Array<[string, string]> = [
    [
      "**混用登录模型和自定义模型的子代理，需要单独设计。**原生子代理由父进程创建。",
      "<strong>混用登录模型和自定义模型的子代理，需要单独设计。</strong>原生子代理由父进程创建。",
    ],
    [
      "**两个进程仍能修改同一个项目目录。**分开 `CODEX_HOME` 隔离的是 Codex 自身状态。",
      '<strong>两个进程仍能修改同一个项目目录。</strong>分开 <code class="markdown-inline-code">CODEX_HOME</code> 隔离的是 Codex 自身状态。',
    ],
    ["请看**「重要」**说明。", "请看<strong>「重要」</strong>说明。"],
    ["这里*强调。*继续。", "这里<em>强调。</em>继续。"],
    ["这里***重要。***继续。", "这里<strong><em>重要。</em></strong>继续。"],
    ["**テスト。**続き", "<strong>テスト。</strong>続き"],
  ];
  for (const [source, html] of cases) {
    expect(renderFeedMarkdownHtml(source)).toBe(`<p>${html}</p>`);
  }
});

test("CJK emphasis keeps literal markers in code and escaped text", () => {
  expect(renderFeedMarkdownHtml("`**中文。**后续`")).toBe(
    '<p><code class="markdown-inline-code">**中文。**后续</code></p>',
  );
  expect(renderFeedMarkdownHtml("\\*\\*中文。\\*\\*后续")).toBe("<p>**中文。**后续</p>");
  const fenced = renderFeedMarkdownHtml("```text\n**中文。**后续\n```");
  expect(fenced).toContain("**中文。**后续");
  expect(fenced).not.toContain("<strong>");
  expect(renderFeedMarkdownHtml("**English.**continuation")).toBe("<p>**English.**continuation</p>");
});

test("renderFeedMarkdownHtml serializes tables blockquotes and file refs", () => {
  const html = renderFeedMarkdownHtml(
    ["> note", "", "| h |", "| --- |", "| c |", "", "See /tmp/x.ts"].join("\n"),
  );
  expect(html).toContain("<blockquote>");
  expect(html).toContain('<table class="markdown-table">');
  expect(html).toContain("<th");
  expect(html).toContain('class="markdown-table-th"');
  expect(html).toContain("min-width:");
  expect(html).toContain("<td>");
  expect(html).toContain("markdown-file-ref");
  expect(html).not.toMatch(/class="markdown-file-ref"[^>]*target="_blank"/);
});

test("markdownTableHeaderMinWidthCh prefers about half the unwrapped measure", () => {
  expect(markdownTableHeaderMinWidthCh("abcd")).toBe(4); // floor
  expect(markdownTableHeaderMinWidthCh("abcdefgh")).toBe(4);
  expect(markdownTableHeaderMinWidthCh("abcdefghij")).toBe(5);
  // CJK counts double → "路由示例" (4 chars → 8 units) → min 4ch
  expect(markdownTableHeaderMinWidthCh("路由示例")).toBe(4);
  expect(markdownTableHeaderMinWidthCh("输入单价与价差说明文字")).toBe(11);
  expect(markdownTableHeaderMinWidthCh("x".repeat(80))).toBe(28); // cap
});

test("isMermaidLang matches mermaid fence params", () => {
  expect(isMermaidLang("mermaid")).toBe(true);
  expect(isMermaidLang("Mermaid")).toBe(true);
  expect(isMermaidLang("mermaid theme")).toBe(true);
  expect(isMermaidLang("ts")).toBe(false);
  expect(isMermaidLang("")).toBe(false);
});

test("renderFeedMarkdownHtml marks mermaid fences without rendering SVG", () => {
  const html = renderFeedMarkdownHtml(["```mermaid", "graph TD", "  A-->B", "```"].join("\n"));
  expect(html).toContain("markdown-code-block--mermaid");
  expect(html).toContain("language-mermaid");
  expect(html).toContain("A--&gt;B");
  expect(html).not.toContain("<svg");
});

test("renderFeedMarkdownHtml renders html fences as preview cards", () => {
  const html = renderFeedMarkdownHtml(
    ["```html", "<html><title>Demo</title><body>Hi</body></html>", "```"].join("\n"),
  );
  expect(html).toContain("markdown-code-block--html");
  expect(html).toContain("markdown-html-card");
  expect(html).toContain("Demo");
  expect(html).not.toContain("<body>Hi</body>");
});

test("createFeedMarkdownDoc keeps raw HTML blocks and does not invent file refs", () => {
  const doc = createFeedMarkdownDoc(
    [
      "# Title",
      "",
      "<details>",
      "<summary>展开</summary>",
      "",
      "隐藏内容",
      "",
      "</details>",
      "",
      '<div style="color:red">提示</div>',
    ].join("\n"),
  );
  const json = JSON.stringify(doc.toJSON());
  expect(json).toContain("html_block");
  expect(json).toContain("<details>");
  expect(json).toContain("提示");
  expect(json).not.toContain('"type":"file_ref"');
});

test("renderFeedMarkdownHtml emits raw HTML for block tags", () => {
  const html = renderFeedMarkdownHtml(
    [
      '<div style="color:red"><strong>提示框</strong></div>',
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n"),
  );
  expect(html).toContain('<div style="color:red"><strong>提示框</strong></div>');
  expect(html).toContain("markdown-table");
  expect(html).not.toContain("markdown-file-ref");
});
