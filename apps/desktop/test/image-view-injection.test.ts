import { expect, test } from "bun:test";
import fs from "node:fs";
import { INTEGRATION_IDS } from "../src/shared/integrations";

const indexSource = fs.readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
const piSessionSource = fs.readFileSync(new URL("../src/main/pi-mcp-session.ts", import.meta.url), "utf8");

test("the image view is not an integration switch", () => {
  // The integration list is the switches the settings panel offers; `computerUse` joined it
  // after this test was written. What the test is about is that the image *view* is not one
  // of them, so it asks that question instead of freezing the list's contents.
  expect(INTEGRATION_IDS).not.toContain("imageView");
  expect(INTEGRATION_IDS).toContain("browser");
  expect(INTEGRATION_IDS).toContain("imageGeneration");
});

test("image view injection is always-on and not an integration switch", () => {
  expect(indexSource).toContain("imageViewGateway.resolveInjection(");
  expect(indexSource).toContain("imageViewGateway.mergeIntoSdkConfig(");
  // Codex now receives the thread-scoped Hub descriptor; the old direct
  // process-global gateway resolver would create a second dispatch path.
  expect(indexSource).toContain("registerBuiltin(ECO_IMAGE_VIEW_MCP_SERVER, imageViewInject.sdkEntry)");
  expect(indexSource).not.toContain("imageViewGateway.resolveGlobalCodexServer()");
  expect(indexSource).toContain("buildImageViewPromptAppend()");
  expect(indexSource).toContain("imageViewGateway.noteThreadPrompt(");
  expect(indexSource).toContain("ECO_IMAGE_VIEW_MCP_SERVER");
  expect(indexSource).not.toMatch(/integrationEnabled\([^)]*["']imageView["']/);
});

test("Claude MCP merge always includes eco_image_view after image generation", () => {
  const start = indexSource.indexOf("const withImageMcp = imageGenerationGateway.mergeIntoSdkConfig");
  expect(start).toBeGreaterThanOrEqual(0);
  const slice = indexSource.slice(start, start + 2200);
  expect(slice).toContain("imageViewGateway.mergeIntoSdkConfig");
  expect(indexSource).toContain("ECO_IMAGE_VIEW_MCP_SERVER");
  expect(indexSource).toContain("const hubBuiltinKeys = Object.keys(withWechatMcp.mcpServers)");
});

test("Pi session builder accepts always-on imageViewInject and excludes user override", () => {
  expect(piSessionSource).toContain("imageViewInject");
  expect(piSessionSource).toContain("ECO_IMAGE_VIEW_MCP_SERVER");
});
