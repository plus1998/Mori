import { createHash } from "node:crypto";
import type { WechatNotification } from "./mori-assistant-wechat";

/** Only direct requests grant sending permission; quoted data and tool arguments do not. */
export function explicitlyRequestsWechat(text: string): boolean {
  const direct = text
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, "")
    .replace(/“[^”]*”|「[^」]*」|"(?:\\.|[^"\\])*"/g, "")
    .replace(/^\s*(?:>|mcp-tool:).*$/gm, "");
  return direct.split(/[。！？!?\n]/).some((sentence) => {
    if (!/(?:微信|wechat)/i.test(sentence)) return false;
    if (
      /(?:不要|不用|无需|不必|别|禁止|取消|不允许|不应|不能|未要求|没有要求|尚未|\b(?:no|not|never|without|don['’]t)\b)/i.test(
        sentence,
      )
    )
      return false;
    return sentence.split(/[，,；;]/).some((clause) => {
      if (
        /(?:如何|怎么|解释|示例|文案|支持|实现|测试|需求|功能|\b(?:example|implement|test|support)\b)/i.test(
          clause,
        )
      )
        return false;
      const action =
        /(?:发|发送|通知|告诉)[^。！？!?\n]{0,30}(?:微信|wechat)|(?:微信|wechat)[^。！？!?\n]{0,30}(?:发|发送|通知|告诉)|\b(?:send|notify|message)\b[^.!?\n]{0,60}\bwechat\b|\bwechat\b[^.!?\n]{0,30}\b(?:me|send|notify)\b/i.test(
          clause,
        );
      const request =
        /(?:给我|通知我|告诉我|发我|请|把|做完|完成后|结束后|完工|^\s*(?:发|发送|用微信|通过微信))|\b(?:me|my)\b/i.test(
          clause,
        );
      return action && request;
    });
  });
}

/** Stable across retries, distinct for each user request, independent of tool-call IDs. */
export function wechatNotificationId(scope: string, notification: WechatNotification): string {
  return `wechat-${createHash("sha256")
    .update(JSON.stringify([scope, notification]))
    .digest("hex")}`;
}
