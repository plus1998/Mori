import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { CenterServerSettingsPanel } from "../src/renderer/CenterServerSettingsPanel";
import type { CenterServerSettingsSnapshot } from "../src/shared/center-server";
import { renderLocalized } from "./i18n-test";

const connectedSnapshot: CenterServerSettingsSnapshot = {
  settings: {
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    serverUrl: "https://example.supabase.co",
    hasAnonKey: true,
    deviceId: "dev_1",
    deviceName: "Eco Desktop",
    hasDeviceSecret: true,
    hasRefreshToken: true,
  },
  status: {
    state: "connected",
    connectedAt: "2026-08-18T00:00:00.000Z",
  },
};

function renderPanel(snapshot: CenterServerSettingsSnapshot = connectedSnapshot, busy = false) {
  return renderLocalized(
    createElement(CenterServerSettingsPanel, {
      snapshot,
      busy,
      onSave: async () => snapshot,
      onTestConnection: async () => ({ ok: true }),
      onSignUp: async () => ({
        ...snapshot,
        user: { id: "u1", email: "a@b.c", displayName: null, createdAt: "2026-08-18T00:00:00.000Z" },
      }),
      onSignIn: async () => ({
        ...snapshot,
        user: { id: "u1", email: "a@b.c", displayName: null, createdAt: "2026-08-18T00:00:00.000Z" },
      }),
      onCreatePairing: async () => ({
        pairingId: "pair_1",
        code: "123456",
        bootstrapToken: "token",
        qrPayload: "eco://pair",
        expiresAt: "2026-08-18T01:00:00.000Z",
      }),
      onListBindings: async () => [],
      onListPresence: async () => [],
      onRevokeBinding: async () => ({
        id: "bind_1",
        userId: "user_1",
        desktopDeviceId: "dev_1",
        mobileDeviceId: "mob_1",
        capabilities: [],
        createdAt: "2026-08-18T00:00:00.000Z",
        revokedAt: null,
      }),
      onConnect: async () => snapshot,
      onDisconnect: async () => snapshot,
      onRemoveConnection: async () => snapshot,
      onGetVaultStatus: async () => ({ hasVaultKey: false, state: "idle" as const }),
      onGetSyncStatus: async () => ({
        domains: [
          {
            domain: "providers" as const,
            state: "dirty" as const,
            summary: "1 · OpenAI",
          },
        ],
      }),
      onRequestVaultClaim: async () => ({
        claimId: "claim_1",
        expiresAt: "2026-08-18T01:00:00.000Z",
      }),
      onListPendingVaultClaims: async () => [],
      onApproveVaultClaim: async () => ({
        claimId: "claim_1",
        code: "123456",
        expiresAt: "2026-08-18T01:00:00.000Z",
      }),
      onSubmitVaultClaimCode: async () => ({
        ok: true,
        vaultStatus: { hasVaultKey: true, state: "idle" as const },
      }),
      onCancelVaultClaim: async () => ({ hasVaultKey: false, state: "idle" as const }),
    }),
    "zh-CN",
  );
}

test("connected connection panel keeps switch and delete enabled", () => {
  const markup = renderPanel();

  expect(markup).toContain("互联");
  expect(markup).toContain("Supabase Cloud 部署");
  expect(markup).toContain("删除连接");
  expect(markup).toContain('role="switch" aria-checked="true"');
  expect(markup).not.toMatch(/role="switch"[^>]*disabled/);
  expect(markup).not.toMatch(/cs-text-action is-muted"[^>]*disabled[^>]*>[\s\S]*?删除连接/);
});

test("connected connection panel shows sync status instead of pull/push buttons", () => {
  const markup = renderPanel();

  expect(markup).toContain("同步");
  expect(markup).toContain("设备");
  expect(markup).toContain("同步状态");
  expect(markup).toContain("在各设置页使用云图标单独拉取或推送");
  expect(markup).not.toContain("从云端更新");
  expect(markup).not.toContain("推送到云端");
});

test("saving still disables switch and delete", () => {
  const markup = renderPanel(connectedSnapshot, true);

  expect(markup).toMatch(/role="switch"[^>]*disabled/);
  expect(markup).toMatch(/cs-text-action is-muted"[^>]*disabled[^>]*>[\s\S]*?删除连接/);
});

test("bindings loading is not part of connection action busy", () => {
  const source = readFileSync(
    new URL("../src/renderer/CenterServerSettingsPanel.tsx", import.meta.url),
    "utf8",
  );
  expect(source).toContain("connectionBusy || saveBusy || authBusy || vaultBusy");
  expect(source).not.toContain("connectionBusy || bindingsLoading || saveBusy");
});
