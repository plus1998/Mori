import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.ECO_E2E_ENV_FILE ?? path.join(desktopRoot, ".e2e-env.json");

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(envFile)) {
    return;
  }

  const env = JSON.parse(readFileSync(envFile, "utf8")) as {
    startedVite?: boolean;
    vitePid?: number | null;
  };

  if (env.startedVite && typeof env.vitePid === "number" && env.vitePid > 0) {
    try {
      process.kill(env.vitePid, "SIGTERM");
    } catch {
      // Vite may already have exited.
    }
  }

  unlinkSync(envFile);
}
