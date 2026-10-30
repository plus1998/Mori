import type { BaseWindow, MenuItemConstructorOptions } from "electron";
import type { AppMenuCommand } from "../shared/ipc";
import { defaultShortcutBindings, type ShortcutBindings } from "../shared/keyboard-shortcuts";

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
    id: command,
    ...(accelerator ? { accelerator } : {}),
    click: (_menuItem, browserWindow) => dispatch(command, browserWindow),
  };
}

export function buildApplicationMenuTemplate(
  appName: string,
  platform: NodeJS.Platform,
  dispatch: AppMenuCommandDispatcher,
  bindings: ShortcutBindings = defaultShortcutBindings(platform),
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
        commandItem("Mori", "open-mori", dispatch),
        commandItem("Scheduled Tasks", "open-scheduling", dispatch),
        commandItem("Todos", "open-todos", dispatch),
        commandItem("Search", "open-search", dispatch),
        commandItem("Settings", "open-settings", dispatch),
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

  const apply = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.flatMap((item) => {
      const id = item.id;
      if (Array.isArray(item.submenu)) item.submenu = apply(item.submenu);
      if (!id || !(id in bindings)) return [item];
      const keys = bindings[id] ?? [];
      const { accelerator: _accelerator, ...unbound } = item;
      return [
        keys[0] ? { ...item, accelerator: keys[0] } : unbound,
        ...keys.slice(1).map((accelerator) => ({
          ...unbound,
          accelerator,
          visible: false,
          acceleratorWorksWhenHidden: true,
        })),
      ];
    });
  return apply(template);
}
