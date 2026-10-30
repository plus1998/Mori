import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.ECO_E2E_ENV_FILE ?? path.join(desktopRoot, ".e2e-env.json");

function stopExistingEcoDesktopProcesses(): void {
  spawnSync("pkill", ["-f", "Electron.app.*apps/desktop"], { stdio: "ignore" });
}

function readPort(raw: string, label: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid ${label} port: ${raw}`);
  }
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isRendererReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForRenderer(url: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isRendererReady(url)) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Renderer did not start at ${url}`);
}

function runBuild(script: string): void {
  const result = spawnSync("bun", ["run", script], {
    cwd: desktopRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`bun run ${script} exited with ${result.status ?? 1}`);
  }
}

export default async function globalSetup(): Promise<void> {
  stopExistingEcoDesktopProcesses();
  runBuild("build:main");
  runBuild("build:preload");

  const rendererPort = readPort(process.env.ECO_RENDERER_PORT ?? "5173", "renderer");
  const rendererUrl = `http://127.0.0.1:${rendererPort}/`;

  let viteProcess: ReturnType<typeof spawn> | null = null;
  const rendererAlreadyRunning = await isRendererReady(rendererUrl);
  if (!rendererAlreadyRunning) {
    viteProcess = spawn(
      "./node_modules/.bin/vite",
      ["--host", "127.0.0.1", "--strictPort", "--port", String(rendererPort)],
      {
        cwd: desktopRoot,
        env: process.env,
        stdio: "pipe",
      },
    );
    await waitForRenderer(rendererUrl);
  }

  writeFileSync(
    envFile,
    JSON.stringify({
      rendererUrl,
      rendererPort,
      vitePid: viteProcess?.pid ?? null,
      startedVite: viteProcess !== null,
    }),
  );
}
