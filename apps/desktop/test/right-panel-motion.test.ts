import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appSource = readFileSync(fileURLToPath(new URL("../src/renderer/App.tsx", import.meta.url)), "utf8");
const styles = readFileSync(fileURLToPath(new URL("../src/renderer/styles.css", import.meta.url)), "utf8");
const drawerSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/SubagentTaskDrawer.tsx", import.meta.url)),
  "utf8",
);
const taskPanelController = appSource.slice(
  appSource.indexOf("const revealTaskPanel"),
  appSource.indexOf("const handleTaskPanelResizePointerDown"),
);

test("task panel releases layout only after its compositor exit completes", () => {
  // Critical layout flags apply immediately after the exit animation; secondary
  // mode side-effects can stay non-urgent.
  expect(appSource).toMatch(
    /taskPanelAnimationControls[\s\S]*?\.start\([\s\S]*?\)\s*\.then\(\(\) => \{[\s\S]*?setTaskDrawerOpen\(false\);\s*setTaskPanelLayoutPresent\(false\);/,
  );
  expect(appSource).toContain("setTaskPanelExiting(true)");
  expect(appSource).toContain("is-task-panel-exiting");
  expect(styles).toContain(".is-task-panel-exiting");
  expect(appSource).toContain("Boolean(showWorkspacePanel && workspacePanelResolvedOpen)");
  expect(appSource).not.toContain(
    "showWorkspacePanel && workspacePanelResolvedOpen && !taskPanelLayoutPresent",
  );
  expect(appSource).toMatch(
    /if \(shouldAutoOpenWorkspacePanel\(nextLayoutMode\)\) \{\s*setWorkspacePanelManualOverride\(\{[\s\S]*?open: true,/,
  );
});

test("task panel marks browser panel closed on dismiss for soft-reveal state", () => {
  expect(taskPanelController).toMatch(
    /void window\.eco\?\.browserSetVisible\?\.\(\{\s*visible:\s*false\s*\}\);\s*\/\/[\s\S]*?setTaskPanelExiting\(true\)/,
  );
  expect(appSource).toContain("surfaceActive={taskPanelOpen && !taskPanelExiting}");
  expect(drawerSource).toContain("surfaceActive={surfaceActive}");
  const workspaceSource = readFileSync(
    fileURLToPath(new URL("../src/renderer/BrowserTaskWorkspace.tsx", import.meta.url)), "utf8",
  );
  expect(workspaceSource).toContain("active={focused && surfaceActive}");
  expect(workspaceSource).toContain("visible={visible && surfaceActive}");
});

test("right panel motion stays on transform and opacity instead of animating grid layout", () => {
  const mainPaneRule = styles.match(/\.codex-main-pane\s*\{[^}]*\}/s)?.[0] ?? "";
  const workspaceGridRule = styles.match(/\.codex-main-scroll\.has-workspace-panel\s*\{[^}]*\}/s)?.[0] ?? "";

  expect(mainPaneRule).not.toContain("grid-template-columns 0.32s");
  expect(workspaceGridRule).not.toContain("grid-template-columns 0.32s");
  expect(appSource).toContain('style={{ willChange: "transform, opacity" }}');
  // Feed shell must track size instantly — layout="size" spring reads as rubber-band on resize.
  expect(appSource).not.toContain('layout={prefersReducedMotion ? false : "size"}');
  expect(appSource).not.toContain('transition={{ layout: { type: "spring"');
  expect(taskPanelController).toMatch(
    /taskPanelAnimationControls\s*\.start\(\s*prefersReducedMotion\s*\?\s*\{\s*opacity:\s*0\s*\}/,
  );
  expect(appSource).toContain("const width = activityWorkspace.clientWidth;");
  expect(appSource).not.toContain("const width = activityWorkspace.getBoundingClientRect().width;");
});

test("task panel close remains reversible and all close paths share the controller", () => {
  expect(taskPanelController).toContain("taskPanelAnimationControls.stop();");
  expect(taskPanelController).toContain("duration: reversingExit ? 0.28 : 0.34");
  expect(taskPanelController).toMatch(/if \(taskPanelClosingRef\.current\) \{\s*revealTaskPanel\(\);/);
  expect(taskPanelController).toMatch(
    /pendingTaskPanelTabCloseRef\.current = tabId;\s*dismissTaskPanel\(\);/,
  );
  const homeToolController = appSource.slice(
    appSource.indexOf("const openTaskPanelHomeTool"),
    appSource.indexOf("const openReviewTaskDrawer"),
  );
  expect(homeToolController).toMatch(
    /if \(tool === "terminal"\) \{[\s\S]*?toggleTerminalForCurrentProject\(\);\s*dismissTaskPanel\(\);/,
  );
});

test("task panel ui is saved and restored per thread instead of hard-reset", () => {
  expect(appSource).toContain("taskPanelUiByThreadRef");
  expect(appSource).toContain("liveTaskPanelUiRef.current");
  expect(appSource).toContain("normalizeTaskPanelSessionUiState");
  expect(appSource).toContain("emptyTaskPanelSessionUiState");
  expect(appSource).toMatch(
    /if \(prevThreadId\) \{\s*taskPanelUiByThreadRef\.current\[prevThreadId\] = liveTaskPanelUiRef\.current;/,
  );
  expect(appSource).not.toMatch(
    /setTaskPanelActiveTab\(TASK_PANEL_HOME_TAB_ID\);\s*setFileTarget\(undefined\);\s*setOpenTaskPanelTabIds\(\[\]\);\s*setTaskDrawerOpen\(false\);\s*setTaskPanelLayoutPresent\(false\);/,
  );
});

test("panel chrome stays pinned; main topbar only hosts workspace controls", () => {
  // A group (workspace) rides the feed topbar; B group is a top-only overlay (not a content column).
  // Settings never mounts B (or A). Fullscreen slot expands the overlay leftward under equal icon gaps.
  expect(appSource).toContain('data-group="workspace"');
  expect(appSource).toContain('data-group="chrome"');
  expect(appSource).toContain("shouldShowPanelChromeGroupB");
  expect(appSource).toContain("shouldShowWorkspaceActionGroupA");
  expect(appSource).toContain("has-panel-chrome");
  expect(appSource).toContain("is-chrome-fs-slot-open");
  expect(appSource).toContain("resolveTaskPanelLayoutPhase");
  expect(appSource).toContain("panelChromeCssVariables");
  expect(appSource).toContain("codex-main-pane-panel-actions");
  expect(appSource).toContain("codex-main-pane-panel-action-slot");
  expect(appSource).toContain("toggleTaskPanelFullscreen");
  expect(appSource).toContain("{showPanelChromeGroupB ? renderPanelControlButtons() : null}");
  expect(appSource).not.toContain("toolbarEnd");
  expect(drawerSource).not.toContain("toolbarEnd");
  expect(styles).toContain(".codex-main-pane-panel-actions");
  expect(styles).toContain(".codex-main-pane-panel-action-slot.is-open");
  expect(styles).toContain("has-panel-chrome");
  expect(styles).toContain("--panel-chrome-strip-width");
  // Top-only overlay, not a reserved full-height grid column.
  expect(styles).toContain("position: absolute");
  expect(styles).not.toContain("panel-chrome-start");
  // Closed FS slot must not steal inter-icon gap (prevents A/B kissing).
  expect(styles).toContain("margin-inline-end: calc(-1 * var(--panel-chrome-gap))");
  // Topbar plane reserves strip width so A/B steps match while task is closed.
  expect(styles).toMatch(
    /\.has-panel-chrome:not\(\.is-task-panel-open\)[\s\S]*?\.codex-main-topbar[\s\S]*?padding-right:\s*var\(--panel-chrome-strip-width\)/,
  );
  // Floating cards hug pane edge (no chrome-column compensation).
  expect(styles).not.toContain(
    "right: calc(var(--workspace-cards-panel-right) - var(--panel-chrome-strip-width))",
  );
  // Message nav is not re-gated by competing viewport/container display:none rules.
  expect(styles).not.toMatch(
    /@media \(max-width: 900px\) \{\s*\.activity-user-message-nav \{\s*display:\s*none/,
  );
  expect(styles).not.toContain("is-feed-nav-layout");
  expect(appSource).toContain("taskPanelGeometryCssVariables");
  expect(appSource).not.toContain("MAX_TASK_PANEL_WIDTH");
  expect(styles).toContain("--feed-column-min-width");
  expect(styles).not.toContain("max(360px, calc(100% - 320px))");

  const mainTopbar = appSource.slice(
    appSource.indexOf("const renderWorkspaceTopbarActions"),
    appSource.indexOf("const renderTaskPanel"),
  );
  expect(mainTopbar).toContain("webChatListAnchorRef");
  expect(mainTopbar).toContain("toggleWorkspacePanelForCurrentProject");
  expect(mainTopbar).not.toContain("toggleTerminalForCurrentProject");
  expect(mainTopbar).not.toContain("toggleTaskPanelForCurrentProject");
  expect(appSource).toContain("{taskPanelLayoutOpen ? renderTaskPanel() : null}");
  expect(appSource).toContain("taskPanelLayoutOpen && !taskPanelExiting");
});

test("in-panel browser tab clicks switch pages without opening or exiting fullscreen", () => {
  expect(taskPanelController).toContain("const selectBrowserTaskTab");
  expect(taskPanelController).toContain("shouldResetTaskPanelFullscreenOnBrowserOpen");
  expect(appSource).toMatch(
    /onSelectBrowser=\{\(browserId\) => \{\s*if \(browserId\) \{\s*selectBrowserTaskTab\(browserId\);/,
  );
  expect(appSource).not.toMatch(/onSelectBrowser=\{\(browserId\) => \{\s*openBrowserTaskPanel\(browserId\)/);
});

test("reopening the task sidebar restores its last tab instead of spawning a new one", () => {
  const toggle = appSource.slice(
    appSource.indexOf("const toggleTaskPanelForCurrentProject"),
    appSource.indexOf("const openWebChatItem"),
  );
  expect(toggle).toContain("resolveTaskPanelReopenTab(openTaskPanelTabIds, taskPanelActiveTabRef.current)");
  // A fresh start page is the empty-panel fallback only, never the default reopen path.
  expect(toggle).toMatch(/if \(!restoreTab\) \{\s*openBrowserTaskPanel\(\);\s*return;\s*\}/);
  expect(toggle).toContain("setTaskPanelActiveTab(restoreTab);");
  expect(toggle).toContain("revealTaskPanel();");
});
