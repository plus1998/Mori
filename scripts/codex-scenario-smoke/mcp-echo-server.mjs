#!/usr/bin/env node
/**
 * Minimal stdio MCP server for Eco Codex scenario smoke.
 *
 * Codex (verified via community reports for codex-mcp-client / rmcp) uses
 * newline-delimited JSON over stdio — NOT LSP-style Content-Length framing.
 *
 * Refs:
 * - https://github.com/i1s-abhishek/youtube-studio-mcp/pull/1
 *   "Codex sends newline-delimited JSON… Content-Length causes handshake timeout"
 * - https://github.com/openai/codex/issues/14933
 * - https://community.openai.com/t/mcp-servers-all-time-out-narrowed-it-down-to-stdio-bug/1363658
 *
 * Tools: smoke_ping, smoke_echo
 */
import fs from "node:fs";

const SERVER_INFO = { name: "eco-smoke-mcp", version: "1.0.1" };
const LOG_PATH = process.env.ECO_SMOKE_MCP_LOG?.trim() || "";
const TOOLS = [
  {
    name: "smoke_ping",
    description: "Return a fixed smoke ping payload for Mori Codex scenario tests.",
    inputSchema: {
      type: "object",
      properties: {
        marker: { type: "string", description: "Optional marker to echo back" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "smoke_echo",
    description: "Echo the provided text back for Mori Codex scenario tests.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

function log(line) {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore
  }
}

/** Codex expects NDJSON responses (JSON + newline). */
function writeMessage(message) {
  const body = `${JSON.stringify(message)}\n`;
  process.stdout.write(body);
  log(`OUT ${body.trim()}`);
}

function ok(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleRequest(msg) {
  if (!msg || typeof msg.method !== "string") return;
  log(`IN method=${msg.method} id=${String(msg.id)}`);
  const { id, method, params } = msg;
  if (method === "initialize") {
    ok(id, {
      // Codex commonly negotiates 2025-06-18; echo client version when present.
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") {
    ok(id, { tools: TOOLS });
    return;
  }
  if (method === "resources/list") {
    ok(id, { resources: [] });
    return;
  }
  if (method === "resources/templates/list") {
    ok(id, { resourceTemplates: [] });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "smoke_ping") {
      const marker = typeof args.marker === "string" ? args.marker : "nop";
      ok(id, { content: [{ type: "text", text: `SMOKE_MCP_PONG:${marker}` }] });
      return;
    }
    if (name === "smoke_echo") {
      const text = typeof args.text === "string" ? args.text : "";
      ok(id, { content: [{ type: "text", text: `SMOKE_MCP_ECHO:${text}` }] });
      return;
    }
    fail(id, -32601, `Unknown tool: ${name}`);
    return;
  }
  if (method === "ping") {
    ok(id, {});
    return;
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  log(`RAW +${chunk.length}B buf=${buffer.length}`);
  // NDJSON: one JSON object per line. Also tolerate accidental Content-Length
  // by skipping header lines until a `{...}` line appears.
  while (true) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    if (/^Content-Length:/i.test(line)) continue;
    if (!line.startsWith("{")) continue;
    try {
      handleRequest(JSON.parse(line));
    } catch (error) {
      log(`PARSE_ERR ${String(error)} line=${line.slice(0, 120)}`);
    }
  }
});
process.stdin.on("end", () => {
  log("STDIN_END");
  process.exit(0);
});
process.stdin.resume();
log(`START pid=${process.pid}`);
