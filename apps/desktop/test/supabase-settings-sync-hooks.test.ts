import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentOrchestrationStore } from "../src/main/agent-orchestration-store";
import { createAsrSettingsStore } from "../src/main/asr-settings-store";
import { createGitSettingsStore } from "../src/main/git-settings-store";
import { createImageGenerationStore } from "../src/main/image-generation-store";
import { createIntegratedWebSearchSettingsStore } from "../src/main/integrated-web-search-settings-store";
import { createLocalSecretCodec } from "../src/main/local-secret-codec";
import { createPackageScriptArgsStore } from "../src/main/package-script-args-store";
import { createPersonalizationSettingsStore } from "../src/main/personalization-settings-store";
import { createProviderStore } from "../src/main/provider-store";
import { createProxyBridgeSettingsStore } from "../src/main/proxy-bridge-settings-store";
import { createSshBookmarkStore } from "../src/main/ssh-bookmark-store";
import {
  filterSecretsForDomain,
  mergeDomainSecrets,
  secretKindsForDomain,
} from "../src/main/supabase-settings-sync";
import { createDesktopSettingsSyncHooks } from "../src/main/supabase-settings-sync-hooks";
import { createWorkflowSettingsStore } from "../src/main/workflow-settings-store";

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test("providers domain covers both provider and provider-proxy secret kinds", () => {
  expect(secretKindsForDomain("providers")).toEqual(["provider", "provider-proxy"]);
  expect(
    filterSecretsForDomain(
      [
        { kind: "provider", key: "p1", value: "k" },
        { kind: "provider-proxy", key: "p1", value: "socks5://x:1080" },
        { kind: "proxy", key: "upstream_proxy_url", value: "socks5://g:1080" },
      ],
      "providers",
    ).map((secret) => secret.kind),
  ).toEqual(["provider", "provider-proxy"]);
  expect(
    mergeDomainSecrets(
      [
        { kind: "provider-proxy", key: "p9", value: "socks5://old:1080" },
        { kind: "proxy", key: "upstream_proxy_url", value: "socks5://g:1080" },
      ],
      [
        { kind: "provider-proxy", key: "p1", value: "socks5://new:1080" },
        { kind: "proxy", key: "upstream_proxy_url", value: "socks5://g:1080" },
      ],
      "providers",
    )
      .filter((secret) => secret.kind === "provider-proxy")
      .map((secret) => secret.key),
  ).toEqual(["p1"]);
});

test.skipIf(!sqliteAvailable)("desktop sync hooks collect and apply per-provider proxy secrets", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-provider-proxy-sync-"));
  const dbPath = path.join(dir, "eco-coding.sqlite");
  const codec = createLocalSecretCodec();
  const providerStore = await createProviderStore(dbPath);
  const hooks = createDesktopSettingsSyncHooks({
    providerStore,
    asrSettingsStore: await createAsrSettingsStore(dbPath),
    imageGenerationStore: await createImageGenerationStore(dbPath),
    workflowSettingsStore: await createWorkflowSettingsStore(dbPath),
    agentOrchestrationStore: await createAgentOrchestrationStore(dbPath),
    proxyBridgeSettingsStore: await createProxyBridgeSettingsStore(dbPath),
    integratedWebSearchSettingsStore: await createIntegratedWebSearchSettingsStore(dbPath, codec),
    gitSettingsStore: await createGitSettingsStore(dbPath),
    personalizationSettingsStore: await createPersonalizationSettingsStore(dbPath),
    packageScriptArgsStore: createPackageScriptArgsStore(path.join(dir, "package-script-args.json")),
    sshBookmarkStore: await createSshBookmarkStore(dbPath, codec),
  });

  const provider = providerStore.saveProvider({
    name: "Proxied",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    upstreamProxyUrl: "socks5://p.example:7890",
    defaultModel: "m1",
    enabled: true,
  });

  // Collect: provider key + provider-proxy secret.
  const secrets = hooks.collectPlainSecrets();
  expect(secrets).toContainEqual({
    kind: "provider",
    key: provider.id,
    value: "k",
  });
  expect(secrets).toContainEqual({
    kind: "provider-proxy",
    key: provider.id,
    value: "socks5://p.example:7890",
  });

  // Apply without the provider-proxy secret: local proxy cleared, API key intact.
  hooks.applyDomainPlainSecrets(
    secrets.filter((secret) => !(secret.kind === "provider-proxy" && secret.key === provider.id)),
    "providers",
  );
  let withSecret = providerStore.getProviderWithSecret(provider.id)!;
  expect(withSecret.upstreamProxyUrl).toBeUndefined();
  expect(withSecret.apiKey).toBe("k");

  // Apply with the provider-proxy secret: local proxy restored.
  hooks.applyDomainPlainSecrets(secrets, "providers");
  withSecret = providerStore.getProviderWithSecret(provider.id)!;
  expect(withSecret.upstreamProxyUrl).toBe("socks5://p.example:7890");
  expect(withSecret.apiKey).toBe("k");

  // Unknown provider reference for provider-proxy is rejected.
  expect(() =>
    hooks.applyDomainPlainSecrets(
      [{ kind: "provider-proxy", key: "missing", value: "socks5://x:1080" }],
      "providers",
    ),
  ).toThrow("Cloud provider proxy secret references missing provider: missing");
});

test.skipIf(!sqliteAvailable)("desktop sync hooks carry package script args and prefixes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-script-overrides-sync-"));
  const dbPath = path.join(dir, "eco-coding.sqlite");
  const codec = createLocalSecretCodec();
  const packageScriptArgsStore = createPackageScriptArgsStore(path.join(dir, "package-script-args.json"));
  const hooks = createDesktopSettingsSyncHooks({
    providerStore: await createProviderStore(dbPath),
    asrSettingsStore: await createAsrSettingsStore(dbPath),
    imageGenerationStore: await createImageGenerationStore(dbPath),
    workflowSettingsStore: await createWorkflowSettingsStore(dbPath),
    agentOrchestrationStore: await createAgentOrchestrationStore(dbPath),
    proxyBridgeSettingsStore: await createProxyBridgeSettingsStore(dbPath),
    integratedWebSearchSettingsStore: await createIntegratedWebSearchSettingsStore(dbPath, codec),
    gitSettingsStore: await createGitSettingsStore(dbPath),
    personalizationSettingsStore: await createPersonalizationSettingsStore(dbPath),
    packageScriptArgsStore,
    sshBookmarkStore: await createSshBookmarkStore(dbPath, codec),
  });

  const workspace = path.join(dir, "repo");
  await packageScriptArgsStore.saveScriptOverrides(workspace, "dev", {
    args: "--port 3000",
    prefix: "nvm use 20",
  });
  await packageScriptArgsStore.warmCache();

  const payload = hooks.collectSettingsPayload();
  expect(payload.packageScriptArgs).toEqual({ [workspace]: { dev: "--port 3000" } });
  expect(payload.packageScriptPrefixes).toEqual({ [workspace]: { dev: "nvm use 20" } });

  // Cloud snapshot from an older app version: args only, local prefixes survive.
  await packageScriptArgsStore.saveScriptOverrides(workspace, "dev", { args: "--port 4000" });
  await hooks.applySettingsPayload({
    ...payload,
    packageScriptPrefixes: undefined,
  });
  expect(await packageScriptArgsStore.getWorkspaceOverrides(workspace)).toEqual({
    args: { dev: "--port 3000" },
    prefixes: { dev: "nvm use 20" },
  });

  // Full snapshot replaces both maps.
  await hooks.applySettingsPayload({
    ...payload,
    packageScriptArgs: { [workspace]: { build: "--verbose" } },
    packageScriptPrefixes: { [workspace]: { build: "nvm use 18" } },
  });
  expect(await packageScriptArgsStore.getWorkspaceOverrides(workspace)).toEqual({
    args: { build: "--verbose" },
    prefixes: { build: "nvm use 18" },
  });
});

test.skipIf(!sqliteAvailable)(
  "desktop sync hooks carry per-core User-Agents and keep them out of other domains",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-agent-ua-sync-"));
    const dbPath = path.join(dir, "eco-coding.sqlite");
    const codec = createLocalSecretCodec();
    const proxyBridgeSettingsStore = await createProxyBridgeSettingsStore(dbPath);
    const hooks = createDesktopSettingsSyncHooks({
      providerStore: await createProviderStore(dbPath),
      asrSettingsStore: await createAsrSettingsStore(dbPath),
      imageGenerationStore: await createImageGenerationStore(dbPath),
      workflowSettingsStore: await createWorkflowSettingsStore(dbPath),
      agentOrchestrationStore: await createAgentOrchestrationStore(dbPath),
      proxyBridgeSettingsStore,
      integratedWebSearchSettingsStore: await createIntegratedWebSearchSettingsStore(dbPath, codec),
      gitSettingsStore: await createGitSettingsStore(dbPath),
      personalizationSettingsStore: await createPersonalizationSettingsStore(dbPath),
      packageScriptArgsStore: createPackageScriptArgsStore(path.join(dir, "package-script-args.json")),
      sshBookmarkStore: await createSshBookmarkStore(dbPath, codec),
    });

    proxyBridgeSettingsStore.save({ upstreamUserAgents: { codex: "codex/1", pi: "pi/1" } });
    const payload = hooks.collectSettingsPayload();
    expect(payload.proxyBridge?.upstreamUserAgents).toEqual({ codex: "codex/1", pi: "pi/1" });

    // A cloud snapshot replaces the local per-core map.
    await hooks.applySettingsPayload({
      ...payload,
      proxyBridge: { upstreamUserAgents: { claude: "claude/2" } },
    });
    expect(proxyBridgeSettingsStore.get().upstreamUserAgents).toEqual({ claude: "claude/2" });

    // An older/legacy snapshot that lacks the field follows the same rule as the
    // global UA: the cloud snapshot wins, so a missing field means "cleared".
    await hooks.applySettingsPayload({ ...payload, proxyBridge: {} });
    expect(proxyBridgeSettingsStore.get().upstreamUserAgents).toBeUndefined();

    // A snapshot without proxyBridge at all also clears it.
    proxyBridgeSettingsStore.save({ upstreamUserAgents: { pi: "pi/9" } });
    await hooks.applySettingsPayload({ ...payload, proxyBridge: undefined });
    expect(proxyBridgeSettingsStore.get().upstreamUserAgents).toBeUndefined();
  },
);
