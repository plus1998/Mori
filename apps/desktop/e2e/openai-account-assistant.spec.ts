import type { ElectronApplication, Page } from "@playwright/test";
import { generateAccountTotp } from "../src/main/openai-account-assistant-data";
import { expect, test } from "./fixtures/electron-app";

async function openAccountSettings(page: Page) {
  await page.getByRole("button", { name: /^(设置|Settings)$/u }).click();
  await page.getByRole("button", { name: /^(服务商|Provider)$/u }).click();
  await page.getByRole("tab", { name: "ChatGPT", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "ChatGPT Login", exact: true }).click();
}

async function openHelper(app: ElectronApplication, card: ReturnType<Page["locator"]>, target: "Web" | "Codex") {
  await card.getByRole("button", { name: target, exact: true }).click();
  const opened = app.waitForEvent("window");
  await card.getByRole("menuitem", { name: /^(登录助手|Login helper)$/u }).click();
  const helper = await opened;
  await helper.waitForURL(url => url.pathname.endsWith("/codex-account-assistant.html") && url.searchParams.get("target") === target.toLowerCase());
  return helper;
}

test("opens the login helper without starting a login and copies saved credentials", async ({
  electronApp,
  ecoPage,
}) => {
  const name = `Login helper test ${Date.now()}`;
  const email = "login-helper@example.test";
  const password = "login-helper-test-password";
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  let accountId: string | undefined;
  let clipboardSaved = false;
  let helper: Page | undefined;

  try {
    const account = await ecoPage.evaluate((input) => window.eco.openAIAccountsCreate(input), {
      name,
      email,
      password,
      twoFactorSecret: secret,
    });
    accountId = account.id;
    await openAccountSettings(ecoPage);

    const accountCard = ecoPage.locator("article").filter({ hasText: name });
    await expect(accountCard).toBeVisible();
    const windowsBefore = electronApp.windows().length;
    helper = await openHelper(electronApp, accountCard, "Codex");
    await expect(helper.getByRole("heading", { name })).toBeVisible();
    await expect.poll(() => electronApp.windows().length).toBe(windowsBefore + 1);
    const state = await ecoPage.evaluate((id) => window.eco.openAIAccountsAssistantState(id, "codex"), account.id);
    expect(state.hasLoginWindow).toBe(false);
    expect(state.canFill).toBe(false);
    await expect(helper.getByRole("button", { name: /打开登录页|Open sign-in page/u })).toBeVisible();

    await electronApp.evaluate(async ({ clipboard, ClipboardItem }) => {
      const saved = await Promise.all(
        (await clipboard.read()).map(async (item) => {
          const entries = await Promise.all(
            item.types.map(async (type) => [type, await item.getType(type)] as const),
          );
          return new ClipboardItem(Object.fromEntries(entries));
        }),
      );
      (
        globalThis as typeof globalThis & { loginHelperTestClipboard?: typeof saved }
      ).loginHelperTestClipboard = saved;
    });
    clipboardSaved = true;

    await helper.getByRole("button", { name: /复制邮箱|Copy Email/u }).click();
    expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(email);
    await helper.getByRole("button", { name: /复制密码|Copy Password/u }).click();
    expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(password);
    await helper.getByRole("button", { name: /复制验证码|Copy Code/u }).click();
    const code = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
    const now = Date.now();
    expect([generateAccountTotp(secret, now).code, generateAccountTotp(secret, now - 30_000).code]).toContain(
      code,
    );
  } finally {
    if (clipboardSaved) {
      await electronApp.evaluate(async ({ clipboard }) => {
        const global = globalThis as typeof globalThis & {
          loginHelperTestClipboard?: Awaited<ReturnType<typeof clipboard.read>>;
        };
        const saved = global.loginHelperTestClipboard ?? [];
        if (saved.length) await clipboard.write(saved);
        else clipboard.clear();
        delete global.loginHelperTestClipboard;
      });
    }
    if (helper && !helper.isClosed()) await helper.close();
    if (accountId) await ecoPage.evaluate((id) => window.eco.openAIAccountsDelete(id), accountId);
  }
});

test("Web and Codex helpers sign into their own pages for the same account", async ({ electronApp, ecoPage }) => {
  const name = "Separate sign-in helpers";
  const email = "separate-sign-in@example.test";
  const account = await ecoPage.evaluate(input => window.eco.openAIAccountsCreate(input), { name, email, proxyMode: "direct" });
  try {
    await electronApp.evaluate(({ app, session }, { id, email }) => {
      const ses = session.fromPath(`${app.getPath("userData")}/codex-accounts/${id}/browser`);
      let signedIn = false;
      const claims = Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        "https://api.openai.com/auth": { chatgpt_account_id: "test-web-account" },
      })).toString("base64url");
      ses.protocol.handle("https", request => {
        const url = new URL(request.url);
        if (url.origin === "https://chatgpt.com" && url.pathname === "/api/auth/session") {
          return Response.json(signedIn ? { accessToken: `e30.${claims}.test`, user: { email } } : {});
        }
        if (url.origin === "https://chatgpt.com" && url.pathname === "/signed-in") signedIn = true;
        return new Response('<input type="email"><a href="/signed-in">Sign in</a>', {
          headers: { "content-type": "text/html" },
        });
      });
    }, { id: account.id, email });

    await openAccountSettings(ecoPage);
    const card = ecoPage.locator("article").filter({ hasText: name });
    const web = await openHelper(electronApp, card, "Web");
    const codex = await openHelper(electronApp, card, "Codex");
    await expect(web.getByText(/^(ChatGPT Web 登录助手|ChatGPT Web login helper)$/u)).toBeVisible();
    await expect(codex.getByText(/^(Codex 登录助手|Codex login helper)$/u)).toBeVisible();

    const signIn = /打开登录页|Open sign-in page/u;
    const tabs = () => ecoPage.evaluate(async id =>
      (await window.eco.getBrowserState()).allInstances.filter(tab => tab.accountId === id), account.id);
    expect(await tabs()).toHaveLength(0);
    await web.getByRole("button", { name: signIn }).click();
    await expect.poll(async () => (await tabs()).map(tab => tab.url)).toEqual(["https://chatgpt.com/"]);
    await expect(codex.getByRole("button", { name: signIn })).toBeVisible();
    await codex.getByRole("button", { name: signIn }).click();
    await expect.poll(async () => (await tabs()).map(tab => new URL(tab.url).origin)).toEqual(
      expect.arrayContaining(["https://chatgpt.com", "https://auth.openai.com"]),
    );

    await web.getByRole("button", { name: /^(填入|Fill)$/u }).first().click();
    const values = await electronApp.evaluate(async ({ webContents }) => {
      const guests = webContents.getAllWebContents().filter(contents => contents.getType() === "webview");
      const webGuest = guests.find(contents => contents.getURL() === "https://chatgpt.com/")!;
      const codexGuest = guests.find(contents => contents.getURL().startsWith("https://auth.openai.com/"))!;
      return Promise.all([webGuest, codexGuest].map(guest => guest.executeJavaScript('document.querySelector("input").value')));
    });
    expect(values).toEqual([email, ""]);

    await electronApp.evaluate(({ webContents }) =>
      webContents.getAllWebContents().find(contents => contents.getType() === "webview" && contents.getURL() === "https://chatgpt.com/")!
        .executeJavaScript('document.querySelector("a").click()'),
    );
    await expect(web.getByRole("status")).toContainText("Web 已登录");
    await expect(card.getByRole("button", { name: "Web", exact: true })).toHaveClass(/is-ready/u);
    await expect(card.getByRole("button", { name: "Codex", exact: true })).toHaveClass(/is-danger/u);
    await expect(codex.getByRole("status")).not.toContainText("Web 已登录");
    expect((await tabs()).map(tab => new URL(tab.url).origin)).toEqual(["https://auth.openai.com"]);
  } finally {
    await ecoPage.evaluate(id => window.eco.openAIAccountsDelete(id), account.id);
  }
});
