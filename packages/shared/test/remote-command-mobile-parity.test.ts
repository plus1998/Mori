import { expect, test } from "bun:test";
import { getRemoteCommandDefinition, validateRemoteCommandArgs } from "../src/remote-command-registry";

const commands = [
  ["conversation:share", { threadId: "thr_1" }, "execute"],
  ["thread:wechat-follow", { threadId: "thr_1", enabled: true }, "write_safe"],
  ["image-display-artifact:delete", { artifactId: "media_1" }, "write_safe"],
  ["image-generation-artifacts:list", { threadId: "thr_1" }, "read"],
  ["image-generation-artifact:read", { artifactId: "image_1", imageIndex: 0 }, "read"],
  ["html-host-artifacts:list", { threadId: "thr_1" }, "read"],
  ["workspace:project-search-terms", { projects: [{ path: "/repo", name: "会话存档" }] }, "read"],
  ["thread:read-file", { threadId: "thr_1", filePath: "src/main.ts" }, "read"],
  ["account-usage:history", { kind: "chatgpt_login", accountId: "account_1", period: "5h" }, "read"],
  ["usage:overview", { period: "month", providerKey: "chatgpt_login" }, "read"],
] as const;

for (const [channel, payload, risk] of commands) {
  test(`${channel} is callable by a bound mobile with explicit arguments`, () => {
    expect(getRemoteCommandDefinition(channel)).toMatchObject({ risk, requiredCapabilities: ["rpc:invoke"] });
    expect(validateRemoteCommandArgs(channel, [payload])).toEqual({ ok: true });
    expect(validateRemoteCommandArgs(channel, [{}])).toMatchObject({ ok: false });
    expect(validateRemoteCommandArgs(channel, [])).toMatchObject({ ok: false });
  });
}
test("plan links retain the existing positional conversation identity", () => {
  expect(validateRemoteCommandArgs("thread:plan-executions", ["thr_1"])).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("thread:plan-executions", [{}])).toMatchObject({ ok: false });
});
