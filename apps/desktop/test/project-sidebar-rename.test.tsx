import { expect, test } from "bun:test";
import { createElement } from "react";
import { ProjectActionMenu } from "../src/renderer/ProjectSidebarTree";
import { renderLocalized } from "./i18n-test";

function renderMenu(locale: "zh-CN" | "en-US", props: Partial<Parameters<typeof ProjectActionMenu>[0]> = {}) {
  return renderLocalized(
    createElement(ProjectActionMenu, {
      pinned: false,
      hasCustomName: false,
      onTogglePin: () => undefined,
      onStartRename: () => undefined,
      onResetName: () => undefined,
      onRemove: () => undefined,
      onOpenProjectFolder: () => undefined,
      ...props,
    }),
    locale,
  );
}

test("project menu exposes the rename action in Chinese", () => {
  const markup = renderMenu("zh-CN");
  expect(markup).toContain("重命名项目");
  expect(markup).toContain("lucide-pencil");
});

test("project menu exposes the rename action in English", () => {
  const markup = renderMenu("en-US");
  expect(markup).toContain("Rename project");
});

test("reset default name action appears only when the project has a custom name", () => {
  const withoutCustom = renderMenu("zh-CN", { hasCustomName: false });
  expect(withoutCustom).not.toContain("恢复默认名称");

  const withCustom = renderMenu("zh-CN", { hasCustomName: true });
  expect(withCustom).toContain("恢复默认名称");
});

test("pin action toggles its label", () => {
  expect(renderMenu("zh-CN", { pinned: false })).toContain(">置顶<");
  expect(renderMenu("zh-CN", { pinned: true })).toContain(">取消置顶<");
});

test("open folder action appears in the project menu", () => {
  expect(renderMenu("zh-CN")).toContain("在文件夹中打开");
  expect(renderMenu("en-US")).toContain("Open in folder");
});
