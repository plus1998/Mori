import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatGptWebImageModelCatalogSnapshot, ImageGenerationChatModelOption } from "../shared/image-generation";
import { canUseOpenAIAccountCredentials, canUseOpenAIAccountWebCredentials } from "../shared/openai-account";
import type { CodexImageAccountPort } from "./codex-image-service";

export const CHATGPT_WEB_IMAGE_MODELS_PATH = "/backend-api/models?iim=false&include_icons=false&is_gizmo=false";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only expose picker entries; raw models also contain research and internal rollout slugs. */
export function parseChatGptWebImageModels(value: unknown): ImageGenerationChatModelOption[] {
  if (!record(value) || !Array.isArray(value.models) || !Array.isArray(value.categories) || !Array.isArray(value.versions)) {
    throw new Error("Web 生图模型列表格式无效。");
  }
  const visible = new Map<string, string>();
  const disabled = new Set<string>();
  const enabled = new Set<string>();
  for (const version of value.versions) {
    if (!record(version)) continue;
    const slugs = Array.isArray(version.slugs) ? version.slugs : [];
    for (const slug of slugs) {
      if (typeof slug !== "string") continue;
      if (version.enabled === false) disabled.add(slug);
      else if (version.enabled === true) {
        enabled.add(slug);
        visible.set(slug, "");
      }
    }
    if (version.enabled !== true || !Array.isArray(version.intelligence_presets)) continue;
    for (const preset of version.intelligence_presets) {
      if (record(preset) && preset.preset_type === "available" && typeof preset.model_slug === "string") {
        enabled.add(preset.model_slug);
        visible.set(preset.model_slug, "");
      }
    }
  }
  for (const category of value.categories) {
    if (!record(category)) continue;
    const slugs = [category.default_model, ...(Array.isArray(category.supported_models) ? category.supported_models : [])];
    for (const slug of slugs) {
      if (typeof slug === "string") visible.set(slug, typeof category.human_category_name === "string" ? category.human_category_name : "");
    }
  }
  const models = new Map<string, ImageGenerationChatModelOption>();
  for (const model of value.models) {
    if (!record(model) || typeof model.slug !== "string" || !model.slug.trim() || !visible.has(model.slug) ||
      (disabled.has(model.slug) && !enabled.has(model.slug)) ||
      !Array.isArray(model.enabled_tools) || !model.enabled_tools.includes("image_gen_tool_enabled")) continue;
    const title = typeof model.title === "string" && model.title.trim() ? model.title : model.slug;
    const category = visible.get(model.slug);
    models.set(model.slug, {
      modelId: model.slug,
      displayName: category && category !== title ? `${title} · ${category}` : title,
    });
  }
  if (!models.size) throw new Error("接口未返回可供选择的 Web 生图对话模型。");
  return [...models.values()];
}

interface CacheEntry {
  models: ImageGenerationChatModelOption[];
  fetchedAt?: number;
  lastError?: string;
}

interface Options {
  cachePath: string;
  accounts: Pick<CodexImageAccountPort, "listAccounts" | "getAccountDetails">;
  fetchModels: (accountId: string, signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  fetchTimeoutMs?: number;
}

/** Drawing Web only. Each account is fetched once; subsequent network access requires refresh. */
export class ChatGptWebImageModelCatalogService {
  private entries: Record<string, CacheEntry> = {};
  private loaded = false;
  private cacheError = "";
  private pending: Promise<ChatGptWebImageModelCatalogSnapshot> | undefined;

  constructor(private readonly options: Options) {}

  get(refresh = false): Promise<ChatGptWebImageModelCatalogSnapshot> {
    // Re-evaluate the pool after in-flight work: account switches must not receive the old pool's snapshot.
    if (this.pending) return this.pending.then(() => this.get(refresh));
    this.pending = this.read(refresh).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const document: unknown = JSON.parse(await fs.readFile(this.options.cachePath, "utf8"));
      if (!record(document) || document.version !== 1 || !record(document.accounts)) throw new Error("invalid cache");
      for (const [key, entry] of Object.entries(document.accounts)) {
        if (!record(entry) || !Array.isArray(entry.models) || !entry.models.every((m) =>
          record(m) && typeof m.modelId === "string" && typeof m.displayName === "string") ||
          (entry.fetchedAt !== undefined && (typeof entry.fetchedAt !== "number" || !Number.isFinite(entry.fetchedAt))) ||
          (entry.lastError !== undefined && typeof entry.lastError !== "string")) throw new Error("invalid cache");
        this.entries[key] = entry as unknown as CacheEntry;
      }
    } catch (error) {
      this.entries = {};
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.cacheError = "Web 生图模型缓存无法读取，请手动刷新。";
    }
    this.loaded = true;
  }

  private async read(refresh: boolean): Promise<ChatGptWebImageModelCatalogSnapshot> {
    await this.load();
    if (this.cacheError && !refresh) return { models: [], lastError: this.cacheError };
    const selected = (await this.options.accounts.listAccounts()).filter((a) => a.imageGenerationEnabled && (canUseOpenAIAccountCredentials(a) || canUseOpenAIAccountWebCredentials(a)));
    if (!selected.length) return { models: [], lastError: "请先在账号池中选择至少一个已登录的账号。" };
    const accounts = await Promise.all(selected.map(async (account) => {
      const details = await this.options.accounts.getAccountDetails(account.id);
      const auth = details.authJson ? JSON.parse(details.authJson) : {};
      const identity = details.webAuth?.accountId ?? auth.tokens?.account_id ?? auth.account_id;
      if (typeof identity !== "string" || !identity) throw new Error(`账号“${account.name}”缺少账号标识，请重新登录。`);
      const key = createHash("sha256").update(`${account.id}\0${identity}`).digest("hex");
      return { ...account, key };
    }));
    let changed = false;
    await Promise.all(accounts.map(async (account) => {
      const previous = this.entries[account.key];
      if (previous && !refresh) return;
      changed = true;
      const signal = AbortSignal.timeout(this.options.fetchTimeoutMs ?? 30_000);
      try {
        const models = parseChatGptWebImageModels(await this.options.fetchModels(account.id, signal));
        this.entries[account.key] = { models, fetchedAt: (this.options.now ?? Date.now)() };
      } catch (error) {
        this.entries[account.key] = {
          ...previous,
          models: previous?.models ?? [],
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    if (changed) {
      await fs.mkdir(path.dirname(this.options.cachePath), { recursive: true });
      const temporary = `${this.options.cachePath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, accounts: this.entries }), { mode: 0o600 });
      await fs.rename(temporary, this.options.cachePath);
      this.cacheError = "";
    }
    const entries = accounts.map((account) => this.entries[account.key]!);
    const common = entries.map((entry) => new Set(entry.models.map((model) => model.modelId)));
    const models = entries[0]!.models.filter((model) => common.every((ids) => ids.has(model.modelId)));
    const errors = accounts.flatMap((account, index) => entries[index]!.lastError ? [`${account.name}：${entries[index]!.lastError}`] : []);
    const times = entries.flatMap((entry) => entry.fetchedAt === undefined ? [] : [entry.fetchedAt]);
    return {
      models,
      ...(times.length === entries.length ? { fetchedAt: Math.min(...times) } : {}),
      ...(errors.length ? { lastError: errors.join("\n") } : !models.length ? { lastError: "所选账号没有共同可用的 Web 生图对话模型。" } : {}),
    };
  }
}
