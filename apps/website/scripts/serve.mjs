import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assets, websiteRoot } from "./assets.mjs";
import { ensureMedia } from "./media.mjs";

const args = process.argv.slice(2);
const production = args.includes("--dist");
const portIndex = args.indexOf("--port");
const port = Number(portIndex < 0 ? 4321 : args[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("--port must be an integer between 1 and 65535");
}
if (!production) await ensureMedia();
const root = resolve(websiteRoot, production ? "dist" : "src");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const asset = !production && assets.get(pathname);
    const filename = asset
      ? fileURLToPath(asset)
      : resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!asset && !filename.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(filename);
    if (!info.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    const headers = {
      "Content-Type": contentTypes[extname(filename)] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    };
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    if (request.method === "GET" && request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      } else {
        start = -1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
        response.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end();
        return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
      headers["Content-Length"] = end - start + 1;
    }
    response.writeHead(status, headers);
    if (request.method === "HEAD") response.end();
    else
      createReadStream(filename, info.size ? { start, end } : undefined)
        .on("error", () => response.destroy())
        .pipe(response);
  } catch (error) {
    const invalid = error instanceof URIError || error instanceof TypeError;
    response.writeHead(invalid ? 400 : 404).end(invalid ? "Bad request" : "Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mori website ${production ? "preview" : "dev"} → http://localhost:${port}`);
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
