import { expect, test } from "bun:test";
import {
  ECO_IMAGE_DISPLAY_FULL_TOOL,
  ECO_IMAGE_DISPLAY_MCP_SERVER,
  ECO_IMAGE_DISPLAY_TOOL,
  isEcoImageDisplayToolName,
  isAgentBrowserScreenshotToolName,
  readAbsolutePathFromMcpToolOutput,
  readImageDisplayArtifactFromToolOutput,
  readImageDisplayMetadataFromToolOutput,
  resolveEcoImageDisplayToolCall,
} from "../src/eco-image-display-tool";

test("recognizes Eco image display MCP names", () => {
  expect(isEcoImageDisplayToolName(ECO_IMAGE_DISPLAY_FULL_TOOL)).toBe(true);
  expect(isEcoImageDisplayToolName(`mcp__${ECO_IMAGE_DISPLAY_MCP_SERVER}__${ECO_IMAGE_DISPLAY_TOOL}`)).toBe(
    true,
  );
  expect(isEcoImageDisplayToolName("mcp__eco_image_view__view_image")).toBe(false);
  expect(isEcoImageDisplayToolName("display_image")).toBe(true);
});

test("readImageDisplayArtifactFromToolOutput parses artifactId JSON", () => {
  expect(
    readImageDisplayArtifactFromToolOutput({
      aggregatedOutput: JSON.stringify({ status: "ok", artifactId: "art-123" }),
    }),
  ).toBe("art-123");
});

test("readImageDisplayMetadataFromToolOutput parses artifactId and title", () => {
  expect(
    readImageDisplayMetadataFromToolOutput({
      aggregatedOutput: JSON.stringify({
        status: "ok",
        artifactId: "art-456",
        title: "封面",
      }),
    }),
  ).toEqual({ artifactId: "art-456", title: "封面" });
});

test("readImageDisplayMetadataFromToolOutput accepts raw JSON string (PI/SDK path)", () => {
  expect(
    readImageDisplayMetadataFromToolOutput(
      JSON.stringify({
        status: "ok",
        artifactId: "a8d81de1-fba7-4590-a3ad-3f41cad35b6d",
        mimeType: "image/png",
        bytes: 1652581,
      }),
    ),
  ).toEqual({ artifactId: "a8d81de1-fba7-4590-a3ad-3f41cad35b6d" });
});

test("readAbsolutePathFromMcpToolOutput extracts screenshot path", () => {
  expect(
    readAbsolutePathFromMcpToolOutput({
      aggregatedOutput: "C:\\Users\\admin\\AppData\\Local\\Temp\\eco-browser-screenshot-1.png",
    }),
  ).toBe("C:\\Users\\admin\\AppData\\Local\\Temp\\eco-browser-screenshot-1.png");
});

test("isAgentBrowserScreenshotToolName matches browser screenshot tools", () => {
  expect(isAgentBrowserScreenshotToolName("mcp__eco_agent_browser__agent_browser_screenshot")).toBe(true);
  expect(isAgentBrowserScreenshotToolName("agent_browser_screenshot")).toBe(true);
  expect(isAgentBrowserScreenshotToolName("mcp__eco_image_display__display_image")).toBe(false);
});

test("resolveEcoImageDisplayToolCall unwraps PI mcp proxy display_image calls", () => {
  expect(
    resolveEcoImageDisplayToolCall("mcp", {
      tool: "display_image",
      server: "eco_image_display",
      args: { source: "url", url: "https://example.com/a.png" },
    }),
  ).toEqual({
    name: "mcp__eco_image_display__display_image",
    source: "url",
  });
  expect(
    resolveEcoImageDisplayToolCall("mcp", {
      tool: "show_media_to_user",
      server: "eco_image_display",
      args: { source: "path", path: "/tmp/clip.mp4" },
    }),
  ).toEqual({ name: ECO_IMAGE_DISPLAY_FULL_TOOL, source: "path" });
  expect(isEcoImageDisplayToolName("show_media_to_user")).toBe(true);
});
