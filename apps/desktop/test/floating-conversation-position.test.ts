import { describe, expect, test } from "bun:test";
import { clampFloatingConversationPosition as clamp } from "../src/renderer/use-floating-conversation-position";

describe("floating conversation placement", () => {
  const pane = { width: 1200, height: 880 };
  const card = { width: 600, height: 620 };

  test("keeps a valid user placement", () => {
    expect(clamp({ centerX: 600, bottom: 100 }, pane, card)).toEqual({ centerX: 600, bottom: 100 });
  });

  test("keeps a dragged card inside both horizontal edges", () => {
    expect(clamp({ centerX: -400, bottom: 16 }, pane, card).centerX).toBe(316);
    expect(clamp({ centerX: 1800, bottom: 16 }, pane, card).centerX).toBe(884);
  });

  test("leaves the toolbar clear and keeps the bottom edge reachable", () => {
    expect(clamp({ centerX: 600, bottom: 900 }, pane, card).bottom).toBe(204);
    expect(clamp({ centerX: 600, bottom: -90 }, pane, card).bottom).toBe(16);
  });

  test("repositions a ball near an edge when expanded into a card", () => {
    const ball = clamp({ centerX: 1160, bottom: 600 }, pane, { width: 48, height: 48 });
    expect(ball).toEqual({ centerX: 1160, bottom: 600 });
    expect(clamp(ball, pane, card)).toEqual({ centerX: 884, bottom: 204 });
  });

  test("clamps a saved placement after the pane becomes smaller", () => {
    expect(clamp({ centerX: 884, bottom: 204 }, { width: 680, height: 720 }, card))
      .toEqual({ centerX: 364, bottom: 44 });
  });

  test("centers a surface that consumes the available width", () => {
    expect(clamp({ centerX: 999, bottom: 16 }, { width: 400, height: 600 }, { width: 368, height: 300 }).centerX).toBe(200);
  });
});
