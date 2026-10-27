import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { OpenAIAccountService } from "./apps/desktop/src/main/openai-account-service";
import { CodexAppServerClient } from "@eco/runtime/codex-app-server-client";

const exe = "/Applications/Mori.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
const auth = await fs.readFile("/tmp/acct_auth.json", "utf8");
const userData = await fs.mkdtemp(path.join(os.tmpdir(), "eco-active-quota-"));

let spawnCount = 0;
const service = new OpenAIAccountService(
  userData,
  () => exe,
  (state) => console.log("[changed]", JSON.stringify(state.syncStatus)),
  async () => {
    spawnCount += 1;
    const home = path.join(userData, "codex");
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.CODEX_ACCESS_TOKEN;
    const child = spawn(exe, ["app-server", "--stdio"], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const client = CodexAppServerClient.attachToProcess(child, { timeoutMs: 30_000 });
    await client.initialize({ clientInfo: { name: "eco_coding", title: "Mori", version: "0.1.0" } });
    return client;
  },
);
await service.initialize();
console.log("syncStatus after init:", JSON.stringify(service.getSyncStatus()));
const account = await service.createAccount({ name: "repro", email: "wbhxjc8wxqim@post.com" });
await service.setAuthJson(account.id, auth);
await service.setActiveAccount(account.id);
await service.applyPendingTransition();
console.log("pending:", service.getPendingAccountId(), "syncStatus:", JSON.stringify(service.getSyncStatus()));
console.log("active:", await service.getActiveAccountId());
try {
  const quota = await service.queryQuota(account.id);
  console.log("QUOTA OK:", JSON.stringify(quota));
} catch (error) {
  console.log("QUOTA FAILED:", error instanceof Error ? error.message : String(error));
}
console.log("spawnCount:", spawnCount, "syncStatus:", JSON.stringify(service.getSyncStatus()));
const main = await fs.readFile(path.join(userData, "codex/auth.json")).catch(() => null);
console.log("main auth published:", main !== null);
await service.dispose();
await fs.rm(userData, { recursive: true, force: true });
