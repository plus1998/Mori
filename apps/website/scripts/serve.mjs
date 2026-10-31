import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assets, websiteRoot } from "./assets.mjs";

const args = process.argv.slice(2);
const production = args.includes("--dist");
const portIndex = args.indexOf("--port");
const port = Number(portIndex < 0 ? 4321 : args[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("--port must be an integer between 1 and 65535");
}
const root = resolve(websiteRoot, production ? "dist" : "src");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
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
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filename)] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    if (request.method === "HEAD") response.end();
    else
      createReadStream(filename)
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
