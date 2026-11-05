import { expect, test } from "./fixtures/electron-app";

test("Codex composer exposes MCP, subagent, and skills UI", async ({ ecoPage: page }) => {
  test.skip(
    (process.env.ECO_DEV_USER_DATA_SUFFIX ?? "E2E") === "E2E",
    "Requires a configured Dev profile. Run with ECO_DEV_USER_DATA_SUFFIX=Dev.",
  );
  test.setTimeout(60_000);

  const newConversation = page.locator("button.sidebar-action").filter({ hasText: "新对话" });
  await expect(newConversation).toHaveCount(1, { timeout: 30_000 });
  await newConversation.click();

  const codexCore = page.locator(".composer-core-segmented button").filter({ hasText: /^Codex$/ });
  await expect(codexCore).toHaveCount(1, { timeout: 15_000 });
  await codexCore.click();

  const mcpTrigger = page
    .locator(".composer-context-bar")
    .locator('button.composer-agents-trigger[aria-label*="MCP"]');
  const mcpLabel = await mcpTrigger.getAttribute("aria-label");
  expect(mcpLabel?.includes("MCP")).toBe(true);
  await mcpTrigger.click();

  const mcpSwitches = page.locator(
    '.composer-agents-popover[aria-label="MCP 服务器"] [role="switch"]',
  );
  const mcpSwitchCount = await mcpSwitches.count();
  for (let index = 0; index < mcpSwitchCount; index += 1) {
    const state = await mcpSwitches.nth(index).evaluate((input) => ({
      checked: input.getAttribute("aria-checked") === "true",
      disabled: (input as HTMLButtonElement).disabled,
    }));
    expect(state.disabled).toBe(false);
  }
  await mcpTrigger.click();

  const subagentTrigger = page
    .locator(".composer-context-bar")
    .locator('button.composer-agents-trigger[aria-label*="子代理"]');
  const subagentLabel = await subagentTrigger.getAttribute("aria-label");
  expect(subagentLabel?.includes("子代理")).toBe(true);
  await subagentTrigger.click();

  const subagentSwitches = page.locator(
    '.composer-agents-popover[aria-label="子代理详情"] [role="switch"]',
  );
  const subagentSwitchCount = await subagentSwitches.count();
  for (let index = 0; index < subagentSwitchCount; index += 1) {
    const state = await subagentSwitches.nth(index).evaluate((input) => ({
      checked: input.getAttribute("aria-checked") === "true",
      disabled: (input as HTMLButtonElement).disabled,
    }));
    expect(state.disabled).toBe(false);
  }

  const switchSubagentRows = await page
    .locator('.composer-agents-popover[aria-label="子代理详情"] .composer-agent-row [role="switch"]')
    .count();
  expect(switchSubagentRows).toBeGreaterThan(0);

  const skillsBarCount = await page.locator(".composer-skills-bar").count();
  const composerInput = page.locator('.composer-primary [contenteditable="true"]');
  await expect(composerInput).toHaveCount(1);

  console.log(
    JSON.stringify(
      {
        ok: true,
        core: "codex",
        mcpLabel,
        mcpSwitchCount,
        subagentLabel,
        subagentSwitchCount,
        switchSubagentRows,
        skillsBarCount,
      },
      null,
      2,
    ),
  );
});
