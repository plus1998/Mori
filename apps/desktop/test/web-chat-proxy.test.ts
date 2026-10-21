import { expect, test } from "bun:test";
import { webChatProxyConfig, normalizeWebChatListSnapshot, mergeWebChatList, createCustomWebChatItem, removeCustomWebChatItem } from "../src/shared/web-chat-list";

test("web chat proxy modes and invalid addresses", () => {
  expect(webChatProxyConfig("")).toEqual({ mode: "system" });
  expect(webChatProxyConfig("direct")).toEqual({ mode: "direct" });
  for (const scheme of ["http", "https", "socks4", "socks5"]) {
    expect(webChatProxyConfig(`${scheme}://127.0.0.1:7890`)).toEqual({ mode: "fixed_servers", proxyRules: `${scheme}://127.0.0.1:7890` });
  }
  for (const address of ["bad", "ftp://localhost:12", "http://localhost:12/path"]) {
    expect(() => webChatProxyConfig(address)).toThrow();
  }
});

test("list edits preserve saved proxy", () => {
  const snapshot = normalizeWebChatListSnapshot({ customs: [], proxy: "socks5://localhost:1080" });
  const added = createCustomWebChatItem({ title: "Test", url: "https://example.com" }, snapshot, () => "custom-test");
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error(added.reason);
  expect(added.next.proxy).toBe(snapshot.proxy);
  expect(removeCustomWebChatItem(added.item.id, added.next).proxy).toBe(snapshot.proxy);
  expect(mergeWebChatList(snapshot).proxy).toBe(snapshot.proxy);
});


test("proxy credentials survive special characters and never enter Chromium proxy rules", async () => {
  const { buildWebChatProxy, splitWebChatProxy } = await import("../src/shared/web-chat-list");
  const proxy = buildWebChatProxy("http://localhost:7890", "user@name", "p:a/ss% word");
  expect(splitWebChatProxy(proxy)).toEqual({ address: "http://localhost:7890", username: "user@name", password: "p:a/ss% word" });
  expect(webChatProxyConfig(proxy).proxyRules).toBe("http://localhost:7890");
  expect(() => webChatProxyConfig("socks4://u:p@localhost:1080")).toThrow("SOCKS4");
});

test("HTTP auth matches only proxy challenges at the configured endpoint and clears stale auth", async () => {
  const { WebChatProxyController } = await import("../src/main/web-chat-proxy");
  const calls: string[] = [];
  const controller = new WebChatProxyController({
    closeAllConnections: async () => { calls.push("close"); },
    clearAuthCache: async () => { calls.push("clear"); },
    setProxy: async () => { calls.push("set"); },
  });
  await controller.apply("https://u:p@proxy.example:443");
  expect(calls).toEqual(["close", "clear", "set"]);
  expect(controller.credentials({ isProxy: true, host: "proxy.example", port: 443 })).toEqual(["u", "p"]);
  expect(controller.credentials({ isProxy: false, host: "proxy.example", port: 443 })).toBeUndefined();
  expect(controller.credentials({ isProxy: true, host: "other.example", port: 443 })).toBeUndefined();
  expect(controller.credentials({ isProxy: true, host: "proxy.example", port: 80 })).toBeUndefined();
  await controller.apply("https://u:p@proxy.example:443");
  expect(calls).toHaveLength(3);
  await controller.apply("direct");
  expect(controller.credentials({ isProxy: true, host: "proxy.example", port: 443 })).toBeUndefined();
  controller.dispose();
});


test("legacy shared proxy migrates per site and explicit direct/system values override it", () => {
  const migrated = normalizeWebChatListSnapshot({ customs: [], proxy: "http://u:p@localhost:7890" });
  expect(migrated.siteProxies?.chatgpt).toBe("http://u:p@localhost:7890");
  expect(migrated.siteProxies?.doubao).toBe("http://u:p@localhost:7890");
  const next = normalizeWebChatListSnapshot({ ...migrated, siteProxies: { ...migrated.siteProxies, doubao: "direct", kimi: "" } });
  expect(next.siteProxies?.chatgpt).toBe("http://u:p@localhost:7890");
  expect(next.siteProxies?.doubao).toBe("direct");
  expect(next.siteProxies?.kimi).toBe("");
  const added = createCustomWebChatItem({ title: "Test", url: "https://example.com" }, next, () => "new-site");
  if (!added.ok) throw new Error(added.reason);
  expect(added.next.siteProxies?.["new-site"]).toBeUndefined();
  expect(removeCustomWebChatItem("new-site", added.next).siteProxies?.doubao).toBe("direct");
});

test("site controllers keep proxy routing and credentials independent", async () => {
  const { WebChatProxyController } = await import("../src/main/web-chat-proxy");
  const routes: unknown[][] = [[], []];
  const controllers = routes.map((calls) => new WebChatProxyController({
    closeAllConnections: async () => {}, clearAuthCache: async () => {},
    setProxy: async (config) => { calls.push(config); },
  }));
  const first = controllers[0]!;
  const second = controllers[1]!;
  await first.apply("http://userA:passA@localhost:7890");
  await second.apply("direct");
  expect(routes[0]).toEqual([{ mode: "fixed_servers", proxyRules: "http://localhost:7890" }]);
  expect(routes[1]).toEqual([{ mode: "direct" }]);
  const challenge = { isProxy: true, host: "localhost", port: 7890 };
  expect(first.credentials(challenge)).toEqual(["userA", "passA"]);
  expect(second.credentials(challenge)).toBeUndefined();
  await second.apply("http://userB:passB@localhost:7890");
  expect(second.credentials(challenge)).toEqual(["userB", "passB"]);
  expect(first.credentials(challenge)).toEqual(["userA", "passA"]);
  first.dispose(); second.dispose();
});
