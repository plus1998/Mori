import { expect, test } from "bun:test";
import { getRemoteCommandDefinition, validateRemoteCommandArgs } from "../src/remote-command-registry";

test("scheduling remote commands require the paired RPC capability and complete mutation identities", () => {
  for (const [channel, args, risk] of [
    ["scheduling:list", [], "read"],
    ["scheduling:create", [{ requestId: "request", kind: "session_message", name: "hello", prompt: "hello", trigger: { type: "at", at: "2027-01-01T00:00:00Z" } }], "write_safe"],
    ["scheduling:update", [{ id: "schedule", expectedRevision: 2, enabled: false }], "write_safe"],
    ["scheduling:delete", ["schedule"], "write_safe"],
    ["scheduling:delete", ["schedule", 2], "write_safe"],
    ["scheduling:run-now", [{ id: "schedule", requestId: "request" }], "execute"],
    ["scheduling:preview", [{ type: "at", at: "2027-01-01T00:00:00Z" }], "read"],
  ] as const) {
    expect(getRemoteCommandDefinition(channel)).toMatchObject({ requiredCapabilities: ["rpc:invoke"], risk });
    expect(validateRemoteCommandArgs(channel, [...args])).toEqual({ ok: true });
  }
  expect(validateRemoteCommandArgs("scheduling:create", [{ kind: "session_message" }]).ok).toBe(false);
  expect(validateRemoteCommandArgs("scheduling:update", [{ id: "schedule" }]).ok).toBe(false);
  expect(validateRemoteCommandArgs("scheduling:run-now", [{ id: "schedule" }]).ok).toBe(false);
  expect(validateRemoteCommandArgs("scheduling:delete", ["schedule", "2"]).ok).toBe(false);
});
