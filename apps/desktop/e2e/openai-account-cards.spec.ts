import { expect, type Page, test } from "@playwright/test";
import type { OpenAIAccount } from "../src/shared/openai-account";

async function openCards(page: Page) {
  const origin = process.env.ECO_ACCOUNT_LOADING_TEST_URL ?? "http://127.0.0.1:5173";
  await page.goto(new URL("/e2e/fixtures/openai-accounts-loading.html", origin).href);
  await expect(page.locator(".codex-empty-state[aria-busy=true]")).toBeVisible();
  await page.evaluate(() => {
    const now = Date.now();
    const account = (id: string, name: string, email: string, used: number): OpenAIAccount => ({
      id,
      name,
      email,
      createdAt: new Date(now).toISOString(),
      proxyMode: "system",
      isLoggedIn: true,
      authState: "configured",
      webAuthState: "configured",
      quota: {
        planType: "plus",
        email,
        fetchedAt: now,
        resetCreditsAvailable: 0,
        rateLimit: {
          allowed: true,
          limitReached: false,
          primaryWindow: {
            usedPercent: used,
            limitWindowSeconds: 18_000,
            resetAfterSeconds: 7200,
            resetAt: now / 1000 + 7200,
          },
          secondaryWindow: {
            usedPercent: 12,
            limitWindowSeconds: 604_800,
            resetAfterSeconds: 86_400,
            resetAt: now / 1000 + 86_400,
          },
        },
      },
    });
    const accounts = [
      account("card-1", "personal@example.test", "personal@example.test", 32),
      account(
        "card-2",
        "A longer account name for checking title truncation and flexible card layout",
        "long-account-email@example.test",
        93,
      ),
    ];
    if (!window.eco) throw new Error("Missing fixture API");
    window.eco.openAIAccountsList = async () => accounts;
    window.accountLoadingFixture.complete(1, null);
    window.accountLoadingFixture.changed();
  });
  await expect(page.locator(".codex-account-card")).toHaveCount(2);
}

for (const theme of ["light", "dark"]) {
  test(`Login cards remain flat and usable across ${theme} panel widths`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 950 });
    await openCards(page);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const card = page.locator(".codex-account-card").first();
    await expect(card).toHaveCSS(
      "border-top-color",
      theme === "dark" ? "rgb(53, 53, 53)" : "rgb(231, 231, 231)",
    );
    await expect(card.locator(".codex-account-identity")).toHaveText(/personal@example.test/);
    await expect(card.locator(".codex-account-identity > span")).toHaveCount(0);
    await expect(card.getByRole("meter").first()).toHaveAttribute("aria-valuenow", "68");
    for (const width of [960, 520, 290]) {
      // A narrow settings pane can sit inside a wide desktop window: viewport-only
      // media queries failed to handle this layout.
      await page.locator(".provider-settings-page").evaluate((node, width) => {
        node.style.width = `${width}px`;
        node.style.maxWidth = "100%";
        node.style.margin = "0 auto";
      }, width);
      const geometry = await card.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const controls = [...node.querySelectorAll(".codex-status-tag, .codex-account-actions button")].map(
          (button) => {
            const rect = button.getBoundingClientRect();
            return { left: rect.left, right: rect.right };
          },
        );
        return {
          left: bounds.left,
          right: bounds.right,
          overflow: node.scrollWidth > node.clientWidth,
          shadow: getComputedStyle(node).boxShadow,
          controls,
        };
      });
      expect(geometry.shadow).toBe("none");
      expect(geometry.overflow).toBe(false);
      for (const control of geometry.controls) {
        expect(control.left).toBeGreaterThanOrEqual(geometry.left);
        expect(control.right).toBeLessThanOrEqual(geometry.right);
      }
      await card.hover();
      await expect(card).toHaveCSS("box-shadow", "none");
      await card.locator(".codex-status-tag").first().click();
      const menu = card.getByRole("menu");
      await expect(menu).toBeVisible();
      const bounds = await menu.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect(bounds && bounds.x + bounds.width).toBeLessThanOrEqual(1200);
      await card.locator(".codex-status-tag").first().click();
    }
    await card.locator("summary").click();
    await expect(card.locator("details")).toHaveAttribute("open", "");
    await card.locator("summary").click();
    await expect(card.locator("details")).not.toHaveAttribute("open", "");
  });
}
