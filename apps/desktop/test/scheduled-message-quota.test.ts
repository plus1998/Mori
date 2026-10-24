import { expect, test } from "bun:test";
import { localScheduleDate } from "../src/renderer/schedule-form";
import {
  initialScheduledMessageForm,
  scheduledMessageTriggerFor,
} from "../src/renderer/scheduled-message-form";
import { nextScheduledMessageQuotaReset } from "../src/renderer/scheduled-message-quota";
import type { OpenAIAccountQuota } from "../src/shared/openai-account";

const now = Date.parse("2026-10-24T08:00:00Z");
const hour = now + 3600_000;
const week = now + 7 * 86400_000;
const primaryWindow = {
  usedPercent: 30,
  limitWindowSeconds: 18000,
  resetAt: hour / 1000,
  resetAfterSeconds: 3600,
};
const secondaryWindow = {
  usedPercent: 40,
  limitWindowSeconds: 604800,
  resetAt: week / 1000,
  resetAfterSeconds: 604800,
};
const quota: OpenAIAccountQuota = {
  planType: "plus",
  email: "test@example.test",
  fetchedAt: now,
  resetCreditsAvailable: 0,
  rateLimit: {
    allowed: true,
    limitReached: false,
    primaryWindow,
    secondaryWindow,
  },
};

test("uses the next quota reset, or waits for every exhausted period", () => {
  expect(nextScheduledMessageQuotaReset(quota, now)).toBe(new Date(hour).toISOString());
  for (const primaryUsed of [30, 100]) {
    expect(
      nextScheduledMessageQuotaReset(
        {
          ...quota,
          rateLimit: {
            ...quota.rateLimit,
            primaryWindow: { ...primaryWindow, usedPercent: primaryUsed },
            secondaryWindow: { ...secondaryWindow, usedPercent: 100 },
          },
        },
        now,
      ),
    ).toBe(new Date(week).toISOString());
  }
});

test("relative reset times are based on the snapshot timestamp, not dialog creation", () => {
  const relative: OpenAIAccountQuota = {
    ...quota,
    rateLimit: {
      ...quota.rateLimit,
      secondaryWindow: null,
      primaryWindow: { ...primaryWindow, resetAt: 0 },
    },
  };
  expect(nextScheduledMessageQuotaReset(relative, now + 600_000)).toBe(new Date(hour).toISOString());
  expect(nextScheduledMessageQuotaReset(relative, hour + 1)).toBeUndefined();
});

test("missing, expired or invalid reset data never invents a send time", () => {
  expect(nextScheduledMessageQuotaReset(quota, week + 1)).toBeUndefined();
  expect(
    nextScheduledMessageQuotaReset(
      {
        ...quota,
        rateLimit: {
          ...quota.rateLimit,
          primaryWindow: null,
          secondaryWindow: null,
        },
      },
      now,
    ),
  ).toBeUndefined();
  expect(
    nextScheduledMessageQuotaReset(
      {
        ...quota,
        rateLimit: {
          ...quota.rateLimit,
          secondaryWindow: { ...secondaryWindow, usedPercent: 100, resetAt: NaN, resetAfterSeconds: NaN },
        },
      },
      now,
    ),
  ).toBeUndefined();
});

test("the shortcut creates a fixed one-off deadline that survives later submission", () => {
  const at = nextScheduledMessageQuotaReset(quota, now);
  if (!at) throw new Error("expected quota reset time");
  const form = {
    ...initialScheduledMessageForm(undefined, now),
    timingMode: "schedule" as const,
    at: localScheduleDate(at),
    originalAt: at,
  };
  expect(scheduledMessageTriggerFor(form, now + 600_000)).toEqual({ type: "at", at });
});
