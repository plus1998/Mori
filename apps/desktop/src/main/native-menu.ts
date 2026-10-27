import type { BaseWindow, MenuItemConstructorOptions } from "electron";
import type { AppMenuCommand } from "../shared/ipc";

export type AppMenuCommandDispatcher = (
  command: AppMenuCommand,
  browserWindow: BaseWindow | undefined,
) => void;

function commandItem(
  label: string,
  command: AppMenuCommand,
  dispatch: AppMenuCommandDispatcher,
  accelerator?: string,
): MenuItemConstructorOptions {
  return {
    label,
    ...(accelerator ? { accelerator } : {}),
    click: (_menuItem, browserWindow) => dispatch(command, browserWindow),
  };
}

export function buildApplicationMenuTemplate(
  appName: string,
  platform: NodeJS.Platform,
  dispatch: AppMenuCommandDispatcher,
): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about", label: `About ${appName}` },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${appName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${appName}` },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        commandItem("New Chat", "new-chat", dispatch, "CmdOrCtrl+N"),
        commandItem("Open Folder...", "open-folder", dispatch, "CmdOrCtrl+O"),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        commandItem("Toggle Sidebar", "toggle-sidebar", dispatch, "CmdOrCtrl+B"),
        commandItem("Toggle Bottom Panel", "toggle-bottom-panel", dispatch),
        commandItem("Toggle Work Panel", "toggle-work-panel", dispatch),
        commandItem("Toggle Review Panel", "toggle-review-panel", dispatch),
        commandItem("Toggle File Tree", "toggle-file-tree", dispatch),
        commandItem("Toggle Browser", "toggle-browser", dispatch),
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? ([{ type: "separator" }, { role: "front" }] satisfies MenuItemConstructorOptions[])
          : ([{ role: "close" }] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "Help",
      submenu: [commandItem("Check for Updates", "check-for-updates", dispatch)],
    },
  );

  return template;
}
