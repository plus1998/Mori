import { expect, test } from "bun:test";
import {
  composerReferences,
  composerReferenceToken,
  parseMentionQuery,
} from "../src/shared/composer-references";
import { parsePromptSegments } from "../src/renderer/composer-skills";

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
test("malformed reference encodings are not upgraded into chips", () => {
  expect(composerReferences("@ssh{%broken} @web{%7B%7D}")).toEqual([]);
});
