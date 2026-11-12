import http from "node:http";
import net, { type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { SocksClient, type SocksProxy } from "socks";
import { appendUpstreamLogLine } from "./upstream-log";

type Phase = "tcp-connect" | "socks-handshake" | "tunnel";
export interface SocksBridgeDiagnostic {
  connectionId: string;
  event: "established" | "failure" | "closed";
  proxyEndpoint: string;
  destination: string;
  phase: Phase;
  elapsedMs: number;
  code?: string;
  message?: string;
  bytesRead?: number;
  bytesWritten?: number;
}

export interface SocksHttpBridge {
  port: number;
  close(): void;
  getLastFailure(): SocksBridgeDiagnostic | undefined;
}

interface Destination {
  host: string;
  port: number;
}
let nextBridgeId = 1;

function parseDestination(authority: string): Destination {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^\s:/?#@[\]\\]+)(?::([0-9]+))?$/u.exec(authority);
  if (!match?.[1]) throw new Error("Invalid CONNECT authority");
  const host = match[1].replace(/^\[|\]$/gu, "");
  if (match[1].startsWith("[") && net.isIP(host) !== 6) throw new Error("Invalid IPv6 address");
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CONNECT port");
  return { host, port };
}

/** A loopback-only HTTP proxy. SOCKS negotiation is owned here so it can be cancelled. */
export async function startSocksToHttpBridge(
  proxyUrl: string,
  options: {
    connectTimeoutMs?: number;
    onDiagnostic?: (event: SocksBridgeDiagnostic) => void;
  } = {},
): Promise<SocksHttpBridge> {
  let url: URL;
  let userId: string;
  let password: string;
  try {
    url = new URL(proxyUrl);
    userId = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    // URL/parser errors can contain the original URL, including credentials.
    throw new Error("Invalid SOCKS proxy URL");
  }
  if (
    !["socks:", "socks4:", "socks5:", "socks5h:"].includes(url.protocol) ||
    !url.hostname ||
    (url.pathname && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid SOCKS proxy URL");
  }
  const type = url.protocol === "socks4:" ? 4 : 5;
  const port = url.port ? Number(url.port) : 1080;
  if (
    port < 1 ||
    port > 65535 ||
    Buffer.byteLength(userId) > 255 ||
    Buffer.byteLength(password) > 255 ||
    (type === 4 && password)
  )
    throw new Error("Invalid SOCKS proxy credentials or port");
  const proxyHost = url.hostname.replace(/^\[|\]$/gu, "");
  const proxy: SocksProxy = { host: proxyHost, port, type, userId, password };
  const proxyEndpoint = `${url.protocol}//${url.host}`;
  const timeoutMs = options.connectTimeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid SOCKS connection timeout");
  const secrets = [...new Set([url.username, url.password, userId, password].filter(Boolean))];
  const redact = (message: string) =>
    secrets.reduce((value, secret) => value.split(secret).join("[redacted]"), message);
  const bridgeId = nextBridgeId++;
  let nextConnectionId = 1;
  let closed = false;
  let lastFailure: SocksBridgeDiagnostic | undefined;
  const sockets = new Set<Socket>();
  const pending = new Set<AbortController>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const emit = (event: SocksBridgeDiagnostic) => {
    if (event.event === "failure") lastFailure = event;
    if (options.onDiagnostic) options.onDiagnostic(event);
    else {
      const line = `[socks-bridge] ${JSON.stringify(event)}\n`;
      process.stderr.write(line);
      appendUpstreamLogLine(line);
    }
  };

  const dial = async (destination: Destination, controller: AbortController): Promise<Socket> => {
    const started = Date.now();
    const connectionId = `${bridgeId}:${nextConnectionId++}`;
    const target =
      net.isIP(destination.host) === 6
        ? `[${destination.host}]:${destination.port}`
        : `${destination.host}:${destination.port}`;
    let phase: Phase = "tcp-connect";
    const socket = new net.Socket({ allowHalfOpen: true });
    socket.setNoDelay(true);
    track(socket);
    const diagnostic = (event: SocksBridgeDiagnostic["event"], extra: Partial<SocksBridgeDiagnostic> = {}) =>
      emit({
        connectionId,
        event,
        proxyEndpoint,
        destination: target,
        phase,
        elapsedMs: Date.now() - started,
        ...extra,
      });
    const abort = () =>
      socket.destroy(Object.assign(new Error("SOCKS connection cancelled"), { code: "ABORT_ERR" }));
    const timer = setTimeout(
      () => socket.destroy(Object.assign(new Error("SOCKS connection timed out"), { code: "ETIMEDOUT" })),
      timeoutMs,
    );
    controller.signal.addEventListener("abort", abort, { once: true });
    pending.add(controller);
    try {
      controller.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off("connect", connected);
          socket.off("error", failed);
          socket.off("close", ended);
        };
        const connected = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const ended = () => failed(new Error("Proxy TCP connection closed"));
        socket.once("connect", connected);
        socket.once("error", failed);
        socket.once("close", ended);
        socket.connect({ host: proxyHost, port: proxy.port });
      });
      controller.signal.throwIfAborted();
      phase = "socks-handshake";
      await SocksClient.createConnection({
        command: "connect",
        proxy,
        destination,
        existing_socket: socket,
        timeout: Math.max(1, timeoutMs - (Date.now() - started)),
      });
      controller.signal.throwIfAborted();
      if (closed || socket.destroyed) throw new Error("Proxy connection closed during negotiation");
      phase = "tunnel";
      const initialWritten = socket.bytesWritten;
      let bytesRead = 0;
      socket.on("data", (chunk: Buffer) => {
        bytesRead += chunk.length;
      });
      socket.on("error", (error: NodeJS.ErrnoException) =>
        diagnostic("failure", { code: error.code ?? "TUNNEL_ERROR", message: redact(error.message) }),
      );
      socket.once("end", () => {
        if (!closed && !socket.errored && bytesRead === 0 && socket.bytesWritten > initialWritten) {
          diagnostic("failure", {
            code: "UPSTREAM_EOF_BEFORE_DATA",
            message: "Upstream ended the tunnel before returning application data",
          });
        }
      });
      socket.once("close", () =>
        diagnostic("closed", { bytesRead, bytesWritten: socket.bytesWritten - initialWritten }),
      );
      diagnostic("established");
      return socket;
    } catch (error) {
      if (!controller.signal.aborted && !closed) {
        const message = error instanceof Error ? error.message : "SOCKS connection failed";
        const socketCode = (socket.errored as NodeJS.ErrnoException | null)?.code;
        const code =
          socketCode ??
          (/authentication/iu.test(message)
            ? "SOCKS_AUTH_FAILED"
            : /timed out/iu.test(message)
              ? "ETIMEDOUT"
              : /rejected/iu.test(message)
                ? "SOCKS_TARGET_REJECTED"
                : "SOCKS_CONNECT_FAILED");
        diagnostic("failure", { code, message: redact(message) });
      }
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      pending.delete(controller);
    }
  };

  const server = http.createServer((request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
      if (target.protocol !== "http:" || target.username || target.password || target.hash)
        throw new Error("Invalid proxy request");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.once("aborted", cancel);
    response.once("close", cancel);
    void dial({ host: target.hostname.replace(/^\[|\]$/gu, ""), port: Number(target.port) || 80 }, controller)
      .then((socket) => {
        if (closed || response.destroyed || controller.signal.aborted) {
          socket.destroy();
          return;
        }
        const headers: http.OutgoingHttpHeaders = { ...request.headers, host: target.host };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        const upstream = http.request(
          target,
          {
            method: request.method,
            headers,
            // agent:false would create a new Agent and ignore this connected socket.
            createConnection: () => socket,
          },
          (incoming) => {
            response.writeHead(incoming.statusCode ?? 502, incoming.headers);
            incoming.pipe(response);
            incoming.on("error", () => response.destroy());
          },
        );
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502).end();
          else response.destroy();
        });
        response.once("close", () => upstream.destroy());
        request.once("error", () => upstream.destroy());
        request.pipe(upstream);
      })
      .catch(() => {
        if (!response.destroyed) response.writeHead(502).end();
      })
      .finally(() => {
        request.off("aborted", cancel);
        response.off("close", cancel);
      });
  });
  server.on("connection", track);
  server.on("connect", (request, client, head) => {
    let destination: Destination;
    try {
      destination = parseDestination(request.url ?? "");
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    // Read while negotiating so a disconnected client is observable. Buffering
    // through a stream retains early TLS bytes and applies normal backpressure.
    const input = new PassThrough();
    if (head.length) input.write(head);
    const ended = () => {
      if (input.readableLength === 0) cancel();
    };
    client.once("close", cancel);
    client.once("end", ended);
    client.once("close", () => input.destroy());
    client.pipe(input);
    void dial(destination, controller)
      .then((socket) => {
        if (closed || client.destroyed || controller.signal.aborted) {
          socket.destroy();
          return;
        }
        client.on("error", () => socket.destroy());
        socket.on("error", () => client.destroy());
        client.once("close", () => socket.destroy());
        // A normal EOF must flush buffered response data before closing the client.
        socket.once("close", () => {
          if (socket.readableEnded) client.end();
          else client.destroy();
        });
        socket.once("close", () => input.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        input.pipe(socket).pipe(client);
      })
      .catch(() => {
        input.destroy();
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      })
      .finally(() => {
        client.off("close", cancel);
        client.off("end", ended);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法启动 SOCKS 代理转接");
  }
  return {
    port: address.port,
    getLastFailure: () => lastFailure,
    close() {
      if (closed) return;
      closed = true;
      server.close();
      for (const controller of pending) controller.abort();
      for (const socket of sockets) socket.destroy();
    },
  };
}
