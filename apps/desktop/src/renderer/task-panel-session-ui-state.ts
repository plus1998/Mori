import { TASK_PANEL_HOME_TAB_ID, type TaskPanelActiveTab } from "./SubagentTaskDrawer";
import type { WorkspaceFileReference } from "./workspace-file-reference";
import { normalizeBrowserSplitLayout, type BrowserSplitLayout } from "./browser-split-layout";

export type TaskPanelSessionFileTarget = WorkspaceFileReference & {
  requestId?: number;
};

export type TaskPanelSessionUiState = {
  open: boolean;
  activeTab: TaskPanelActiveTab;
  openTabIds: TaskPanelActiveTab[];
  fullscreen: boolean;
  browserSplit?: BrowserSplitLayout;
  selectedSubagentAgentId?: string;
  fileTarget?: TaskPanelSessionFileTarget;
};

export function emptyTaskPanelSessionUiState(): TaskPanelSessionUiState {
  return {
    open: false,
    activeTab: TASK_PANEL_HOME_TAB_ID,
    openTabIds: [],
    fullscreen: false,
  };
}

export type CaptureTaskPanelSessionUiStateInput = {
  open: boolean;
  activeTab: TaskPanelActiveTab;
  openTabIds: readonly TaskPanelActiveTab[];
  fullscreen: boolean;
  browserSplit?: BrowserSplitLayout;
  selectedSubagentAgentId?: string;
  fileTarget?: TaskPanelSessionFileTarget;
};

export function captureTaskPanelSessionUiState(
  input: CaptureTaskPanelSessionUiStateInput,
): TaskPanelSessionUiState {
  const openTabIds = dedupeTabIds(input.openTabIds);
  const activeTab =
    typeof input.activeTab === "string" && input.activeTab.trim() ? input.activeTab : TASK_PANEL_HOME_TAB_ID;
  const fileTarget = normalizeFileTarget(input.fileTarget);
  const browserSplit = normalizeBrowserSplitLayout(input.browserSplit, openTabIds);
  const selectedSubagentAgentId =
    typeof input.selectedSubagentAgentId === "string" && input.selectedSubagentAgentId.trim()
      ? input.selectedSubagentAgentId.trim()
      : undefined;

  return {
    open: input.open === true,
    activeTab,
    openTabIds,
    fullscreen: input.open === true && input.fullscreen === true,
    ...(browserSplit ? { browserSplit } : {}),
    ...(selectedSubagentAgentId ? { selectedSubagentAgentId } : {}),
    ...(fileTarget ? { fileTarget } : {}),
  };
}

export function normalizeTaskPanelSessionUiState(value: unknown): TaskPanelSessionUiState {
  if (!value || typeof value !== "object") {
    return emptyTaskPanelSessionUiState();
  }
  const record = value as Partial<TaskPanelSessionUiState>;
  const openTabIds = Array.isArray(record.openTabIds)
    ? dedupeTabIds(record.openTabIds.filter((tabId): tabId is string => typeof tabId === "string"))
    : [];
  const activeTab =
    typeof record.activeTab === "string" && record.activeTab.trim()
      ? record.activeTab.trim()
      : TASK_PANEL_HOME_TAB_ID;
  const fileTarget = normalizeFileTarget(record.fileTarget);
  const browserSplit = normalizeBrowserSplitLayout(record.browserSplit, openTabIds);
  const selectedSubagentAgentId =
    typeof record.selectedSubagentAgentId === "string" && record.selectedSubagentAgentId.trim()
      ? record.selectedSubagentAgentId.trim()
      : undefined;
  const open = record.open === true;

  return {
    open,
    activeTab:
      openTabIds.includes(activeTab) || activeTab === TASK_PANEL_HOME_TAB_ID
        ? activeTab
        : (openTabIds.at(-1) ?? TASK_PANEL_HOME_TAB_ID),
    openTabIds,
    fullscreen: open && record.fullscreen === true,
    ...(browserSplit ? { browserSplit } : {}),
    ...(selectedSubagentAgentId ? { selectedSubagentAgentId } : {}),
    ...(fileTarget ? { fileTarget } : {}),
  };
}

function dedupeTabIds(tabs: readonly TaskPanelActiveTab[]): TaskPanelActiveTab[] {
  const seen = new Set<string>();
  const next: TaskPanelActiveTab[] = [];
  for (const tabId of tabs) {
    if (typeof tabId !== "string" || !tabId.trim()) {
      continue;
    }
    if (tabId === TASK_PANEL_HOME_TAB_ID) {
      continue;
    }
    if (seen.has(tabId)) {
      continue;
    }
    seen.add(tabId);
    next.push(tabId);
  }
  return next;
}

function normalizeFileTarget(value: unknown): TaskPanelSessionFileTarget | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<TaskPanelSessionFileTarget>;
  if (typeof record.path !== "string" || !record.path.trim()) {
    return undefined;
  }
  const target: TaskPanelSessionFileTarget = {
    path: record.path.trim(),
  };
  if (typeof record.line === "number" && Number.isFinite(record.line)) {
    target.line = Math.trunc(record.line);
  }
  if (typeof record.column === "number" && Number.isFinite(record.column)) {
    target.column = Math.trunc(record.column);
  }
  if (typeof record.requestId === "number" && Number.isFinite(record.requestId)) {
    target.requestId = Math.trunc(record.requestId);
  }
  return target;
}
