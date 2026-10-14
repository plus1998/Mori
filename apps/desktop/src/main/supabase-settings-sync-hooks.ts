/**
 * Build SettingsSyncHooks from Desktop provider / ASR / image / workflow / orchestration stores.
 */

import type { ImageGenerationProfileSaveInput } from "../shared/image-generation";
import type {
  AsrApiMode,
  AsrProfileSaveInput,
  CandidateModelInput,
  ProviderConfigInput,
  RouteProfileInput,
} from "../shared/ipc";
import type { AgentOrchestrationStore } from "./agent-orchestration-store";
import type { AsrSettingsStore } from "./asr-settings-store";
import { type GitSettingsStore, normalizeGitSettingsSnapshot } from "./git-settings-store";
import type { ImageGenerationStore } from "./image-generation-store";
import type { IntegratedWebSearchSettingsStore } from "./integrated-web-search-settings-store";
import type { PackageScriptArgsStore } from "./package-script-args-store";
import {
  normalizePersonalizationSettingsSnapshot,
  type PersonalizationSettingsStore,
} from "./personalization-settings-store";
import type { ProjectOrchestrationSettingsStore } from "./project-orchestration-settings-store";
import type { ProviderStore } from "./provider-store";
import type { ProxyBridgeSettingsStore } from "./proxy-bridge-settings-store";
import { resolveOutboundProxyUrl, resolveUpstreamUserAgentOverrides } from "./proxy-bridge-settings-store";
import type { SshBookmarkStore } from "./ssh-bookmark-store";
import { sshBookmarkSecretKeyKey, sshBookmarkSecretPasswordKey } from "./ssh-bookmark-store";
import {
  type DomainSettingsSyncHooks,
  ECO_INTEGRATED_WEB_SEARCH_API_KEY_SECRET,
  ECO_PROXY_URL_SECRET,
  ECO_WORKFLOW_CURSOR_API_KEY_SECRET,
  type EcoPlainSecret,
  type EcoSettingsSyncDomain,
  type EcoSyncedProxyBridgeSettings,
  type EcoSyncedSettingsPayload,
  type EcoSyncedWorkflowSettings,
  emptyEcoSyncedSettingsPayload,
  filterSecretsForDomain,
  syncableAgentTemplates,
} from "./supabase-settings-sync";
import type { WorkflowSettingsStore } from "./workflow-settings-store";

export function createDesktopSettingsSyncHooks(input: {
  providerStore: ProviderStore;
  asrSettingsStore: AsrSettingsStore;
  imageGenerationStore: ImageGenerationStore;
  workflowSettingsStore: WorkflowSettingsStore;
  agentOrchestrationStore: AgentOrchestrationStore;
  proxyBridgeSettingsStore: ProxyBridgeSettingsStore;
  integratedWebSearchSettingsStore: IntegratedWebSearchSettingsStore;
  gitSettingsStore: GitSettingsStore;
  personalizationSettingsStore: PersonalizationSettingsStore;
  packageScriptArgsStore: PackageScriptArgsStore;
  projectOrchestrationSettingsStore?: ProjectOrchestrationSettingsStore;
  sshBookmarkStore: SshBookmarkStore;
}): DomainSettingsSyncHooks {
  return {
    collectSettingsPayload: () => collectPayload(input),
    applySettingsPayload: (payload) => applyPayload(input, payload),
    collectPlainSecrets: () => collectSecrets(input),
    applyPlainSecrets: (secrets) => applySecrets(input, secrets),
    applyDomainPlainSecrets: (secrets, domain) => applyDomainSecrets(input, secrets, domain),
  };
}

function isUserOwnedSource(source: string | undefined): boolean {
  return source === "user" || source === undefined;
}

function collectPayload(input: {
  providerStore: ProviderStore;
  asrSettingsStore: AsrSettingsStore;
  imageGenerationStore: ImageGenerationStore;
  workflowSettingsStore: WorkflowSettingsStore;
  agentOrchestrationStore: AgentOrchestrationStore;
  proxyBridgeSettingsStore: ProxyBridgeSettingsStore;
  integratedWebSearchSettingsStore: IntegratedWebSearchSettingsStore;
  gitSettingsStore: GitSettingsStore;
  personalizationSettingsStore: PersonalizationSettingsStore;
  packageScriptArgsStore: PackageScriptArgsStore;
  sshBookmarkStore: SshBookmarkStore;
}): EcoSyncedSettingsPayload {
  const providers = input.providerStore.listProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    requestPath: provider.requestPath,
    version: provider.version,
    apiCompat: provider.apiCompat,
    ...(provider.tokenCountMode ? { tokenCountMode: provider.tokenCountMode } : {}),
    ...(provider.authMethod ? { authMethod: provider.authMethod } : {}),
    ...(provider.credentialPoolId ? { credentialPoolId: provider.credentialPoolId } : {}),
    defaultModel: provider.defaultModel,
    enabled: provider.enabled,
  }));

  const asr = input.asrSettingsStore.listProfiles();
  const image = input.imageGenerationStore.getSettings();
  const orchestration = input.agentOrchestrationStore;
  const packageScriptOverrides = input.packageScriptArgsStore.getAllSnapshotSync();
  const proxyBridge = input.proxyBridgeSettingsStore.get();
  const upstreamUserAgents = resolveUpstreamUserAgentOverrides(proxyBridge);

  return {
    version: 1,
    providers,
    asr: {
      activeProfileId: asr.activeProfileId,
      profiles: asr.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        endpoint: profile.endpoint,
        apiMode: profile.apiMode,
        model: profile.model,
        systemPrompt: profile.systemPrompt,
      })),
    },
    imageGeneration: {
      enabled: image.enabled,
      activeProfileId: image.activeProfileId,
      profiles: image.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        endpoint: profile.endpoint,
        model: profile.model,
        supportsImageToImage: profile.supportsImageToImage,
      })),
    },
    mainAgentConfigs: orchestration.listMainAgentConfigs().filter((row) => isUserOwnedSource(row.source)),
    mainAgentPrompts: orchestration.listMainAgentPrompts().filter((row) => isUserOwnedSource(row.source)),
    subagentOrchestrations: orchestration
      .listSubagentOrchestrations()
      .filter((row) => isUserOwnedSource(row.source)),
    agentTemplates: syncableAgentTemplates(orchestration.listAgentTemplates()),
    candidateModels: providers.flatMap((provider) =>
      input.providerStore.listCandidateModels(provider.id).map(
        (candidate): CandidateModelInput => ({
          id: candidate.id,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          ...(candidate.displayName ? { displayName: candidate.displayName } : {}),
          ...(candidate.modelsDevMapping ? { modelsDevMapping: candidate.modelsDevMapping } : {}),
          ...(candidate.manualSpec ? { manualSpec: candidate.manualSpec } : {}),
          sortOrder: candidate.sortOrder,
        }),
      ),
    ),
    routeProfiles: input.providerStore.listRouteProfiles().map(
      (profile): RouteProfileInput => ({
        id: profile.id,
        name: profile.name,
        routes: profile.routes,
      }),
    ),
    proxyBridge: {
      ...(proxyBridge.upstreamUserAgent ? { upstreamUserAgent: proxyBridge.upstreamUserAgent } : {}),
      ...(upstreamUserAgents ? { upstreamUserAgents } : {}),
      integratedWebSearch: {
        enabled: input.integratedWebSearchSettingsStore.get().enabled,
        provider: input.integratedWebSearchSettingsStore.get().provider,
        approvalMode: input.integratedWebSearchSettingsStore.get().approvalMode,
      },
    },
    git: input.gitSettingsStore.get(),
    personalization: input.personalizationSettingsStore.get(),
    packageScriptArgs: packageScriptOverrides.args,
    packageScriptPrefixes: packageScriptOverrides.prefixes,
    sshBookmarks: input.sshBookmarkStore.getSnapshot().bookmarks,
  };
}

async function applyPayload(
  input: {
    providerStore: ProviderStore;
    asrSettingsStore: AsrSettingsStore;
    imageGenerationStore: ImageGenerationStore;
    workflowSettingsStore: WorkflowSettingsStore;
    agentOrchestrationStore: AgentOrchestrationStore;
    proxyBridgeSettingsStore: ProxyBridgeSettingsStore;
    integratedWebSearchSettingsStore: IntegratedWebSearchSettingsStore;
    gitSettingsStore: GitSettingsStore;
    personalizationSettingsStore: PersonalizationSettingsStore;
    packageScriptArgsStore: PackageScriptArgsStore;
    projectOrchestrationSettingsStore?: ProjectOrchestrationSettingsStore;
    sshBookmarkStore: SshBookmarkStore;
  },
  payload: EcoSyncedSettingsPayload,
): Promise<void> {
  if (payload.version !== 1) {
    throw new Error(`Unsupported settings payload version: ${String(payload.version)}`);
  }

  const remoteProviderIds = new Set(payload.providers.map((provider) => provider.id));
  const remoteCandidateIds = new Set((payload.candidateModels ?? []).map((candidate) => candidate.id));
  const remoteAsrIds = new Set(payload.asr.profiles.map((profile) => profile.id));
  const remoteImageIds = new Set(payload.imageGeneration.profiles.map((profile) => profile.id));
  const remoteTemplateIds = new Set((payload.agentTemplates ?? []).map((template) => template.id));
  const remoteMainConfigIds = new Set((payload.mainAgentConfigs ?? []).map((config) => config.id));
  const remoteMainPromptIds = new Set((payload.mainAgentPrompts ?? []).map((prompt) => prompt.id));
  const remoteSubagentIds = new Set(
    (payload.subagentOrchestrations ?? []).map((orchestration) => orchestration.id),
  );

  for (const provider of payload.providers) {
    const saveInput: ProviderConfigInput = {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      requestPath: provider.requestPath,
      version: provider.version,
      apiCompat: provider.apiCompat as NonNullable<ProviderConfigInput["apiCompat"]>,
      ...(provider.tokenCountMode
        ? {
            tokenCountMode: provider.tokenCountMode as NonNullable<ProviderConfigInput["tokenCountMode"]>,
          }
        : {}),
      ...(provider.authMethod
        ? { authMethod: provider.authMethod as NonNullable<ProviderConfigInput["authMethod"]> }
        : {}),
      ...(provider.credentialPoolId ? { credentialPoolId: provider.credentialPoolId } : {}),
      defaultModel: provider.defaultModel,
      enabled: provider.enabled,
      // Omit apiKey so existing local key is preserved until secrets pull.
    };
    input.providerStore.saveProvider(saveInput);
  }

  for (const candidate of payload.candidateModels ?? []) {
    input.providerStore.saveCandidateModel(candidate);
  }
  // Full snapshot: drop local-only providers/candidates before route replace.
  for (const provider of input.providerStore.listProviders()) {
    if (!remoteProviderIds.has(provider.id)) {
      input.providerStore.deleteProvider(provider.id);
      continue;
    }
    for (const candidate of input.providerStore.listCandidateModels(provider.id)) {
      if (!remoteCandidateIds.has(candidate.id)) {
        input.providerStore.deleteCandidateModel(candidate.id);
      }
    }
  }
  input.providerStore.replaceRouteProfilesForSync(payload.routeProfiles ?? []);

  for (const profile of payload.asr.profiles) {
    const saveInput: AsrProfileSaveInput = {
      id: profile.id,
      name: profile.name,
      endpoint: profile.endpoint,
      apiMode: profile.apiMode as AsrApiMode,
      model: profile.model,
      systemPrompt: profile.systemPrompt,
    };
    input.asrSettingsStore.saveProfile(saveInput);
  }
  // Activate before pruning so local-only active profiles can be deleted.
  if (payload.asr.activeProfileId && remoteAsrIds.has(payload.asr.activeProfileId)) {
    input.asrSettingsStore.activateProfile(payload.asr.activeProfileId);
  }
  // ASR store requires ≥1 profile; empty cloud snapshots cannot wipe the last local row.
  if (remoteAsrIds.size > 0) {
    for (const profile of input.asrSettingsStore.listProfiles().profiles) {
      if (!remoteAsrIds.has(profile.id)) {
        input.asrSettingsStore.deleteProfile(profile.id);
      }
    }
  }

  for (const profile of payload.imageGeneration.profiles) {
    const saveInput: ImageGenerationProfileSaveInput = {
      id: profile.id,
      name: profile.name,
      provider: profile.provider as ImageGenerationProfileSaveInput["provider"],
      endpoint: profile.endpoint,
      model: profile.model,
      supportsImageToImage: profile.supportsImageToImage === true,
    };
    input.imageGenerationStore.saveProfile(saveInput);
  }
  if (
    payload.imageGeneration.activeProfileId &&
    remoteImageIds.has(payload.imageGeneration.activeProfileId)
  ) {
    input.imageGenerationStore.activateProfile(payload.imageGeneration.activeProfileId, {
      skipApiKeyCheck: true,
    });
  }
  // Image store requires ≥1 profile; empty cloud snapshots cannot wipe the last local row.
  if (remoteImageIds.size > 0) {
    for (const profile of input.imageGenerationStore.getSettings().profiles) {
      if (!remoteImageIds.has(profile.id)) {
        input.imageGenerationStore.deleteProfile(profile.id);
      }
    }
  }
  input.imageGenerationStore.setEnabled(payload.imageGeneration.enabled, {
    skipApiKeyCheck: true,
  });

  // Templates before orchestrations that reference them; configs/prompts before workflow selection.
  for (const template of payload.agentTemplates ?? []) {
    if (!isUserOwnedSource(template.source) || template.builtIn) {
      continue;
    }
    input.agentOrchestrationStore.saveAgentTemplate({
      ...template,
      source: "user",
      builtIn: false,
    });
  }
  for (const config of payload.mainAgentConfigs ?? []) {
    if (!isUserOwnedSource(config.source)) {
      continue;
    }
    input.agentOrchestrationStore.saveMainAgentConfig({ ...config, source: "user" });
  }
  for (const prompt of payload.mainAgentPrompts ?? []) {
    if (!isUserOwnedSource(prompt.source)) {
      continue;
    }
    input.agentOrchestrationStore.saveMainAgentPrompt({ ...prompt, source: "user" });
  }
  for (const orchestration of payload.subagentOrchestrations ?? []) {
    if (!isUserOwnedSource(orchestration.source)) {
      continue;
    }
    input.agentOrchestrationStore.saveSubagentOrchestration({
      ...orchestration,
      source: "user",
    });
  }

  if (payload.proxyBridge) {
    applyProxyBridgeSettingsPayload(input, payload.proxyBridge);
  } else {
    const current = input.proxyBridgeSettingsStore.get();
    if (current.upstreamUserAgent || current.upstreamUserAgents) {
      const { upstreamUserAgent: _removedUa, upstreamUserAgents: _removedPerCore, ...rest } = current;
      input.proxyBridgeSettingsStore.save(rest);
    }
  }

  // Drop local-only user orchestration after workflow defaults point at the cloud snapshot.
  for (const template of input.agentOrchestrationStore.listAgentTemplates()) {
    if (!isUserOwnedSource(template.source) || template.builtIn) {
      continue;
    }
    if (!remoteTemplateIds.has(template.id)) {
      input.agentOrchestrationStore.deleteAgentTemplate(template.id);
    }
  }
  for (const config of input.agentOrchestrationStore.listMainAgentConfigs()) {
    if (!isUserOwnedSource(config.source) || remoteMainConfigIds.has(config.id)) {
      continue;
    }
    input.workflowSettingsStore.clearDefaultMainAgentConfigReference(config.id);
    input.projectOrchestrationSettingsStore?.clearMainAgentConfigReference(config.id);
    input.agentOrchestrationStore.deleteMainAgentConfig(config.id);
  }
  for (const prompt of input.agentOrchestrationStore.listMainAgentPrompts()) {
    if (!isUserOwnedSource(prompt.source) || remoteMainPromptIds.has(prompt.id)) {
      continue;
    }
    input.workflowSettingsStore.clearDefaultMainAgentPromptReference(prompt.id);
    input.projectOrchestrationSettingsStore?.clearMainAgentPromptReference(prompt.id);
    input.agentOrchestrationStore.deleteMainAgentPrompt(prompt.id);
  }
  for (const orchestration of input.agentOrchestrationStore.listSubagentOrchestrations()) {
    if (!isUserOwnedSource(orchestration.source) || remoteSubagentIds.has(orchestration.id)) {
      continue;
    }
    input.agentOrchestrationStore.deleteSubagentOrchestration(orchestration.id);
  }

  if (payload.git !== undefined) {
    input.gitSettingsStore.save(normalizeGitSettingsSnapshot(payload.git));
  }
  if (payload.personalization !== undefined) {
    input.personalizationSettingsStore.save(
      normalizePersonalizationSettingsSnapshot(payload.personalization),
    );
  }
  if (payload.packageScriptArgs !== undefined || payload.packageScriptPrefixes !== undefined) {
    // Older cloud snapshots have no prefixes key: keep the local ones.
    const current = input.packageScriptArgsStore.getAllSnapshotSync();
    await input.packageScriptArgsStore.replaceAll({
      args: payload.packageScriptArgs ?? current.args,
      prefixes: payload.packageScriptPrefixes ?? current.prefixes,
    });
  }
  if (payload.sshBookmarks !== undefined) {
    input.sshBookmarkStore.replaceMetadata({ bookmarks: payload.sshBookmarks });
  }
}

function applyProxyBridgeSettingsPayload(
  input: {
    proxyBridgeSettingsStore: ProxyBridgeSettingsStore;
    integratedWebSearchSettingsStore: IntegratedWebSearchSettingsStore;
  },
  proxyBridge: EcoSyncedProxyBridgeSettings,
): void {
  const current = input.proxyBridgeSettingsStore.get();
  input.proxyBridgeSettingsStore.save({
    ...(current.enabled === undefined ? {} : { enabled: current.enabled }),
    ...(proxyBridge.upstreamUserAgent ? { upstreamUserAgent: proxyBridge.upstreamUserAgent } : {}),
    ...(proxyBridge.upstreamUserAgents ? { upstreamUserAgents: proxyBridge.upstreamUserAgents } : {}),
    ...(current.upstreamProxyUrl ? { upstreamProxyUrl: current.upstreamProxyUrl } : {}),
  });
  if (proxyBridge.integratedWebSearch) {
    input.integratedWebSearchSettingsStore.save({
      enabled: proxyBridge.integratedWebSearch.enabled,
      provider: proxyBridge.integratedWebSearch.provider,
      approvalMode: proxyBridge.integratedWebSearch.approvalMode,
    });
  }
}

function collectSecrets(input: {
  providerStore: ProviderStore;
  asrSettingsStore: AsrSettingsStore;
  imageGenerationStore: ImageGenerationStore;
  workflowSettingsStore: WorkflowSettingsStore;
  proxyBridgeSettingsStore: ProxyBridgeSettingsStore;
  integratedWebSearchSettingsStore: IntegratedWebSearchSettingsStore;
  sshBookmarkStore: SshBookmarkStore;
}): EcoPlainSecret[] {
  const secrets: EcoPlainSecret[] = [];

  for (const provider of input.providerStore.listProvidersWithSecrets()) {
    if (provider.apiKey.trim()) {
      secrets.push({ kind: "provider", key: provider.id, value: provider.apiKey });
    }
    const providerProxyUrl = provider.upstreamProxyUrl?.trim();
    if (providerProxyUrl) {
      secrets.push({ kind: "provider-proxy", key: provider.id, value: providerProxyUrl });
    }
  }

  const asr = input.asrSettingsStore.listProfiles();
  for (const profile of asr.profiles) {
    const config = input.asrSettingsStore.getClientConfig(profile.id);
    if (config?.apiKey.trim()) {
      secrets.push({ kind: "asr", key: profile.id, value: config.apiKey });
    }
  }

  for (const imageSecret of input.imageGenerationStore.listProfileSecrets()) {
    if (imageSecret.apiKey.trim()) {
      secrets.push({ kind: "image", key: imageSecret.profileId, value: imageSecret.apiKey });
    }
  }

  const cursorApiKey = input.workflowSettingsStore.get().acpCursorApiKey?.trim();
  if (cursorApiKey) {
    secrets.push({
      kind: "workflow",
      key: ECO_WORKFLOW_CURSOR_API_KEY_SECRET,
      value: cursorApiKey,
    });
  }

  const proxyUrl = resolveOutboundProxyUrl(input.proxyBridgeSettingsStore.get());
  if (proxyUrl) {
    secrets.push({ kind: "proxy", key: ECO_PROXY_URL_SECRET, value: proxyUrl });
  }

  const integratedWebSearchApiKey = input.integratedWebSearchSettingsStore.getApiKey()?.trim();
  if (integratedWebSearchApiKey) {
    secrets.push({
      kind: "proxy",
      key: ECO_INTEGRATED_WEB_SEARCH_API_KEY_SECRET,
      value: integratedWebSearchApiKey,
    });
  }

  for (const bookmark of input.sshBookmarkStore.getSnapshot().bookmarks) {
    const password = input.sshBookmarkStore.getPassword(bookmark.id);
    if (password?.trim()) {
      secrets.push({
        kind: "ssh",
        key: sshBookmarkSecretPasswordKey(bookmark.id),
        value: password,
      });
    }
    const storedKey = input.sshBookmarkStore.getStoredKey(bookmark.id);
    if (storedKey?.trim()) {
      secrets.push({
        kind: "ssh",
        key: sshBookmarkSecretKeyKey(bookmark.id),
        value: storedKey,
      });
    }
  }

  return secrets;
}

function applySecrets(
  input: {
    providerStore: ProviderStore;
    asrSettingsStore: AsrSettingsStore;
    imageGenerationStore: ImageGenerationStore;
    workflowSettingsStore: WorkflowSettingsStore;
    proxyBridgeSettingsStore: ProxyBridgeSettingsStore;
    integratedWebSearchSettingsStore: IntegratedWebSearchSettingsStore;
    sshBookmarkStore: SshBookmarkStore;
  },
  secrets: EcoPlainSecret[],
): void {
  applyDomainSecrets(input, secrets, "providers");
  applyDomainSecrets(input, secrets, "asr");
  applyDomainSecrets(input, secrets, "imageGeneration");
  applyDomainSecrets(input, secrets, "defaultAgent");
  applyDomainSecrets(input, secrets, "proxyBridge");
  applyDomainSecrets(input, secrets, "sshBookmarks");
}

function applyDomainSecrets(
  input: {
    providerStore: ProviderStore;
    asrSettingsStore: AsrSettingsStore;
    imageGenerationStore: ImageGenerationStore;
    workflowSettingsStore: WorkflowSettingsStore;
    proxyBridgeSettingsStore: ProxyBridgeSettingsStore;
    integratedWebSearchSettingsStore: IntegratedWebSearchSettingsStore;
    sshBookmarkStore: SshBookmarkStore;
  },
  secrets: EcoPlainSecret[],
  domain: EcoSettingsSyncDomain,
): void {
  const domainSecrets = filterSecretsForDomain(secrets, domain);
  const secretIds = new Set(domainSecrets.map((secret) => `${secret.kind}:${secret.key}`));

  if (domain === "providers") {
    for (const provider of input.providerStore.listProvidersWithSecrets()) {
      if (provider.apiKey && !secretIds.has(`provider:${provider.id}`)) {
        input.providerStore.clearProviderApiKey(provider.id);
      }
      const hasProviderProxy = (provider.upstreamProxyUrl ?? "").trim().length > 0;
      if (hasProviderProxy && !secretIds.has(`provider-proxy:${provider.id}`)) {
        input.providerStore.clearProviderUpstreamProxy(provider.id);
      }
    }
    for (const secret of domainSecrets) {
      if (!secret.value.trim()) {
        continue;
      }
      if (secret.kind === "provider") {
        const existing = input.providerStore.getProviderWithSecret(secret.key);
        if (!existing) {
          throw new Error(`Cloud provider secret references missing provider: ${secret.key}`);
        }
        input.providerStore.saveProvider({
          id: existing.id,
          name: existing.name,
          baseUrl: existing.baseUrl,
          requestPath: existing.requestPath,
          version: existing.version,
          apiCompat: existing.apiCompat,
          ...(existing.tokenCountMode ? { tokenCountMode: existing.tokenCountMode } : {}),
          ...(existing.authMethod ? { authMethod: existing.authMethod } : {}),
          ...(existing.credentialPoolId ? { credentialPoolId: existing.credentialPoolId } : {}),
          defaultModel: existing.defaultModel,
          enabled: existing.enabled,
          apiKey: secret.value,
        });
      }
      if (secret.kind === "provider-proxy") {
        const existing = input.providerStore.getProviderWithSecret(secret.key);
        if (!existing) {
          throw new Error(`Cloud provider proxy secret references missing provider: ${secret.key}`);
        }
        input.providerStore.saveProvider({
          id: existing.id,
          name: existing.name,
          baseUrl: existing.baseUrl,
          requestPath: existing.requestPath,
          version: existing.version,
          apiCompat: existing.apiCompat,
          ...(existing.tokenCountMode ? { tokenCountMode: existing.tokenCountMode } : {}),
          ...(existing.authMethod ? { authMethod: existing.authMethod } : {}),
          ...(existing.credentialPoolId ? { credentialPoolId: existing.credentialPoolId } : {}),
          defaultModel: existing.defaultModel,
          enabled: existing.enabled,
          upstreamProxyUrl: secret.value,
        });
      }
    }
    return;
  }

  if (domain === "asr") {
    for (const profile of input.asrSettingsStore.listProfiles().profiles) {
      if (profile.hasApiKey && !secretIds.has(`asr:${profile.id}`)) {
        input.asrSettingsStore.clearProfileApiKey(profile.id);
      }
    }
    for (const secret of domainSecrets) {
      if (!secret.value.trim() || secret.kind !== "asr") {
        continue;
      }
      const profiles = input.asrSettingsStore.listProfiles().profiles;
      const profile = profiles.find((row) => row.id === secret.key);
      if (!profile) {
        throw new Error(`Cloud ASR secret references missing profile: ${secret.key}`);
      }
      input.asrSettingsStore.saveProfile({
        id: profile.id,
        name: profile.name,
        endpoint: profile.endpoint,
        apiMode: profile.apiMode,
        model: profile.model,
        systemPrompt: profile.systemPrompt,
        apiKey: secret.value,
      });
    }
    return;
  }

  if (domain === "imageGeneration") {
    for (const profile of input.imageGenerationStore.listProfileSecrets()) {
      if (!secretIds.has(`image:${profile.profileId}`)) {
        input.imageGenerationStore.clearProfileApiKey(profile.profileId);
      }
    }
    for (const secret of domainSecrets) {
      if (!secret.value.trim() || secret.kind !== "image") {
        continue;
      }
      const settings = input.imageGenerationStore.getSettings();
      const profile = settings.profiles.find((row) => row.id === secret.key);
      if (!profile) {
        throw new Error(`Cloud image secret references missing profile: ${secret.key}`);
      }
      input.imageGenerationStore.saveProfile({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        endpoint: profile.endpoint,
        model: profile.model,
        apiKey: secret.value,
      });
    }
    return;
  }

  if (domain === "defaultAgent") {
    if (!secretIds.has(`workflow:${ECO_WORKFLOW_CURSOR_API_KEY_SECRET}`)) {
      const { acpCursorApiKey: _removed, ...workflow } = input.workflowSettingsStore.get();
      input.workflowSettingsStore.save(workflow);
    }
    for (const secret of domainSecrets) {
      if (!secret.value.trim() || secret.kind !== "workflow") {
        continue;
      }
      if (secret.key === ECO_WORKFLOW_CURSOR_API_KEY_SECRET) {
        const current = input.workflowSettingsStore.get();
        input.workflowSettingsStore.save({
          ...current,
          acpCursorApiKey: secret.value,
        });
      }
    }
    return;
  }

  if (domain === "proxyBridge") {
    if (!secretIds.has(`proxy:${ECO_PROXY_URL_SECRET}`)) {
      const { upstreamProxyUrl: _removed, ...proxy } = input.proxyBridgeSettingsStore.get();
      input.proxyBridgeSettingsStore.save(proxy);
    }
    if (!secretIds.has(`proxy:${ECO_INTEGRATED_WEB_SEARCH_API_KEY_SECRET}`)) {
      input.integratedWebSearchSettingsStore.save({ apiKey: "" });
    }
    for (const secret of domainSecrets) {
      if (!secret.value.trim() || secret.kind !== "proxy") {
        continue;
      }
      if (secret.key === ECO_PROXY_URL_SECRET) {
        input.proxyBridgeSettingsStore.save({
          ...input.proxyBridgeSettingsStore.get(),
          upstreamProxyUrl: secret.value,
        });
      }
      if (secret.key === ECO_INTEGRATED_WEB_SEARCH_API_KEY_SECRET) {
        input.integratedWebSearchSettingsStore.save({ apiKey: secret.value });
      }
    }
    return;
  }

  if (domain === "sshBookmarks") {
    for (const bookmark of input.sshBookmarkStore.getSnapshot().bookmarks) {
      const passwordKey = sshBookmarkSecretPasswordKey(bookmark.id);
      const keyKey = sshBookmarkSecretKeyKey(bookmark.id);
      if (bookmark.authType === "password" && !secretIds.has(`ssh:${passwordKey}`)) {
        input.sshBookmarkStore.clearPassword(bookmark.id);
      }
      if (bookmark.authType === "key" && bookmark.keySource === "stored" && !secretIds.has(`ssh:${keyKey}`)) {
        input.sshBookmarkStore.clearStoredKey(bookmark.id);
      }
    }
    for (const secret of domainSecrets) {
      if (!secret.value.trim() || secret.kind !== "ssh") {
        continue;
      }
      const passwordPrefix = "ssh_password:";
      const keyPrefix = "ssh_key:";
      if (secret.key.startsWith(passwordPrefix)) {
        const bookmarkId = secret.key.slice(passwordPrefix.length);
        if (!input.sshBookmarkStore.getPublic(bookmarkId)) {
          continue;
        }
        input.sshBookmarkStore.setPassword(bookmarkId, secret.value);
      } else if (secret.key.startsWith(keyPrefix)) {
        const bookmarkId = secret.key.slice(keyPrefix.length);
        if (!input.sshBookmarkStore.getPublic(bookmarkId)) {
          continue;
        }
        input.sshBookmarkStore.setStoredKey(bookmarkId, secret.value);
      }
    }
  }
}

export { emptyEcoSyncedSettingsPayload };
