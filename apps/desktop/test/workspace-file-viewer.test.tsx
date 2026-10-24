import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceFileViewer } from "../src/renderer/WorkspaceFileViewer";
import "../src/renderer/i18n";

test("renders a compact file viewer and defers its directory tree until requested", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { eco: undefined },
  });
  try {
    const html = renderToStaticMarkup(
      createElement(WorkspaceFileViewer, {
        workspacePath: "/repo",
        target: { path: "/repo/src/App.tsx", requestId: 1 },
      }),
    );

    expect(html).toContain('class="workspace-file-viewer"');
    expect(html).toContain('class="workspace-file-viewer__breadcrumbs"');
    expect(html).toContain(">repo</button>");
    expect(html).toContain(">App.tsx</button>");
    expect(html).toContain('class="workspace-file-header__open-group"');
    expect(html).toContain('aria-label="打开方式…"');
    expect(html).toContain(">打开</span>");
    expect(html).not.toContain("workspace-file-viewer__navigator");
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});

test("an external Feed file exposes breadcrumbs and open actions", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { eco: undefined } });
  try {
    const html = renderToStaticMarkup(
      createElement(WorkspaceFileViewer, {
        workspacePath: "/repo",
        target: { path: "/outside/private.txt", requestId: 1 },
      }),
    );
    expect(html).toContain(">outside</button>");
    expect(html).toContain(">private.txt</button>");
    expect(html).toContain("workspace-file-header__open-group");
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
