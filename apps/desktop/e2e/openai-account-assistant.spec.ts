import type { Page } from "@playwright/test";
import { generateAccountTotp } from "../src/main/openai-account-assistant-data";
import { expect, test } from "./fixtures/electron-app";

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
    await ecoPage.getByRole("button", { name: /^(设置|Settings)$/u }).click();
    await ecoPage.getByRole("button", { name: /^(服务商|Provider)$/u }).click();
    await ecoPage.getByRole("tab", { name: "ChatGPT Login" }).click();

    const accountCard = ecoPage.locator("article").filter({ hasText: name });
    await expect(accountCard).toBeVisible();
    await ecoPage.setViewportSize({ width: 900, height: 300 });
    await accountCard.getByRole("button", { name: /更多操作|More actions/u }).click();
    const menu = ecoPage.getByRole("menu", { name: /账号操作|Account actions/u });
    const openHelper = menu.getByRole("menuitem", { name: /打开登录助手|Open login helper/u });
    await expect(openHelper).toBeVisible();
    const menuBounds = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
    });
    expect(menuBounds.top).toBeGreaterThanOrEqual(8);
    expect(menuBounds.bottom).toBeLessThanOrEqual(menuBounds.viewportHeight - 8);
    await menu.getByRole("menuitem", { name: /^(删除|Delete)$/u }).scrollIntoViewIfNeeded();
    await expect(menu).toBeVisible();

    const windowsBefore = electronApp.windows().length;
    const opened = electronApp.waitForEvent("window");
    await openHelper.click();
    helper = await opened;
    await helper.waitForURL("**/codex-account-assistant.html?**");
    await expect(helper.getByRole("heading", { name })).toBeVisible();
    await expect.poll(() => electronApp.windows().length).toBe(windowsBefore + 1);
    expect(electronApp.windows().some((page) => /^https?:\/\/auth\.openai\.com/u.test(page.url()))).toBe(
      false,
    );

    const state = await ecoPage.evaluate((id) => window.eco.openAIAccountsAssistantState(id), account.id);
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
