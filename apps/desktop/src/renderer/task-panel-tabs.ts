/** Task panel tab ids — kept outside SubagentTaskDrawer so App can import without the drawer chunk. */

export const TASK_PANEL_HOME_TAB_ID = "__home__";
export const TASK_PANEL_FILES_TAB_ID = "__files__";
export const TASK_PANEL_FILE_VIEWER_TAB_ID = "__file_viewer__";
export const TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID = "__background_terminal_tasks__";
export const TASK_PANEL_SSH_BOOKMARKS_TAB_ID = "__ssh_bookmarks__";
export const TASK_PANEL_REVIEW_TAB_ID = "__review__";
export const TASK_PANEL_PLAN_TAB_ID = "__plan__";
/** @deprecated Single-browser tab id; use browserTaskTabId(browserId). */
export const TASK_PANEL_BROWSER_TAB_ID = "__browser__";

export const TASK_PANEL_IMAGE_GENERATION_TAB_ID = "__image_generation_tool__";
export const TASK_PANEL_SPEECH_GENERATION_TAB_ID = "__speech_generation_tool__";

export type TaskPanelHomeTool = "review" | "files" | "terminal" | "sshBookmarks" | "imageGeneration" | "speechGeneration";

const NEW_TASK_PANEL_TAB_PREFIX = "new-tab:";

export function newTaskPanelTabId(id: string): string {
  return `${NEW_TASK_PANEL_TAB_PREFIX}${id}`;
}

export function isNewTaskPanelTabId(tabId: string): boolean {
  return tabId.startsWith(NEW_TASK_PANEL_TAB_PREFIX);
}

export type TaskPanelActiveTab =
  | typeof TASK_PANEL_HOME_TAB_ID
  | typeof TASK_PANEL_FILES_TAB_ID
  | typeof TASK_PANEL_FILE_VIEWER_TAB_ID
  | typeof TASK_PANEL_REVIEW_TAB_ID
  | typeof TASK_PANEL_PLAN_TAB_ID
  | typeof TASK_PANEL_BACKGROUND_TERMINAL_TAB_ID
  | typeof TASK_PANEL_SSH_BOOKMARKS_TAB_ID
  | typeof TASK_PANEL_BROWSER_TAB_ID
  | string;
