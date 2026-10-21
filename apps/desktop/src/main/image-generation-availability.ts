import type { ImageGenerationSettingsSnapshot } from "../shared/image-generation";

/** Composer readiness follows the selected channel's authentication method. */
export function imageGenerationAvailability(
  settings: ImageGenerationSettingsSnapshot,
  codex: { available: boolean; reason?: string } = { available: false, reason: "Codex 生图账号尚未检查。" },
): { available: boolean; reason?: string } {
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId);
  if (!profile) return { available: false, reason: "当前创意绘画配置不存在。" };
  let reason: string | undefined;
  if (profile.provider === "codex" || profile.provider === "chatgpt_web") {
    if (!codex.available) reason = codex.reason ?? "没有可用的 Codex 生图账号。";
  } else if (!profile.hasApiKey) reason = "当前创意绘画 Profile 尚未配置 API Key。";
  else if (!settings.apiKeyEncryptionAvailable) reason = "系统加密不可用，无法读取创意绘画 API Key。";
  return { available: settings.enabled && !reason, ...(reason ? { reason } : {}) };
}
