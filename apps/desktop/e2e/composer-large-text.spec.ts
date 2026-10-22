import { readFileSync } from "node:fs";
import { expect, type Locator, test } from "@playwright/test";

async function paste(editor: Locator, text: string): Promise<void> {
  await editor.focus();
  await editor.evaluate((node, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
}

async function select(editor: Locator, start: number, end: number): Promise<void> {
  await editor.evaluate(
    async (node, offsets) => {
      const path = "/src/renderer/composer-skills-editable.ts";
      const { setSelectionOffsets } = await import(/* @vite-ignore */ path);
      setSelectionOffsets(node, offsets.start, offsets.end);
    },
    { start, end },
  );
}

test.beforeEach(async ({ page }) => {
  const rendererUrl =
    process.env.ECO_COMPOSER_TEST_URL ??
    JSON.parse(readFileSync(new URL("../.e2e-env.json", import.meta.url), "utf8")).rendererUrl;
  await page.goto(new URL("/e2e/fixtures/composer-height.html", rendererUrl).href);
  await page.getByRole("textbox").fill("");
});

test("large reference drafts delete promptly without retaining thousands of native undo nodes", async ({
  page,
}) => {
  const editor = page.getByRole("textbox");
  const value = page.getByTestId("draft-value");
  const text = "hello $pdf @file{/tmp/a.ts} log line\n".repeat(5000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const before = await cdp.send("Memory.getDOMCounters");
  for (const key of ["Backspace", "Delete", "Backspace"]) {
    await paste(editor, text);
    expect(await value.evaluate((node) => node.textContent?.length)).toBe(text.length);
    expect(await editor.locator("[data-file-path]").count()).toBe(5000);
    await editor.press("ControlOrMeta+a");
    const started = Date.now();
    await editor.press(key);
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(value).toHaveText("");
    await editor.press("ControlOrMeta+z");
    expect(await value.evaluate((node) => node.textContent?.length)).toBe(text.length);
    await editor.press("ControlOrMeta+Shift+z");
    await expect(value).toHaveText("");
  }
  await cdp.send("HeapProfiler.collectGarbage");
  const after = await cdp.send("Memory.getDOMCounters");
  expect(after.nodes - before.nodes).toBeLessThan(1000);
});

test("large plain multiline paste preserves blank lines and supports partial reverse selection deletion", async ({
  page,
}) => {
  const editor = page.getByRole("textbox");
  const value = page.getByTestId("draft-value");
  const text = "中文日志 abcdefghijklmnopqrstuvwxyz 0123456789\n\n".repeat(10_000);
  const started = Date.now();
  await paste(editor, text);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await value.evaluate((node, expected) => node.textContent === expected, text)).toBe(true);
  const start = 37;
  const end = text.length - 29;
  await select(editor, end, start);
  await editor.press("Backspace");
  await expect(value).toHaveText(text.slice(0, start) + text.slice(end));
  await editor.press("ControlOrMeta+z");
  expect(await value.evaluate((node, expected) => node.textContent === expected, text)).toBe(true);
  const selection = await editor.evaluate(async (node) => {
    const path = "/src/renderer/composer-skills-editable.ts";
    return (await import(/* @vite-ignore */ path)).getSelectionOffsets(node);
  });
  expect(selection).toEqual({ start: end, end: start });
});

test("typing and paste over a large selection and cut share undo/redo with subsequent typing", async ({
  page,
}) => {
  const editor = page.getByRole("textbox");
  const value = page.getByTestId("draft-value");
  const text = "hello $pdf @file{/tmp/a.ts}\n".repeat(1000);
  await paste(editor, text);
  await editor.press("ControlOrMeta+a");
  await editor.press("x");
  await expect(value).toHaveText("x");
  await editor.pressSequentially("yz");
  await expect(value).toHaveText("xyz");
  await editor.press("ControlOrMeta+z");
  await expect(value).toHaveText("x");
  await editor.press("ControlOrMeta+z");
  expect(await value.evaluate((node, expected) => node.textContent === expected, text)).toBe(true);
  await paste(editor, "replacement");
  await expect(value).toHaveText("replacement");
  await editor.press("ControlOrMeta+a");
  await editor.evaluate((node) =>
    node.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteByCut",
      }),
    ),
  );
  await expect(value).toHaveText("");
  await editor.press("ControlOrMeta+z");
  await expect(value).toHaveText("replacement");
  await page.getByRole("button", { name: "Reset draft" }).click();
  await editor.focus();
  await editor.press("ControlOrMeta+z");
  await expect(value).toContainText("Line 1: editable draft");
});

test("file chips inside large draft lines still select on first Backspace and delete on second", async ({
  page,
}) => {
  const editor = page.getByRole("textbox");
  const value = page.getByTestId("draft-value");
  const prefix = "log line\n".repeat(3000);
  const token = "@file{/tmp/a.ts}";
  const text = `${prefix}${token} `;
  await paste(editor, text);
  await select(editor, text.length, text.length);
  await editor.press("Backspace");
  expect(await value.evaluate((node) => node.textContent?.length)).toBe(text.length);
  await editor.press("Backspace");
  expect(await value.evaluate((node, expected) => node.textContent === expected, prefix)).toBe(true);
  await editor.press("ControlOrMeta+z");
  expect(await editor.locator("[data-file-path]").count()).toBe(1);
});

test("line boundaries remain editable, including blank lines and a single pasted newline", async ({
  page,
}) => {
  const editor = page.getByRole("textbox");
  const value = page.getByTestId("draft-value");
  await paste(editor, "\n");
  expect(await value.evaluate((node) => node.textContent)).toBe("\n");
  await editor.press("ControlOrMeta+a");
  const text = `${"log line\n".repeat(3000)}\nend\n`;
  await paste(editor, text);
  await select(editor, text.length - 4, text.length - 4);
  await editor.press("x");
  const changed = `${text.slice(0, -4)}x${text.slice(-4)}`;
  expect(await value.evaluate((node, expected) => node.textContent === expected, changed)).toBe(true);
  await editor.press("Enter");
  const withLine = `${text.slice(0, -4)}x\n${text.slice(-4)}`;
  expect(await value.evaluate((node, expected) => node.textContent === expected, withLine)).toBe(true);
  await editor.press("Backspace");
  expect(await value.evaluate((node, expected) => node.textContent === expected, changed)).toBe(true);
});

test("a huge paragraph preserves copy text and Unicode while editing across layout fragments", async ({
  page,
}) => {
  const editor = page.getByRole("textbox");
  const value = page.getByTestId("draft-value");
  const emoji = "👩🏽‍💻";
  const text = `${"a".repeat(2047)}${emoji}${"b".repeat(2046)}e\u0301${"长段落 text ".repeat(80_000)}`;
  const started = Date.now();
  await paste(editor, text);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await value.evaluate((node, expected) => node.textContent === expected, text)).toBe(true);
  await editor.press("ControlOrMeta+a");
  expect(await editor.evaluate((_, expected) => window.getSelection()?.toString() === expected, text)).toBe(
    true,
  );
  expect(
    await editor.evaluate(
      (node, glyph) => [...node.children].some((child) => child.textContent?.includes(glyph)),
      emoji,
    ),
  ).toBe(true);

  // Start of the second layout fragment, immediately after the first 2047 chars.
  await editor.evaluate((node) => {
    const selection = window.getSelection();
    const target = node.children[1]?.firstChild;
    if (!selection || !target) throw new Error("Expected a second editable text fragment");
    selection.setBaseAndExtent(target, 0, target, 0);
  });
  await editor.press("Backspace");
  expect(await value.evaluate((node, expected) => node.textContent === expected, text.slice(1))).toBe(true);
  await editor.press("ControlOrMeta+z");
  await select(editor, 2047, 2047);
  await editor.press("Delete");
  const withoutEmoji = text.slice(0, 2047) + text.slice(2047 + emoji.length);
  expect(await value.evaluate((node, expected) => node.textContent === expected, withoutEmoji)).toBe(true);
  await editor.press("ControlOrMeta+z");
  await select(editor, 2047, 2047);
  await editor.press("x");
  const typed = `${text.slice(0, 2047)}x${text.slice(2047)}`;
  expect(await value.evaluate((node, expected) => node.textContent === expected, typed)).toBe(true);
  await editor.press("Enter");
  const withLine = `${text.slice(0, 2047)}x\n${text.slice(2047)}`;
  expect(await value.evaluate((node, expected) => node.textContent === expected, withLine)).toBe(true);
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
  await expect(value).toHaveText("");
});
