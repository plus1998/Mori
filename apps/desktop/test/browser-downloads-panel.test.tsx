import { expect, test } from "bun:test";
import { createElement } from "react";
import { BrowserDownloadsPanel } from "../src/renderer/BrowserDownloadsPanel";
import type { BrowserDownload, BrowserDownloadState } from "../src/shared/browser-downloads";
import { renderLocalized } from "./i18n-test";

function file(state: BrowserDownloadState, name = "报告.pdf"): BrowserDownload {
  return { id: state, browserId: "tab", name, state, mimeType: "application/pdf", url: "https://test.invalid/report.pdf",
    receivedBytes: 1024, totalBytes: 2048, createdAt: 1 };
}

test("finished downloads expose delete while completed files retain save and reveal actions", () => {
  for (const state of ["completed", "failed", "cancelled"] as const) {
    const markup = renderLocalized(createElement(BrowserDownloadsPanel, { browserId: "tab", files: [file(state)] }), "zh-CN");
    expect(markup).toContain('aria-label="删除下载 报告.pdf"');
    expect(markup.includes('aria-label="另存为 报告.pdf"')).toBe(state === "completed");
    expect(markup.includes('aria-label="在文件夹中显示 报告.pdf"')).toBe(state === "completed");
    expect(markup).not.toContain('aria-label="取消下载 报告.pdf"');
  }
});

test("active downloads show progress and cancellation before deletion becomes available", () => {
  const markup = renderLocalized(createElement(BrowserDownloadsPanel, { browserId: "tab", files: [file("pending")] }), "zh-CN");
  expect(markup).toContain('aria-label="取消下载 报告.pdf"');
  expect(markup).toContain('aria-label="报告.pdf 下载进度"');
  expect(markup).toContain("50%");
  expect(markup).toContain("1.0 KB / 2.0 KB");
  expect(markup).not.toContain('aria-label="删除下载 报告.pdf"');
});

test("empty downloads explain where files appear without offering file actions", () => {
  const markup = renderLocalized(createElement(BrowserDownloadsPanel, { browserId: "tab", files: [] }), "en-US");
  expect(markup).toContain("No downloads yet");
  expect(markup).toContain("Files you download from the web will appear here");
  expect(markup).not.toContain("<button");
});
