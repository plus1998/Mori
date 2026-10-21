import { expect, test } from "bun:test";
import {
  formatBillingCacheHitRate,
  resolveBillingMainModelLabel,
  shouldShowBillingSavings,
} from "../src/renderer/ThreadInfoPanel";
import type { ThreadBillingSnapshot } from "../src/shared/ipc";

const billing = {
  plannerModelLabel: "gpt-5.5 · OpenAI",
  totalTokens: {
    input: 2_000,
    output: 500,
    cacheRead: 6_000,
    cacheCreation: 2_000,
  },
} as ThreadBillingSnapshot;

test("hides the savings row when no money was saved", () => {
  expect(shouldShowBillingSavings(0)).toBe(false);
  expect(shouldShowBillingSavings(-0)).toBe(false);
});

test("keeps savings and overpayment rows for non-zero amounts", () => {
  expect(shouldShowBillingSavings(0.01)).toBe(true);
  expect(shouldShowBillingSavings(-0.01)).toBe(true);
});

test("formats cache hit rate using all billed prompt tokens", () => {
  expect(formatBillingCacheHitRate(billing)).toBe("60%");
});

test("uses the currently selected main agent model in billing tips", () => {
  expect(
    resolveBillingMainModelLabel(
      billing,
      [
        {
          role: "main",
          displayName: "Main agent",
          modelId: "openai/gpt-5.6-sol",
          title: "Main agent · openai/gpt-5.6-sol",
          main: true,
        },
      ],
      "Main model",
    ),
  ).toBe("gpt-5.6-sol");
  expect(resolveBillingMainModelLabel(billing, undefined, "Main model")).toBe("gpt-5.5");
});
