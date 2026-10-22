import { expect, test } from "bun:test";
import { evaluateDesktopNotificationPolicy } from "../src/main/desktop-notification-policy";
import {
  defaultNotificationSettings,
  type DesktopNotificationKind,
} from "../src/shared/notification-settings";

const kinds: DesktopNotificationKind[] = ["completion", "approval", "question"];
const focusedWindow = {
  isDestroyed: () => false,
  isVisible: () => true,
  isMinimized: () => false,
  isFocused: () => true,
};
const disabled = { ok: false, reason: "preference_disabled" };

test("selected thread stays quiet when the native window is focused, regardless of DOM focus", () => {
  // No renderer focus flag is involved: webviews/native controls may own focus.
  for (const kind of kinds) {
    expect(
      evaluateDesktopNotificationPolicy(kind, true, true, defaultNotificationSettings(), focusedWindow),
    ).toEqual(disabled);
  }
});

test("notifies for a selected thread after the native window loses focus", () => {
  for (const kind of kinds) {
    expect(
      evaluateDesktopNotificationPolicy(kind, true, true, defaultNotificationSettings(), {
        ...focusedWindow,
        isFocused: () => false,
      }),
    ).toEqual({ ok: true });
  }
});

test("other threads can notify while the native window is focused", () => {
  for (const kind of kinds) {
    expect(
      evaluateDesktopNotificationPolicy(kind, false, true, defaultNotificationSettings(), focusedWindow),
    ).toEqual({ ok: true });
  }
});

test("delivery re-evaluation reads current native focus and preferences", () => {
  let focused = false;
  const window = { ...focusedWindow, isFocused: () => focused };
  const settings = defaultNotificationSettings();
  expect(evaluateDesktopNotificationPolicy("completion", true, true, settings, window)).toEqual({ ok: true });
  focused = true;
  expect(evaluateDesktopNotificationPolicy("completion", true, true, settings, window)).toEqual(disabled);
  settings.turnCompletion = "always";
  expect(evaluateDesktopNotificationPolicy("completion", true, true, settings, window)).toEqual({ ok: true });
  settings.turnCompletion = "never";
  focused = false;
  expect(evaluateDesktopNotificationPolicy("completion", true, true, settings, window)).toEqual(disabled);
});

test("hidden, minimized, missing and destroyed windows are not actively viewed", () => {
  const windows = [
    undefined,
    { ...focusedWindow, isVisible: () => false },
    { ...focusedWindow, isMinimized: () => true },
    {
      ...focusedWindow,
      isDestroyed: () => true,
      isFocused: () => {
        throw new Error("must not access a destroyed window");
      },
    },
  ];
  for (const window of windows) {
    expect(
      evaluateDesktopNotificationPolicy("completion", true, true, defaultNotificationSettings(), window),
    ).toEqual({ ok: true });
  }
});

test("explicit notification preferences and OS support still apply", () => {
  const settings = defaultNotificationSettings();
  expect(
    evaluateDesktopNotificationPolicy(
      "completion",
      true,
      true,
      {
        ...settings,
        turnCompletion: "always",
      },
      focusedWindow,
    ),
  ).toEqual({ ok: true });
  expect(
    evaluateDesktopNotificationPolicy(
      "completion",
      false,
      true,
      {
        ...settings,
        turnCompletion: "never",
      },
      focusedWindow,
    ),
  ).toEqual(disabled);
  expect(
    evaluateDesktopNotificationPolicy(
      "approval",
      false,
      true,
      {
        ...settings,
        permissionEnabled: false,
      },
      focusedWindow,
    ),
  ).toEqual(disabled);
  expect(
    evaluateDesktopNotificationPolicy(
      "question",
      false,
      true,
      {
        ...settings,
        questionEnabled: false,
      },
      focusedWindow,
    ),
  ).toEqual(disabled);
  expect(evaluateDesktopNotificationPolicy("completion", false, false, settings, undefined)).toEqual({
    ok: false,
    reason: "unsupported",
  });
});
