/** TypeSafe System One HTTP contract: https://api.typesafe.ai/openapi.json */
import { buildMessagesUrl, withUpstreamProxyFetch } from "./provider-models";
import type { ProviderConfigSecret } from "./provider-store";

export interface SystemOneChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export function parseSystemOneChoiceAnswer(
  value: unknown,
  choices: readonly string[],
  field: string = "answer",
): SystemOneChoiceAnswer {
  if (!value || typeof value !== "object") throw new Error("SystemOne 返回了无效答案。");
  const answer = value as SystemOneChoiceAnswer;
  const isProbability = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (
    answer.type !== "choice" ||
    !choices.includes(answer.choice) ||
    !isProbability(answer.confidence) ||
    !answer.probabilities ||
    typeof answer.probabilities !== "object" ||
    Array.isArray(answer.probabilities) ||
    Object.keys(answer.probabilities).length !== choices.length ||
    choices.some((choice) => !isProbability(answer.probabilities[choice]))
  ) {
    throw new Error(`SystemOne 返回了无效的选项或概率（${field}：选项、置信度或概率字段不符合契约）。`);
  }
  const total = Object.values(answer.probabilities).reduce((sum, probability) => sum + probability, 0);
  // The API rounds probabilities. Include the intended ±1% endpoints despite IEEE-754 error.
  if (Math.abs(total - 1) > 0.01 + 1e-9) {
    throw new Error(
      `SystemOne 返回了无效的选项或概率（${field}：概率总和 ${total} 超过允许的 ±0.01 舍入范围）。`,
    );
  }
  const chosenProbability = answer.probabilities[answer.choice];
  if (chosenProbability === undefined) throw new Error("SystemOne 响应缺少所选选项的概率。");
  if (Object.values(answer.probabilities).some((probability) => probability > chosenProbability + 1e-6)) {
    throw new Error("SystemOne 的选项与概率分布不一致。");
  }
  return answer;
}

export async function postSystemOneRequest(input: {
  provider: Pick<ProviderConfigSecret, "baseUrl" | "requestPath" | "version" | "apiKey" | "upstreamProxyUrl">;
  modelId: string;
  state: unknown;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
  signal: AbortSignal;
  globalProxyUrl?: string;
  fetcher?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const url = buildMessagesUrl(
    input.provider.baseUrl,
    input.provider.requestPath,
    input.provider.version,
  ).replace(/\/messages$/, "/systemone");
  return withUpstreamProxyFetch(
    input.provider.upstreamProxyUrl || input.globalProxyUrl,
    input.fetcher ?? fetch,
    async (fetcher) => {
      const response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${input.provider.apiKey}` },
        body: JSON.stringify({ model: input.modelId, state: input.state, questions: input.questions }),
        signal: input.signal,
      });
      if (!response.ok) throw new Error(`SystemOne 请求失败：HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("answers" in body) ||
        !body.answers ||
        typeof body.answers !== "object" ||
        Array.isArray(body.answers)
      ) {
        throw new Error("SystemOne 响应缺少有效 answers。");
      }
      return body.answers as Record<string, unknown>;
    },
  );
}
