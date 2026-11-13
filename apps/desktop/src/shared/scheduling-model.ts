import type { CoreKind } from "@eco/runtime/core-runtime";
import type { ModelRef } from "./agent-orchestration";

/** Scheduled tasks must pin the same explicit main-model binding as Composer. */
export function schedulingMainModelIssue(coreKind: CoreKind, model: ModelRef | undefined) {
  if (coreKind === "acp") return undefined;
  if (!model?.providerId.trim() || !model.modelId.trim()) return "scheduling.configRequired";
  if (model.providerId === "openai" && coreKind !== "codex") return "scheduling.loginRequiresCodex";
  if ((model.providerId === "openai" || model.providerId === "eco-coding-chatgpt") && !model.accountId?.trim()) {
    return "composer.route.selectAccount";
  }
  return undefined;
}
