import type { OpenAIAccountProxyConfig } from "../shared/openai-account";
import { buildCodexProxyEnv, resolveCodexProxyUrl, type SystemProxyResolver } from "./codex-proxy";
import { startSocksToHttpBridge, type SocksHttpBridge } from "./socks-http-bridge";

export class CursorAccountProxy {
  // ACP processes can survive a turn. Keep their original bridge alive until app shutdown.
  private readonly bridges = new Map<string, Promise<SocksHttpBridge>>();

  async env(config: OpenAIAccountProxyConfig, systemProxy: SystemProxyResolver): Promise<NodeJS.ProcessEnv> {
    let url = await resolveCodexProxyUrl(config, systemProxy);
    if (url && new URL(url).protocol.startsWith("socks")) {
      const endpoint = url;
      let bridge = this.bridges.get(endpoint);
      if (!bridge) {
        bridge = startSocksToHttpBridge(endpoint).catch((error: unknown) => {
          this.bridges.delete(endpoint);
          throw error;
        });
        this.bridges.set(endpoint, bridge);
      }
      url = `http://127.0.0.1:${(await bridge).port}`;
    }
    // Cursor's spawn helpers overlay these values on process.env.
    const env = buildCodexProxyEnv({}, { mode: "proxy", url: url ?? "" });
    if (!url) env.NO_PROXY = env.no_proxy = "*";
    return env;
  }

  dispose(): void {
    for (const bridge of this.bridges.values()) {
      void bridge.then((value) => value.close(), () => {});
    }
    this.bridges.clear();
  }
}
