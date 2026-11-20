#!/usr/bin/env node
/**
 * Eco stdio front for open-computer-use MCP.
 * Transparent proxy: spawn upstream `mcp`, forward frames, and notify Eco on tools/call
 * so the OS presence overlay can light up regardless of Claude/Codex/Pi event naming.
 */
import { spawn } from "node:child_process";

const controlUrl = (process.env.ECO_COMPUTER_USE_CONTROL_URL || "").replace(/\/$/, "");
const controlSecret = process.env.ECO_COMPUTER_USE_CONTROL_SECRET || "";
const binaryPath = process.env.ECO_OPEN_COMPUTER_USE_BINARY || "";
const threadId = (process.env.ECO_COMPUTER_USE_THREAD_ID || "").trim();

if (!controlUrl || !controlSecret) {
  process.stderr.write(
    "[eco-computer-use-mcp] ECO_COMPUTER_USE_CONTROL_URL and ECO_COMPUTER_USE_CONTROL_SECRET are required\n",
  );
  process.exit(1);
}
if (!binaryPath) {
  process.stderr.write("[eco-computer-use-mcp] ECO_OPEN_COMPUTER_USE_BINARY is required\n");
  process.exit(1);
}

function notifyToolStarted(name, args) {
  void fetch(`${controlUrl}/v1/tool-started`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Eco-Computer-Use-Control-Secret": controlSecret,
    },
    body: JSON.stringify({
      name,
      arguments: args && typeof args === "object" ? args : {},
      ...(threadId ? { threadId } : {}),
    }),
  }).catch((error) => {
    process.stderr.write(
      `[eco-computer-use-mcp] presence notify failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}

function handleClientJson(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;
  if (message.method !== "tools/call") return;
  const params = message.params && typeof message.params === "object" ? message.params : {};
  const name = typeof params.name === "string" ? params.name : "";
  if (!name) return;
  const args =
    params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
  notifyToolStarted(name, args);
}

/** Sniff MCP Content-Length frames and NDJSON lines on the client→server stream. */
class ClientFrameSniffer {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length === 0) return;

      const asUtf8Start = this.buf.slice(0, Math.min(64, this.buf.length)).toString("utf8");
      const looksLikeContentLength = /^content-length\s*:/i.test(asUtf8Start);

      if (looksLikeContentLength) {
        const headerEnd = this.buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = this.buf.slice(0, headerEnd).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          // Corrupt header — drop one byte and retry.
          this.buf = this.buf.slice(1);
          continue;
        }
        const len = Number(match[1]);
        const start = headerEnd + 4;
        if (this.buf.length < start + len) return;
        const body = this.buf.slice(start, start + len).toString("utf8");
        this.buf = this.buf.slice(start + len);
        handleClientJson(body);
        continue;
      }

      // NDJSON / line-delimited JSON
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = this.buf.slice(0, nl).toString("utf8").replace(/\r$/, "").trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.startsWith("{")) {
        handleClientJson(line);
      }
    }
  }
}

const sniffer = new ClientFrameSniffer();
const child = spawn(binaryPath, ["mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: process.env,
});

child.on("error", (error) => {
  process.stderr.write(
    `[eco-computer-use-mcp] failed to spawn open-computer-use: ${error.message}\n`,
  );
  process.exit(1);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

child.stdout.on("data", (chunk) => {
  if (!process.stdout.write(chunk)) {
    child.stdout.pause();
    process.stdout.once("drain", () => child.stdout.resume());
  }
});

process.stdin.on("data", (chunk) => {
  sniffer.push(chunk);
  if (!child.stdin.write(chunk)) {
    process.stdin.pause();
    child.stdin.once("drain", () => process.stdin.resume());
  }
});

process.stdin.on("end", () => {
  child.stdin.end();
});

child.on("exit", (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
    return;
  }
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  });
}
