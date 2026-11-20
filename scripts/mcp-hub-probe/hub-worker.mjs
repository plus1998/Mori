#!/usr/bin/env node

// Fixed-identity HTTP worker for the independent-connection fallback probe.
// It intentionally has no bearer credential: the process itself is the
// session boundary. The worker exits on SIGTERM.

import http from "node:http";

const identityArg = process.argv.indexOf("--identity");
const identity = identityArg >= 0 ? String(process.argv[identityArg + 1] ?? "unknown") : "unknown";
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || !String(request.url ?? "").startsWith("/mcp")) {
    response.writeHead(405).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  let message;
  try {
    message = JSON.parse(raw || "{}");
  } catch {
    response.writeHead(400).end(JSON.stringify({ error: "invalid json" }));
    return;
  }
  const id = message.id ?? null;
  const method = message.method;
  if (method === "initialize") {
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": `${identity}-worker` });
    response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mori_mcp_worker", version: "0.1.0" } } }));
    return;
  }
  if (method === "notifications/initialized") {
    response.writeHead(202).end();
    return;
  }
  if (method === "tools/list") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [{ name: "search_tools", inputSchema: { type: "object" } }, { name: "call_tool", inputSchema: { type: "object" } }] } }));
    return;
  }
  if (method === "tools/call" && message.params?.name === "call_tool" && message.params?.arguments?.name === "echo_context") {
    const result = { identity, requestId: `worker-${Date.now()}` };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "unsupported worker probe call" } }));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`READY http://127.0.0.1:${address.port}/mcp\n`);
});

