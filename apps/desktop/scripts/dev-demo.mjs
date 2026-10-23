import electronPath from "electron";
import { createDevProcesses } from "./dev-processes.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const rendererPort = readPort(process.env.ECO_RENDERER_PORT ?? "5173", "renderer");
const rendererUrl = `http://127.0.0.1:${rendererPort}/`;
const { start, run, fail } = createDevProcesses({ cwd: desktopRoot });

async function main() {
  console.error("[eco-demo] 启动演示模式：使用 mock IPC，不连接真实 Agent / 网关 / SQLite。");

  await run("bun", ["run", "build:demo-main"]);
  await run("bun", ["run", "build:preload"]);

  const rendererAlreadyRunning = await isRendererReady();
  if (!rendererAlreadyRunning) {
    start("./node_modules/.bin/vite", ["--host", "127.0.0.1", "--strictPort", "--port", String(rendererPort)]);
    await waitForRenderer();
  }

  start(electronPath, ["dist/demo-main/demo.js"], {
    env: {
      ...process.env,
      ECO_DEMO: "1",
      VITE_DEV_SERVER_URL: rendererUrl,
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
}

void main().catch(fail);

async function waitForRenderer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (await isRendererReady()) return;
    await delay(250);
  }
  throw new Error(`Renderer did not start at ${rendererUrl}`);
}

async function isRendererReady() {
  try {
    const response = await fetch(rendererUrl);
    return response.ok;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPort(raw, label) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid ${label} port: ${raw}`);
  }
  return parsed;
}
