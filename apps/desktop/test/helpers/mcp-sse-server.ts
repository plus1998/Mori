import http from "node:http";
import type { AddressInfo } from "node:net";

/** A real legacy SSE endpoint: GET event stream plus a separate POST channel. */
export async function startMcpSseServer() {
  const streams = new Map<string, http.ServerResponse>();
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const requests: Array<{ method: string; authenticated: boolean }> = [];
  let nextSession = 0;
  const headers = { Authorization: "Bearer private-sse-token", "x-sse-test": "private-sse-header" };
  const server = http.createServer(async (req, res) => {
    const authenticated =
      req.headers.authorization === headers.Authorization &&
      req.headers["x-sse-test"] === headers["x-sse-test"];
    requests.push({ method: req.method ?? "", authenticated });
    if (!authenticated) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/sse") {
      const id = String(++nextSession);
      streams.set(id, res);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
      res.on("close", () => streams.delete(id));
      return;
    }
    const stream = streams.get(url.searchParams.get("sessionId") ?? "");
    if (req.method !== "POST" || url.pathname !== "/messages" || !stream) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(202).end();
    if (message.id === undefined) return;
    let result: unknown;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "legacy-sse", version: "1" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: ["echo", "blocked"].map((name) => ({
          name,
          description: `SSE ${name}`,
          inputSchema: { type: "object" },
        })),
      };
    } else if (message.method === "tools/call") {
      calls.push(message.params);
      if (message.params.arguments.wait) return;
      result = {
        content: [{ type: "text", text: String(message.params.arguments.value ?? "SSE result") }],
        ...(message.params.arguments.fail ? { isError: true } : {}),
      };
    } else {
      result = {};
    }
    stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`,
    headers,
    calls,
    requests,
    close: async () => {
      for (const stream of streams.values()) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
