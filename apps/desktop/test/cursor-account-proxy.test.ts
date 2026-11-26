import { expect, test } from "bun:test";
import { CursorAccountProxy } from "../src/main/cursor-account-proxy";

test("uses only the selected Cursor account route and reuses its SOCKS bridge", async () => {
  const proxy = new CursorAccountProxy();
  const rejectSystemResolution = () => { throw new Error("System route should not be consulted"); };
  try {
    expect(await proxy.env({ mode: "direct" }, rejectSystemResolution)).toMatchObject({
      HTTP_PROXY: "", HTTPS_PROXY: "", https_proxy: "", NO_PROXY: "*",
    });
    expect(await proxy.env({ mode: "system" }, () => "PROXY proxy.example.test:8080")).toMatchObject({
      HTTP_PROXY: "http://proxy.example.test:8080", https_proxy: "http://proxy.example.test:8080",
    });
    const config = { mode: "manual", proxyUrl: "socks5://127.0.0.1:1080" } as const;
    const routes = await Promise.all([
      proxy.env(config, rejectSystemResolution),
      proxy.env(config, rejectSystemResolution),
    ]);
    expect(routes[0]?.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(routes[1]).toEqual(routes[0]);
  } finally {
    proxy.dispose();
  }
});
