import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { AccountBrowserPage } from "../src/main/account-browser-page";
import { installCodexAuthCompletionGuard } from "../src/main/codex-auth-completion-guard";

function setup(read: () => Promise<string>) {
  let destroyed = false;
  let closable = true;
  let cancellations = 0;
  const closed = new Set<() => void>();
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, executeJavaScript: read });
  const page: AccountBrowserPage = {
    id: "login-tab", webContents: contents as never,
    isDestroyed: () => destroyed,
    focus() {},
    async close() { destroyed = true; for (const listener of closed) listener(); },
    onClosed(listener) { closed.add(listener); return () => { closed.delete(listener); }; },
    setClosable(value) { closable = value; },
  };
  const guard = installCodexAuthCompletionGuard(page, () => { cancellations++; });
  return { page, guard, contents, closable: () => closable, cancellations: () => cancellations };
}

const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

test("remote success blocks tab closure until the local login result settles", async () => {
  const test = setup(async () => "Signed in to Codex. You may now close this page");
  try {
    await flush();
    expect(test.closable()).toBe(false);
    expect(test.cancellations()).toBe(0);
    test.guard.allowClose();
    expect(test.closable()).toBe(true);
  } finally { test.guard.dispose(); }
});

test("closing the tab cancels login and removes completion watchers", async () => {
  const test = setup(async () => "Sign in");
  try {
    await test.page.close();
    expect(test.cancellations()).toBe(1);
    expect(test.contents.listenerCount("did-finish-load")).toBe(0);
  } finally { test.guard.dispose(); }
});

test("a late completion-page read cannot block closure after local settlement", async () => {
  let finish!: (value: string) => void;
  const test = setup(() => new Promise(resolve => { finish = resolve; }));
  try {
    test.guard.allowClose();
    finish("Signed in to Codex. You may now close this page");
    await flush();
    expect(test.closable()).toBe(true);
  } finally { test.guard.dispose(); }
});
