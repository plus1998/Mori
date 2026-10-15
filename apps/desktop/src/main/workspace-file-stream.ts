import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export const WORKSPACE_FILE_SCHEME = "eco-workspace";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".m4b": "audio/mp4",
  ".weba": "audio/webm",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".json": "application/json",
};

export type OpenWorkspaceStreamFile = (request: {
  workspacePath: string;
  filePath: string;
}) => Promise<{ handle: FileHandle; size: number }>;

/** A workspace capability is only issued by the desktop file-read IPC; URLs contain no disk path. */
export class WorkspaceFileStreams {
  private readonly roots = new Map<string, string>();
  private readonly tokens = new Map<string, string>();

  constructor(private readonly openFile: OpenWorkspaceStreamFile) {}

  urlForFile(workspacePath: string, filePath: string): string {
    const relative = path.relative(workspacePath, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("File must be inside the workspace.");
    let token = this.tokens.get(workspacePath);
    if (!token) {
      token = randomUUID();
      this.tokens.set(workspacePath, token);
      this.roots.set(token, workspacePath);
    }
    return `${WORKSPACE_FILE_SCHEME}://${token}/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
  }

  async respond(request: Request): Promise<Response> {
    const headers = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Range");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers });
    let handle: FileHandle | undefined;
    try {
      const url = new URL(request.url);
      const root = this.roots.get(url.hostname);
      if (url.protocol !== `${WORKSPACE_FILE_SCHEME}:` || !root)
        return new Response(null, { status: 403, headers });
      const filePath = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      const relative = path.relative(root, filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return new Response(null, { status: 403, headers });
      const file = await this.openFile({ workspacePath: root, filePath });
      handle = file.handle;
      const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "text/plain; charset=utf-8";
      headers.set("Content-Type", mime);
      headers.set(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
      );
      // HTML files may be opened directly too: their preview cannot execute scripts or send data out.
      if (mime.startsWith("text/html"))
        headers.set(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; style-src 'unsafe-inline' eco-workspace:; img-src data: blob: eco-workspace:; font-src data: eco-workspace:; media-src eco-workspace:; base-uri eco-workspace:; form-action 'none'",
        );
      const rangeHeader = request.headers.get("Range");
      const range = rangeHeader ? parseByteRange(rangeHeader, file.size) : undefined;
      if (rangeHeader && !range) {
        await handle.close();
        handle = undefined;
        headers.set("Content-Range", `bytes */${file.size}`);
        return new Response(null, { status: 416, headers });
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? file.size - 1;
      headers.set("Content-Length", String(Math.max(0, end - start + 1)));
      if (range) headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
      const status = range ? 206 : 200;
      if (request.method === "HEAD" || file.size === 0 || request.signal.aborted) {
        await handle.close();
        handle = undefined;
        return new Response(null, { status, headers });
      }
      const stream = handle.createReadStream({ start, end, autoClose: true, highWaterMark: 64 * 1024 });
      handle = undefined; // The stream owns and closes the validated descriptor, including cancellation.
      const abort = () => {
        stream.destroy();
      };
      request.signal.addEventListener("abort", abort, { once: true });
      stream.once("close", () => request.signal.removeEventListener("abort", abort));
      return new Response(
        Readable.toWeb(stream, {
          strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
        }) as ReadableStream<Uint8Array>,
        { status, headers },
      );
    } catch (error) {
      if (handle) await handle.close();
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return new Response(missing ? "File not found." : "File cannot be read from this workspace.", {
        status: missing ? 404 : 403,
        headers,
      });
    }
  }
}

export function parseByteRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return undefined;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return undefined;
  if (first === undefined)
    return last && last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : undefined;
  if (first >= size || (last !== undefined && last < first)) return undefined;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}
