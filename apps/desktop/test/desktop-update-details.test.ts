import { expect, test } from "bun:test";
import { desktopUpdateDetails } from "../src/renderer/desktop-update-details";
import type { DesktopUpdateState } from "../src/shared/desktop-update";

const state: DesktopUpdateState = {
  phase: "downloading", capability: "auto", currentVersion: "1.0.0",
  phaseStartedAt: 1000, progressUpdatedAt: 2000,
  progress: { percent: 40, total: 1000, transferred: 400, bytesPerSecond: 100 },
};

test("estimates remaining download time from real byte counts and transfer rate", () => {
  expect(desktopUpdateDetails(state, 3000)).toMatchObject({ remainingSeconds: 6, elapsedSeconds: 2, stalled: false });
});

test("drops stale speed and ETA when data stops arriving", () => {
  expect(desktopUpdateDetails(state, 17_000)).toMatchObject({ bytesPerSecond: 0, remainingSeconds: undefined, stalled: true });
});

test("unknown totals or rates never produce a fabricated remaining time", () => {
  for (const progress of [undefined, { percent: NaN, total: 0, transferred: 0, bytesPerSecond: Infinity }, { percent: 10, total: 100, transferred: 10, bytesPerSecond: 0 }]) {
    const details = desktopUpdateDetails({ ...state, ...(progress ? { progress } : { progress: undefined }) } as DesktopUpdateState, 3000);
    expect(details.remainingSeconds).toBeUndefined();
    expect(Number.isFinite(details.percent)).toBe(true);
  }
});
