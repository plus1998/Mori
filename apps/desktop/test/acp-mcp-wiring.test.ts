import { expect, test } from "bun:test";
import fs from "node:fs";

const indexSource = fs.readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
const runSource = fs.readFileSync(new URL("../src/main/acp-runtime-run.ts", import.meta.url), "utf8");

test("ACP runtime deps map Eco session MCP onto Cursor session/new and session/load", () => {
  expect(indexSource).toContain("toAcpMcpServers");
  expect(indexSource).toContain("resolveAcpMcpServers:");
  const start = indexSource.indexOf("resolveAcpMcpServers:");
  expect(start).toBeGreaterThanOrEqual(0);
  const slice = indexSource.slice(start, start + 400);
  expect(slice).toContain("resolvePiSessionResourcesForThread");
  expect(slice).toContain("toAcpMcpServers(prepared.mcpServers)");
});

/**
 * The body of a top-level declaration.
 *
 * These assertions are about which statements a function contains, not about how many
 * characters they occupy: a fixed character window fails the moment the file is
 * reformatted (it did, at 1800 vs 1817) and says nothing about the behaviour that changed.
 */
function declarationBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + declaration.length);
  const next = rest.search(/\n(?:export )?(?:async )?function |\n\/\*\*/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("ACP continuation persists Composer runtime config before the next Cursor session/load", () => {
  const body = declarationBody(indexSource, "async function startAcpThreadContinuation");
  expect(body).toContain("runtimeConfigInput");
  expect(body).toContain("saveThreadRuntimeConfig");
  expect(body).toContain("normalizeThreadRuntimeConfig");
});

test("ACP run always forwards resolved mcpServers to the driver", () => {
  expect(runSource).toContain("const mcpServers = deps.resolveAcpMcpServers");
  expect(runSource).toContain("mcpServers,");
});

test("ACP run wires Eco permission handler onto the driver", () => {
  expect(indexSource).toContain("resolveAcpPermissionHandler:");
  expect(indexSource).toContain("createAcpPermissionHandler");
  expect(indexSource).toContain('reviewThreadToolApproval(threadId, request, tool, "acp")');
  expect(indexSource).toContain("log: (phase, payload) => logUpstream(phase, payload)");
  expect(runSource).toContain("resolveAcpPermissionHandler");
  expect(runSource).toContain("onRequestPermission");
  expect(runSource).not.toContain("bashReviewMode");
});

test("ACP running threads can still change bashReviewMode via the shared busy-run policy", () => {
  const start = indexSource.indexOf("IPC_CHANNELS.threadUpdateRuntimeConfig");
  expect(start).toBeGreaterThanOrEqual(0);
  const slice = indexSource.slice(start, start + 2200);
  expect(slice).toContain("resolveBusyThreadRuntimeConfigUpdate");
  expect(slice).not.toMatch(
    /coreKind === "acp"[\s\S]{0,180}status === "running"[\s\S]{0,180}请等待当前运行结束后再修改配置/,
  );
});

test("runtime-config updates that only touch mid-run-safe fields keep the locked snapshot", () => {
  const start = indexSource.indexOf("IPC_CHANNELS.threadUpdateRuntimeConfig");
  const slice = indexSource.slice(start, start + 5200);
  // bashReviewMode + auxiliary / approval / vision selections are re-read per request,
  // so they patch the stored config instead of rematerializing the session snapshot.
  expect(slice).toContain("isBusyMutableOnlyRuntimeConfigUpdate(existing, incoming)");
  expect(slice).toContain("applyBusyMutableRuntimeConfigFields(existing, incoming)");
  expect(slice).toContain("isBusyMutableOnlyRuntimeConfigUpdate(existing, runtimeConfig)");
});
