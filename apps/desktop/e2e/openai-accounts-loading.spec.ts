import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    accountLoadingFixture: {
      reads(): number;
      listeners(): number;
      changed(): void;
      complete(id: number, name: string | null): void;
      fail(id: number): void;
    };
  }
}

async function openFixture(page: Page) {
  await page.goto(new URL("/e2e/fixtures/openai-accounts-loading.html",
    process.env.ECO_ACCOUNT_LOADING_TEST_URL ?? "http://127.0.0.1:5173").href);
  await expect(page.locator(".codex-accounts-hero")).toBeVisible();
}

test("first read distinguishes loading, failed, and successfully empty accounts", async ({ page }) => {
  await openFixture(page);
  await expect(page.locator(".codex-empty-state[aria-busy=true]")).toBeVisible();
  await expect(page.locator(".codex-accounts-toolbar")).toHaveCount(0);
  await expect(page.getByText("No accounts yet. Add one to get started.", { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.accountLoadingFixture.fail(1));
  await expect(page.getByRole("alert")).toContainText("SQLite account read failed");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".codex-empty-state[aria-busy=true]")).toBeVisible();
  await page.evaluate(() => window.accountLoadingFixture.complete(2, null));
  await expect(page.locator(".codex-accounts-toolbar")).toContainText("0 accounts");
  await expect(page.getByText("No accounts yet. Add one to get started.", { exact: true })).toBeVisible();
  await expect(page.locator(".codex-empty-state")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("switching supplier tabs retains accounts without a transient empty state or another read", async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => window.accountLoadingFixture.complete(1, "Saved Login account"));
  await expect(page.locator(".codex-account-card")).toContainText("Saved Login account");
  await page.evaluate(() => {
    const invalid: string[] = [];
    Object.assign(window, { accountLoadingInvalidFrames: invalid });
    new MutationObserver(() => {
      if (document.querySelector(".codex-empty-state")) invalid.push("empty or loading");
      const toolbar = document.querySelector(".codex-accounts-toolbar");
      if (toolbar?.textContent?.includes("0 accounts")) invalid.push("zero accounts");
    }).observe(document.getElementById("root")!, { subtree: true, childList: true, characterData: true });
  });
  for (let i = 0; i < 3; i++) {
    await page.getByRole("tab").first().click();
    await page.getByRole("tab", { name: "ChatGPT Login", exact: true }).click();
    await expect(page.locator(".codex-account-card")).toContainText("Saved Login account");
  }
  expect(await page.evaluate(() => window.accountLoadingFixture.reads())).toBe(1);
  expect(await page.evaluate(() => window.accountLoadingFixture.listeners())).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { accountLoadingInvalidFrames: string[] }).accountLoadingInvalidFrames)).toEqual([]);
});

test("account events update inactive tabs; background failures retain cards and allow retry", async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => window.accountLoadingFixture.complete(1, "Original account"));
  await expect(page.locator(".codex-account-card")).toContainText("Original account");
  await page.getByRole("tab").first().click();
  await page.evaluate(() => {
    window.accountLoadingFixture.changed();
    window.accountLoadingFixture.complete(2, "Changed while hidden");
  });
  await page.getByRole("tab", { name: "ChatGPT Login", exact: true }).click();
  await expect(page.locator(".codex-account-card")).toContainText("Changed while hidden");
  await page.evaluate(() => window.accountLoadingFixture.changed());
  await expect(page.locator(".codex-account-card")).toContainText("Changed while hidden");
  await expect(page.locator(".codex-empty-state")).toHaveCount(0);
  await page.evaluate(() => window.accountLoadingFixture.fail(3));
  await expect(page.getByRole("alert")).toContainText("SQLite account read failed");
  await expect(page.locator(".codex-account-card")).toContainText("Changed while hidden");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.evaluate(() => window.accountLoadingFixture.complete(4, "Retried account"));
  await expect(page.locator(".codex-account-card")).toContainText("Retried account");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an older read cannot overwrite a newer account snapshot or report a stale error", async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    window.accountLoadingFixture.changed();
    window.accountLoadingFixture.complete(2, "Newest account");
  });
  await expect(page.locator(".codex-account-card")).toContainText("Newest account");
  await page.evaluate(() => window.accountLoadingFixture.fail(1));
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".codex-account-card")).toContainText("Newest account");
  await page.evaluate(() => {
    window.accountLoadingFixture.changed();
    window.accountLoadingFixture.changed();
    window.accountLoadingFixture.complete(4, "Latest successful read");
  });
  await expect(page.locator(".codex-account-card")).toContainText("Latest successful read");
  await page.evaluate(() => window.accountLoadingFixture.complete(3, "Stale account"));
  await expect(page.locator(".codex-account-card")).toContainText("Latest successful read");
});
