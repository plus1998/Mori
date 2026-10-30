import { expect, test } from "bun:test";
import {
  composerReferences,
  composerReferenceToken,
  parseMentionQuery,
} from "../src/shared/composer-references";
import { parsePromptSegments } from "../src/renderer/composer-skills";
import { appendProjectTodoReference, projectTodoReference } from "../src/shared/project-todos";

const reference = {
  kind: "web" as const,
  id: "browser_1",
  label: "订单 @ work {预览}",
  detail: "https://example.com/?q=中文&x=1",
};
test("reference tokens survive copy, draft storage, and mixed file/skill parsing", () => {
  const token = composerReferenceToken(reference);
  expect(composerReferences(`请看 ${token} 和 @file{/tmp/a.ts} $pdf`)).toEqual([reference]);
  expect(
    parsePromptSegments(`请看 ${token} 和 @file{/tmp/a.ts} $pdf`).filter((item) => item.type !== "text"),
  ).toEqual([
    { type: "reference", reference },
    { type: "file", path: "/tmp/a.ts" },
    { type: "skill", name: "pdf" },
  ]);
});
test("mention queries filter by category without triggering on SSH endpoints or email", () => {
  expect(parseMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  expect(parseMentionQuery("请看 @网页:订单", 9)).toEqual({ start: 3, query: "订单", kind: "web" });
  expect(parseMentionQuery("@SSH：prod", 9)).toEqual({ start: 0, query: "prod", kind: "ssh" });
  expect(parseMentionQuery("@会话测试", 5)).toEqual({ start: 0, query: "测试", kind: "conversation" });
  expect(parseMentionQuery("user@10.0.0.1", 13)).toBeNull();
  expect(parseMentionQuery("me@example.com", 14)).toBeNull();
  expect(parseMentionQuery(composerReferenceToken(reference), 500)).toBeNull();
});

test("mentions work directly after Chinese text and punctuation, including in the middle of a draft", () => {
  for (const prefix of ["帮我看看", "处理：", "参考【", "请用/", "看看\n", "请看 "]) {
    const draft = `${prefix}@网页:订单，然后继续检查`;
    const cursor = draft.indexOf("，然后");
    expect(parseMentionQuery(draft, cursor)).toEqual({ start: prefix.length, query: "订单", kind: "web" });
    expect(parseMentionQuery(`${prefix}@`, prefix.length + 1)).toEqual({ start: prefix.length, query: "" });
  }
  const token = composerReferenceToken(reference);
  expect(parseMentionQuery(`${token}@待办:修复`, token.length + 6)).toEqual({
    start: token.length, query: "修复", kind: "todo",
  });
});

test("inline mention boundaries still exclude email and SSH usernames", () => {
  for (const text of ["请联系me@example.com", "first.last+tag@example.com", "ssh-name@host", "root@10.0.0.1"]) {
    expect(parseMentionQuery(text, text.length)).toBeNull();
  }
});
test("malformed reference encodings are not upgraded into chips", () => {
  expect(composerReferences("@ssh{%broken} @web{%7B%7D}")).toEqual([]);
});

test("todo references retain identity, preserve drafts, and round-trip as atomic chips", () => {
  const todo = { id: "todo-1", text: "修复 @ 标签\n完整待办内容", projectPath: "/project/a" };
  const prompt = appendProjectTodoReference("保留原草稿", todo);
  const reference = projectTodoReference(todo);
  expect(prompt.startsWith("保留原草稿\n")).toBe(true);
  expect(composerReferences(prompt)).toEqual([reference]);
  expect(parsePromptSegments(prompt).find(segment => segment.type === "reference")).toEqual({ type: "reference", reference });
  expect(appendProjectTodoReference(prompt, todo)).toBe(prompt);
  expect(composerReferences(appendProjectTodoReference(prompt, { ...todo, id: "todo-2" }))).toHaveLength(2);
  const query = "处理 @待办:修复";
  expect(parseMentionQuery(query, query.length)).toEqual({ start: 3, kind: "todo", query: "修复" });
  expect(parseMentionQuery("@todo", 5)).toEqual({ start: 0, kind: "todo", query: "" });
});
