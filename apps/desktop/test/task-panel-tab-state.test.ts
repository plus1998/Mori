import { describe, expect, test } from "bun:test";
import {
  addOpenTaskPanelTab,
  removeOpenTaskPanelTab,
  replaceOpenTaskPanelTab,
  resolveTaskPanelReopenTab,
} from "../src/renderer/task-panel-tab-state";
import {
  TASK_PANEL_FILES_TAB_ID,
  TASK_PANEL_HOME_TAB_ID,
  TASK_PANEL_REVIEW_TAB_ID,
  TASK_PANEL_SSH_BOOKMARKS_TAB_ID,
} from "../src/renderer/task-panel-tabs";

describe("task panel tab state", () => {
  test("keeps an opened tab without duplicating it", () => {
    expect(addOpenTaskPanelTab(["files", "review"], "files")).toEqual(["files", "review"]);
    expect(addOpenTaskPanelTab(["files"], "review")).toEqual(["files", "review"]);
  });

  test("replaces only the source new tab when opening a home tool", () => {
    for (const toolTabId of [
      TASK_PANEL_FILES_TAB_ID,
      TASK_PANEL_REVIEW_TAB_ID,
      TASK_PANEL_SSH_BOOKMARKS_TAB_ID,
    ]) {
      expect(
        replaceOpenTaskPanelTab(
          ["browser:page", "browser:new", "browser:other-new"],
          "browser:new",
          toolTabId,
        ),
      ).toEqual(["browser:page", toolTabId, "browser:other-new"]);
    }
  });

  test("removes the new tab and reuses an already opened tool tab", () => {
    expect(
      replaceOpenTaskPanelTab(
        [TASK_PANEL_FILES_TAB_ID, "browser:new", TASK_PANEL_REVIEW_TAB_ID],
        "browser:new",
        TASK_PANEL_REVIEW_TAB_ID,
      ),
    ).toEqual([TASK_PANEL_FILES_TAB_ID, TASK_PANEL_REVIEW_TAB_ID]);
  });

  test("adds the tool tab after browser state has already removed the source", () => {
    expect(replaceOpenTaskPanelTab(["browser:page"], "browser:new", TASK_PANEL_FILES_TAB_ID)).toEqual([
      "browser:page",
      TASK_PANEL_FILES_TAB_ID,
    ]);
  });

  test("falls back to the neighboring tab when the active tab closes", () => {
    expect(removeOpenTaskPanelTab(["files", "review", "agent"], "review")).toEqual({
      tabs: ["files", "agent"],
      fallback: "files",
    });
    expect(removeOpenTaskPanelTab(["files", "review"], "files")).toEqual({
      tabs: ["review"],
      fallback: "review",
    });
  });

  test("leaves no fallback when the final tab closes", () => {
    expect(removeOpenTaskPanelTab(["file-viewer"], "file-viewer")).toEqual({
      tabs: [],
    });
  });

  test("reopening the panel restores the tab it collapsed on instead of opening a new one", () => {
    expect(resolveTaskPanelReopenTab(["files", "browser:page", "review"], "browser:page")).toBe(
      "browser:page",
    );
    expect(resolveTaskPanelReopenTab(["files", "new-tab:1"], "new-tab:1")).toBe("new-tab:1");
  });

  test("reopening falls back to the last opened tab when the active tab is gone or is home", () => {
    expect(resolveTaskPanelReopenTab(["files", "review"], TASK_PANEL_HOME_TAB_ID)).toBe("review");
    expect(resolveTaskPanelReopenTab(["files", "review"], "closed-agent")).toBe("review");
  });

  test("reopening an empty panel has no tab to restore", () => {
    expect(resolveTaskPanelReopenTab([], TASK_PANEL_HOME_TAB_ID)).toBeUndefined();
  });
});
