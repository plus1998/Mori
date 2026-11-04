import { expect, test } from "bun:test";
import {
  isStructuralStreamingTail,
  partitionStreamingMarkdown,
} from "../src/renderer/streaming-markdown-partition";

test("non-streaming keeps everything stable", () => {
  expect(partitionStreamingMarkdown("hello\n\nworld", false)).toEqual({
    stable: "hello\n\nworld",
    tail: "",
  });
});

test("single unfinished paragraph is all tail", () => {
  expect(partitionStreamingMarkdown("正在分析项目结构", true)).toEqual({
    stable: "",
    tail: "正在分析项目结构",
  });
});

test("unfinished prose tail is not structural", () => {
  expect(isStructuralStreamingTail("正在分析项目结构")).toBe(false);
  expect(isStructuralStreamingTail("- a\n- b\npartial")).toBe(false);
  expect(isStructuralStreamingTail("# Title still open")).toBe(false);
});

test("blank-line committed paragraph becomes stable", () => {
  expect(partitionStreamingMarkdown("done para\n\nworking", true)).toEqual({
    stable: "done para\n\n",
    tail: "working",
  });
  expect(isStructuralStreamingTail("working")).toBe(false);
});

test("heading followed by blank is stable before unfinished body", () => {
  expect(partitionStreamingMarkdown("# Title\n\nbody so far", true)).toEqual({
    stable: "# Title\n\n",
    tail: "body so far",
  });
});

test("incomplete fence holds from open fence and is structural", () => {
  expect(partitionStreamingMarkdown("intro\n```bash\necho hi", true)).toEqual({
    stable: "intro\n",
    tail: "```bash\necho hi",
  });
  expect(isStructuralStreamingTail("```bash\necho hi")).toBe(true);
});

test("completed fence with following unfinished prose splits after fence", () => {
  expect(partitionStreamingMarkdown("intro\n```bash\necho hi\n```\nnext", true)).toEqual({
    stable: "intro\n```bash\necho hi\n```\n",
    tail: "next",
  });
  expect(isStructuralStreamingTail("next")).toBe(false);
});

test("completed fence closed at eof with no following unfinished block is stable", () => {
  // Ends mid-block after closed fence without trailing blank — fence itself is complete,
  // but no extra blank so if there's nothing after the fence line, completedThrough is EOF.
  expect(partitionStreamingMarkdown("intro\n```bash\necho hi\n```\n", true)).toEqual({
    stable: "intro\n```bash\necho hi\n```\n",
    tail: "",
  });
  expect(isStructuralStreamingTail("")).toBe(false);
});

test("incomplete GFM table stays mutable but uses live Markdown", () => {
  const source = "| a | b |\n| --- | --- |\n| 1 |";
  expect(partitionStreamingMarkdown(source, true)).toEqual({
    stable: "",
    tail: source,
  });
  expect(isStructuralStreamingTail(source)).toBe(false);
  expect(isStructuralStreamingTail(`${source} 2`)).toBe(false);
  expect(isStructuralStreamingTail(`${source} 2 |`)).toBe(false);
});

test("pipe rows without separator are not structural", () => {
  expect(isStructuralStreamingTail("| a | b |\n| c | d |")).toBe(false);
  expect(isStructuralStreamingTail("| a | b |\n| ---")).toBe(false);
});

test("malformed pipe rows then prose do not freeze the tail as plain", () => {
  const source = "| a | b |\n| c | d |\n\nmore text";
  expect(partitionStreamingMarkdown(source, true)).toEqual({
    stable: "| a | b |\n| c | d |\n\n",
    tail: "more text",
  });
  expect(isStructuralStreamingTail("more text")).toBe(false);
});

test("malformed pipe rows ending on prose commit before the prose line", () => {
  const source = "| a | b |\n| c | d |\nmore text";
  expect(partitionStreamingMarkdown(source, true)).toEqual({
    stable: "| a | b |\n| c | d |\n",
    tail: "more text",
  });
  expect(isStructuralStreamingTail("more text")).toBe(false);
});

test("complete table then unfinished para", () => {
  const source = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nmore";
  expect(partitionStreamingMarkdown(source, true)).toEqual({
    stable: "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n",
    tail: "more",
  });
});

test("incomplete SEARCH block holds into tail (with optional stable prefix)", () => {
  expect(partitionStreamingMarkdown("before\n<<<<<<< SEARCH\nold", true)).toEqual({
    stable: "before\n",
    tail: "<<<<<<< SEARCH\nold",
  });
  expect(isStructuralStreamingTail("<<<<<<< SEARCH\nold")).toBe(true);
});
