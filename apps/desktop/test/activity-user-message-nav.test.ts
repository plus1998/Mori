import { expect, test } from "bun:test";
import {
  ACTIVITY_USER_MESSAGE_NAV,
  activityUserMessageNavMarkerY,
  resolveActivityUserMessageActiveAnchorId,
} from "../src/renderer/activity-user-message-nav";

const VIEWPORT = { top: 0, height: 540, distanceFromBottomPx: 0 };

test("the tail wins: at the Feed end the last user message is active even when its prompt row sits below the marker", () => {
  // Short last turn: its prompt block starts at y=300, below the 46% marker (248).
  const anchors = [
    { id: "u1", top: -881 },
    { id: "u2", top: -361 },
    { id: "u3", top: 300 },
  ];
  expect(activityUserMessageNavMarkerY(VIEWPORT)).toBeCloseTo(248.4, 1);
  expect(resolveActivityUserMessageActiveAnchorId(anchors, VIEWPORT)).toBe("u3");
});

test("the tail wins even when the last prompt row is under the fold by less than the snap band", () => {
  const anchors = [
    { id: "u1", top: -900 },
    { id: "u2", top: -400 },
    { id: "u3", top: 560 },
  ];
  expect(resolveActivityUserMessageActiveAnchorId(anchors, { ...VIEWPORT, distanceFromBottomPx: 40 })).toBe(
    "u3",
  );
});

test("reading history keeps the marker rule: the last prompt above the marker wins", () => {
  const anchors = [
    { id: "u1", top: -881 },
    { id: "u2", top: -361 },
    { id: "u3", top: 300 },
  ];
  const reading = { ...VIEWPORT, distanceFromBottomPx: 4_000 };
  expect(resolveActivityUserMessageActiveAnchorId(anchors, reading)).toBe("u2");
  // Deliberate scroll-up past the snap band must not be rewritten to the tail.
  expect(resolveActivityUserMessageActiveAnchorId(anchors, { ...VIEWPORT, distanceFromBottomPx: 300 })).toBe(
    "u2",
  );
  expect(ACTIVITY_USER_MESSAGE_NAV.bottomSnapPx).toBeLessThan(300);
});

test("scans by visual position, not DOM order, when virtual sentinels precede the mounted window", () => {
  // DOM order: unmounted sentinels (rendered before the window) then mounted rows.
  // The sentinel at y=900 is far below the marker; DOM-order scanning would stop there.
  const domOrder = [
    { id: "sentinel-1", top: -1_000 },
    { id: "sentinel-2", top: -500 },
    { id: "sentinel-3", top: 900 },
    { id: "mounted-1", top: 100 },
    { id: "mounted-2", top: 200 },
  ];
  expect(
    resolveActivityUserMessageActiveAnchorId(domOrder, { ...VIEWPORT, distanceFromBottomPx: 5_000 }),
  ).toBe("mounted-2");
});

test("a conversation shorter than the viewport marks its first prompt, and the only prompt at the tail", () => {
  const anchors = [{ id: "u1", top: 400 }];
  expect(resolveActivityUserMessageActiveAnchorId(anchors, { ...VIEWPORT, distanceFromBottomPx: 900 })).toBe(
    "u1",
  );
  expect(resolveActivityUserMessageActiveAnchorId(anchors, VIEWPORT)).toBe("u1");
});

test("above every prompt (reader parked in the header) the first prompt is marked", () => {
  const anchors = [
    { id: "u1", top: 300 },
    { id: "u2", top: 420 },
    { id: "u3", top: 500 },
  ];
  expect(
    resolveActivityUserMessageActiveAnchorId(anchors, { ...VIEWPORT, distanceFromBottomPx: 2_000 }),
  ).toBe("u1");
});

test("no anchors means nothing is active", () => {
  expect(resolveActivityUserMessageActiveAnchorId([], VIEWPORT)).toBeUndefined();
});
