import { expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { buildApplicationMenuTemplate } from "../src/main/native-menu";
import type { AppMenuCommand } from "../src/shared/ipc";

function submenuFor(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const submenu = template.find((item) => item.label === label)?.submenu;
  if (!Array.isArray(submenu)) {
    throw new Error(`Missing ${label} submenu`);
  }
  return submenu;
}

test("macOS app menu uses the supplied display name for native role labels", () => {
  for (const displayName of ["Mori", "Mori Dev"]) {
    const template = buildApplicationMenuTemplate(displayName, "darwin", () => {});
    const appMenu = submenuFor(template, displayName);
    for (const [role, verb] of [
      ["about", "About"],
      ["hide", "Hide"],
      ["quit", "Quit"],
    ]) {
      expect(appMenu.find((item) => item.role === role)?.label).toBe(`${verb} ${displayName}`);
    }
  }
});

test("builds File and View commands and dispatches their typed command ids", () => {
  const commands: AppMenuCommand[] = [];
  const template = buildApplicationMenuTemplate("Eco Coding", "darwin", (command) => {
    commands.push(command);
  });
  const fileMenu = submenuFor(template, "File");
  const viewMenu = submenuFor(template, "View");

  expect(fileMenu.filter((item) => item.label).map((item) => item.label)).toEqual([
    "New Chat",
    "Open Folder...",
  ]);
  expect(viewMenu.filter((item) => item.label).map((item) => item.label)).toEqual([
    "Toggle Sidebar",
    "Toggle Bottom Panel",
    "Toggle Work Panel",
    "Toggle Review Panel",
    "Toggle File Tree",
    "Toggle Browser",
  ]);

  for (const item of [...fileMenu, ...viewMenu]) {
    if (item.click) {
      (item.click as () => void)();
    }
  }
  expect(commands).toEqual([
    "new-chat",
    "open-folder",
    "toggle-sidebar",
    "toggle-bottom-panel",
    "toggle-work-panel",
    "toggle-review-panel",
    "toggle-file-tree",
    "toggle-browser",
  ]);
});

test("preserves native application, edit, view, and window roles", () => {
  const template = buildApplicationMenuTemplate("Eco Coding", "darwin", () => {});
  const appMenu = submenuFor(template, "Eco Coding");
  const editMenu = submenuFor(template, "Edit");
  const viewMenu = submenuFor(template, "View");
  const windowMenu = submenuFor(template, "Window");

  expect(appMenu.some((item) => item.role === "quit")).toBe(true);
  expect(editMenu.map((item) => item.role).filter(Boolean)).toEqual([
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectAll",
  ]);
  expect(viewMenu.some((item) => item.role === "toggleDevTools")).toBe(true);
  expect(windowMenu.some((item) => item.role === "minimize")).toBe(true);

  const linuxTemplate = buildApplicationMenuTemplate("Eco Coding", "linux", () => {});
  expect(linuxTemplate[0]?.label).toBe("File");
  expect(submenuFor(linuxTemplate, "File").some((item) => item.role === "quit")).toBe(true);
});
