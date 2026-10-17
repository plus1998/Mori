import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodexGatewayModelAlias, type CodexGatewayApiCompat } from "../../shared/src";
import { resolveCodexHomeDir } from "./codex-config-sync.js";
import { assertCodexGatedModelApiCompat, isCodexGatedOptionalModelId } from "./codex-gated-models.js";
import { DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT, resolveEffectiveContextLimit } from "./models-dev-limits.js";

export const ECO_MODEL_CATALOG_FILE_NAME = "eco-model-catalog.json";

export type CodexMultiAgentVersion = "v1" | "v2";

/**
 * Codex Multi-Agent v2 is available to the GPT-5.6 Terra tier and above,
 * including the GPT-6 family.
 * Keep this decision in one place so catalog aliases and thread config cannot
 * disagree about which child-agent protocol a model should use.
 */
export function resolveCodexMultiAgentVersion(modelId: string): CodexMultiAgentVersion {
  const normalized = modelId.trim();
  return /^gpt-5\.6-(?:sol|terra)(?:$|[-_.])/iu.test(normalized) || /^gpt-6(?:$|[-_.])/iu.test(normalized)
    ? "v2"
    : "v1";
}

/** Manual capability overrides that may be applied onto a catalog alias entry. */
export interface CodexCatalogManualCapabilities {
  contextTokens?: number;
  supportsImageInput?: boolean;
  /** Bound to thread/role provider capabilities, not the shared model catalog entry. */
  supportsRemoteCompaction?: boolean;
}

/**
 * Secret-free route description used to materialize Codex model-catalog aliases.
 * Only fields that affect catalog metadata / routing identity belong here.
 */
export interface CodexGatewayCatalogRoute {
  providerId: string;
  modelId: string;
  apiCompat: CodexGatewayApiCompat;
  displayName?: string;
  manualSpec?: CodexCatalogManualCapabilities;
}

/**
 * Secret-free provider snapshot used when expanding catalog routes.
 * Models may carry optional per-model apiCompat / manual capability overrides.
 */
export interface EcoProviderModelForCatalog {
  modelId: string;
  displayName?: string;
  apiCompat?: CodexGatewayApiCompat | undefined;
  manualSpec?: CodexCatalogManualCapabilities | undefined;
}

export interface EcoProviderForModelCatalog {
  id: string;
  name?: string;
  enabled?: boolean;
  apiCompat?: CodexGatewayApiCompat | undefined;
  defaultModel?: string | undefined;
  models?: readonly EcoProviderModelForCatalog[] | undefined;
}

export interface CollectCodexGatewayCatalogRoutesInput {
  /** Provider defaults + candidate models (lowest priority). */
  providers?: readonly EcoProviderForModelCatalog[];
  /** Persisted route-profile / coding route rows. */
  routeConfigs?: readonly CodexGatewayCatalogRoute[];
  /** Orchestration agents (main + subagents). */
  orchestrationAgents?: readonly CodexGatewayCatalogRoute[];
  /** Current effective runtime / agent routes (highest priority). */
  effectiveRoutes?: readonly CodexGatewayCatalogRoute[];
}

export interface SyncEcoCodexModelCatalogInput {
  ecoDataDir: string;
  codexExecutable: string;
  routes: readonly CodexGatewayCatalogRoute[];
  globalContextWindowLimit?: number;
  /**
   * Optional override for the temporary CODEX_HOME used while dumping the bundled catalog.
   * Tests inject this so the real user home is never touched.
   */
  bundledDumpHomeDir?: string;
  /** Injectable process runner for tests. */
  runCodex?: typeof runCodexDebugModelsBundled;
}

export interface SyncEcoCodexModelCatalogResult {
  catalogPath: string;
  fingerprint: string;
  aliasSlugs: string[];
  nativeModelCount: number;
  changed: boolean;
}

export interface EcoCodexModelCatalogDocument {
  models: CodexBundledModelEntry[];
}

/** Subset of Codex bundled catalog fields Eco needs for freeform apply_patch registration. */
export interface CodexBundledModelEntry {
  slug: string;
  display_name?: string;
  description?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: unknown;
  shell_type?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  apply_patch_tool_type?: string;
  context_window?: number;
  max_context_window?: number;
  effective_context_window_percent?: number;
  input_modalities?: string[];
  supports_parallel_tool_calls?: boolean;
  supports_reasoning_summaries?: boolean;
  support_verbosity?: boolean;
  supports_image_detail_original?: boolean;
  supports_search_tool?: boolean;
  multi_agent_version?: CodexMultiAgentVersion;
  multi_agent_reasoning_effort?: string;
  use_responses_lite?: boolean;
  base_instructions?: string;
  [key: string]: unknown;
}

export function resolveEcoModelCatalogPath(ecoDataDir: string): string {
  return path.join(resolveCodexHomeDir(ecoDataDir), ECO_MODEL_CATALOG_FILE_NAME);
}

export function fingerprintEcoModelCatalog(document: EcoCodexModelCatalogDocument): string {
  return createHash("sha256").update(stableCatalogJson(document)).digest("hex");
}

/**
 * Collect unique catalog routes. Later sources win on metadata for the same alias key
 * (providerId + modelId + apiCompat). Callers should pass sources in ascending priority
 * so the final entry reflects the highest-priority route description.
 */
export function mergeCodexGatewayCatalogRoutes(
  ...sources: readonly (readonly CodexGatewayCatalogRoute[])[]
): CodexGatewayCatalogRoute[] {
  const byAlias = new Map<string, CodexGatewayCatalogRoute>();
  for (const source of sources) {
    for (const route of source) {
      const providerId = route.providerId.trim();
      const modelId = route.modelId.trim();
      if (!providerId || !modelId) {
        continue;
      }
      const normalized: CodexGatewayCatalogRoute = {
        providerId,
        modelId,
        apiCompat: route.apiCompat,
        ...(route.displayName?.trim() ? { displayName: route.displayName.trim() } : {}),
        ...(route.manualSpec ? { manualSpec: { ...route.manualSpec } } : {}),
      };
      const alias = buildCodexGatewayModelAlias(
        normalized.providerId,
        normalized.modelId,
        normalized.apiCompat,
      );
      byAlias.set(alias, normalized);
    }
  }
  return [...byAlias.values()].sort((left, right) => {
    const leftKey = `${left.providerId}\0${left.apiCompat}\0${left.modelId}`;
    const rightKey = `${right.providerId}\0${right.apiCompat}\0${right.modelId}`;
    return leftKey.localeCompare(rightKey);
  });
}

/**
 * Expand provider defaults, candidates, route configs, orchestration agents, and
 * currently-effective runtime routes into deduped catalog aliases.
 *
 * Metadata priority (later wins): providers → routeConfigs → orchestrationAgents → effectiveRoutes.
 */
export function collectCodexGatewayCatalogRoutes(
  input: CollectCodexGatewayCatalogRoutesInput,
): CodexGatewayCatalogRoute[] {
  const fromProviders: CodexGatewayCatalogRoute[] = [];
  for (const provider of input.providers ?? []) {
    const providerId = provider.id.trim();
    if (!providerId || provider.enabled === false) {
      continue;
    }
    const providerCompat = provider.apiCompat ?? "openai_responses";
    const providerName = provider.name?.trim() || providerId;
    const defaultModel = provider.defaultModel?.trim();
    if (defaultModel) {
      fromProviders.push({
        providerId,
        modelId: defaultModel,
        apiCompat: providerCompat,
        displayName: `${providerName} / ${defaultModel}`,
      });
    }
    for (const model of provider.models ?? []) {
      const modelId = model.modelId.trim();
      if (!modelId) {
        continue;
      }
      fromProviders.push({
        providerId,
        modelId,
        apiCompat: model.apiCompat ?? providerCompat,
        ...(model.displayName?.trim()
          ? { displayName: model.displayName.trim() }
          : { displayName: `${providerName} / ${modelId}` }),
        ...(model.manualSpec ? { manualSpec: { ...model.manualSpec } } : {}),
      });
    }
  }

  return mergeCodexGatewayCatalogRoutes(
    fromProviders,
    input.routeConfigs ?? [],
    input.orchestrationAgents ?? [],
    input.effectiveRoutes ?? [],
  );
}

export async function loadBundledCodexModelCatalog(
  codexExecutable: string,
  options: {
    dumpHomeDir?: string;
    runCodex?: typeof runCodexDebugModelsBundled;
  } = {},
): Promise<CodexBundledModelEntry[]> {
  const run = options.runCodex ?? runCodexDebugModelsBundled;
  const dumpHomeDir = options.dumpHomeDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-bundled-")));
  const ownsDumpHome = options.dumpHomeDir === undefined;
  try {
    const raw = await run(codexExecutable, dumpHomeDir);
    return parseBundledCodexModelCatalog(raw);
  } finally {
    if (ownsDumpHome) {
      await fs.rm(dumpHomeDir, { recursive: true, force: true });
    }
  }
}

export function parseBundledCodexModelCatalog(raw: string): CodexBundledModelEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex bundled model catalog JSON is invalid: ${message}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    throw new Error('Codex bundled model catalog must be an object with a "models" array.');
  }
  const models: CodexBundledModelEntry[] = [];
  for (const [index, entry] of parsed.models.entries()) {
    if (!isRecord(entry) || typeof entry.slug !== "string" || !entry.slug.trim()) {
      throw new Error(`Codex bundled model catalog models[${index}] is missing a non-empty slug.`);
    }
    models.push(entry as CodexBundledModelEntry);
  }
  if (models.length === 0) {
    throw new Error("Codex bundled model catalog contains no models.");
  }
  return models;
}

export function selectFreeformApplyPatchTemplate(
  nativeModels: readonly CodexBundledModelEntry[],
): CodexBundledModelEntry {
  const freeform = nativeModels
    .filter((entry) => entry.apply_patch_tool_type === "freeform")
    .sort((left, right) => {
      const leftPriority = typeof left.priority === "number" ? left.priority : Number.MAX_SAFE_INTEGER;
      const rightPriority = typeof right.priority === "number" ? right.priority : Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return left.slug.localeCompare(right.slug);
    });
  const template = freeform[0];
  if (!template) {
    throw new Error(
      'Codex bundled model catalog has no freeform apply_patch template (apply_patch_tool_type: "freeform").',
    );
  }
  return template;
}

/**
 * Longest-prefix / longest-slug match against known native slugs.
 * Exact slug wins; otherwise the longest native slug that is a prefix of the upstream id
 * (or vice-versa when the upstream id is a prefix of a native slug) is preferred.
 */
export function selectNativeTemplateForModel(
  nativeModels: readonly CodexBundledModelEntry[],
  upstreamModelId: string,
  freeformTemplate: CodexBundledModelEntry,
): { template: CodexBundledModelEntry; known: boolean } {
  const needle = upstreamModelId.trim().toLowerCase();
  if (!needle) {
    return { template: freeformTemplate, known: false };
  }

  let best: CodexBundledModelEntry | undefined;
  let bestScore = -1;
  for (const entry of nativeModels) {
    const slug = entry.slug.trim().toLowerCase();
    if (!slug) {
      continue;
    }
    if (slug === needle) {
      return { template: entry, known: true };
    }
    if (needle.startsWith(slug) || slug.startsWith(needle)) {
      const score = Math.min(slug.length, needle.length);
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
  }
  if (best) {
    return { template: best, known: true };
  }
  return { template: freeformTemplate, known: false };
}

export function buildEcoCodexModelCatalogDocument(
  nativeModels: readonly CodexBundledModelEntry[],
  routes: readonly CodexGatewayCatalogRoute[],
  globalContextWindowLimit = DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT,
): EcoCodexModelCatalogDocument {
  const freeformTemplate = selectFreeformApplyPatchTemplate(nativeModels);
  const cappedNativeModels = nativeModels.map((entry) =>
    applyGlobalCatalogContextWindowLimit(cloneCatalogEntry(entry), globalContextWindowLimit),
  );
  const nativeBySlug = new Map(cappedNativeModels.map((entry) => [entry.slug, entry]));
  const models: CodexBundledModelEntry[] = cappedNativeModels;
  const seenAliases = new Set<string>();

  for (const route of mergeCodexGatewayCatalogRoutes(routes)) {
    const alias = buildCodexGatewayModelAlias(route.providerId, route.modelId, route.apiCompat);
    if (seenAliases.has(alias) || nativeBySlug.has(alias)) {
      continue;
    }
    seenAliases.add(alias);
    const { template, known } = selectNativeTemplateForModel(nativeModels, route.modelId, freeformTemplate);
    if (isCodexGatedOptionalModelId(route.modelId)) {
      assertCodexGatedModelApiCompat({ modelId: route.modelId, apiCompat: route.apiCompat });
    }
    models.push(
      applyGlobalCatalogContextWindowLimit(
        buildAliasCatalogEntry(alias, route, template, known),
        globalContextWindowLimit,
      ),
    );
  }

  return { models };
}

export function applyGlobalCatalogContextWindowLimit(
  entry: CodexBundledModelEntry,
  globalContextWindowLimit: number,
): CodexBundledModelEntry {
  const declaredContext =
    typeof entry.context_window === "number" && entry.context_window > 0
      ? entry.context_window
      : typeof entry.max_context_window === "number" && entry.max_context_window > 0
        ? entry.max_context_window
        : undefined;
  if (declaredContext === undefined) {
    return entry;
  }
  const effective = resolveEffectiveContextLimit(declaredContext, globalContextWindowLimit);
  entry.context_window = effective;
  entry.max_context_window = effective;
  return entry;
}

/**
 * Official DeepSeek / third-party Codex catalogs use shell_type=shell_command and
 * tool_mode=null. GPT freeform templates inherit tool_mode=code_mode_only, which
 * makes Codex advertise freeform custom tool `exec` (JS V8). Grok and similar
 * models treat that input as shell and fail with SyntaxError.
 */
export function isDeepSeekUpstreamModelId(modelId: string): boolean {
  return /\bdeepseek\b/i.test(modelId.trim()) || /^deepseek/i.test(modelId.trim());
}

export function applyShellCommandCodexToolRegistration(entry: CodexBundledModelEntry): void {
  entry.shell_type = "shell_command";
  entry.apply_patch_tool_type = "freeform";
  entry.tool_mode = null;
}

export function applyDeepSeekCodexToolRegistration(
  entry: CodexBundledModelEntry,
  upstreamModelId: string,
): void {
  if (!isDeepSeekUpstreamModelId(upstreamModelId)) {
    return;
  }
  applyShellCommandCodexToolRegistration(entry);
}

export function buildAliasCatalogEntry(
  aliasSlug: string,
  route: CodexGatewayCatalogRoute,
  template: CodexBundledModelEntry,
  knownNativeMatch: boolean,
): CodexBundledModelEntry {
  const entry = cloneCatalogEntry(template);
  entry.slug = aliasSlug;
  entry.display_name =
    route.displayName?.trim() || `${route.providerId} / ${route.modelId} (${route.apiCompat})`;
  entry.description =
    typeof entry.description === "string" && entry.description.trim()
      ? entry.description
      : `Eco gateway route alias for ${route.providerId}/${route.modelId}.`;
  entry.visibility = "list";
  entry.supported_in_api = true;
  // The freeform template is currently GPT-5.6 Sol (v2). Do not let unknown
  // or lower-tier upstream models inherit its child-agent protocol by clone.
  entry.multi_agent_version = knownNativeMatch
    ? (template.multi_agent_version ?? resolveCodexMultiAgentVersion(route.modelId))
    : "v1";
  // Always register freeform apply_patch so Eco coding routes can edit files.
  entry.apply_patch_tool_type = "freeform";
  // Unknown third-party models (Grok, DeepSeek, …) must not inherit GPT code mode.
  if (!knownNativeMatch) {
    applyShellCommandCodexToolRegistration(entry);
  } else {
    applyDeepSeekCodexToolRegistration(entry, route.modelId);
  }

  if (!knownNativeMatch) {
    // Unknown third-party models inherit only the tool-registration template.
    // Keep undeclared capabilities conservative — do not impersonate full GPT ability.
    entry.supports_parallel_tool_calls = false;
    entry.supports_reasoning_summaries = false;
    entry.support_verbosity = false;
    entry.supports_image_detail_original = false;
    entry.supports_search_tool = false;
    entry.use_responses_lite = false;
    entry.input_modalities = ["text"];
    // The freeform template is a GPT model and always carries its own window.
    // Do not advertise that unrelated limit for unknown upstream models.
    entry.context_window = 128_000;
    entry.max_context_window = 128_000;
    // Drop premium-only marketing fields that would misrepresent the third-party model.
    delete entry.service_tiers;
    delete entry.additional_speed_tiers;
    delete entry.availability_nux;
    delete entry.upgrade;
    delete entry.web_search_tool_type;
  }

  applyManualCatalogCapabilities(entry, route.manualSpec);
  return entry;
}

export function applyManualCatalogCapabilities(
  entry: CodexBundledModelEntry,
  manualSpec: CodexCatalogManualCapabilities | undefined,
): void {
  if (!manualSpec) {
    return;
  }
  if (
    typeof manualSpec.contextTokens === "number" &&
    Number.isFinite(manualSpec.contextTokens) &&
    manualSpec.contextTokens > 0
  ) {
    const tokens = Math.floor(manualSpec.contextTokens);
    entry.context_window = tokens;
    entry.max_context_window = tokens;
  }
  if (manualSpec.supportsImageInput === true) {
    const modalities = new Set(
      Array.isArray(entry.input_modalities)
        ? entry.input_modalities.filter((value): value is string => typeof value === "string")
        : [],
    );
    modalities.add("text");
    modalities.add("image");
    entry.input_modalities = [...modalities];
  } else if (manualSpec.supportsImageInput === false) {
    entry.input_modalities = ["text"];
    entry.supports_image_detail_original = false;
  }
}

/**
 * Atomically write the Eco model catalog and return whether content changed.
 * Does not create or copy models_cache.json — Codex loads model_catalog_json directly.
 */
export async function writeEcoCodexModelCatalog(
  catalogPath: string,
  document: EcoCodexModelCatalogDocument,
): Promise<{ fingerprint: string; changed: boolean }> {
  const fingerprint = fingerprintEcoModelCatalog(document);
  const nextBody = `${stableCatalogJson(document)}\n`;

  let previousBody: string | undefined;
  try {
    previousBody = await fs.readFile(catalogPath, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  if (previousBody === nextBody) {
    return { fingerprint, changed: false };
  }

  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  const tempPath = `${catalogPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, nextBody, "utf8");
  await fs.rename(tempPath, catalogPath);
  return { fingerprint, changed: true };
}

export async function syncEcoCodexModelCatalog(
  input: SyncEcoCodexModelCatalogInput,
): Promise<SyncEcoCodexModelCatalogResult> {
  const codexExecutable = input.codexExecutable.trim();
  if (!codexExecutable) {
    throw new Error("Codex executable is required to sync the Eco model catalog.");
  }

  const nativeModels = await loadBundledCodexModelCatalog(codexExecutable, {
    ...(input.bundledDumpHomeDir ? { dumpHomeDir: input.bundledDumpHomeDir } : {}),
    ...(input.runCodex ? { runCodex: input.runCodex } : {}),
  });
  const routes = mergeCodexGatewayCatalogRoutes(input.routes);
  const document = buildEcoCodexModelCatalogDocument(nativeModels, routes, input.globalContextWindowLimit);
  const catalogPath = resolveEcoModelCatalogPath(input.ecoDataDir);
  const written = await writeEcoCodexModelCatalog(catalogPath, document);
  const aliasSlugs = document.models
    .map((entry) => entry.slug)
    .filter((slug) => slug.startsWith("eco_route_v1.") || slug.startsWith("eco_"));

  return {
    catalogPath,
    fingerprint: written.fingerprint,
    aliasSlugs: [...new Set(aliasSlugs)].sort(),
    nativeModelCount: nativeModels.length,
    changed: written.changed,
  };
}

export async function runCodexDebugModelsBundled(
  codexExecutable: string,
  codexHomeDir: string,
): Promise<string> {
  await fs.mkdir(codexHomeDir, { recursive: true });
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(codexExecutable, ["debug", "models", "--bundled"], {
      env: {
        ...process.env,
        CODEX_HOME: codexHomeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(
        new Error(`Failed to spawn Codex for bundled model catalog (${codexExecutable}): ${error.message}`),
      );
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit ${code ?? "null"} signal ${signal ?? "null"}`;
      reject(new Error(`Codex debug models --bundled failed: ${detail}`));
    });
  });
}

function cloneCatalogEntry(entry: CodexBundledModelEntry): CodexBundledModelEntry {
  return JSON.parse(JSON.stringify(entry)) as CodexBundledModelEntry;
}

function stableCatalogJson(document: EcoCodexModelCatalogDocument): string {
  return `${JSON.stringify(document, null, 2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
