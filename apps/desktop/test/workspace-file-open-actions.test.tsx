import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import type { BrowserOpenRequest } from "../src/shared/browser";
import { openWorkspaceFileDefault, WorkspaceFileOpenActions } from "../src/renderer/WorkspaceFileOpenActions";
import { renderLocalized } from "./i18n-test";

function createApi() {
  return {
    browserOpen: mock(async (_request: BrowserOpenRequest) => {}),
    openFileExternally: mock(async (_path: string) => {}),
  };
}

test("both file entry points open HTML in the built-in browser without losing Windows paths", async () => {
  for (const path of ["/repo/page.html", "/repo/page.htm", "/repo/page.xhtml", "/repo/page.shtml", "C:\\项目\\网页.HTML"]) {
    const api = createApi();
    await openWorkspaceFileDefault(path, api, { workspacePath: "/repo" });
    expect(api.browserOpen.mock.calls).toEqual([[{ url: path, reveal: true, activate: true, workspacePath: "/repo" }]]);
    expect(api.openFileExternally).not.toHaveBeenCalled();
  }
});

test("regular files open via the system with their exact paths", async () => {
  for (const path of ["/repo/report.pdf", "/repo/a folder/notes.md", "C:\\项目\\数据.xlsx"]) {
    const api = createApi();
    await openWorkspaceFileDefault(path, api, { workspacePath: "/repo" });
    expect(api.openFileExternally.mock.calls).toEqual([[path]]);
    expect(api.browserOpen).not.toHaveBeenCalled();
  }
});

test("open errors propagate for display rather than turning into a successful no-op", async () => {
  const api = createApi();
  const error = new Error("File not found");
  api.openFileExternally.mockRejectedValueOnce(error);
  await expect(openWorkspaceFileDefault("/repo/missing.pdf", api, { workspacePath: "/repo" })).rejects.toBe(error);
});

test("the shared toolbar labels both the default action and the applications menu", () => {
  const html = renderLocalized(createElement(WorkspaceFileOpenActions, { filePath: "/repo/report.pdf", workspacePath: "/repo", requestId: 1 }), "en-US");
  expect(html).toContain(">Open</span>");
  expect(html).toContain('aria-label="Open with…"');
  expect(html).toContain('aria-expanded="false"');
});

test("opening HTML from a conversation retains that conversation's browser scope", async () => {
  const api = createApi();
  await openWorkspaceFileDefault("/repo/page.html", api, { workspacePath: "/repo", threadId: "thread-a" });
  expect(api.browserOpen.mock.calls).toEqual([[{
    url: "/repo/page.html", reveal: true, activate: true, threadId: "thread-a",
  }]]);
});
