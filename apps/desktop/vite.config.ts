import { copyFileSync, cpSync, createReadStream, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const materialIconsSrc = path.resolve(rootDir, "node_modules/material-icon-theme/icons");

/**
 * Material Icon Theme stores some icons only as `*.clone.svg` (e.g. angular-service).
 * UI requests `iconName.svg` via getMaterialIconUrl — resolve to either form.
 */
function resolveMaterialIconDiskPath(iconFile: string): string | undefined {
  if (!iconFile || iconFile.includes("..") || iconFile.includes("/") || iconFile.includes("\\")) {
    return undefined;
  }
  const direct = path.join(materialIconsSrc, iconFile);
  if (existsSync(direct)) {
    return direct;
  }
  if (iconFile.endsWith(".svg") && !iconFile.endsWith(".clone.svg")) {
    const clonePath = path.join(materialIconsSrc, `${iconFile.slice(0, -".svg".length)}.clone.svg`);
    if (existsSync(clonePath)) {
      return clonePath;
    }
  }
  return undefined;
}

/** Ensure packaged dist also has standard `.svg` names for clone-only icons. */
function materializeCloneIconsAsSvg(destDir: string): void {
  for (const file of readdirSync(destDir)) {
    if (!file.endsWith(".clone.svg")) {
      continue;
    }
    const standardName = `${file.slice(0, -".clone.svg".length)}.svg`;
    const standardPath = path.join(destDir, standardName);
    if (!existsSync(standardPath)) {
      copyFileSync(path.join(destDir, file), standardPath);
    }
  }
}

function materialIconsPlugin(): Plugin {
  return {
    name: "eco-material-icons",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/material-icons/")) {
          next();
          return;
        }
        const iconFile = decodeURIComponent(url.slice("/material-icons/".length));
        const filePath = resolveMaterialIconDiskPath(iconFile);
        if (!filePath) {
          res.statusCode = iconFile ? 404 : 400;
          res.end(iconFile ? "Not found" : "Bad request");
          return;
        }
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        createReadStream(filePath).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(materialIconsSrc)) {
        throw new Error(`material-icon-theme icons missing at ${materialIconsSrc}`);
      }
      const dest = path.resolve(rootDir, "dist/renderer/material-icons");
      cpSync(materialIconsSrc, dest, { recursive: true });
      materializeCloneIconsAsSvg(dest);
    },
  };
}

/** Keep PDF workers, fonts and decoders local in development and packaged builds. */
function pdfPreviewAssetsPlugin(): Plugin {
  const source = path.resolve(rootDir, "node_modules/pdfjs-dist");
  const folders = ["cmaps", "standard_fonts", "wasm", "iccs"];
  return {
    name: "eco-pdf-preview-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/([^/?]+)(?:\?.*)?$/.exec(req.url ?? "");
        if (!match) {
          next();
          return;
        }
        const folder = match[1];
        const name = match[2];
        if (!folder || !name || name === "." || name === ".." || name.includes("%")) {
          res.statusCode = 400;
          res.end();
          return;
        }
        const file = path.join(source, folder, name);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader(
          "Content-Type",
          name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
        );
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const folder of folders)
        cpSync(path.join(source, folder), path.resolve(rootDir, "dist/renderer/pdfjs", folder), {
          recursive: true,
        });
    },
  };
}

export default defineConfig({
  plugins: [react(), materialIconsPlugin(), pdfPreviewAssetsPlugin()],
  root: ".",
  // Relative paths so loadFile(file://...) resolves assets next to index.html in packaged app.
  base: "./",
  // Dynamic grammar imports in the highlighter worker require ES module output.
  worker: { format: "es" },
  // Vite 预构建可能把 @lezer/highlight / @codemirror/* 拆成多份，
  // 导致 CodeMirror 语言包 load 后 token 不上色（社区高频问题）。
  // 强制去重，确保运行时只有单一实例。
  resolve: {
    dedupe: [
      "@lezer/highlight",
      "@lezer/common",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
    ],
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(rootDir, "index.html"),
        accountAssistant: path.resolve(rootDir, "codex-account-assistant.html"),
      },
      external: ["@anthropic-ai/claude-agent-sdk", "electron"],
      output: {
        manualChunks(id) {
          if (id.includes("/src/renderer/ActivityLogView")) {
            return "activity-log-view";
          }
          if (
            id.includes("/src/renderer/TerminalPanel") ||
            id.includes("/src/renderer/GhosttyTerminal") ||
            id.includes("node_modules/ghostty-web")
          ) {
            return "terminal-panel";
          }
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
