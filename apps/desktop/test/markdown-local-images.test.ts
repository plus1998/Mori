import { expect, test } from "bun:test";
import {
  collectLocalImageSrcs,
  dataUrlFromWorkspaceFile,
  isPathInsideWorkspace,
  normalizePathSegments,
  resolveMarkdownImagePath,
  rewriteHtmlImageSrcs,
  rewriteLocalImageSrcs,
} from "../src/renderer/markdown-local-images";
import { createFeedMarkdownDoc } from "../src/renderer/prosemirror/feed-markdown";

const workspace = "C:/repo";
const readme = "C:/repo/README.md";
const nested = "C:/repo/docs/guide.md";

test("normalizePathSegments collapses dot segments", () => {
  expect(normalizePathSegments("C:/repo/docs/../assets/./a.png")).toBe("C:/repo/assets/a.png");
  expect(normalizePathSegments("/repo/docs/../a.png")).toBe("/repo/a.png");
});

test("resolveMarkdownImagePath resolves relative to markdown file", () => {
  expect(resolveMarkdownImagePath(workspace, nested, "../assets/demo.png")).toBe("C:/repo/assets/demo.png");
  expect(resolveMarkdownImagePath(workspace, readme, "docs/assets/demo.png")).toBe(
    "C:/repo/docs/assets/demo.png",
  );
});

test("resolveMarkdownImagePath treats leading slash as workspace-root when not under workspace", () => {
  expect(resolveMarkdownImagePath(workspace, readme, "/docs/assets/demo.png")).toBe(
    "C:/repo/docs/assets/demo.png",
  );
});

test("resolveMarkdownImagePath skips remote and data urls", () => {
  expect(resolveMarkdownImagePath(workspace, readme, "https://example.com/a.png")).toBeUndefined();
  expect(resolveMarkdownImagePath(workspace, readme, "data:image/png;base64,xx")).toBeUndefined();
});

test("resolveMarkdownImagePath supports images outside the workspace", () => {
  expect(resolveMarkdownImagePath(workspace, nested, "../../outside.png")).toBe("C:/outside.png");
  expect(resolveMarkdownImagePath("/repo", "/tmp/report/readme.md", "./images/a.png")).toBe(
    "/tmp/report/images/a.png",
  );
  expect(resolveMarkdownImagePath("/repo", "/tmp/report/readme.md", "/tmp/a.png")).toBe("/tmp/a.png");
  expect(isPathInsideWorkspace(workspace, "C:/other/a.png")).toBe(false);
});

test("collect and rewrite local images in markdown and html blocks", () => {
  const doc = createFeedMarkdownDoc(
    [
      "![hero](docs/assets/a.png)",
      "",
      '<div><img src="apps/desktop/public/splash-icon.png" alt="logo"/></div>',
      "",
      "![remote](https://example.com/b.png)",
    ].join("\n"),
  );
  const srcs = collectLocalImageSrcs(doc);
  expect(srcs).toContain("docs/assets/a.png");
  expect(srcs).toContain("apps/desktop/public/splash-icon.png");
  expect(srcs).not.toContain("https://example.com/b.png");

  const rewritten = rewriteLocalImageSrcs(
    doc,
    new Map([
      ["docs/assets/a.png", "data:image/png;base64,AAA"],
      ["apps/desktop/public/splash-icon.png", "data:image/png;base64,BBB"],
    ]),
  );
  const json = JSON.stringify(rewritten.toJSON());
  expect(json).toContain("data:image/png;base64,AAA");
  expect(json).toContain("data:image/png;base64,BBB");
  expect(json).toContain("https://example.com/b.png");
});

test("rewriteHtmlImageSrcs only replaces mapped srcs", () => {
  const html = '<img src="local.png" alt="x"/><img src="https://x/y.png"/>';
  expect(rewriteHtmlImageSrcs(html, new Map([["local.png", "data:image/png;base64,ZZ"]]))).toBe(
    '<img src="data:image/png;base64,ZZ" alt="x"/><img src="https://x/y.png"/>',
  );
});

test("dataUrlFromWorkspaceFile supports image base64 and svg text", () => {
  expect(
    dataUrlFromWorkspaceFile({
      kind: "image",
      mimeType: "image/png",
      base64: "abc",
    }),
  ).toBe("data:image/png;base64,abc");
  const svgUrl = dataUrlFromWorkspaceFile({
    kind: "text",
    content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  });
  expect(svgUrl?.startsWith("data:image/svg+xml;base64,")).toBe(true);
});
