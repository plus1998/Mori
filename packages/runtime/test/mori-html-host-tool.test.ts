import { describe, expect, test } from "bun:test";
import {
  readHtmlHostMetadataFromToolOutput,
  resolveEcoHtmlHostToolCall,
} from "../src/mori-html-host-tool";

describe("mori-html-host-tool", () => {
  test("resolveEcoHtmlHostToolCall matches publish_html", () => {
    const call = resolveEcoHtmlHostToolCall("publish_html", {
      title: "Report",
      html: "<h1>Hi</h1>",
    });
    expect(call?.name).toBe("publish_html");
    expect(call?.title).toBe("Report");
  });

  test("readHtmlHostMetadataFromToolOutput parses success payload", () => {
    const meta = readHtmlHostMetadataFromToolOutput(
      JSON.stringify({
        status: "ok",
        pageId: "abc",
        publicUrl: "https://example.com/functions/v1/html-page-view/slug",
        title: "Report",
        expiresAt: "2030-01-01T00:00:00.000Z",
        canExtend: true,
      }),
    );
    expect(meta?.pageId).toBe("abc");
    expect(meta?.publicUrl).toContain("html-page-view");
    expect(meta?.canExtend).toBe(true);
  });
});
