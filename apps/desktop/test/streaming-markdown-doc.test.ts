import { expect, test } from "bun:test";
import { createFeedMarkdownDoc } from "../src/renderer/prosemirror/feed-markdown";
import {
  buildStreamingMarkdownDoc,
  createStreamingMarkdownDocCache,
  isIncrementalMarkdownSafe,
} from "../src/renderer/streaming-markdown-doc";
import {
  isStructuralStreamingTail,
  partitionStreamingMarkdown,
} from "../src/renderer/streaming-markdown-partition";

/**
 * Markdown blocks can be re-interpreted as more text arrives (`a | b` becomes a
 * table once a delimiter row shows up, a paragraph becomes a setext heading when
 * `---` lands, a blank line splits or merges a list). The incremental builder
 * must therefore produce the exact same document as a full parse for *every*
 * prefix, otherwise streamed output would differ from the settled output.
 */
const corpus: Array<[string, string]> = [
  ["paragraphs", "第一段输出\n\n第二段输出\n\n"],
  ["heading-list", "# 标题\n\n正文内容\n\n- 列表 a\n- 列表 b\n\n"],
  ["fence", "说明\n\n```ts\nconst a = 1;\n```\n\n继续\n\n"],
  ["table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后面\n\n"],
  ["pipe-lookalike", "a | b\n--- | --\n\n后续\n\n"],
  ["pipe-to-table", "a | b\n--- | ---\n1 | 2\n\n后续\n\n"],
  ["inline-marks", "**粗体** 和 `code`\n\n> 引用\n> 第二行\n\n"],
  [
    "cjk-emphasis",
    "**两个进程仍能修改同一个项目目录。**分开 `CODEX_HOME` 隔离。\n\n请看**「重要」**说明。\n\n这里***重要。***继续。\n\n",
  ],
  ["ordered", "1. one\n2. two\n\n3. three\n\n"],
  ["indented-code", "  缩进代码\n\n普通\n\n"],
  ["nested-list", "- 外层\n  - 内层\n\n    - 更深\n\n结束\n\n"],
  ["setext", "标题\n---\n\n下一个\n\n"],
  ["setext-late", "标题\n\n---\n\n下一个\n\n"],
  ["hr", "分隔\n\n***\n\n再来\n\n"],
  ["bare-fence", "```\n未标注语言\n```\n\n"],
  ["many-blanks", "para\n\n\n\nmultiple blanks\n\n"],
  ["loose-list", "- a\n\n- b\n\n  continuation\n\n"],
  ["list-continuation", "- a\n\n  continued\n\n"],
  ["blockquote-lazy", "> quote\n\nlazy\n\n"],
  ["inline-html", "文本里有 <br> 内联标签\n\n下一段\n\n"],
  ["html-container", "<details>\n\n<summary>x</summary>\n\nbody\n\n</details>\n\n后\n\n"],
  ["link-ref-def", "[a]: https://example.com\n\n引用 [a] 链接\n\n"],
  ["task-list", "- [ ] 未完成\n- [x] 完成\n\n"],
  [
    "mixed",
    "# 报告\n\n## 结论\n\n- 要点一\n- 要点二\n\n| 指标 | 值 |\n| --- | --- |\n| a | 1 |\n\n```bash\necho hi\n```\n\n收尾段落\n\n",
  ],
];

const jsonOf = (doc: ReturnType<typeof createFeedMarkdownDoc>) => JSON.stringify(doc.toJSON());

test("every streamed prefix matches a full parse", () => {
  const failures: string[] = [];
  for (const [label, text] of corpus) {
    for (const suffix of ["", "正在继续输出这一段说明"]) {
      const stream = `${text}${suffix}`;
      const cache = createStreamingMarkdownDocCache();
      for (let end = 1; end <= stream.length; end += 1) {
        const prefix = stream.slice(0, end);
        const { stable, tail } = partitionStreamingMarkdown(prefix, true);
        if (isStructuralStreamingTail(tail)) {
          // The renderer shows incomplete fences/tables as plain text on purpose.
          continue;
        }
        const streamed = buildStreamingMarkdownDoc(cache, stable, tail);
        const full = createFeedMarkdownDoc(prefix);
        if (jsonOf(streamed) !== jsonOf(full)) {
          failures.push(
            `${label}${suffix ? "(+tail)" : ""} @${end} ${JSON.stringify(prefix)}\n  streamed=${jsonOf(streamed).slice(0, 300)}\n  full=${jsonOf(full).slice(0, 300)}`,
          );
          break;
        }
      }
    }
  }
  expect(failures.join("\n\n")).toBe("");
});

test("unsupported constructs fall back to a full parse instead of drifting", () => {
  for (const unsafe of [
    "[a]: https://example.com\n\n引用 [a]\n",
    "<div>\nhtml block\n</div>\n",
    "<!-- note -->\n\n正文\n",
    "<details open>\n\nx\n\n</details>\n",
  ]) {
    expect(isIncrementalMarkdownSafe(unsafe)).toBe(false);
  }
  for (const safe of ["普通段落\n\n- a\n- b\n", "| a |\n| --- |\n| 1 |\n", "```ts\ncode\n```\n"]) {
    expect(isIncrementalMarkdownSafe(safe)).toBe(true);
  }

  const cache = createStreamingMarkdownDocCache();
  for (const segment of [
    "[a]: https://example.com\n",
    "[a]: https://example.com\n\n",
    "[a]: https://example.com\n\n引用 [a] 链接\n",
    "<div>\nhtml block\n",
    "<div>\nhtml block\n</div>\n\n后\n",
  ]) {
    const { stable, tail } = partitionStreamingMarkdown(segment, true);
    const doc = buildStreamingMarkdownDoc(cache, stable, tail);
    expect(jsonOf(doc)).toBe(jsonOf(createFeedMarkdownDoc(segment)));
  }
});

test("a rewritten (non append-only) text never reuses stale fragments", () => {
  const cache = createStreamingMarkdownDocCache();
  const first = "第一段\n\n第二段\n\n结论 A\n";
  const { stable, tail } = partitionStreamingMarkdown(first, true);
  buildStreamingMarkdownDoc(cache, stable, tail);

  // Same prefix, different ending: the open block must be rebuilt, not patched.
  const rewritten = "第一段\n\n第二段\n\n结论 B\n";
  const second = partitionStreamingMarkdown(rewritten, true);
  const doc = buildStreamingMarkdownDoc(cache, second.stable, second.tail);
  expect(jsonOf(doc)).toBe(jsonOf(createFeedMarkdownDoc(rewritten)));
});
