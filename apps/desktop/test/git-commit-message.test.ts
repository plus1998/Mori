import { expect, test } from "bun:test";
import type { AnthropicProxyRoute } from "../src/main/anthropic-proxy";
import {
  buildCommitMessageRequestBody,
  buildCommitMessageUserMessage,
  extractCommitMessageText,
  sanitizeCommitMessage,
  summarizeCommitMessage,
} from "../src/main/git-commit-message";
import type { CommitDiffContext } from "../src/main/git-operations";

const route: AnthropicProxyRoute = {
  role: "explore",
  modelId: "qwen3.6-27b",
  provider: {
    id: "p1",
    name: "AI-Studio",
    baseUrl: "http://example.com",
    requestPath: "",
    version: "v1",
    apiKey: "",
    enabled: true,
  },
};

const context: CommitDiffContext = {
  stagedNameStatus: "M\tREADME.md",
  stagedStat: " README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
  stagedPatch: "diff --git a/README.md b/README.md",
  stagedPatchTruncated: false,
  recentCommits: "abc1234 feat: seed",
};

test("buildCommitMessageUserMessage includes staged diff sections", () => {
  const message = buildCommitMessageUserMessage(context);
  expect(message).toContain("## Staged files");
  expect(message).toContain("README.md");
  expect(message).toContain("## Recent commits");
  expect(message).toContain("总长度不超过");
});

test("buildCommitMessageUserMessage includes unstaged sections", () => {
  const message = buildCommitMessageUserMessage({
    ...context,
    unstagedNameStatus: "M\tsrc/app.ts",
    unstagedPatch: "diff --git a/src/app.ts",
    unstagedPatchTruncated: true,
  });
  expect(message).toContain("## Unstaged files");
  expect(message).toContain("unstaged patch 已在上方截断");
});

test("buildCommitMessageUserMessage includes custom instructions", () => {
  const message = buildCommitMessageUserMessage(context, "使用中文，subject 不超过 50 字");
  expect(message).toContain("## 提交指令");
  expect(message).toContain("使用中文，subject 不超过 50 字");
});

test("buildCommitMessageRequestBody includes custom instructions in system prompt", () => {
  const body = buildCommitMessageRequestBody(route, context, "使用中文");
  expect(String(body.system)).toContain("遵循以下用户提交指令：使用中文");
  const userContent = (body.messages as Array<{ content: string }>)[0]?.content;
  expect(userContent).toContain("## 提交指令");
  expect(userContent).toContain("使用中文");
});

test("sanitizeCommitMessage rejects refusal-like output", () => {
  expect(sanitizeCommitMessage("抱歉，我无法生成提交信息")).toBeUndefined();
});

test("sanitizeCommitMessage keeps valid conventional commit text", () => {
  expect(sanitizeCommitMessage("feat(git): add commit dialog\n\n- stage diff")).toBe(
    "feat(git): add commit dialog\n\n- stage diff",
  );
});

test("sanitizeCommitMessage truncates overly long output", () => {
  const long = `feat(ui): ${"x".repeat(3000)}`;
  expect(sanitizeCommitMessage(long)?.length).toBe(2000);
});

test("buildCommitMessageRequestBody disables thinking", () => {
  const body = buildCommitMessageRequestBody(route, context);
  expect(body.disableThinking).toBe(true);
  expect(body.maxTokens).toBeUndefined();
});

test("buildCommitMessageRequestBody uses route max output tokens when configured", () => {
  const body = buildCommitMessageRequestBody({ ...route, maxOutputTokens: 4096 }, context);
  expect(body.maxTokens).toBe(4096);
});

test("extractCommitMessageText ignores thinking-only responses", () => {
  const text = extractCommitMessageText({
    content: [{ type: "thinking", thinking: "analyzing diff..." }],
  });
  expect(text).toBeUndefined();
});

test("extractCommitMessageText prefers text blocks", () => {
  const text = extractCommitMessageText({
    content: [
      { type: "thinking", thinking: "analyzing diff..." },
      { type: "text", text: "feat(ui): add refresh-all toolbar" },
    ],
  });
  expect(text).toBe("feat(ui): add refresh-all toolbar");
});

test("extractCommitMessageText ignores redacted thinking blocks", () => {
  const text = extractCommitMessageText({
    content: [
      { type: "redacted_thinking", data: "..." },
      { type: "text", text: "fix(git): handle empty diff" },
    ],
  });
  expect(text).toBe("fix(git): handle empty diff");
});

test("summarizeCommitMessage streams accumulated text through onTextDelta", async () => {
  const streamed: string[] = [];
  const message = await summarizeCommitMessage(
    route,
    context,
    async () =>
      new Response(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "feat(git): stream commit text" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    undefined,
    (text) => {
      streamed.push(text);
    },
  );

  expect(message).toBe("feat(git): stream commit text");
  expect(streamed).toEqual(["feat(git): stream commit text"]);
});
