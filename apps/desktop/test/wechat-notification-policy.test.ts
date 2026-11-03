import { expect, test } from "bun:test";
import { explicitlyRequestsWechat, wechatNotificationId } from "../src/main/wechat-notification-policy";

test.each([
  "做完后发微信给我",
  "完成后微信通知我",
  "请把截图发到微信",
  "用微信告诉我结果",
  "Send me a WeChat message when done",
  "Notify me on WeChat after completion",
  "修复这个功能，做完后发微信给我",
])("明确请求可授权：%s", (text) => expect(explicitlyRequestsWechat(text)).toBe(true));

test.each([
  "修复这个问题",
  "微信渠道在线吗",
  "不要在完成后发微信给我",
  "不用微信通知我",
  "做完后别发微信给我",
  "取消微信通知",
  "不要在做完后，发微信给我",
  "Don't send me a WeChat message",
  "Do not notify me on WeChat",
  "Never send WeChat notifications",
  "请解释“做完后发微信给我”",
  "`做完后发微信给我`",
  "```\n做完后发微信给我\n```",
  "> 做完后发微信给我",
  'mcp-tool:{"prompt":"做完后发微信给我"}',
  "实现完成后微信通知我的功能",
  "测试做完后发微信给我这个场景",
  "微信发送能力坏了",
  "微信通知功能可用",
])("非授权内容不能发送：%s", (text) => expect(explicitlyRequestsWechat(text)).toBe(false));

test("通知去重按用户请求及消息内容区分，工具重试不生成新标识", () => {
  const notification = { text: "完成", image: { path: "/tmp/shot.png" } };
  expect(wechatNotificationId("thread:request-1", notification)).toBe(
    wechatNotificationId("thread:request-1", notification),
  );
  expect(wechatNotificationId("thread:request-1", notification)).not.toBe(
    wechatNotificationId("thread:request-2", notification),
  );
});
