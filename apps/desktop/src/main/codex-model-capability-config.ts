import { createHash } from "node:crypto";
import {
  type CodexGatewayCatalogRoute,
  type CodexRemoteCompactionSupport,
  resolveCodexRemoteCompaction,
} from "@eco/runtime";
import { resolveUpstreamApiCompat } from "../shared/api-compat";
import type { EcoProviderForCodexCatalog } from "./codex-runtime-run";

export function createCodexRemoteCompactionResolver(
  providers: readonly EcoProviderForCodexCatalog[],
  routes: readonly CodexGatewayCatalogRoute[] = [],
) {
  return (ref: { providerId: string; modelId: string; apiCompat?: string }): CodexRemoteCompactionSupport => {
    if (ref.providerId === "openai") return "v2";
    const provider = providers.find((entry) => entry.id === ref.providerId);
    const candidate = provider?.models?.find((model) => model.modelId === ref.modelId);
    const route = routes.find(
      (entry) => entry.providerId === ref.providerId && entry.modelId === ref.modelId,
    );
    // Candidate settings are authoritative; a persisted thread snapshot may predate a toggle.
    const supportsRemoteCompaction = candidate
      ? candidate.manualSpec?.supportsRemoteCompaction === true
      : route?.manualSpec?.supportsRemoteCompaction === true;
    const apiCompat = ref.apiCompat ?? route?.apiCompat ?? provider?.apiCompat;
    if (
      apiCompat !== undefined &&
      apiCompat !== "anthropic" &&
      apiCompat !== "openai_responses" &&
      apiCompat !== "openai_chat_completions"
    ) {
      throw new Error(`Unsupported Codex model protocol: ${apiCompat}`);
    }
    return resolveCodexRemoteCompaction({
      providerId: ref.providerId,
      modelId: ref.modelId,
      apiCompat: resolveUpstreamApiCompat(apiCompat, provider?.apiCompat),
      supportsRemoteCompaction,
    });
  };
}

export function assertCodexSubagentCompactionCompatible(
  mainSupport: CodexRemoteCompactionSupport,
  roles: readonly { providerId: string; modelId: string; apiCompat?: string; roleId: string }[],
  resolveSupport: ReturnType<typeof createCodexRemoteCompactionResolver>,
): void {
  for (const role of roles) {
    if (resolveSupport(role) !== mainSupport) {
      throw new Error(
        `Codex 0.163 的原生子代理继承主会话的远程压缩设置，子代理「${role.roleId}」所选模型「${role.providerId} / ${role.modelId}」与主模型设置不一致。请在候选模型中统一远程压缩开关，或关闭该子代理后重试。`,
      );
    }
  }
}

export function fingerprintCodexProviderConfig(configToml: string): string {
  return createHash("sha256").update(configToml).digest("hex");
}
