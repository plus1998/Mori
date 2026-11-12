import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { type SocksBridgeDiagnostic, startSocksToHttpBridge } from "../src/main/socks-http-bridge";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for socket state");
    await Bun.sleep(5);
  }
}

async function fakeSocks(
  mode: "echo" | "stall" | "auth-failure" | "target-failure" | "half-close" | "empty-eof" = "echo",
  banner = Buffer.alloc(0),
) {
  const sockets = new Set<net.Socket>();
  const destinations: Array<{ addressType: number; host: string; port: number }> = [];
  let greetings = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.on("end", () => {
      if (mode === "half-close") socket.end(Buffer.alloc(512 * 1024, 0xa5));
      else socket.end();
    });
    let buffer = Buffer.alloc(0);
    let phase = "greeting";
    const read = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (phase === "greeting") {
        if (buffer.length < 2 || buffer.length < 2 + buffer.readUInt8(1)) return;
        buffer = buffer.subarray(2 + buffer.readUInt8(1));
        greetings++;
        if (mode === "stall") return;
        if (mode === "auth-failure") {
          socket.write(Buffer.from([5, 2]));
          phase = "auth";
        } else {
          socket.write(Buffer.from([5, 0]));
          phase = "connect";
        }
      }
      if (phase === "auth") {
        if (buffer.length < 2) return;
        const endUser = 2 + buffer.readUInt8(1);
        if (buffer.length <= endUser || buffer.length < endUser + 1 + buffer.readUInt8(endUser)) return;
        socket.end(Buffer.from([1, 1]));
        return;
      }
      if (phase === "connect") {
        if (buffer.length < 5) return;
        const type = buffer.readUInt8(3);
        const start = type === 3 ? 5 : 4;
        const end = start + (type === 1 ? 4 : type === 4 ? 16 : buffer.readUInt8(4));
        if (buffer.length < end + 2) return;
        destinations.push({
          addressType: type,
          host: buffer.subarray(start, end).toString(type === 3 ? "utf8" : "hex"),
          port: buffer.readUInt16BE(end),
        });
        const tail = buffer.subarray(end + 2);
        socket.off("data", read);
        if (mode === "target-failure") {
          socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        socket.write(Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), banner]));
        if (tail.length && mode === "echo") socket.write(tail);
        if (mode === "echo") socket.on("data", (chunk) => socket.write(chunk));
        if (mode === "empty-eof") socket.once("data", () => socket.end());
      }
    };
    socket.on("data", read);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.close();
    for (const socket of sockets) socket.destroy();
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    sockets,
    destinations,
    get greetings() {
      return greetings;
    },
  };
}

async function bridgeFor(port: number, timeoutMs = 1000) {
  const events: SocksBridgeDiagnostic[] = [];
  const bridge = await startSocksToHttpBridge(`socks5://bridge-user:bridge-secret%40%25@127.0.0.1:${port}`, {
    connectTimeoutMs: timeoutMs,
    onDiagnostic: (event) => events.push(event),
  });
  cleanups.push(() => bridge.close());
  return { ...bridge, events };
}

async function connect(port: number, authority = "example.test:443", head = Buffer.alloc(0)) {
  const socket = net.connect(port, "127.0.0.1");
  cleanups.push(() => socket.destroy());
  socket.on("error", () => {});
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  await once(socket, "connect");
  socket.write(
    Buffer.concat([Buffer.from(`CONNECT ${authority} HTTP/1.1\r\nHost: localhost\r\n\r\n`), head]),
  );
  return { socket, chunks, data: () => Buffer.concat(chunks) };
}

test("client cancellation destroys a SOCKS handshake without waiting for its timeout", async () => {
  const socks = await fakeSocks("stall");
  const bridge = await bridgeFor(socks.port, 10_000);
  const client = await connect(bridge.port);
  await until(() => socks.greetings === 1);
  client.socket.destroy();
  await until(() => socks.sockets.size === 0);
  expect(bridge.events).toEqual([]);
});

test("bridge shutdown destroys pending handshakes and established tunnels, and is idempotent", async () => {
  for (const mode of ["stall", "echo"] as const) {
    const socks = await fakeSocks(mode);
    const bridge = await bridgeFor(socks.port, 10_000);
    const client = await connect(bridge.port);
    await until(() =>
      mode === "stall" ? socks.greetings === 1 : client.data().includes("200 Connection Established"),
    );
    bridge.close();
    bridge.close();
    await until(() => socks.sockets.size === 0 && client.socket.destroyed);
    expect(bridge.getLastFailure()).toBeUndefined();
  }
});

test("handshake timeout returns 502, closes upstream, and records the actual stage without credentials", async () => {
  const socks = await fakeSocks("stall");
  const bridge = await bridgeFor(socks.port, 80);
  const client = await connect(bridge.port);
  await until(() => client.socket.destroyed);
  expect(client.data().toString()).toContain("502 Bad Gateway");
  await until(() => socks.sockets.size === 0);
  expect(bridge.getLastFailure()).toMatchObject({
    phase: "socks-handshake",
    code: "ETIMEDOUT",
    destination: "example.test:443",
  });
  const logs = JSON.stringify(bridge.events);
  expect(logs).not.toContain("bridge-user");
  expect(logs).not.toContain("bridge-secret");
});

test("SOCKS authentication and target rejection remain distinct failures", async () => {
  for (const [mode, code] of [
    ["auth-failure", "SOCKS_AUTH_FAILED"],
    ["target-failure", "SOCKS_TARGET_REJECTED"],
  ] as const) {
    const socks = await fakeSocks(mode);
    const bridge = await bridgeFor(socks.port);
    const client = await connect(bridge.port);
    await until(() => client.socket.destroyed);
    expect(client.data().toString()).toContain("502 Bad Gateway");
    expect(bridge.getLastFailure()).toMatchObject({ phase: "socks-handshake", code });
  }
});

test("CONNECT preserves IPv6, default TLS port, pipelined binary data and coalesced SOCKS reply data", async () => {
  const banner = Buffer.from([0, 255, 7, 128]);
  const payload = Buffer.from([1, 0, 254, 128, 42]);
  const socks = await fakeSocks("echo", banner);
  const bridge = await bridgeFor(socks.port);
  const client = await connect(bridge.port, "[2001:db8::1]:8443", payload);
  const header = Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n");
  await until(() => client.data().length >= header.length + banner.length + payload.length);
  expect(client.data()).toEqual(Buffer.concat([header, banner, payload]));
  expect(socks.destinations[0]).toEqual({
    addressType: 4,
    host: "20010db8000000000000000000000001",
    port: 8443,
  });
  await connect(bridge.port, "example.test");
  await until(() => socks.destinations.length === 2);
  expect(socks.destinations[1]?.port).toBe(443);
});

test("invalid CONNECT authorities are rejected before dialing the proxy", async () => {
  const socks = await fakeSocks();
  const bridge = await bridgeFor(socks.port);
  for (const authority of [
    "example.test:0",
    "example.test:65536",
    "example.test:443garbage",
    "user@example.test:443",
    "::1:443",
    "[bad::ipv6]:443",
    "example.test:443/path",
  ]) {
    const client = await connect(bridge.port, authority);
    await until(() => client.socket.destroyed);
    expect(client.data().toString()).toContain("400 Bad Request");
  }
  expect(socks.greetings).toBe(0);
});

test("client TCP half-close still receives the complete buffered response", async () => {
  const socks = await fakeSocks("half-close");
  const bridge = await bridgeFor(socks.port);
  const client = await connect(bridge.port);
  await until(() => client.data().includes("200 Connection Established"));
  client.socket.end(Buffer.from("request"));
  await until(() => client.socket.destroyed);
  const data = client.data();
  expect(data.subarray(data.indexOf("\r\n\r\n") + 4)).toEqual(Buffer.alloc(512 * 1024, 0xa5));
});

test("upstream EOF after a request is observable without pretending to diagnose TLS", async () => {
  const socks = await fakeSocks("empty-eof");
  const bridge = await bridgeFor(socks.port);
  const client = await connect(bridge.port);
  await until(() => client.data().includes("200 Connection Established"));
  client.socket.write(Buffer.from([22, 3, 1, 0, 1, 0]));
  await until(() => client.socket.destroyed);
  expect(bridge.getLastFailure()).toMatchObject({ phase: "tunnel", code: "UPSTREAM_EOF_BEFORE_DATA" });
  expect(bridge.getLastFailure()?.message).not.toContain("TLS");
});

test("TCP connection refusal is distinct from a SOCKS negotiation error", async () => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const bridge = await bridgeFor(port);
  const client = await connect(bridge.port);
  await until(() => client.socket.destroyed);
  expect(client.data().toString()).toContain("502 Bad Gateway");
  expect(bridge.getLastFailure()).toMatchObject({ phase: "tcp-connect", code: "ECONNREFUSED" });
});

test("aborting an ordinary HTTP request also cancels the pending SOCKS handshake", async () => {
  const socks = await fakeSocks("stall");
  const bridge = await bridgeFor(socks.port, 10_000);
  const request = http.get({ host: "127.0.0.1", port: bridge.port, path: "http://example.test/" });
  request.on("error", () => {});
  cleanups.push(() => request.destroy());
  await until(() => socks.greetings === 1);
  request.destroy();
  await until(() => socks.sockets.size === 0);
});

test("invalid SOCKS URLs reject safely without exposing credentials", async () => {
  for (const url of [
    "socks5://bridge-user:bridge-secret%zz@127.0.0.1:1080",
    "socks5://bridge-user:bridge-secret@bad:99999",
    "http://bridge-user:bridge-secret@localhost:8080",
  ]) {
    try {
      await startSocksToHttpBridge(url);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(String(error)).toContain("Invalid SOCKS");
      expect(String(error)).not.toContain("bridge-secret");
    }
  }
});
