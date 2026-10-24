import electronPath from "electron";
import { createDevProcesses } from "./dev-processes.mjs";
import { resolveDevEcoGatewayPortForLog } from "./dev-gateway-port.mjs";
import {
  devRemoteDebuggingElectronArgs,
  resolveDevRemoteDebuggingPort,
} from "./dev-remote-debugging-port.mjs";

const rendererPort = readPort(process.env.ECO_RENDERER_PORT ?? "5173", "renderer");
const rendererUrl = `http://127.0.0.1:${rendererPort}/`;
const { start, run, fail } = createDevProcesses();

async function main() {
  await run("bun", ["run", "build:main"]);
  await run("bun", ["run", "build:preload"]);

  console.error("[eco] 主进程仅在 dev 启动时编译一次；修改 apps/desktop/src/main 后请重启 bun run dev。");
  console.error(
    "[eco] Dev userData 追加后缀 Dev（可用 ECO_DEV_USER_DATA_SUFFIX 覆盖），可与已安装的发布版并行。",
  );
  const devCdpPort = resolveDevRemoteDebuggingPort();
  if (devCdpPort !== undefined) {
    console.error(`[eco] Dev CDP: http://127.0.0.1:${devCdpPort}/json（Electron 主窗口；关闭: ECO_DEV_CDP=0）`);
  }
  const devGatewayPort = resolveDevEcoGatewayPortForLog();
  console.error(
    `[eco] Dev eco-bridge: http://127.0.0.1:${devGatewayPort}/（发布版默认 18765；可用 ECO_GATEWAY_PORT 覆盖）`,
  );

  const rendererAlreadyRunning = await isRendererReady();
  if (!rendererAlreadyRunning) {
    start("./node_modules/.bin/vite", ["--host", "127.0.0.1", "--strictPort", "--port", String(rendererPort)]);
    await waitForRenderer();
  }

  start(
    electronPath,
    [".", "--enable-logging", ...devRemoteDebuggingElectronArgs(devCdpPort)],
    {
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: rendererUrl,
        ELECTRON_ENABLE_LOGGING: "1",
        ECO_DEV_CDP: process.env.ECO_DEV_CDP ?? "1",
        ...(devCdpPort !== undefined ? { ECO_DEV_CDP_PORT: String(devCdpPort) } : {}),
      },
    },
  );
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
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid ${label} port: ${raw}`);
  }
  return port;
}
