import { describe, expect, test } from "bun:test";
import {
  TASK_PANEL_FILES_TAB_ID,
  TASK_PANEL_HOME_TAB_ID,
  TASK_PANEL_REVIEW_TAB_ID,
} from "../src/renderer/SubagentTaskDrawer";
import {
  captureTaskPanelSessionUiState,
  emptyTaskPanelSessionUiState,
  normalizeTaskPanelSessionUiState,
} from "../src/renderer/task-panel-session-ui-state";

describe("task panel session ui state", () => {
  test("empty defaults to closed home with no open tabs", () => {
    expect(emptyTaskPanelSessionUiState()).toEqual({
      open: false,
      activeTab: TASK_PANEL_HOME_TAB_ID,
      openTabIds: [],
      fullscreen: false,
    });
  });

  test("capture keeps open tabs, active tab, and file target", () => {
    expect(
      captureTaskPanelSessionUiState({
        open: true,
        activeTab: TASK_PANEL_REVIEW_TAB_ID,
        openTabIds: [TASK_PANEL_FILES_TAB_ID, TASK_PANEL_REVIEW_TAB_ID, TASK_PANEL_FILES_TAB_ID],
        fullscreen: true,
        selectedSubagentAgentId: "agent-1",
        fileTarget: { path: "/tmp/a.ts", line: 12, requestId: 3 },
      }),
    ).toEqual({
      open: true,
      activeTab: TASK_PANEL_REVIEW_TAB_ID,
      openTabIds: [TASK_PANEL_FILES_TAB_ID, TASK_PANEL_REVIEW_TAB_ID],
      fullscreen: true,
      selectedSubagentAgentId: "agent-1",
      fileTarget: { path: "/tmp/a.ts", line: 12, requestId: 3 },
    });
  });

  test("capture forces fullscreen off when panel is closed", () => {
    expect(
      captureTaskPanelSessionUiState({
        open: false,
        activeTab: TASK_PANEL_FILES_TAB_ID,
        openTabIds: [TASK_PANEL_FILES_TAB_ID],
        fullscreen: true,
      }),
    ).toEqual({
      open: false,
      activeTab: TASK_PANEL_FILES_TAB_ID,
      openTabIds: [TASK_PANEL_FILES_TAB_ID],
      fullscreen: false,
    });
  });

  test("normalize drops home from open tabs and repairs invalid active tab", () => {
    expect(
      normalizeTaskPanelSessionUiState({
        open: true,
        activeTab: "missing-tab",
        openTabIds: [TASK_PANEL_HOME_TAB_ID, TASK_PANEL_FILES_TAB_ID, ""],
        fullscreen: true,
      }),
    ).toEqual({
      open: true,
      activeTab: TASK_PANEL_FILES_TAB_ID,
      openTabIds: [TASK_PANEL_FILES_TAB_ID],
      fullscreen: true,
    });
  });

  test("normalize returns empty for non-objects", () => {
    expect(normalizeTaskPanelSessionUiState(null)).toEqual(emptyTaskPanelSessionUiState());
    expect(normalizeTaskPanelSessionUiState("nope")).toEqual(emptyTaskPanelSessionUiState());
  });

  test("normalize ignores file targets without a path", () => {
    expect(
      normalizeTaskPanelSessionUiState({
        open: true,
        activeTab: TASK_PANEL_HOME_TAB_ID,
        openTabIds: [],
        fullscreen: false,
        fileTarget: { line: 4 },
      }),
    ).toEqual({
      open: true,
      activeTab: TASK_PANEL_HOME_TAB_ID,
      openTabIds: [],
      fullscreen: false,
    });
  });
});

test("restores legacy external file targets without the obsolete restriction", () => {
  expect(
    normalizeTaskPanelSessionUiState({
      fileTarget: { path: "/outside/file.txt", line: 3, restricted: true },
    }).fileTarget,
  ).toEqual({ path: "/outside/file.txt", line: 3 });
});
