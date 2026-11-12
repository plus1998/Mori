import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withIsolatedCodexAccountClient } from "../src/main/codex-account-quota";
import { startCodexBrowserLogin } from "../src/main/codex-browser-login";
import { buildCodexProxyEnv } from "../src/main/codex-proxy";
import {
  CodexRuntimeLifecycle,
  setCodexAccountProxyConfigGetter,
  setCodexSystemProxyResolver,
} from "../src/main/codex-runtime-lifecycle";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  setCodexAccountProxyConfigGetter(undefined);
  setCodexSystemProxyResolver(undefined);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mori-proxy-spawn-"));
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  const executable = path.join(home, "fake-codex");
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const msg=JSON.parse(line);
  if(msg.id === undefined)return;
  const keys=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','WS_PROXY','WSS_PROXY','http_proxy','https_proxy','all_proxy','ws_proxy','wss_proxy','NO_PROXY','no_proxy'];
  const probe={args:process.argv.slice(2),env:Object.fromEntries(keys.map(key=>[key,process.env[key]]))};
  const result=msg.method==='test/proxy'?probe:msg.method==='account/login/start'?{type:'chatgpt',loginId:'proxy-test',authUrl:'https://auth.openai.com/oauth/authorize?probe='+encodeURIComponent(JSON.stringify(probe))}:{};
  process.stdout.write(JSON.stringify({id:msg.id,result})+'\\n');
});`,
    { mode: 0o755 },
  );
  return { home, executable };
}

interface Probe {
  args: string[];
  env: NodeJS.ProcessEnv;
}
function checkRoute(probe: Probe, url?: string) {
  expect(probe.args).toContain("features.respect_system_proxy=false");
  expect(probe.args).toContain("features.system_proxy_fallback=false");
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "WS_PROXY",
    "WSS_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "ws_proxy",
    "wss_proxy",
  ]) {
    expect(probe.env[key]).toBe(url);
  }
  expect(probe.env.NO_PROXY).toBe(url ? "127.0.0.1,localhost,::1" : "*");
  expect(probe.env.no_proxy).toBe(probe.env.NO_PROXY);
}

test("explicit routes discard wildcard and ChatGPT bypasses inherited from the shell", () => {
  const source = { NO_PROXY: "*,chatgpt.com", no_proxy: ".openai.com", WS_PROXY: "http://ambient:7890" };
  const env = buildCodexProxyEnv(source, { mode: "proxy", url: "http://chosen:8080" });
  expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
  expect(env.WS_PROXY).toBe("http://chosen:8080");
  expect(source.NO_PROXY).toBe("*,chatgpt.com");
  expect(buildCodexProxyEnv(source, { mode: "direct" }).WS_PROXY).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "conversation, account and login processes receive the same strict route and config overrides",
  async () => {
    const { home, executable } = await fixture();
    for (const url of ["http://127.0.0.1:62666", undefined]) {
      setCodexAccountProxyConfigGetter(() => (url ? { mode: "manual", proxyUrl: url } : { mode: "direct" }));
      const lifecycle = new CodexRuntimeLifecycle({
        ecoDataDir: home,
        accountId: "test-account",
        codexExecutable: executable,
      });
      try {
        const client = await lifecycle.start();
        checkRoute(await client.request<Probe>("test/proxy"), url);
        const probe = await withIsolatedCodexAccountClient(
          { executable, codexHomeDir: home, proxy: url ? { mode: "proxy", url } : { mode: "direct" } },
          (accountClient) => accountClient.request<Probe>("test/proxy"),
        );
        checkRoute(probe, url);
        const login = await startCodexBrowserLogin({
          executable,
          codexHomeDir: home,
          proxy: url ? { mode: "proxy", url } : { mode: "direct" },
          env: { HTTP_PROXY: "http://ambient:7890", WSS_PROXY: "http://ambient:7890", NO_PROXY: "*" },
          onAuthenticated: async () => {},
        });
        try {
          checkRoute(JSON.parse(new URL(login.authUrl).searchParams.get("probe") ?? "null"), url);
        } finally {
          login.cancel();
          await login.result;
        }
      } finally {
        await lifecycle.stop();
      }
    }
  },
);

test.skipIf(process.platform === "win32")(
  "stopping during async proxy resolution prevents a late Codex spawn",
  async () => {
    const { home, executable } = await fixture();
    let resolveProxy: ((value: string) => void) | undefined;
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    setCodexSystemProxyResolver(
      () =>
        new Promise<string>((resolve) => {
          resolveProxy = resolve;
          entered?.();
        }),
    );
    const lifecycle = new CodexRuntimeLifecycle({ ecoDataDir: home, codexExecutable: executable });
    const start = lifecycle.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    await ready;
    const stop = lifecycle.stop();
    resolveProxy?.("SOCKS5 127.0.0.1:1080");
    expect(String(await start)).toContain("cancelled before process spawn");
    await stop;
    expect(lifecycle.isRunning()).toBe(false);
    expect(lifecycle.getProcessId()).toBeUndefined();
  },
);
