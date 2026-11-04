import { expect, test } from "./fixtures/electron-app";
import fs from "node:fs/promises";
import http from "node:http";
import type { ElectronApplication, Page } from "@playwright/test";

async function mockAccountPages(app: ElectronApplication, ids: string[]) {
  await app.evaluate(({ app, session }, ids) => {
    for (const id of ids) {
      const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
      ses.protocol.handle("https", () => new Response('<html><title>Profile test</title><body><input type="email"><input type="password"></body></html>', {
        headers: { "content-type": "text/html" },
      }));
    }
  }, ids);
}

async function readAccountPage(app: ElectronApplication, id: string, script: string) {
  return app.evaluate(async ({ app, session, webContents }, { id, script }) => {
    const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
    const guest = webContents.getAllWebContents().find(wc => wc.getType() === "webview" && wc.session === ses);
    if (!guest) throw new Error("Account guest not found");
    return guest.executeJavaScript(script);
  }, { id, script });
}

async function open(page: Page, id: string) {
  await page.evaluate(id => window.eco.openAIAccountsOpenChatGPT(id), id);
  const state = await page.evaluate(() => window.eco.getBrowserState());
  const tab = state.instances.find(tab => tab.accountId === id)!;
  expect(tab).toBeDefined();
  expect(tab.windowed).toBe(true);
  await expect(page.locator(`webview[ecobrowsertabid="${tab.id}"]`)).toHaveCount(0);
  return tab;
}

test("ordinary browser pages detach and dock with their history and workspace session", async ({ electronApp, ecoPage }) => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<title>Window browser ${req.url}</title><body>${req.url}<input></body>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let browserId: string | undefined;
  try {
    const opened = await ecoPage.evaluate(url => window.eco.getHomeProjectPath().then(workspacePath => window.eco.browserOpen({ newBrowser: true, url, activate: true, workspacePath })), `${origin}/first`);
    browserId = opened.focusedBrowserId!;
    await expect.poll(() => electronApp.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(wc => wc.getType() === "webview" && wc.getURL() === url && !wc.isLoading()), `${origin}/first`)).toBe(true);
    await ecoPage.evaluate(async ({ browserId, url }) => { await window.eco.browserNavigate({ browserId, url }); }, { browserId, url: `${origin}/second` });
    await electronApp.evaluate(async ({ webContents }, id) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getType() === "webview" && wc.getURL().endsWith("/second"))!;
      await guest.executeJavaScript('localStorage.setItem("detach-probe", "retained"); document.cookie="detach-cookie=retained"');
    }, browserId);
    await ecoPage.evaluate(id => window.eco.browserSetWindowed(id, true), browserId);
    const shell = electronApp.windows().find(page => page.url().includes(`browser.html?browserId=${browserId}`))!;
    await expect(shell.locator("webview")).toBeVisible();
    await expect(ecoPage.locator(`webview[ecobrowsertabid="${browserId}"]`)).toHaveCount(0);
    const readGuest = (script: string) => electronApp.evaluate(async ({ webContents }, { script, origin }) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getType() === "webview" && wc.getURL().startsWith(origin))!;
      return guest.executeJavaScript(script);
    }, { script, origin });
    expect(await readGuest('localStorage.getItem("detach-probe")')).toBe("retained");
    expect(await readGuest('document.cookie')).toContain("detach-cookie=retained");
    expect(await readGuest('typeof window.eco')).toBe("undefined");
    const history = await electronApp.evaluate(({ webContents }, origin) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getType() === "webview" && wc.getURL().startsWith(origin))!;
      return { entries: guest.navigationHistory.getAllEntries().map(entry => entry.url), index: guest.navigationHistory.getActiveIndex() };
    }, origin);
    expect(history.entries).toContain(`${origin}/first`);
    const originalScope = (await ecoPage.evaluate(() => window.eco.getBrowserState())).uiScopeId;
    await ecoPage.evaluate(async () => window.eco.browserSetUiScope({ threadId: "thr_detached_other", workspacePath: await window.eco.getHomeProjectPath() }));
    await shell.getByRole("textbox").fill(`${origin}/third`);
    await shell.getByRole("textbox").press("Enter");
    await expect.poll(async () => (await ecoPage.evaluate(() => window.eco.getBrowserState())).allInstances.find(page => page.id === browserId)?.url).toBe(`${origin}/third`);
    expect((await ecoPage.evaluate(() => window.eco.getBrowserState())).uiScopeId).toBe("thr_detached_other");
    await shell.getByRole("button", { name: /^(后退|Back)$/u }).click();
    await expect.poll(async () => (await ecoPage.evaluate(() => window.eco.getBrowserState())).allInstances.find(page => page.id === browserId)?.url).toBe(`${origin}/second`);
    await ecoPage.evaluate(async threadId => window.eco.browserSetUiScope({ threadId, workspacePath: await window.eco.getHomeProjectPath() }), originalScope);
    await shell.getByRole("button", { name: /^(后退|Back)$/u }).click();
    await expect.poll(async () => (await ecoPage.evaluate(() => window.eco.getBrowserState())).allInstances.find(page => page.id === browserId)?.url).toBe(`${origin}/first`);
    await shell.getByRole("button", { name: /浏览器更多操作|More browser actions/u }).click();
    await shell.getByRole("menuitem", { name: /移回主窗口|Move to main window/u }).click();
    await expect.poll(() => shell.isClosed()).toBe(true);
    await expect.poll(async () => (await ecoPage.evaluate(() => window.eco.getBrowserState())).allInstances.find(page => page.id === browserId)?.windowed ?? false).toBe(false);
    await expect(ecoPage.locator(`webview[ecobrowsertabid="${browserId}"]`)).toHaveCount(1);
    expect(await readGuest('localStorage.getItem("detach-probe")')).toBe("retained");
    const state = await ecoPage.evaluate(() => window.eco.getBrowserState());
    expect(state.allInstances.find(page => page.id === browserId)?.canGoForward).toBe(true);
    await ecoPage.evaluate(id => window.eco.browserSetWindowed(id, true), browserId);
    await electronApp.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(`browser.html?browserId=${id}`))!.close();
    }, browserId);
    await expect.poll(async () => (await ecoPage.evaluate(() => window.eco.getBrowserState())).allInstances.some(page => page.id === browserId)).toBe(false);
  } finally {
    if (browserId) await ecoPage.evaluate(id => window.eco.browserCloseInstance({ browserId: id }), browserId);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("ChatGPT tabs reuse isolated account data, preserve existing profiles, and delete account guests", async ({ electronApp, ecoPage }) => {
  const accounts: string[] = [];
  try {
    for (const name of ["ChatGPT browser A", "ChatGPT browser B"]) {
      const account = await ecoPage.evaluate(name => window.eco.openAIAccountsCreate({ name, proxyMode: "direct" }), name);
      accounts.push(account.id);
    }
    const [first, second] = accounts as [string, string];
    await mockAccountPages(electronApp, accounts);
    // Seed the pre-existing disk profile before the built-in browser opens it.
    await electronApp.evaluate(async ({ app, session }, id) => {
      const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
      await ses.cookies.set({ url: "https://chatgpt.com", name: "session-probe", value: "account-a",
        secure: true, httpOnly: true, expirationDate: Date.now() / 1_000 + 86_400 });
      await ses.cookies.flushStore();
    }, first);
    const windowsBefore = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    const firstTab = await open(ecoPage, first);
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowsBefore + 1);
    const firstWindow = electronApp.windows().find(page => page.url().includes(`browser.html?browserId=${firstTab.id}`))!;
    await expect(firstWindow.locator(`webview[ecobrowsertabid="${firstTab.id}"]`)).toBeVisible();
    await expect(firstWindow.getByRole("button", { name: /^(刷新|Reload)$/u })).toBeVisible();
    expect(await firstWindow.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim())).not.toBe("");
    await firstWindow.screenshot({ path: "/tmp/eco-account-chatgpt-window.png" });
    expect(firstTab.title).toContain("ChatGPT browser A");
    expect(await readAccountPage(electronApp, first, "typeof window.eco")).toBe("undefined");
    await readAccountPage(electronApp, first, 'localStorage.setItem("history-probe", "account-a")');
    // Opening from settings focuses the existing browser window and keeps settings available.
    await ecoPage.getByRole("button", { name: /^(设置|Settings)$/u }).click();
    await ecoPage.getByRole("button", { name: /^(服务商|Provider)$/u }).click();
    await ecoPage.getByRole("tab", { name: "ChatGPT Login" }).click();
    await ecoPage.locator("article").filter({ hasText: "ChatGPT browser A" }).getByRole("button", { name: /更多操作|More actions/u }).click();
    await ecoPage.getByRole("menuitem", { name: /打开 ChatGPT 网页|Open ChatGPT website/u }).click();
    await expect(firstWindow.locator(`webview[ecobrowsertabid="${firstTab.id}"]`)).toBeVisible();
    expect((await open(ecoPage, first)).id).toBe(firstTab.id);
    await ecoPage.evaluate(id => window.eco.browserCloseInstance({ browserId: id }), firstTab.id);
    const reopened = await open(ecoPage, first);
    expect(await readAccountPage(electronApp, first, 'localStorage.getItem("history-probe")')).toBe("account-a");
    const other = await open(ecoPage, second);
    expect(await readAccountPage(electronApp, second, 'localStorage.getItem("history-probe")')).toBeNull();
    const cookies = await electronApp.evaluate(async ({ app, session }, ids) => Promise.all(ids.map(async id => {
      const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
      return (await ses.cookies.get({ name: "session-probe" })).map(cookie => cookie.value);
    })), accounts);
    expect(cookies).toEqual([["account-a"], []]);
    // Ordinary workspace pages must use another Session as well.
    const ordinary = await ecoPage.evaluate(() => window.eco.browserOpen({ newBrowser: true, url: "about:blank" }));
    const ordinaryPartition = ordinary.instances.find(tab => tab.id === ordinary.focusedBrowserId)!.partition;
    expect(ordinaryPartition).not.toBe(reopened.partition);
    expect(await electronApp.evaluate(async ({ session }, partition) => (await session.fromPartition(partition).cookies.get({ name: "session-probe" })).length, ordinaryPartition)).toBe(0);
    await ecoPage.evaluate(id => window.eco.browserCloseInstance({ browserId: id }), ordinary.focusedBrowserId!);

    const popupOpened = electronApp.waitForEvent("window", {
      predicate: async candidate => {
        try { await candidate.waitForURL("https://chatgpt.com/popup", { timeout: 5_000 }); return true; }
        catch { return false; } // A closed webview can also emit Playwright's window event.
      },
    });
    await readAccountPage(electronApp, first, 'window.open("https://chatgpt.com/popup"); undefined');
    const popup = await popupOpened;
    await popup.waitForURL("https://chatgpt.com/popup");
    expect(await popup.evaluate(() => localStorage.getItem("history-probe"))).toBe("account-a");
    expect(await popup.evaluate(() => typeof window.eco)).toBe("undefined");
    await ecoPage.evaluate(id => window.eco.openAIAccountsDelete(id), first);
    expect(popup.isClosed()).toBe(true);
    accounts.shift();
    const state = await ecoPage.evaluate(() => window.eco.getBrowserState());
    expect(state.allInstances.some(tab => tab.id === reopened.id)).toBe(false);
    expect(state.allInstances.some(tab => tab.id === other.id)).toBe(true);
    const after = await electronApp.evaluate(async ({ app, session }, id) => {
      const directory = `${app.getPath("userData")}/codex-accounts/${id}`;
      return { directory, cookies: (await session.fromPath(`${directory}/browser`).cookies.get({})).length };
    }, first);
    expect(after.cookies).toBe(0);
    await expect(fs.stat(after.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ecoPage.evaluate(id => window.eco.openAIAccountsOpenChatGPT(id), first)).rejects.toThrow("not found");
  } finally {
    for (const id of accounts) await ecoPage.evaluate(id => window.eco.openAIAccountsDelete(id), id);
  }
});

test("account tabs send requests through their own proxy and apply proxy changes without replacing site data", async ({ electronApp, ecoPage }) => {
  const requests: string[] = [];
  const proxy = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    res.end("account-proxy-response");
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as { port: number }).port;
  let accountId: string | undefined;
  try {
    const account = await ecoPage.evaluate(proxyUrl => window.eco.openAIAccountsCreate({
      name: "Account proxy", proxyMode: "manual", proxyUrl,
    }), `http://127.0.0.1:${port}`);
    accountId = account.id;
    await mockAccountPages(electronApp, [account.id]);
    await open(ecoPage, account.id);
    await readAccountPage(electronApp, account.id, 'localStorage.setItem("proxy-probe", "retained")');
    await electronApp.evaluate(async ({ app, session, webContents }, id) => {
      const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
      const guest = webContents.getAllWebContents().find(wc => wc.getType() === "webview" && wc.session === ses)!;
      await guest.loadURL("http://account-proxy.test/probe");
    }, account.id);
    expect((await readAccountPage(electronApp, account.id, 'document.body.innerText')).trim()).toBe("account-proxy-response");
    expect(requests).toContain("http://account-proxy.test/probe");
    await ecoPage.evaluate(accountId => window.eco.openAIAccountsUpdate({ accountId, name: "Account proxy", proxyMode: "direct" }), account.id);
    const resolved = await electronApp.evaluate(async ({ app, session }, id) => {
      const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
      return ses.resolveProxy("http://account-proxy.test/probe");
    }, account.id);
    expect(resolved).toBe("DIRECT");
    await electronApp.evaluate(async ({ app, session, webContents }, id) => {
      const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
      await webContents.getAllWebContents().find(wc => wc.getType() === "webview" && wc.session === ses)!.loadURL("https://chatgpt.com/");
    }, account.id);
    expect(await readAccountPage(electronApp, account.id, 'localStorage.getItem("proxy-probe")')).toBe("retained");
  } finally {
    if (accountId) await ecoPage.evaluate(id => window.eco.openAIAccountsDelete(id), accountId);
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

test("login opens a browser window, supports helper fill, and cancels when the window closes", async ({ electronApp, ecoPage }) => {
  const account = await ecoPage.evaluate(() => window.eco.openAIAccountsCreate({
    name: "Account login tab", email: "account-login@example.test", proxyMode: "direct",
  }));
  try {
    await mockAccountPages(electronApp, [account.id]);
    const result = await ecoPage.evaluate(id => window.eco.openAIAccountsStartLogin(id), account.id);
    expect(result.success, result.message).toBe(true);
    const state = await ecoPage.evaluate(() => window.eco.getBrowserState());
    const tab = state.instances.find(tab => tab.accountId === account.id)!;
    expect(tab.windowed).toBe(true);
    expect(tab.presentationLocked).toBe(true);
    const loginWindow = electronApp.windows().find(page => page.url().includes(`browser.html?browserId=${tab.id}`))!;
    await expect(loginWindow.locator(`webview[ecobrowsertabid="${tab.id}"]`)).toBeVisible();
    await loginWindow.screenshot({ path: "/tmp/eco-account-login-window.png" });
    await expect(ecoPage.locator(`webview[ecobrowsertabid="${tab.id}"]`)).toHaveCount(0);
    await expect(ecoPage.evaluate(id => window.eco.browserSetWindowed(id, false), tab.id)).rejects.toThrow("登录期间");
    expect(tab.url).toMatch(/^https:\/\/auth\.openai\.com\//);
    expect(await ecoPage.evaluate(id => window.eco.openAIAccountsAssistantState(id), account.id)).toMatchObject({ hasLoginWindow: true, canFill: true });
    await ecoPage.evaluate(id => window.eco.openAIAccountsAssistantAction(id, { type: "fill", field: "email" }), account.id);
    expect(await readAccountPage(electronApp, account.id, 'document.querySelector("input").value')).toBe("account-login@example.test");
    await readAccountPage(electronApp, account.id, 'document.body.innerText = "Signed in to Codex. You may now close this page"');
    await expect.poll(async () => (await ecoPage.evaluate(() => window.eco.getBrowserState())).instances.find(page => page.id === tab.id)?.closeBlocked).toBe(true);
    await electronApp.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(`browser.html?browserId=${id}`))!.close();
    }, tab.id);
    const blocked = await ecoPage.evaluate(id => window.eco.browserCloseInstance({ browserId: id }), tab.id);
    expect(blocked.instances.some(page => page.id === tab.id)).toBe(true);
    await ecoPage.evaluate(({ id, loginId }) => window.eco.openAIAccountsCancelLogin(id, loginId), { id: account.id, loginId: result.loginId! });
    await expect.poll(async () => (await ecoPage.evaluate(id => window.eco.openAIAccountsAssistantState(id), account.id)).hasLoginWindow).toBe(false);
    const retry = await ecoPage.evaluate(id => window.eco.openAIAccountsStartLogin(id), account.id);
    expect(retry.success, retry.message).toBe(true);
    const next = await ecoPage.evaluate(() => window.eco.getBrowserState());
    await electronApp.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(`browser.html?browserId=${id}`))!.close();
    }, next.instances.find(page => page.accountId === account.id)!.id);
    await expect.poll(async () => (await ecoPage.evaluate(id => window.eco.openAIAccountsAssistantState(id), account.id)).hasLoginWindow).toBe(false);
  } finally {
    await ecoPage.evaluate(id => window.eco.openAIAccountsDelete(id), account.id);
  }
});

test("HTTP proxy authentication is isolated between accounts using the same endpoint", async ({ electronApp, ecoPage }) => {
  const proxy = http.createServer((req, res) => {
    const auth = req.headers["proxy-authorization"];
    if (!auth) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="account-test"' });
      res.end();
      return;
    }
    res.end(Buffer.from(auth.slice(6), "base64").toString());
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as { port: number }).port;
  const accounts: string[] = [];
  try {
    for (const username of ["account-a", "account-b"]) {
      const account = await ecoPage.evaluate(({ username, port }) => window.eco.openAIAccountsCreate({
        name: username, proxyMode: "manual", proxyUrl: `http://${username}:password@127.0.0.1:${port}`,
      }), { username, port });
      accounts.push(account.id);
      await mockAccountPages(electronApp, [account.id]);
      await open(ecoPage, account.id);
      await electronApp.evaluate(async ({ app, session, webContents }, id) => {
        const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
        await webContents.getAllWebContents().find(wc => wc.getType() === "webview" && wc.session === ses)!.loadURL("http://account-proxy.test/auth");
      }, account.id);
      expect((await readAccountPage(electronApp, account.id, "document.body.innerText")).trim()).toBe(`${username}:password`);
    }
  } finally {
    for (const id of accounts) await ecoPage.evaluate(id => window.eco.openAIAccountsDelete(id), id);
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

test("authenticated SOCKS5 carries account page requests through the browser bridge", async ({ electronApp, ecoPage }) => {
  const net = await import("node:net");
  const sockets = new Set<import("node:net").Socket>();
  const credentials: string[] = [];
  const destinations: string[] = [];
  const proxy = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let stage = 0;
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (stage === 0) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
          buffer = buffer.subarray(2 + buffer[1]!);
          socket.write(Buffer.from([5, 2]));
          stage = 1;
        } else if (stage === 1) {
          if (buffer.length < 2) return;
          const userEnd = 2 + buffer[1]!;
          if (buffer.length <= userEnd || buffer.length < userEnd + 1 + buffer[userEnd]!) return;
          const end = userEnd + 1 + buffer[userEnd]!;
          credentials.push(`${buffer.subarray(2, userEnd)}:${buffer.subarray(userEnd + 1, end)}`);
          buffer = buffer.subarray(end);
          socket.write(Buffer.from([1, 0]));
          stage = 2;
        } else if (stage === 2) {
          if (buffer.length < 5) return;
          const length = buffer[3] === 1 ? 4 : buffer[3] === 3 ? 1 + buffer[4]! : 16;
          const end = 4 + length + 2;
          if (buffer.length < end) return;
          const host = buffer[3] === 1 ? [...buffer.subarray(4, 8)].join(".") : buffer.subarray(5, 4 + length).toString();
          destinations.push(`${host}:${buffer.readUInt16BE(end - 2)}`);
          buffer = buffer.subarray(end);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          stage = 3;
        } else if (stage === 3 && buffer.includes("\r\n\r\n")) {
          stage = 4;
          const body = "account-socks-response";
          socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${body}`);
          return;
        } else return;
      }
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as { port: number }).port;
  let accountId: string | undefined;
  try {
    const account = await ecoPage.evaluate(port => window.eco.openAIAccountsCreate({
      name: "SOCKS account", proxyMode: "manual", proxyUrl: `socks5://socks-user:socks-password@127.0.0.1:${port}`,
    }), port);
    accountId = account.id;
    await mockAccountPages(electronApp, [account.id]);
    await open(ecoPage, account.id);
    await electronApp.evaluate(async ({ app, session, webContents }, id) => {
      const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
      await webContents.getAllWebContents().find(wc => wc.getType() === "webview" && wc.session === ses)!.loadURL("http://192.0.2.1/probe");
    }, account.id);
    expect((await readAccountPage(electronApp, account.id, "document.body.innerText")).trim()).toBe("account-socks-response");
    expect(credentials).toContain("socks-user:socks-password");
    expect(destinations).toContain("192.0.2.1:80");
  } finally {
    if (accountId) await ecoPage.evaluate(id => window.eco.openAIAccountsDelete(id), accountId);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
