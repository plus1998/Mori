import { afterEach, expect, test } from "bun:test";
import { BROWSER_LINK_OPEN_EVENT, openPublishedHtmlInBrowser } from "../src/renderer/browser-link";

const publicUrl = "https://center.example.com/functions/v1/html-page-view/slug";
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const events: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  events.length = 0;
});

function mockResponse(response: Response | Error) {
  globalThis.window = {
    dispatchEvent(event: CustomEvent<string>) {
      expect(event.type).toBe(BROWSER_LINK_OPEN_EVENT);
      events.push(event.detail);
      return true;
    },
  } as unknown as Window & typeof globalThis;
  globalThis.fetch = (async () => {
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
}

test("self-hosted text/html opens the actual public URL", async () => {
  mockResponse(new Response("<!doctype html><html>Report</html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  }));
  await openPublishedHtmlInBrowser(publicUrl);
  expect(events).toEqual([publicUrl]);
});

test("Cloud text/plain HTML still opens a rendered preview", async () => {
  const html = "<!doctype html><html>Report</html>";
  mockResponse(new Response(html, { headers: { "content-type": "text/plain" } }));
  await openPublishedHtmlInBrowser(publicUrl);
  expect(events).toEqual([`data:text/html;charset=utf-8,${encodeURIComponent(html)}`]);
});

test("HTTP errors and non-HTML text remain at their public URL", async () => {
  for (const response of [
    new Response("<!doctype html><html>Expired</html>", { status: 410, headers: { "content-type": "text/plain" } }),
    new Response("upstream error", { headers: { "content-type": "text/plain" } }),
  ]) {
    mockResponse(response);
    await openPublishedHtmlInBrowser(publicUrl);
  }
  expect(events).toEqual([publicUrl, publicUrl]);
});

test("a failed renderer fetch still navigates so the browser can show the response", async () => {
  mockResponse(new Error("Network error"));
  await openPublishedHtmlInBrowser(publicUrl);
  expect(events).toEqual([publicUrl]);
});
