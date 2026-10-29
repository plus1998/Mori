import { expect, test } from "bun:test";
import { getRemoteCommandDefinition, validateRemoteCommandArgs } from "../src/remote-command-registry";

test("reference search is a paired, read-only RPC with a required query", () => {
  expect(getRemoteCommandDefinition("composer-references:search")).toMatchObject({
    risk: "read", requiredCapabilities: ["rpc:invoke"], requiresConfirmation: false,
  });
  expect(validateRemoteCommandArgs("composer-references:search", [{ query: "", kind: "ssh", limit: 12 }]).ok).toBe(true);
  expect(validateRemoteCommandArgs("composer-references:search", [{}]).ok).toBe(false);
  expect(validateRemoteCommandArgs("composer-references:search", []).ok).toBe(false);
});
