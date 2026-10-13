/**
 * Scroll-spy for the left user-message rail.
 *
 * The rail marks the user message the reader is currently looking at. The naive
 * rule — "the last anchor whose prompt row scrolled past the reading marker" —
 * fails in two shapes, both reported as "I am at the bottom but the rail still
 * marks the second-to-last message":
 *
 * 1. **The tail.** A short last turn leaves its prompt row *below* the marker, so
 *    the marker still sits inside the previous turn's span even though there is
 *    nothing left to read but the last turn. At the end of the Feed the last
 *    anchor is the answer, marker or not.
 * 2. **Virtualized rows.** Unmounted sections are represented by zero-size
 *    sentinels rendered *before* the mounted window in DOM order, so DOM order is
 *    not visual order. Scanning in DOM order and stopping at the first anchor
 *    below the marker stops at a sentinel that sits far below the viewport.
 *
 * Geometry is viewport-relative px so the rule stays pure (and testable) while the
 * caller keeps owning measurement.
 */

export interface ActivityUserMessageAnchorRect {
  /** Matches the nav item id (`data-user-message-anchor-id`). */
  id: string;
  /** Anchor box top, relative to the scroll container's top edge. */
  top: number;
}

export interface ActivityUserMessageNavViewport {
  /** Scroll container top edge in the same space as the anchor rects (0 when relative). */
  top: number;
  /** Scroll container height in px. */
  height: number;
  /** `scrollHeight - scrollTop - clientHeight`. */
  distanceFromBottomPx: number;
}

export const ACTIVITY_USER_MESSAGE_NAV = {
  /** Reading marker: 46% down the Feed viewport. */
  markerRatio: 0.46,
  /**
   * Inside this band from the Feed's end the reader is on the tail: mark the last
   * user message. Sized to absorb measurement wobble from virtual-core's end
   * anchor and the live tail row appearing/disappearing, while staying far below
   * the 120px stick-to-bottom band so it never rewrites a deliberate scroll-up.
   */
  bottomSnapPx: 64,
} as const;

export function activityUserMessageNavMarkerY(viewport: ActivityUserMessageNavViewport): number {
  return viewport.top + viewport.height * ACTIVITY_USER_MESSAGE_NAV.markerRatio;
}

/**
 * Active rail item for the current Feed geometry. `undefined` when there is
 * nothing to mark.
 */
export function resolveActivityUserMessageActiveAnchorId(
  anchors: readonly ActivityUserMessageAnchorRect[],
  viewport: ActivityUserMessageNavViewport,
): string | undefined {
  if (anchors.length === 0) {
    return undefined;
  }
  // DOM order is not visual order under virtualization; the marker scan below
  // assumes ascending tops.
  const ordered = [...anchors].sort((a, b) => a.top - b.top);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) {
    return undefined;
  }
  if (viewport.distanceFromBottomPx <= ACTIVITY_USER_MESSAGE_NAV.bottomSnapPx) {
    return last.id;
  }
  const markerY = activityUserMessageNavMarkerY(viewport);
  let active = first;
  for (const anchor of ordered) {
    if (anchor.top > markerY) {
      break;
    }
    active = anchor;
  }
  return active.id;
}
