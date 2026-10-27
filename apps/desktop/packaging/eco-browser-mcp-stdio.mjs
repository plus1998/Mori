#!/usr/bin/env node
/**
 * Eco browser MCP stdio front-end.
 * Always exposes logical server name eco_agent_browser to agents.
 * Forwards tools/list + tools/call to Eco desktop control HTTP with auth:
 *   - ECO_BROWSER_AUTH_TOKEN (thread-bound) when set (Claude / sealed sessions)
 *   - ECO_BROWSER_CONTROL_SECRET (required) to reach control plane
 * Concurrent Codex relies on Eco's claim queue + optional token.
 */
import readline from "node:readline";

const controlUrl = (process.env.ECO_BROWSER_CONTROL_URL || "").replace(/\/$/, "");
const controlSecret = process.env.ECO_BROWSER_CONTROL_SECRET || "";
const authToken = process.env.ECO_BROWSER_AUTH_TOKEN || "";

if (!controlUrl || !controlSecret) {
  process.stderr.write(
    "[eco-browser-mcp] ECO_BROWSER_CONTROL_URL and ECO_BROWSER_CONTROL_SECRET are required\n",
  );
  process.exit(1);
}

async function control(path, body) {
  const res = await fetch(`${controlUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Eco-Browser-Control-Secret": controlSecret,
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`control ${path} non-json: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(json.error || `control ${path} failed: HTTP ${res.status}`);
  }
  return json;
}

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  void (async () => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const id = msg.id;
    const method = msg.method;
    if (typeof method !== "string") {
      return;
    }
    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      return;
    }
    try {
      if (method === "initialize") {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: msg.params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "eco_agent_browser", version: "1.0.0" },
            instructions: "Mori built-in browser. Tools apply only to the authenticated conversation thread.",
          },
        });
        return;
      }
      if (method === "ping") {
        write({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (method === "tools/list") {
        const result = await control("/v1/tools/list", {
          authToken: authToken || undefined,
        });
        write({ jsonrpc: "2.0", id, result: { tools: result.tools ?? [] } });
        return;
      }
      if (method === "tools/call") {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        const result = await control("/v1/tools/call", {
          name,
          arguments: args,
          authToken: authToken || undefined,
        });
        write({
          jsonrpc: "2.0",
          id,
          result: result.result ?? {
            content: [{ type: "text", text: String(result.error || "empty") }],
            isError: Boolean(result.error),
          },
        });
        return;
      }
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (id === undefined) {
        process.stderr.write(`[eco-browser-mcp] ${message}\n`);
        return;
      }
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message },
      });
    }
  })();
});
