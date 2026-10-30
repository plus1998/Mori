import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseApprovalFeedback } from "../src/shared/approval-feedback";
import { ApprovalFeedbackCard } from "../src/renderer/ApprovalFeedbackCard";
import { i18n } from "../src/renderer/i18n";

const envelope = (feedback: string, tool = "Bash") =>
  `The user rejected the preceding ${tool} approval.\nUser feedback: ${feedback}\nDo not retry the rejected request unless the user explicitly asks for it again.`;

test("approval feedback preserves multiline user text and tool labels", () => {
  for (const tool of ["Bash", "FileChange", "PermissionGrant", "image generation"]) {
    expect(parseApprovalFeedback(envelope('你要查什么给我语句查\n保留 <xml> & "引号"', tool))).toEqual({
      toolLabel: tool,
      feedback: '你要查什么给我语句查\n保留 <xml> & "引号"',
    });
  }
  expect(parseApprovalFeedback(envelope("line 1\nline 2").replaceAll("\n", "\r\n"))?.feedback).toBe(
    "line 1\r\nline 2",
  );
});

test("ordinary, embedded, incomplete and empty messages are not reinterpreted", () => {
  const valid = envelope("原因");
  for (const text of [
    "普通消息",
    `请解释：${valid}`,
    `${valid}\n后续问题`,
    valid.slice(0, -1),
    envelope("  "),
  ]) {
    expect(parseApprovalFeedback(text)).toBeUndefined();
  }
});

test("feedback card localizes its heading and escapes user feedback", async () => {
  for (const [locale, title, label] of [
    ["zh-CN", "已拒绝 Bash 审批", "你的反馈"],
    ["en-US", "Bash approval rejected", "Your feedback"],
  ]) {
    await i18n.changeLanguage(locale);
    const markup = renderToStaticMarkup(
      createElement(ApprovalFeedbackCard, {
        feedback: parseApprovalFeedback(envelope("<script>用户反馈</script>"))!,
      }),
    );
    expect(markup).toContain(title!);
    expect(markup).toContain(label!);
    expect(markup).toContain("&lt;script&gt;用户反馈&lt;/script&gt;");
    expect(markup).not.toContain("Do not retry");
    expect(markup).not.toContain("The user rejected");
  }
});
