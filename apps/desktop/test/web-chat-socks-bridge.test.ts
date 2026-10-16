import { expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { startWebChatSocksBridge } from "../src/main/web-chat-proxy";

test("SOCKS5 bridge authenticates HTTP and CONNECT, rejects bad passwords, closes tunnels", async () => {
  const credentials: string[][] = [];
  const sockets = new Set<net.Socket>();
  const socks = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let phase = 0;
    const read = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        buffer = buffer.subarray(2 + buffer[1]!);
        socket.write(Buffer.from([5, 2])); phase = 1;
      }
      if (phase === 1) {
        if (buffer.length < 2) return;
        const nameEnd = 2 + buffer[1]!;
        if (buffer.length <= nameEnd || buffer.length < nameEnd + 1 + buffer[nameEnd]!) return;
        const end = nameEnd + 1 + buffer[nameEnd]!;
        const user = buffer.subarray(2, nameEnd).toString();
        const pass = buffer.subarray(nameEnd + 1, end).toString();
        credentials.push([user, pass]);
        buffer = buffer.subarray(end);
        if (user !== "test" || pass !== "pass@:%") { socket.end(Buffer.from([1, 1])); return; }
        socket.write(Buffer.from([1, 0])); phase = 2;
      }
      if (phase === 2) {
        if (buffer.length < 5) return;
        const hostEnd = buffer[3] === 1 ? 8 : 5 + buffer[4]!;
        if (buffer.length < hostEnd + 2) return;
        const port = buffer.readUInt16BE(hostEnd);
        socket.off("data", read);
        const target = net.connect(port, "127.0.0.1", () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          socket.pipe(target).pipe(socket);
        });
        target.on("error", () => socket.destroy());
        socket.on("close", () => target.destroy());
        target.on("close", () => socket.destroy());
      }
    };
    socket.on("data", read);
  });
  const origin = http.createServer((_req, res) => res.end("through-socks"));
  socks.listen(0, "127.0.0.1"); origin.listen(0, "127.0.0.1");
  await Promise.all([once(socks, "listening"), once(origin, "listening")]);
  const socksPort = (socks.address() as net.AddressInfo).port;
  const originPort = (origin.address() as net.AddressInfo).port;
  const bridge = await startWebChatSocksBridge(`socks5://test:pass%40%3A%25@127.0.0.1:${socksPort}`);
  const bad = await startWebChatSocksBridge(`socks5://test:bad@127.0.0.1:${socksPort}`);
  const request = (port: number) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: `http://127.0.0.1:${originPort}/` }, (res) => {
      let body = ""; res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    }).on("error", reject);
  });
  let tunnel: net.Socket | undefined;
  try {
    expect(await request(bridge.port)).toEqual({ status: 200, body: "through-socks" });
    expect((await request(bad.port)).status).toBe(502);
    tunnel = net.connect(bridge.port, "127.0.0.1");
    await once(tunnel, "connect");
    tunnel.write(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    const [connected] = await once(tunnel, "data");
    expect(connected.toString()).toContain("200 Connection Established");
    tunnel.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    let body = "";
    tunnel.on("data", (chunk) => body += chunk);
    await once(tunnel, "close");
    expect(body).toContain("through-socks");
    expect(credentials).toContainEqual(["test", "pass@:%"]);
    expect(credentials).toContainEqual(["test", "bad"]);
  } finally {
    tunnel?.destroy(); bridge.close(); bad.close();
    for (const socket of sockets) socket.destroy();
    socks.close(); origin.closeAllConnections(); origin.close();
  }
}, 10_000);
