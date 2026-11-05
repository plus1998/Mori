import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { composerReferenceToken } from "../src/shared/composer-references";

const first = composerReferenceToken({
  kind: "web",
  id: "browser-1",
  label: "第一个网页",
  detail: "https://example.com/",
});
const second = composerReferenceToken({
  kind: "web",
  id: "browser-2",
  label: "第二个网页",
  detail: "https://example.org/",
});

test.beforeEach(async ({ page }) => {
  const rendererUrl =
    process.env.ECO_COMPOSER_TEST_URL ??
    JSON.parse(readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8")).rendererUrl;
  await page.goto(new URL("/e2e/fixtures/composer-references.html", rendererUrl).href);
});

test("consecutive web mentions render both chips and preserve their tokens in the draft", async ({
  page,
}) => {
  const editor = page.getByRole("textbox");
  await editor.fill("@网页");
  await page.getByRole("option", { name: /第一个网页/ }).click();
  await editor.pressSequentially("@网页");
  await page.getByRole("option", { name: /第二个网页/ }).click();
  await expect(editor.locator("[data-reference-token]")).toHaveCount(2);
  await expect(editor).not.toContainText("@web{");
  await expect(page.getByTestId("draft-value")).toHaveText(`${first} ${second} `);
  await expect(page.getByTestId("message-preview").locator(".composer-reference-display")).toHaveCount(2);
  await expect(page.getByTestId("message-preview")).not.toContainText("@web{");
  await editor.pressSequentially("继续检查");
  await expect(page.getByTestId("draft-value")).toHaveText(`${first} ${second} 继续检查`);
});

test("controlled updates upgrade a second raw reference even when the first chip already exists", async ({
  page,
}) => {
  const editor = page.getByRole("textbox");
  await editor.fill(`${first} `);
  await expect(editor.locator("[data-reference-token]")).toHaveCount(1);
  // The serialized DOM can already match the incoming controlled value while
  // containing a mixture of rendered chips and raw reference text.
  await editor.evaluate((node, token) => node.append(document.createTextNode(`${token} `)), second);
  await page.getByRole("button", { name: "Append second reference" }).click();
  await expect(page.getByTestId("draft-value")).toHaveText(`${first} ${second} `);
  await expect(editor.locator("[data-reference-token]")).toHaveCount(2);
  await expect(editor).not.toContainText("@web{");
});
