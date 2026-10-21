import { expect, test } from "bun:test";
import {
  htmlPreviewDocument,
  parseTablePreview,
  TABLE_PREVIEW_ROWS,
} from "../src/renderer/workspace-document-preview";

test("CSV and TSV preserve quoted delimiters, escaped quotes, newlines and empty cells", () => {
  expect(parseTablePreview('name,notes,last\r\n"a,b","line 1\nline ""2""",\r\n', ",").rows).toEqual([
    ["name", "notes", "last"],
    ["a,b", 'line 1\nline "2"', ""],
  ]);
  expect(parseTablePreview('name\tnotes\nvalue\t"tab\tinside"', "\t").rows).toEqual([
    ["name", "notes"],
    ["value", "tab\tinside"],
  ]);
});

test("table preview is bounded and malformed quoting produces a visible error", () => {
  const result = parseTablePreview(`name\n${"row\n".repeat(TABLE_PREVIEW_ROWS + 100)}`, ",");
  expect(result.rows.length).toBe(TABLE_PREVIEW_ROWS + 1);
  expect(result.limited).toBe(true);
  expect(parseTablePreview('name\n"unclosed', ",").error).toBeDefined();
});

test("HTML preview applies its policy before file contents and escapes the resource base", () => {
  const source = '<script>window.parent.hacked = true</script><img src="./image.png">';
  const document = htmlPreviewDocument(source, 'eco-workspace://token/a.html?x="&');
  expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("<script>"));
  expect(document).toContain("default-src 'none'");
  expect(document).toContain("&quot;&amp;");
});
