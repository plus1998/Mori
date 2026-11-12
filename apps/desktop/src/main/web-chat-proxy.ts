import { webChatProxyConfig } from "../shared/web-chat-list";
import { startSocksToHttpBridge } from "./socks-http-bridge";

/** Chromium does not implement SOCKS5 password auth. Keep that hop in Node. */
export const startWebChatSocksBridge = startSocksToHttpBridge;

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
