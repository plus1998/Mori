import http from "node:http";
import type { Socket } from "node:net";
import { SocksClient } from "socks";
import { SocksProxyAgent } from "socks-proxy-agent";
import { webChatProxyConfig } from "../shared/web-chat-list";

/** Chromium does not implement SOCKS5 password auth. Keep that hop in Node. */
export async function startWebChatSocksBridge(proxy: string): Promise<{ port: number; close(): void }> {
  const url = new URL(proxy);
  const agent = new SocksProxyAgent(proxy, { timeout: 15_000 });
  const sockets = new Set<Socket>();
  let closed = false;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const server = http.createServer((request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
      if (target.protocol !== "http:") throw new Error("Invalid proxy request");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...request.headers, host: target.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request(target, { method: request.method, headers, agent }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
      incoming.on("error", () => response.destroy());
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    });
    response.on("close", () => upstream.destroy());
    request.on("error", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connection", track);
  server.on("connect", (request, client, head) => {
    let target: URL;
    try {
      target = new URL(`http://${request.url}`);
      if (!target.hostname || target.username || target.password) throw new Error("Invalid CONNECT");
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    void SocksClient.createConnection({
      command: "connect",
      proxy: { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || 1080, type: 5,
        userId: decodeURIComponent(url.username), password: decodeURIComponent(url.password) },
      destination: { host: target.hostname.replace(/^\[|\]$/g, ""), port: Number(target.port) || 80 },
      timeout: 15_000,
    }).then(({ socket }) => {
      if (closed || client.destroyed) { socket.destroy(); return; }
      track(socket);
      client.once("close", () => socket.destroy());
      socket.once("close", () => client.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.write(head);
      client.pipe(socket).pipe(client);
    }).catch(() => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法启动网页 AI 代理转接");
  return { port: address.port, close() {
    closed = true;
    server.close();
    agent.destroy();
    for (const socket of sockets) socket.destroy();
  } };
}

interface ProxySession {
  setProxy(config: ReturnType<typeof webChatProxyConfig>): Promise<void>;
  clearAuthCache(): Promise<void>;
  closeAllConnections(): Promise<void>;
}

export class WebChatProxyController {
  private current: string | undefined;
  private initialized = false;
  private bridge: { close(): void } | undefined;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly session: ProxySession) {}

  apply(proxy?: string): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.initialized && proxy === this.current) return;
      let config = webChatProxyConfig(proxy);
      const parsed = proxy && proxy !== "direct" ? new URL(proxy) : undefined;
      const bridge = parsed?.protocol === "socks5:" && (parsed.username || parsed.password)
        ? await startWebChatSocksBridge(proxy!) : undefined;
      if (bridge) config = { mode: "fixed_servers", proxyRules: `http://127.0.0.1:${bridge.port}` };
      const previous = this.current;
      this.current = proxy;
      try {
        await this.session.closeAllConnections();
        await this.session.clearAuthCache();
        await this.session.setProxy(config);
      } catch (error) {
        this.current = previous;
        bridge?.close();
        throw error;
      }
      this.bridge?.close();
      this.bridge = bridge;
      this.initialized = true;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  credentials(info: { isProxy: boolean; host: string; port: number }): [string, string] | undefined {
    if (!info.isProxy || !this.current || this.current === "direct") return;
    const url = new URL(this.current);
    if (!["http:", "https:"].includes(url.protocol) || !(url.username || url.password)) return;
    if (info.host.toLowerCase() !== url.hostname.toLowerCase() || info.port !== (Number(url.port) || (url.protocol === "https:" ? 443 : 80))) return;
    return [decodeURIComponent(url.username), decodeURIComponent(url.password)];
  }

  dispose(): void { this.bridge?.close(); this.bridge = undefined; }
}
