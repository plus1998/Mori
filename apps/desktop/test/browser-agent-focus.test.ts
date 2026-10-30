import { expect, test } from "bun:test";
import type { WebContents } from "electron";
import { submitBrowserAgentPointer } from "../src/main/browser-agent-focus";

test("unsupported runtime or non-guest targets reject before submitting native input", () => {
  let submissions = 0;
  const submit = () => { submissions++; };
  const guest = { isDestroyed: () => false, getType: () => "webview" } as WebContents;
  expect(() => submitBrowserAgentPointer({ ...guest, getType: () => "window" } as WebContents, submit)).toThrow("live webview");
  // Bun is deliberately not an Electron runtime. No guessed address or raw-input retry.
  expect(() => submitBrowserAgentPointer(guest, submit)).toThrow("已阻止原生点击");
  expect(submissions).toBe(0);
});
