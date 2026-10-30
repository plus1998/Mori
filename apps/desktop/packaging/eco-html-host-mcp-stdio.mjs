#!/usr/bin/env node
import readline from "node:readline";

const controlUrl = (process.env.ECO_HTML_HOST_CONTROL_URL || "").replace(/\/$/, "");
const controlSecret = process.env.ECO_HTML_HOST_CONTROL_SECRET || "";
const authToken = process.env.ECO_HTML_HOST_AUTH_TOKEN || "";

if (!controlUrl || !controlSecret) {
  process.stderr.write("[eco-html-host-mcp] missing control URL or secret\n");
  process.exit(1);
}

async function control(route, body) {
  const response = await fetch(`${controlUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Eco-Html-Host-Control-Secret": controlSecret,
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({ ...(body || {}), ...(authToken ? { authToken } : {}) }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void (async () => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = message;
    if (typeof method !== "string" || method.startsWith("notifications/")) return;
    try {
      if (method === "initialize") {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "eco_html_host", version: "1.0.0" },
            instructions:
              "Mori HTML hosting for progress/report pages. Publish single-file HTML; Mori wraps chrome and returns a publicUrl.",
          },
        });
      } else if (method === "ping") {
        write({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        const result = await control("/v1/tools/list", {});
        write({ jsonrpc: "2.0", id, result: { tools: result.tools || [] } });
      } else if (method === "tools/call") {
        const result = await control("/v1/tools/call", {
          name: params?.name,
          arguments: params?.arguments || {},
        });
        write({ jsonrpc: "2.0", id, result: result.result });
      } else {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  })();
});
