import type { ResolvedModelRoute } from "../../model-router/src";
import {
  CLAUDE_SUBAGENT_COMPACT_WINDOW_MAX,
  CLAUDE_SUBAGENT_COMPACT_WINDOW_MIN,
  validateClaudeSubagentCompactWindow,
} from "../../shared/src";

function routeContext(route: ResolvedModelRoute, label: string): number {
  return Math.min(
    ...[route.primary, ...route.fallbacks].map((model) => {
      if (
        model.contextWindowResolved === false ||
        !Number.isSafeInteger(model.contextWindow) ||
        (model.contextWindow ?? 0) <= 0
      ) {
        throw new Error(
          `${label}的模型 ${model.displayName || model.modelId} 缺少已确认的上下文长度，请在候选模型中补全参数后再启动 Claude 子代理。`,
        );
      }
      return model.contextWindow!;
    }),
  );
}

/** Compute only for definitions exposed in this run; never change the parent's settings. */
export function applyClaudeSubagentCompactionWindows(
  definitions: Record<string, unknown>,
  routes: readonly ResolvedModelRoute[],
): Record<string, unknown> {
  if (Object.keys(definitions).length === 0) return definitions;
  const parent = routes.find((route) => route.role === "planner") ?? routes[0];
  if (!parent) throw new Error("Claude 子代理压缩缺少主会话模型路由。");
  const parentWindow = routeContext(parent, "主代理");
  return Object.fromEntries(
    Object.entries(definitions).map(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Claude 子代理 ${key} 定义无效。`);
      const definition = value as Record<string, unknown>;
      const role = key.startsWith("eco_") ? key.slice(4) : key;
      const route =
        routes.find((entry) => entry.role === role) ??
        routes.find((entry) => entry.primary.modelId === definition.model);
      if (!route) throw new Error(`Claude 子代理 ${key} 缺少对应的模型路由，无法配置独立压缩窗口。`);
      const ownWindow = routeContext(route, `子代理 ${key}`);
      const requested = definition.autoCompactWindow;
      if (requested !== undefined) validateClaudeSubagentCompactWindow(requested, `子代理 ${key}`);
      const effective = Math.min(
        ownWindow,
        parentWindow,
        requested ?? Infinity,
        CLAUDE_SUBAGENT_COMPACT_WINDOW_MAX,
      );
      if (effective < CLAUDE_SUBAGENT_COMPACT_WINDOW_MIN) {
        throw new Error(
          `Claude 子代理 ${key} 的有效上下文只有 ${effective} tokens；SDK 独立压缩窗口最小为 100000，无法为该模型配置安全的自动压缩。请更换模型或关闭该子代理。`,
        );
      }
      return [key, { ...definition, autoCompactWindow: effective }];
    }),
  );
}
