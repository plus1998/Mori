import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCodexAppServerEnv,
  CodexRuntimeLifecycle,
  parseElectronProxyResolution,
  resolveCodexProxyUrl,
  setCodexAccountProxyConfigGetter,
  setCodexExternalAuthProvider,
} from "../src/main/codex-runtime-lifecycle";

describe("Codex app-server environment", () => {
  test("task runtime receives external access tokens and delegates refresh to the bound account", async () => {
    const ecoDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-runtime-auth-"));
    const executable = path.join(ecoDataDir, "fake-codex");
    await fs.writeFile(executable, `#!/usr/bin/env node
const readline=require('node:readline');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let pending;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 if(!msg.method){send({id:pending,result:msg.result});return;}
 if(msg.method==='initialized')return;
 if(msg.method==='test/refresh'){pending=msg.id;send({id:'refresh',method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:'chatgpt-a'}});return;}
 if(msg.method==='account/login/start' && (msg.params.type!=='chatgptAuthTokens'||Object.keys(msg.params).some(key=>key.includes('refresh')))){send({id:msg.id,error:{code:-1,message:'invalid credentials'}});return;}
 send({id:msg.id,result:{}});
});`, { mode: 0o755 });
    const requests: Array<{ accountId?: string; previous?: string }> = [];
    setCodexExternalAuthProvider(async (accountId, previous) => {
      requests.push({ ...(accountId ? { accountId } : {}), ...(previous ? { previous } : {}) });
      return { accountId: "a", accessToken: previous ? "new-access" : "old-access", chatgptAccountId: "chatgpt-a" };
    });
    setCodexAccountProxyConfigGetter(() => ({ mode: "direct" }));
    const lifecycle = new CodexRuntimeLifecycle({ ecoDataDir, codexExecutable: executable });
    try {
      const client = await lifecycle.start();
      expect(await client.request("test/refresh")).toEqual({ accessToken: "new-access", chatgptAccountId: "chatgpt-a" });
      expect(requests).toEqual([{}, { accountId: "a", previous: "old-access" }]);
    } finally {
      await lifecycle.stop();
      setCodexExternalAuthProvider(undefined);
      setCodexAccountProxyConfigGetter(undefined);
      await fs.rm(ecoDataDir, { recursive: true, force: true });
    }
  });
  test("bypasses proxies for the local Eco gateway", () => {
    const env = buildCodexAppServerEnv(
      {
        HTTP_PROXY: "http://proxy.example.test:8080",
        HTTPS_PROXY: "http://proxy.example.test:8080",
      },
      "C:\\eco\\codex",
    );

    expect(env.CODEX_HOME).toBe("C:\\eco\\codex");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(env.HTTP_PROXY).toBe("http://proxy.example.test:8080");
  });

  test("direct mode removes inherited proxy variables", () => {
    const env = buildCodexAppServerEnv(
      {
        HTTP_PROXY: "http://proxy.example.test:8080",
        HTTPS_PROXY: "http://proxy.example.test:8080",
        ALL_PROXY: "socks5://proxy.example.test:1080",
        http_proxy: "http://proxy.example.test:8080",
        https_proxy: "http://proxy.example.test:8080",
        all_proxy: "socks5://proxy.example.test:1080",
      },
      "/tmp/eco/codex",
      { mode: "direct" },
    );

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.all_proxy).toBeUndefined();
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
  });

  test("proxy mode injects only the resolved proxy endpoint", () => {
    const env = buildCodexAppServerEnv(
      {
        ALL_PROXY: "socks5://ambient.example.test:1080",
        NO_PROXY: "internal.example.test",
      },
      "/tmp/eco/codex",
      { mode: "proxy", url: "http://127.0.0.1:7890" },
    );

    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBe("internal.example.test,127.0.0.1,localhost,::1");
  });

  test("preserves and deduplicates existing proxy bypass entries", () => {
    const env = buildCodexAppServerEnv(
      {
        NO_PROXY: "internal.example.test,LOCALHOST",
        no_proxy: "metadata.google.internal,127.0.0.1",
      },
      "/tmp/eco/codex",
    );

    expect(env.NO_PROXY).toBe("internal.example.test,LOCALHOST,metadata.google.internal,127.0.0.1,::1");
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  test("parses Chromium system proxy results and honors direct resolution", () => {
    expect(parseElectronProxyResolution("PROXY 127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(parseElectronProxyResolution("SOCKS5 127.0.0.1:7890")).toBe("socks5://127.0.0.1:7890");
    expect(parseElectronProxyResolution("PROXY proxy.example.test:8080; DIRECT")).toBe(
      "http://proxy.example.test:8080",
    );
    expect(parseElectronProxyResolution("DIRECT")).toBeUndefined();
    expect(parseElectronProxyResolution("QUIC proxy.example.test:443")).toBeUndefined();
  });

  test("system mode uses the OS resolver while manual mode takes precedence", async () => {
    await expect(resolveCodexProxyUrl(
      { mode: "system" },
      () => Promise.resolve("PROXY 127.0.0.1:7890"),
    )).resolves.toBe("http://127.0.0.1:7890");
    await expect(resolveCodexProxyUrl(
      { mode: "manual", proxyUrl: "http://manual.example.test:8080" },
      () => Promise.resolve("PROXY 127.0.0.1:7890"),
    )).resolves.toBe("http://manual.example.test:8080");
    await expect(resolveCodexProxyUrl({ mode: "direct" }, () => {
      throw new Error("system proxy must not be queried in direct mode");
    })).resolves.toBeUndefined();
  });

  test("fails closed when the configured account proxy is invalid", async () => {
    const ecoDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-proxy-"));
    setCodexAccountProxyConfigGetter(() => ({
      mode: "manual",
      proxyUrl: "ftp://user:secret@proxy.example.test:21",
    }));
    try {
      const lifecycle = new CodexRuntimeLifecycle({ ecoDataDir, codexExecutable: "unused" });
      await expect(lifecycle.start()).rejects.toThrow(
        "Configured OpenAI account proxy could not be initialized",
      );
    } finally {
      setCodexAccountProxyConfigGetter(undefined);
      await fs.rm(ecoDataDir, { recursive: true, force: true });
    }
  });
});
