import type { AccountBrowserPage } from "./account-browser-page";

export const ACCOUNT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

export async function prepareAccountLoginBrowser(page: AccountBrowserPage): Promise<void> {
  const contents = page.webContents;
  await contents.loadURL("about:blank");
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  await contents.debugger.sendCommand("Emulation.setUserAgentOverride", {
    userAgent: ACCOUNT_BROWSER_USER_AGENT,
    acceptLanguage: "en-US,en",
  });
  await contents.debugger.sendCommand("Emulation.setLocaleOverride", { locale: "en_US" });
  await contents.debugger.sendCommand("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
}
