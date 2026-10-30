import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const moriStyles = readFileSync(new URL("../src/renderer/mori-assistant.css", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const pattern = new RegExp(
    `(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  );
  return moriStyles.match(pattern)?.[2] ?? "";
}

test("sent message bubbles keep a comfortable minimum width", () => {
  const bubble = ruleBody(".mori-message.is-user");

  expect(bubble).toContain("width: fit-content");
  expect(bubble).toContain("min-width: min(180px, 100%)");
  // Short single-character replies ("好", "OK") still get a readable pill instead of a sliver.
  expect(bubble).toMatch(/min-width:\s*min\(180px,\s*100%\)/);
});

test("the bubble minimum never outgrows narrow panels and long content still wraps", () => {
  const bubble = ruleBody(".mori-message.is-user");

  // `100%` inside min() caps the minimum to the feed width, so a narrow panel cannot
  // force horizontal overflow; 85% keeps long replies from spanning the whole feed.
  expect(bubble).toMatch(/min-width:\s*min\(\d+px,\s*100%\)/);
  expect(bubble).toContain("max-width: 85%");
  expect(bubble).toContain("box-sizing: border-box");

  // Unbroken long text stays inside the bubble.
  expect(ruleBody(".mori-message")).toContain("overflow-wrap: anywhere");
});
