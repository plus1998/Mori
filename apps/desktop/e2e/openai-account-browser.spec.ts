import { expect, test } from "./fixtures/electron-app";
import fs from "node:fs/promises";

test("ChatGPT windows reuse an isolated account profile and delete its site data", async ({ electronApp, ecoPage }) => {
  const accounts: string[] = [];
  try {
    for (const name of ["ChatGPT browser A", "ChatGPT browser B"]) {
      const account = await ecoPage.evaluate(name => window.eco.openAIAccountsCreate({ name, proxyMode: "direct" }), name);
      accounts.push(account.id);
    }
    const [first, second] = accounts as [string, string];
    // Serve a deterministic page at the real origin; this test needs no external login.
    await electronApp.evaluate(({ app, session }, ids) => {
      for (const id of ids) {
        const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
        ses.protocol.handle("https", () => new Response("<html><body>ChatGPT profile test</body></html>", {
          headers: { "content-type": "text/html" },
        }));
      }
    }, accounts);

    const open = async (id: string) => {
      const opened = electronApp.waitForEvent("window");
      await ecoPage.evaluate(id => window.eco.openAIAccountsOpenChatGPT(id), id);
      const page = await opened;
      await page.waitForURL("https://chatgpt.com/");
      return page;
    };
    const firstPage = await open(first);
    expect(await firstPage.evaluate(() => typeof window.eco)).toBe("undefined");
    await firstPage.evaluate(() => localStorage.setItem("history-probe", "account-a"));
    await electronApp.evaluate(async ({ app, session }, id) => {
      const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
      await ses.cookies.set({ url: "https://chatgpt.com", name: "session-probe", value: "account-a",
        secure: true, httpOnly: true, expirationDate: Date.now() / 1_000 + 86_400 });
      await ses.cookies.flushStore();
    }, first);
    const count = electronApp.windows().length;
    await ecoPage.evaluate(id => window.eco.openAIAccountsOpenChatGPT(id), first);
    expect(electronApp.windows().length).toBe(count);
    await firstPage.close();
    const reopened = await open(first);
    expect(await reopened.evaluate(() => localStorage.getItem("history-probe"))).toBe("account-a");
    const other = await open(second);
    expect(await other.evaluate(() => localStorage.getItem("history-probe"))).toBeNull();
    const cookies = await electronApp.evaluate(async ({ app, session }, ids) => Promise.all(ids.map(async id => {
      const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
      return (await ses.cookies.get({ name: "session-probe" })).map(cookie => cookie.value);
    })), accounts);
    expect(cookies).toEqual([["account-a"], []]);

    await ecoPage.evaluate(id => window.eco.openAIAccountsDelete(id), first);
    accounts.shift();
    expect(reopened.isClosed()).toBe(true);
    expect(other.isClosed()).toBe(false);
    const after = await electronApp.evaluate(async ({ app, session }, id) => {
      const directory = `${app.getPath("userData")}/codex-accounts/${id}`;
      const cookies = await session.fromPath(`${directory}/browser`).cookies.get({});
      return { directory, cookies: cookies.length };
    }, first);
    expect(after.cookies).toBe(0);
    await expect(fs.stat(after.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ecoPage.evaluate(id => window.eco.openAIAccountsOpenChatGPT(id), first)).rejects.toThrow("not found");
  } finally {
    for (const id of accounts) await ecoPage.evaluate(id => window.eco.openAIAccountsDelete(id), id);
  }
});
