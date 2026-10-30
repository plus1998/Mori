import { describe, expect, test } from "bun:test";
import {
  addOpenTaskPanelTab,
  moveOpenTaskPanelTab,
  removeOpenTaskPanelTab,
  removeOpenTaskPanelTabs,
  replaceOpenTaskPanelTab,
  resolveTaskPanelReopenTab,
  taskPanelTabsToClose,
} from "../src/renderer/task-panel-tab-state";
import {
  TASK_PANEL_FILES_TAB_ID,
  TASK_PANEL_HOME_TAB_ID,
  TASK_PANEL_REVIEW_TAB_ID,
  TASK_PANEL_SSH_BOOKMARKS_TAB_ID,
} from "../src/renderer/task-panel-tabs";

describe("task panel tab state", () => {
  test("moves browser tabs in both directions without losing tools or changing tab identity", () => {
    const tabs = ["browser:a", TASK_PANEL_FILES_TAB_ID, "browser:b", "new-tab:1"];
    const moved = moveOpenTaskPanelTab(tabs, "browser:a", "browser:b", "after");
    expect(moved).toEqual([TASK_PANEL_FILES_TAB_ID, "browser:b", "browser:a", "new-tab:1"]);
    expect(moveOpenTaskPanelTab(moved, "new-tab:1", TASK_PANEL_FILES_TAB_ID, "before")).toEqual([
      "new-tab:1",
      TASK_PANEL_FILES_TAB_ID,
      "browser:b",
      "browser:a",
    ]);
    expect(tabs).toEqual(["browser:a", TASK_PANEL_FILES_TAB_ID, "browser:b", "new-tab:1"]);
    // Opening a page replaces its start tab at the position chosen by the user.
    expect(replaceOpenTaskPanelTab(moved, "new-tab:1", "browser:c")).toEqual([
      TASK_PANEL_FILES_TAB_ID,
      "browser:b",
      "browser:a",
      "browser:c",
    ]);
  });

  test("a closed source/target or an unchanged drop leaves the current order intact", () => {
    const tabs = ["browser:a", "browser:b"];
    expect(moveOpenTaskPanelTab(tabs, "closed", "browser:b", "before")).toBe(tabs);
    expect(moveOpenTaskPanelTab(tabs, "browser:a", "closed", "after")).toBe(tabs);
    expect(moveOpenTaskPanelTab(tabs, "browser:a", "browser:a", "after")).toBe(tabs);
    expect(moveOpenTaskPanelTab(tabs, "browser:a", "browser:b", "before")).toBe(tabs);
  });

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

describe("task panel batch close", () => {
  test("targets the right-clicked tab and uses the order after dragging", () => {
    const tabs = moveOpenTaskPanelTab(
      ["browser:a", "files", "browser:b", "review"],
      "browser:a",
      "browser:b",
      "after",
    );
    expect(taskPanelTabsToClose(tabs, "browser:b", "right")).toEqual(["browser:a", "review"]);
    expect(taskPanelTabsToClose(tabs, "browser:b", "others")).toEqual(["files", "browser:a", "review"]);
    expect(taskPanelTabsToClose(tabs, "browser:b", "all")).toEqual(tabs);
    expect(tabs).toEqual(["files", "browser:b", "browser:a", "review"]);
  });

  test("disables empty actions and ignores a target that has already closed", () => {
    expect(taskPanelTabsToClose(["files"], "files", "others")).toEqual([]);
    expect(taskPanelTabsToClose(["files", "review"], "review", "right")).toEqual([]);
    for (const action of ["all", "others", "right"] as const) {
      expect(taskPanelTabsToClose(["files", "review"], "gone", action)).toEqual([]);
    }
  });

  test("preserves the active tab when a different tab is right-clicked", () => {
    expect(removeOpenTaskPanelTabs(["files", "review", "browser:a"], ["browser:a"], "files")).toEqual({
      tabs: ["files", "review"],
      fallback: "files",
    });
  });

  test("chooses a surviving neighbor atomically when several tabs close", () => {
    const tabs = ["files", "review", "browser:a", "browser:b"];
    expect(removeOpenTaskPanelTabs(tabs, ["review", "browser:a"], "browser:a")).toEqual({
      tabs: ["files", "browser:b"],
      fallback: "files",
    });
    expect(removeOpenTaskPanelTabs(tabs, ["files", "review", "browser:a"], "files")).toEqual({
      tabs: ["browser:b"],
      fallback: "browser:b",
    });
    expect(removeOpenTaskPanelTabs(tabs, ["files", "review", "browser:a"], "review")).toEqual({
      tabs: ["browser:b"],
      fallback: "browser:b",
    });
  });

  test("all tabs close together without a stale fallback, including duplicate close requests", () => {
    expect(
      removeOpenTaskPanelTabs(["files", "review"], ["files", "review", "files", "gone"], "review"),
    ).toEqual({ tabs: [] });
  });
});
