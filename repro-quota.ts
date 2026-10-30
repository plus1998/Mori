import { spawn } from "node:child_process";
import { CodexAppServerClient } from "@eco/runtime/codex-app-server-client";

const exe = "/Applications/Mori.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
const home = "/tmp/codexrepro";
const env = { ...process.env, CODEX_HOME: home, HOME: home };
delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.CODEX_ACCESS_TOKEN;
const child = spawn(exe, ["app-server", "--stdio", "-c", 'cli_auth_credentials_store="file"'], { env, stdio: ["pipe","pipe","pipe"] });
child.stderr.setEncoding("utf8");
let stderr = "";
child.stderr.on("data", (c) => { stderr += c; });
const client = CodexAppServerClient.attachToProcess(child, { timeoutMs: 30000 });
try {
  await client.initialize({ clientInfo: { name: "eco_coding", title: "Mori", version: "0.1.0" } });
  const acct = await client.request("account/read", { refreshToken: false }, { timeoutMs: 30000 });
  console.log("ACCOUNT:", JSON.stringify(acct));
  try {
    const rl = await client.request("account/rateLimits/read", undefined, { timeoutMs: 30000 });
    console.log("RATELIMITS:", JSON.stringify(rl, null, 2));
  } catch (e) {
    console.log("RATELIMITS ERROR:", (e as Error).message);
  }
} catch (e) {
  console.log("ERROR:", (e as Error).message);
} finally {
  client.close();
  child.kill("SIGTERM");
  if (stderr.trim()) console.log("STDERR:\n" + stderr.slice(-4000));
}
