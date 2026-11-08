import { expect, test } from "bun:test";
import { version } from "../package.json";
import { moriCodexClientInfo } from "../src/main/codex-client-info";

test("Codex client info uses the desktop app identity and version", () => {
  expect(moriCodexClientInfo()).toEqual({ name: "Mori", title: "Mori", version });
});
