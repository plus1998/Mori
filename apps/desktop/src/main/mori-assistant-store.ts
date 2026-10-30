import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MORI_ASSISTANT_SETTINGS,
  MORI_PET_SIZE_MAX,
  MORI_PET_SIZE_MIN,
  type MoriAssistantSettings,
  type MoriAssistantState,
} from "../shared/mori-assistant";

export function parseAssistantSettings(value: unknown): MoriAssistantSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("助手配置无效。");
  const input = value as Record<string, unknown>;
  const defaults = DEFAULT_MORI_ASSISTANT_SETTINGS;
  const result = { ...defaults, ...input } as MoriAssistantSettings;
  for (const key of [
    "enabled",
    "autoSwitchAccounts",
    "floatingEnabled",
    "backgroundEnabled",
    "wechatEnabled",
  ] as const) {
    if (typeof result[key] !== "boolean") throw new Error(`助手配置 ${key} 必须为布尔值。`);
  }
  for (const key of ["name", "instructions", "model", "providerId", "shortcut", "petKey"] as const) {
    if (typeof result[key] !== "string") throw new Error(`助手配置 ${key} 必须为文本。`);
    result[key] = result[key].trim();
  }
  if (!result.name || result.name.length > 60) throw new Error("助手名称需要 1–60 个字符。");
  if (!result.model || result.model.length > 160) throw new Error("请选择助手模型。");
  if (result.modelSource !== "chatgpt" && result.modelSource !== "custom")
    throw new Error("助手模型来源无效。");
  if (result.enabled && result.modelSource === "custom" && !result.providerId)
    throw new Error("启用助手前请选择自定义模型服务商。");
  if (result.petKey && !/^(codex|codex-home|mori):[^/\\]+$/.test(result.petKey))
    throw new Error("宠物标识无效。");
  if (!result.petSizes || typeof result.petSizes !== "object" || Array.isArray(result.petSizes))
    throw new Error("宠物大小设置无效。");
  for (const [key, size] of Object.entries(result.petSizes)) {
    if (
      (key !== "builtin:mori" && !/^(codex|codex-home|mori):[^/\\]+$/.test(key)) ||
      !Number.isInteger(size) ||
      size < MORI_PET_SIZE_MIN ||
      size > MORI_PET_SIZE_MAX
    )
      throw new Error("宠物大小设置无效。");
  }
  if (result.instructions.length > 20_000) throw new Error("助手指令不能超过 20000 个字符。");
  if (!["low", "medium", "high"].includes(result.reasoningEffort)) throw new Error("助手思考强度无效。");
  if (
    !Array.isArray(result.accountIds) ||
    result.accountIds.some((id) => typeof id !== "string" || !id.trim())
  )
    throw new Error("助手账号列表无效。");
  result.accountIds = [...new Set(result.accountIds)];
  // Return only known fields. Secrets and runtime state never enter exported settings.
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, result[key as keyof MoriAssistantSettings]]),
  ) as unknown as MoriAssistantSettings;
}

/** Small local state only. All conversation content stays in Conversation V2. */
export class MoriAssistantStore {
  state: MoriAssistantState = {
    version: 1,
    settings: { ...DEFAULT_MORI_ASSISTANT_SETTINGS, accountIds: [] },
    sessions: [],
    draft: "",
    taskIds: [],
    sourceByMessage: {},
  };
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly filePath: string) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const value = JSON.parse(raw) as MoriAssistantState;
    if (
      value.version !== 1 ||
      !Array.isArray(value.sessions) ||
      !Array.isArray(value.taskIds) ||
      typeof value.draft !== "string" ||
      !value.sourceByMessage
    )
      throw new Error("助手状态文件无效，原文件已保留。");
    this.state = { ...value, settings: parseAssistantSettings(value.settings) };
    // Older versions exposed a task project preference. Mori's own workspace is managed locally.
    if (Object.hasOwn(value.settings, "defaultProject")) await this.save();
  }

  save(): Promise<void> {
    const content = JSON.stringify(this.state, null, 2);
    const write = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, content, { mode: 0o600 });
        await fs.rename(temp, this.filePath);
      } finally {
        await fs.rm(temp, { force: true });
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
