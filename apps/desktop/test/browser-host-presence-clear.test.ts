import fs from "node:fs";
import path from "node:path";
import { expect, mock, test } from "bun:test";

// BrowserHost imports electron main-process modules at module load time —
// stub them before the dynamic import so the test runs under bun.
mock.module("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler: () => {}, on: () => {}, off: () => {} }) },
  shell: { openExternal: async () => true },
  webContents: { fromId: () => undefined },
  BrowserWindow: class {},
  app: { on: () => {}, getAppPath: () => "" },
  ipcMain: { handle: () => {}, on: () => {} },
  nativeTheme: { shouldUseDarkColors: false },
  contextBridge: {},
  clipboard: {},
  screen: {},
}));

const { BrowserHost } = await import("../src/main/browser-host");
import type { BrowserAgentPresenceEvent } from "../src/shared/browser-agent-presence";

function createTestHost(presence: BrowserAgentPresenceEvent[]): BrowserHost {
  return new BrowserHost({
    getMainWindow: () => undefined,
    getSettings: () => ({ get: () => ({ agentIntegrationEnabled: false }) }) as never,
    broadcast: () => {},
    broadcastAgentPresence: (event: BrowserAgentPresenceEvent) => {
      presence.push(event);
    },
    resolveWorkspacePath: () => "/tmp/ws-t1",
  } as never);
}

test("clearAgentPresenceForThread emits idle for every browser in the thread scope", async () => {
  const presence: BrowserAgentPresenceEvent[] = [];
  const host = createTestHost(presence);
  try {
    await host.openSharedSession({ threadId: "t1", workspacePath: "/tmp/ws-t1", revealUi: false });
    await host.openSharedSession({
      threadId: "t1",
      workspacePath: "/tmp/ws-t1",
      revealUi: false,
      newBrowser: true,
      updateUiFocus: false,
    });
    const state = host.getState();
    // Only one scope exists in this test, so allGuestInstances == thread browsers.
    const browserIds = state.allGuestInstances.map((b) => b.id);
    expect(browserIds.length).toBe(2);

    host.noteAgentPresenceForThread("t1");
    const activeIds = presence.filter((e) => e.type === "active").map((e) => e.browserId);
    expect(activeIds.length).toBeGreaterThan(0);

    host.clearAgentPresenceForThread("t1");
    const idleIds = presence.filter((e) => e.type === "idle").map((e) => e.browserId);
    for (const id of browserIds) {
      expect(idleIds).toContain(id);
    }
    // Clearing cancels the pending 15s idle timer — no extra idle for the
    // active browser after its scheduled fire.
    const idleCountForBrowser = (browserId: string) =>
      presence.filter((e) => e.type === "idle" && e.browserId === browserId).length;
    for (const id of browserIds) {
      expect(idleCountForBrowser(id)).toBe(1);
    }
  } finally {
    host.dispose();
  }
});

test("clearAgentPresenceForThread is a no-op for unknown threads", async () => {
  const presence: BrowserAgentPresenceEvent[] = [];
  const host = createTestHost(presence);
  try {
    host.clearAgentPresenceForThread("no-such-thread");
    host.clearAgentPresenceForThread("   ");
    expect(presence.length).toBe(0);
  } finally {
    host.dispose();
  }
});

test("finishActiveRun clears browser presence when the agent run ends", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/main/index.ts"),
    "utf8",
  );
  const fnMatch = source.match(/function finishActiveRun\(threadId: string\): void \{([\s\S]*?)\n\}/);
  expect(fnMatch, "finishActiveRun must exist in index.ts").toBeDefined();
  expect(fnMatch?.[1]).toContain("clearAgentPresenceForThread(threadId)");
});
