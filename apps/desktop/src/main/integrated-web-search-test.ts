import { searchIntegratedWeb } from "@eco/runtime";
import type { IntegratedWebSearchTestInput, IntegratedWebSearchTestResult } from "../shared/ipc";
import type { IntegratedWebSearchSettingsStore } from "./integrated-web-search-settings-store";

export async function testIntegratedWebSearch(
  input: unknown,
  store: Pick<IntegratedWebSearchSettingsStore, "get" | "getApiKey">,
): Promise<IntegratedWebSearchTestResult> {
  if (!isTestInput(input)) {
    throw new Error("Invalid web search test: select a provider and enter a query (1–128 characters).");
  }
  if (store.get().provider !== input.provider) {
    throw new Error("搜索供应商已变更，请等待配置保存后重试。");
  }
  const apiKey = store.getApiKey();
  if (!apiKey?.trim()) {
    throw new Error("请先配置并保存当前搜索供应商的 API Key。");
  }
  const startedAt = performance.now();
  const signal = AbortSignal.timeout(30_000);
  try {
    const results = await searchIntegratedWeb(input.provider, input.query.trim(), apiKey, {
      count: 3,
      signal,
    });
    return { results, elapsedMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    if (signal.aborted) {
      throw new Error("网络搜索测试超时（30 秒），请检查网络连接后重试。");
    }
    throw error;
  }
}

function isTestInput(value: unknown): value is IntegratedWebSearchTestInput {
  if (!value || typeof value !== "object") return false;
  const { provider, query } = value as Record<string, unknown>;
  return (
    (provider === "tavily" || provider === "doubao" || provider === "deepseek" || provider === "brave") &&
    typeof query === "string" &&
    query.trim().length > 0 &&
    Array.from(query.trim()).length <= 128
  );
}
