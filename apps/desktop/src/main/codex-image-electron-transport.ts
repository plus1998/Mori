import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { net, type Session, session } from "electron";
import type { OpenAIAccountDetails } from "../shared/openai-account";
import type { CodexImageConnection } from "./codex-image-service";
import { startSocksToHttpBridge } from "./openai-account-service";

interface NetworkEntry {
  session: Session;
  proxy?: URL;
  closeBridge?: () => void;
}
const networks = new Map<string, Promise<NetworkEntry>>();

/** Chromium TLS + account-scoped cookies and proxies; credentials never leave chatgpt.com. */
export async function connectCodexImageAccount(account: OpenAIAccountDetails): Promise<CodexImageConnection> {
  const auth = account.authJson ? JSON.parse(account.authJson) : {};
  const identity = auth.tokens?.account_id ?? auth.account_id ?? "";
  const key = createHash("sha256")
    .update(`${account.id}\0${identity}\0${account.proxyMode}\0${account.proxyUrl ?? ""}`)
    .digest("hex");
  let network = networks.get(key);
  if (!network) {
    network = (async () => {
      const isolated = session.fromPartition(`eco-codex-images-${key}`, { cache: false });
      const entry: NetworkEntry = { session: isolated };
      if (account.proxyMode === "direct") {
        await isolated.setProxy({ mode: "direct" });
      } else if (account.proxyMode === "manual" && account.proxyUrl) {
        const proxy = new URL(account.proxyUrl);
        if (proxy.protocol.startsWith("socks")) {
          const bridge = await startSocksToHttpBridge(account.proxyUrl);
          entry.closeBridge = bridge.close;
          await isolated.setProxy({
            proxyRules: `http://127.0.0.1:${bridge.port}`,
            proxyBypassRules: "<-loopback>",
          });
        } else if (proxy.protocol === "http:" || proxy.protocol === "https:") {
          entry.proxy = proxy;
          await isolated.setProxy({
            proxyRules: `${proxy.protocol}//${proxy.host}`,
            proxyBypassRules: "<-loopback>",
          });
        } else throw new Error("Codex 生图账号代理协议不受支持。");
      } else if (account.proxyMode === "manual") {
        throw new Error("Codex 生图账号未填写手动代理地址。");
      }
      return entry;
    })();
    networks.set(key, network);
    network.catch(() => networks.delete(key));
  }
  const entry = await network;
  return {
    close: () => {}, // Account-scoped sessions/bridges are reused and closed at app shutdown.
    fetch: (path, init) =>
      new Promise<Response>((resolve, reject) => {
        const remote = path.startsWith("https://") ? new URL(path) : undefined;
        if (
          remote &&
          (!(
            ["chatgpt.com", "files.oaiusercontent.com"].includes(remote.hostname) ||
            remote.hostname.endsWith(".oaiusercontent.com") ||
            remote.hostname.endsWith(".blob.core.windows.net")
          ) ||
            new Headers(init.headers).has("authorization"))
        ) {
          reject(new Error("图片下载地址无效或带有不允许的账号凭证。"));
          return;
        }
        if (!remote && path !== "/" && !path.startsWith("/backend-api/")) {
          reject(new Error("Codex 图片请求路径无效。"));
          return;
        }
        init.signal?.throwIfAborted();
        const request = net.request({
          url: remote ? remote.toString() : `https://chatgpt.com${path}`,
          method: init.method ?? "GET",
          session: entry.session,
          redirect: "error",
        });
        const abort = () => {
          request.abort();
          reject(init.signal?.reason ?? new Error("请求已取消"));
        };
        const cleanup = () => init.signal?.removeEventListener("abort", abort);
        init.signal?.addEventListener("abort", abort, { once: true });
        for (const [name, value] of new Headers(init.headers)) request.setHeader(name, value);
        request.on("login", (info, callback) => {
          if (info.isProxy && entry.proxy)
            callback(decodeURIComponent(entry.proxy.username), decodeURIComponent(entry.proxy.password));
          else callback();
        });
        request.on("error", (error) => {
          cleanup();
          reject(error);
        });
        request.on("response", (incoming) => {
          incoming.on("end", cleanup);
          incoming.on("error", cleanup);
          const responseHeaders = new Headers();
          for (const [name, values] of Object.entries(incoming.headers)) {
            for (const value of Array.isArray(values) ? values : [values])
              if (value !== undefined) responseHeaders.append(name, value);
          }
          const body = Readable.toWeb(incoming as unknown as Readable) as ReadableStream<Uint8Array>;
          resolve(
            new Response(body, {
              status: incoming.statusCode,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            }),
          );
        });
        if (init.body !== undefined && init.body !== null) {
          if (typeof init.body !== "string" && !(init.body instanceof Uint8Array)) {
            request.abort();
            cleanup();
            reject(new Error("图片请求体必须为 JSON 或图片二进制。"));
            return;
          }
          request.write(typeof init.body === "string" ? init.body : Buffer.from(init.body));
        }
        request.end();
      }),
  };
}

export async function disposeCodexImageConnections(): Promise<void> {
  const entries = await Promise.allSettled(networks.values());
  networks.clear();
  for (const entry of entries)
    if (entry.status === "fulfilled") {
      entry.value.closeBridge?.();
      await entry.value.session.closeAllConnections();
    }
}
