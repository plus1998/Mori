import { runScriptedPiSession, type ProbeSessionOptions } from "./pi-session-events-probe";

const options = JSON.parse(await Bun.stdin.text()) as Pick<
  ProbeSessionOptions,
  "workspace" | "agentDir" | "threadId" | "turns"
>;
const result = await runScriptedPiSession(options);
try {
  console.log(JSON.stringify({ events: result.events, requests: result.requests, turnCount: result.turnCount }));
} finally {
  await result.dispose();
}
