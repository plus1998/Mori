import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildCodexMcpServerOverride } from "@eco/runtime";
import { handleMcpStreamableHttpRequest } from "./mcp-streamable-http";
import type { AssistantTool } from "./mori-assistant-runtime";

export const MORI_COMPUTER_MCP_SERVER = "mori_computer";
const SECRET_HEADER = "x-mori-computer-secret";

/** Runtime-local capability endpoint. Existing native threads gain these tools on resume. */
export class MoriComputerToolGateway {
  private readonly secret = randomBytes(24).toString("base64url");
  private server: http.Server | undefined;
  constructor(
    private readonly tools: AssistantTool[],
    private readonly call: (
      name: string,
      args: Record<string, unknown>,
      id: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}
  async start(): Promise<Record<string, unknown>> {
    if (this.server) throw new Error("Mori 电脑操作入口已经启动。");
    const server = http.createServer((req, res) => {
      void handleMcpStreamableHttpRequest(
        req,
        res,
        {
          serverName: MORI_COMPUTER_MCP_SERVER,
          listTools: async () => ({ tools: this.tools.map((tool) => ({ ...tool })) }),
          callTool: async ({ name, arguments: args, signal }) => {
            signal.throwIfAborted();
            if (!this.tools.some((tool) => tool.name === name)) throw new Error("未知的 Mori 电脑操作入口。");
            try {
              const result = await this.call(name, args, `mori-computer-${randomUUID()}`, signal);
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            } catch (error) {
              return {
                isError: true,
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              };
            }
          },
        },
        { controlSecretHeader: SECRET_HEADER, controlSecret: this.secret },
      );
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return {
      ...buildCodexMcpServerOverride({
        name: MORI_COMPUTER_MCP_SERVER,
        transport: "http",
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
        httpHeaders: { [SECRET_HEADER]: this.secret },
        enabledTools: this.tools.map((tool) => tool.name),
        toolTimeoutSec: 1800,
      }),
      required: true,
    };
  }
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
