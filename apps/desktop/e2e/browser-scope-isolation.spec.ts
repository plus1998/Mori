import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserPersonalScopeId } from "../src/shared/browser";
import { expect, test } from "./fixtures/electron-app";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("project switches restore only their own browser tabs and reject stale navigation", async ({ ecoPage: page }) => {
  const server = createServer((request, response) => {
    const name = request.url === "/b" ? "Scope B" : "Scope A";
    response.setHeader("Content-Type", "text/html");
    response.end(`<title>${name}</title><h1>${name}</h1><button onclick="this.textContent='clicked'">Ready</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const urlA = `http://127.0.0.1:${port}/a`;
  const urlB = `http://127.0.0.1:${port}/b`;
  try {
    await page.evaluate(async (workspacePath) => window.eco.openWorkspacePath(workspacePath), repoRoot);
    await page.reload();
    await expect(page.getByRole("heading", { name: /eco-coding/ })).toBeVisible();
    await page.getByRole("button", { name: "打开任务侧栏", exact: true }).click();
    await page.getByRole("textbox", { name: "地址", exact: true }).fill(urlA);
    await page.getByRole("textbox", { name: "地址", exact: true }).press("Enter");
    await expect(page.getByRole("tab", { name: "Scope A", exact: true })).toBeVisible();
    const stateA = await page.evaluate(async () => window.eco.getBrowserState());
    const idA = stateA.focusedBrowserId!;

    await page.getByRole("group", { name: "Home 拖拽排序区域", exact: true }).hover();
    await page.getByRole("button", { name: "在 Home 中新建对话", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Scope A", exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => (await window.eco.getBrowserState()).instances.length)).toBe(0);
    await expect(page.locator('[data-browser-host-hidden="false"]')).toHaveCount(0);

    await page.getByRole("button", { name: "打开任务侧栏", exact: true }).click();
    await page.getByRole("textbox", { name: "地址", exact: true }).fill(urlB);
    await page.getByRole("textbox", { name: "地址", exact: true }).press("Enter");
    await expect(page.getByRole("tab", { name: "Scope B", exact: true })).toBeVisible();
    const stateB = await page.evaluate(async () => window.eco.getBrowserState());
    const idB = stateB.focusedBrowserId!;
    expect(stateB.uiScopeId).not.toBe(stateA.uiScopeId);
    expect(stateA.guestInstances[0]?.partition).not.toBe(stateB.guestInstances[0]?.partition);

    await page.getByRole("group", { name: "eco-coding 拖拽排序区域", exact: true }).hover();
    await page.getByRole("button", { name: "在 eco-coding 中新建对话", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Scope A", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Scope B", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "地址", exact: true })).toHaveValue(urlA);
    await expect(page.locator('[data-browser-host-hidden="false"]')).toHaveAttribute("data-browser-id", idA);
    expect((await page.evaluate(async () => window.eco.getBrowserState())).uiScopeId).toBe(browserPersonalScopeId(repoRoot));

    const error = await page.evaluate(async ({ browserId, url }) => {
      try { await window.eco.browserNavigate({ browserId, url }); return "navigation unexpectedly succeeded"; }
      catch (caught) { return String(caught); }
    }, { browserId: idB, url: urlA });
    expect(error).toContain("does not belong");
    const state = await page.evaluate(async () => window.eco.getBrowserState());
    expect(state.instances.map((instance) => instance.id)).toEqual([idA]);
    expect(state.allInstances.find((instance) => instance.id === idB)?.url).toBe(urlB);
  } finally {
    await page.evaluate(async () => {
      const state = await window.eco.getBrowserState();
      for (const instance of state.allInstances) await window.eco.browserCloseInstance({ browserId: instance.id });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
