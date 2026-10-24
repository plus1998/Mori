import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composerReferenceToken } from "../src/shared/composer-references";
import type { ThreadPendingFollowUp } from "../src/shared/ipc";
import { FollowUpPromptPreview } from "../src/renderer/FollowUpPromptPreview";

test("queued previews render complete reference tokens as non-interactive chips", () => {
  const token = composerReferenceToken({
    kind: "web_selection", id: "selection-1", label: "网页选中元素", detail: "https://example.com/" + "a".repeat(200),
  });
  const prompt = `${"说明".repeat(70)} ${token} 修改这里 @file{/tmp/example.ts}`;
  const followUp: ThreadPendingFollowUp = {
    id: "queued-1", threadId: "thread-1", prompt, priority: "normal", status: "queued",
    deliveryMode: "queued", createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z",
  };
  const html = renderToStaticMarkup(createElement(FollowUpPromptPreview, { followUp }));
  expect(html).toContain("composer-reference-display");
  expect(html).toContain("<svg");
  expect(html).toContain("@网页选中元素");
  expect(html).toContain("example.ts");
  expect(html).toContain("修改这里");
  expect(html).not.toContain("@web_selection{");
  expect(html).not.toContain("%7B");
  expect(html).not.toContain("<button");
  expect(followUp.prompt).toBe(prompt);
});
