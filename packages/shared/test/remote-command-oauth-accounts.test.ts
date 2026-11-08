import { expect, test } from "bun:test";
import { getRemoteCommandDefinition, validateRemoteCommandArgs } from "../src/remote-command-registry";

test("mobile can list OAuth account summaries and fetch the selected account's model catalog", () => {
  for (const channel of ["chatgpt-subscription:accounts-list", "chatgpt-subscription:account-models-list"]) {
    expect(getRemoteCommandDefinition(channel)).toMatchObject({
      risk: "read",
      requiredCapabilities: ["rpc:invoke"],
      requiresConfirmation: false,
    });
  }
  expect(validateRemoteCommandArgs("chatgpt-subscription:accounts-list", [])).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("chatgpt-subscription:accounts-list", [{}]).ok).toBe(false);
  expect(validateRemoteCommandArgs("chatgpt-subscription:account-models-list", ["oauth-B"])).toEqual({
    ok: true,
  });
  for (const args of [[], [{}], [123], ["a", "b"]]) {
    expect(validateRemoteCommandArgs("chatgpt-subscription:account-models-list", args).ok).toBe(false);
  }
});
