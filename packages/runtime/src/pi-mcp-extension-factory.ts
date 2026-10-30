/**
 * Build the official PI MCP extension from an isolated in-memory config.
 *
 * Kept separate from pi-mcp.ts so renderer bundles never pull the PI runtime
 * (`toPiMcpLoadedConfig` stays a pure data mapper).
 *
 * Eco decides which servers a thread sees and hands them over as a snapshot:
 * `loadConfig` never reads `mcp.json`, and there is no file to write `/mcp`
 * changes back to, so `updateConfig` fails loudly instead of pretending.
 */

import { homedir } from "node:os";
import path from "node:path";
import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { type McpTransport, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { toPiMcpLoadedConfig } from "./pi-mcp.js";

export interface CreatePiMcpExtensionOptions {
  /** Eco-owned agent dir; keeps the MCP server log next to the other PI state. */
  agentDir?: string;
  /**
   * How long the first prompt waits for the Hub to connect, in milliseconds.
   * The Hub is a local HTTP server, so the official 10s default is generous.
   */
  startupWaitMs?: number;
  /** Native MCP reports startup failures through ctx.ui.notify, including in RPC mode. */
  onNotification?: (message: string, type?: "info" | "warning" | "error") => void;
}

/**
 * Returns an ExtensionFactory for the given servers, or undefined when the
 * thread has none (no extension is registered at all in that case).
 */
export async function createPiMcpExtensionFactory(
  mcpServers: Record<string, unknown> | undefined,
  options: CreatePiMcpExtensionOptions = {},
): Promise<ExtensionFactory | undefined> {
  const config = toPiMcpLoadedConfig(mcpServers);
  if (config.servers.length === 0) {
    if (config.errors.length > 0) {
      throw new Error(`No usable MCP server in the PI session config:\n${config.errors.join("\n")}`);
    }
    return undefined;
  }
  if (config.errors.length > 0) {
    // A server Eco selected for this thread cannot be reached by the model.
    // Failing here keeps that visible instead of shipping a partial toolset.
    throw new Error(`Invalid MCP server config for the PI session:\n${config.errors.join("\n")}`);
  }

  const logPath = options.agentDir ? path.join(path.resolve(options.agentDir), "mcp.log") : undefined;

  return (pi) => {
    const transports = new Set<McpTransport>();
    const nativeFactory = createMcpExtension({
      // In-memory snapshot: never read ambient mcp.json / ~/.pi.
      loadConfig: () => config,
      createTransport: (entry, cwd, authProvider) => {
        const server = entry.config;
        // Keep ownership of transports still initializing: native shutdown only
        // closes clients that have finished connecting in PI 1.0.3.
        const transport =
          "url" in server
            ? new StreamableHttpTransport({
                url: server.url,
                ...(server.headers ? { headers: server.headers } : {}),
                ...(authProvider ? { authProvider } : {}),
              })
            : new StdioTransport({
                command: expandHome(server.command),
                ...(server.args ? { args: server.args.map(expandHome) } : {}),
                cwd: path.resolve(cwd, expandHome(server.cwd ?? ".")),
                ...(server.env ? { env: server.env } : {}),
                stderr: "pipe",
              });
        transports.add(transport);
        transport.onClose(() => transports.delete(transport));
        return transport;
      },
      updateConfig: (entry) => {
        throw new Error(
          `MCP server "${entry.name}" is configured by Mori for this session; /mcp changes cannot be saved.`,
        );
      },
      ...(logPath ? { logPath } : {}),
      ...(options.startupWaitMs !== undefined ? { startupWaitMs: options.startupWaitMs } : {}),
    });
    nativeFactory({
      ...pi,
      // The Eco snapshot is authoritative, including over extension registrations.
      getMcpServers: () => [],
      on: ((event: string, handler: (payload: unknown, ctx: ExtensionContext) => unknown) =>
        pi.on(
          event as never,
          ((payload: unknown, ctx: ExtensionContext) =>
            handler(payload, {
              ...ctx,
              ui: {
                ...ctx.ui,
                notify: (message: string, type?: "info" | "warning" | "error") => {
                  options.onNotification?.(message, type);
                  ctx.ui.notify(message, type);
                },
              },
            })) as never,
        )) as ExtensionAPI["on"],
    });
    pi.on("session_shutdown", async () => {
      const results = await Promise.allSettled([...transports].map((transport) => transport.close()));
      transports.clear();
      const errors = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (errors.length > 0)
        throw new AggregateError(
          errors.map((result) => result.reason),
          "PI MCP transport shutdown failed",
        );
    });
  };
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}
