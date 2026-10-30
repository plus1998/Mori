import { expect, test } from "bun:test";
import { createElement } from "react";
import { BrowserTaskWorkspace } from "../src/renderer/BrowserTaskWorkspace";
import { clampBrowserSplitRatio, normalizeBrowserSplitLayout } from "../src/renderer/browser-split-layout";
import { captureTaskPanelSessionUiState, normalizeTaskPanelSessionUiState } from "../src/renderer/task-panel-session-ui-state";
import { renderLocalized } from "./i18n-test";

const split = { browserIds: ["a", "b"] as [string, string], ratio: 0.6 };
const openTabIds = ["browser:a", "browser:b", "browser:c"];

test("session snapshots preserve split pages and width even when the panel is collapsed", () => {
  const snapshot = captureTaskPanelSessionUiState({
    open: false, activeTab: "browser:b", openTabIds, fullscreen: false, browserSplit: split,
  });
  expect(normalizeTaskPanelSessionUiState(snapshot).browserSplit).toEqual(split);
  expect(snapshot.browserSplit?.browserIds).not.toBe(split.browserIds);
});

test("closed, duplicate or foreign-session pages cannot form a split", () => {
  expect(normalizeBrowserSplitLayout(split, ["browser:a"])).toBeUndefined();
  expect(normalizeBrowserSplitLayout({ browserIds: ["a", "a"] }, openTabIds)).toBeUndefined();
  expect(normalizeBrowserSplitLayout({ browserIds: ["a", "foreign"] }, openTabIds)).toBeUndefined();
  expect(normalizeBrowserSplitLayout({ browserIds: ["a", "b", "c"] }, openTabIds)).toBeUndefined();
  expect(normalizeTaskPanelSessionUiState({ openTabIds: ["browser:b"], browserSplit: split }).browserSplit).toBeUndefined();
});

test("split widths stay usable and nonfinite saved widths normalize to equal halves", () => {
  expect(clampBrowserSplitRatio(0)).toBe(0.25);
  expect(clampBrowserSplitRatio(1)).toBe(0.75);
  expect(clampBrowserSplitRatio(NaN)).toBe(0.5);
  expect(normalizeBrowserSplitLayout({ ...split, ratio: Infinity }, openTabIds)?.ratio).toBe(0.5);
});

function renderWorkspace(activeBrowserId = "a", browserIds = ["a", "b", "c"]) {
  return renderLocalized(createElement(BrowserTaskWorkspace, {
    instances: browserIds.map(id => ({ id, title: `Page ${id}`, url: `https://${id}.test` })),
    activeBrowserId, surfaceActive: true, split,
    onChangeSplit() {}, onToggleSplit() {}, onSelectBrowser() {}, onOpenTool() {},
  }), "zh-CN");
}

test("split shows two independent panels and excludes the opposite page from each picker", () => {
  const markup = renderWorkspace();
  expect(markup).toContain('class="browser-task-workspace is-split"');
  expect(markup.match(/role="tabpanel" hidden=""/g)?.length).toBe(1);
  expect(markup.match(/aria-label="浏览器更多操作"/g)?.length).toBe(3);
  expect(markup).toContain('aria-valuenow="60"');
  const selectors = [...markup.matchAll(/<select[^>]*>(.*?)<\/select>/g)].map(match => match[1]);
  expect(selectors).toHaveLength(2);
  expect(selectors[0]).toContain('value="a"');
  expect(selectors[0]).not.toContain('value="b"');
  expect(selectors[1]).toContain('value="b"');
  expect(selectors[1]).not.toContain('value="a"');
});

test("unpaired tabs display alone; a missing page never leaves a blank second pane", () => {
  for (const markup of [renderWorkspace("c"), renderWorkspace("a", ["a", "c"])]) {
    expect(markup).not.toContain('class="browser-task-workspace is-split"');
    expect(markup).not.toContain('role="separator"');
  }
});
