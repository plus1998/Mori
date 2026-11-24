import { net, session } from "electron";
import { Readable } from "node:stream";
import type { ClaudeSessionKeyNetwork } from "./claude-session-key-oauth";

export async function openClaudeSessionKeyNetwork(id: string, proxyUrl?: string): Promise<ClaudeSessionKeyNetwork> {
  const isolated = session.fromPartition(`mori-claude-session-key-${id}`, { cache: false });
  const proxy = proxyUrl ? new URL(proxyUrl) : undefined;
  const credentials = proxy && (proxy.username || proxy.password)
    ? { username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) }
    : undefined;
  await isolated.setProxy(proxy
    ? { mode: "fixed_servers", proxyRules: `${proxy.protocol}//${proxy.host}` }
    : { mode: "direct" });

  return {
    fetch: async (url, init) => {
      const signal = init.signal;
      const headers = new Headers(init.headers);
      const cookie = headers.get("cookie");
      signal?.throwIfAborted();
      if (cookie) {
        // Chromium drops an explicit Cookie header when replaying proxy authentication.
        await isolated.cookies.set({
          url, name: "sessionKey", value: cookie.slice("sessionKey=".length), path: "/",
          secure: true, httpOnly: true, sameSite: "no_restriction",
        });
        headers.delete("cookie");
      }
      return new Promise<Response>((resolve, reject) => {
        signal?.throwIfAborted();
        const request = net.request({
          url, method: init.method ?? "GET", session: isolated, redirect: "error", useSessionCookies: Boolean(cookie),
        });
        const abort = () => {
          request.abort();
          reject(signal?.reason);
        };
        const cleanup = () => signal?.removeEventListener("abort", abort);
        for (const [name, value] of headers) request.setHeader(name, value);
        let sentProxyCredentials = false;
        request.on("login", (info, callback) => {
          if (!sentProxyCredentials && info.isProxy && proxy && credentials
            && info.host.toLowerCase() === proxy.hostname.toLowerCase()
            && info.port === (Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80))) {
            sentProxyCredentials = true;
            callback(credentials.username, credentials.password);
          } else callback();
        });
        request.on("error", error => {
          cleanup();
          reject(error);
        });
        request.on("response", incoming => {
          const stream = incoming as unknown as Readable;
          stream.once("end", cleanup);
          stream.once("close", cleanup);
          const responseHeaders = new Headers();
          for (const [name, values] of Object.entries(incoming.headers)) {
            for (const value of Array.isArray(values) ? values : [values]) {
              if (value !== undefined) responseHeaders.append(name, value);
            }
          }
          const status = incoming.statusCode;
          const noBody = status === 204 || status === 205 || status === 304;
          if (noBody) stream.resume();
          const body = noBody ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>;
          resolve(new Response(body, { status, headers: responseHeaders }));
        });
        signal?.addEventListener("abort", abort, { once: true });
        request.end(init.body);
      });
    },
    close: async () => {
      await isolated.closeAllConnections();
      await isolated.clearAuthCache();
      await isolated.clearStorageData({ storages: ["cookies"] });
    },
  };
}
