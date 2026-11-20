import fs from "node:fs";
import path from "node:path";

const tomlPath = path.join(process.env.APPDATA, "@eco", "desktopDev", "codex", "config.toml");
const toml = fs.readFileSync(tomlPath, "utf8");
const blocks = [...toml.matchAll(/\[mcp_servers\.([^\]]+)\]([\s\S]*?)(?=\n\[mcp_servers\.|\n\[(?!mcp_servers)|$)/g)];

const results = [];
for (const match of blocks) {
  const name = match[1];
  const body = match[2];
  const url = /url = "([^"]+)"/.exec(body)?.[1];
  const secret = /"(X-Eco-[^"]+-Control-Secret)" = "([^"]+)"/.exec(body);
  if (!url || !secret) {
    results.push({ name, skip: true });
    continue;
  }
  const headers = {
    accept: "text/event-stream, application/json",
    "content-type": "application/json",
    [secret[1]]: secret[2],
  };
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "eco_smoke", version: "0" },
      },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  await init.json().catch(() => ({}));
  const notified = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const json = await res.json().catch(() => ({}));
  const tools = Array.isArray(json?.result?.tools) ? json.result.tools.map((t) => t.name) : [];
  results.push({
    name,
    initStatus: init.status,
    notifiedStatus: notified.status,
    status: res.status,
    toolCount: tools.length,
    tools: tools.slice(0, 8),
    url,
  });
}

// Concurrent tools/list against image_view + browser (same process, different ports = one server each)
const image = results.find((r) => r.name === "mori_image_view");
const browser = results.find((r) => r.name === "mori_agent_browser");
if (image?.url && browser?.url) {
  const imageSecret = /"(X-Eco-[^"]+-Control-Secret)" = "([^"]+)"/.exec(
    blocks.find((m) => m[1] === "mori_image_view")?.[2] ?? "",
  );
  const browserSecret = /"(X-Eco-[^"]+-Control-Secret)" = "([^"]+)"/.exec(
    blocks.find((m) => m[1] === "mori_agent_browser")?.[2] ?? "",
  );
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, async (_, i) => {
      const target = i % 2 === 0 ? image : browser;
      const secret = i % 2 === 0 ? imageSecret : browserSecret;
      const res = await fetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [secret[1]]: secret[2],
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: i + 10, method: "tools/list", params: {} }),
      });
      return { i, name: target.name, status: res.status };
    }),
  );
  results.push({ concurrent });
}

console.log(JSON.stringify({ results }, null, 2));
