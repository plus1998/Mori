import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveApprovalModelRoute, type SystemOneApprovalRoute } from "../src/main/approval-model-route";
import { resolveAuxiliaryModelRoute } from "../src/main/auxiliary-model-route";
import { reviewEcoApproval } from "../src/main/eco-approval-reviewer";
import { fetchUpstreamModelsFromCredentials, testProviderConnection } from "../src/main/provider-models";
import { createProviderStore } from "../src/main/provider-store";
import { parseSystemOneChoiceAnswer } from "../src/main/system-one-request";
import { resolveVisionModelRoute } from "../src/main/vision-model-route";
import { createWorkflowSettingsStore } from "../src/main/workflow-settings-store";
import { normalizeUpstreamApiCompat, resolveUpstreamApiCompat } from "../src/shared/api-compat";
import { listCommitMessageCandidateModels } from "../src/shared/resolve-commit-message-route";
import {
  buildAcpThreadRuntimeConfig,
  isThreadRuntimeConfig,
  normalizeThreadRuntimeConfig,
} from "../src/shared/thread-runtime-config";

const route: SystemOneApprovalRoute = {
  kind: "system_one",
  modelId: "jev-latest",
  provider: {
    id: "jev",
    name: "Jev",
    baseUrl: "https://api.typesafe.test",
    requestPath: "/gateway",
    version: "v2",
    apiCompat: "system_one",
    apiKey: "test-key",
    enabled: true,
    hasApiKey: true,
    defaultModel: "jev-latest",
    createdAt: "",
    updatedAt: "",
  },
};
const envelope = {
  userRequest: "检查仓库状态",
  toolName: "Bash",
  toolInput: { command: "git status" },
  cwd: "/repo",
  workspacePath: "/repo",
  reason: "inspect",
};

test("SystemOne accepts exactly ±1% rounded probability totals without a floating point veto", () => {
  for (const probabilities of [
    { low: 0.9, medium: 0.09, high: 0.01, critical: 0.01 },
    { low: 0.9, medium: 0.07, high: 0.01, critical: 0.01 },
  ]) {
    expect(
      parseSystemOneChoiceAnswer(
        { type: "choice", choice: "low", confidence: 0.9, probabilities },
        ["low", "medium", "high", "critical"],
        "risk_level",
      ).choice,
    ).toBe("low");
  }
  expect(() =>
    parseSystemOneChoiceAnswer(
      {
        type: "choice",
        choice: "low",
        confidence: 0.9,
        probabilities: { low: 0.9, medium: 0.1, high: 0.02, critical: 0 },
      },
      ["low", "medium", "high", "critical"],
      "risk_level",
    ),
  ).toThrow("risk_level：概率总和");
});
function choice(value: string, options: string[], confidence = 0.99, probabilities?: Record<string, number>) {
  return {
    type: "choice",
    choice: value,
    confidence,
    probabilities:
      probabilities ??
      Object.fromEntries(
        options.map((option) => [option, option === value ? 0.99 : 0.01 / (options.length - 1)]),
      ),
  };
}
function answers(risk = "low", authorization = "medium", decision = "allow", decisionConfidence = 0.99) {
  return {
    risk_level: choice(risk, ["low", "medium", "high", "critical"]),
    user_authorization: choice(authorization, ["unknown", "low", "medium", "high"]),
    decision: choice(decision, ["allow", "human_required", "deny"], decisionConfidence),
  };
}
function fetchAnswers(value: unknown): typeof fetch {
  return async () =>
    Response.json({ model: "jev-1.13", answers: value, usage: { input_tokens: 1, output_tokens: 1 } });
}

test("SystemOne reviews use state/questions and Bearer auth rather than a chat payload", async () => {
  const result = await reviewEcoApproval({
    route,
    envelope,
    locale: "zh-CN",
    fetcher: async (url, init) => {
      expect(String(url)).toBe("https://api.typesafe.test/gateway/v2/systemone");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("jev-latest");
      expect(body.state.evidence.plannedAction.input.command).toBe("git status");
      expect(Object.keys(body.questions)).toEqual(["risk_level", "user_authorization", "decision"]);
      expect(body.messages).toBeUndefined();
      expect(body.state.policy).toContain("user_authorization");
      expect(body.questions.user_authorization.criteria.high).toContain("necessary implementation");
      expect(body.questions.user_authorization.criteria.medium).toContain("not the exact implementation");
      expect(body.questions.risk_level.instructions).toContain("boundaries alone do not imply high risk");
      return Response.json({ answers: answers() });
    },
  });
  expect(result.action).toBe("allow");
  expect(result.rationale).toContain("SystemOne");
});

for (const [risk, authorization, decision, confidence, action] of [
  ["critical", "high", "allow", 0.99, "human_required"],
  ["low", "high", "deny", 0.99, "human_required"],
  ["high", "low", "allow", 0.99, "human_required"],
  ["high", "high", "allow", 0.99, "human_required"],
  ["low", "medium", "allow", 0.6, "allow"],
  ["low", "medium", "human_required", 0.99, "human_required"],
] as const) {
  test(`SystemOne enforces risk/authorization/confidence: ${risk}/${authorization}/${decision}/${confidence}`, async () => {
    const result = await reviewEcoApproval({
      route,
      envelope,
      fetcher: fetchAnswers(answers(risk, authorization, decision, confidence)),
    });
    expect(result.action).toBe(action);
  });
}

test("read-only MySQL review does not require certainty about the exact authorization grade", async () => {
  const value = answers();
  value.user_authorization = choice("medium", ["unknown", "low", "medium", "high"], 0.44, {
    unknown: 0.02,
    low: 0.03,
    medium: 0.49,
    high: 0.46,
  });
  const result = await reviewEcoApproval({
    route,
    envelope: {
      ...envelope,
      userRequest: "检查归档消息的时间分布",
      toolName: "mysql/mcp__mysql__mysql_query",
      toolInput: {
        sql: "SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM (SELECT created_at FROM wecom_archived_message WHERE id BETWEEN 1 AND 5000 ORDER BY id LIMIT 2000) sample",
      },
    },
    locale: "zh-CN",
    fetcher: fetchAnswers(value),
  });
  expect(result.action).toBe("allow");
  expect(result.rationale).toContain("决策置信度：99.0%");
  expect(result.rationale).not.toContain("44.0%");
});

test("low/medium risk uncertainty does not add a strong authorization requirement", async () => {
  const value = answers("low", "unknown");
  value.risk_level = choice("low", ["low", "medium", "high", "critical"], 0.44, {
    low: 0.48,
    medium: 0.48,
    high: 0.03,
    critical: 0.01,
  });
  value.user_authorization = choice("unknown", ["unknown", "low", "medium", "high"], 0.4, {
    unknown: 0.4,
    low: 0.3,
    medium: 0.2,
    high: 0.1,
  });
  const result = await reviewEcoApproval({ route, envelope, fetcher: fetchAnswers(value) });
  expect(result.action).toBe("allow");
});

for (const authorization of ["medium", "high"]) {
  test(`high risk always reaches the user with ${authorization} authorization selected`, async () => {
    const value = answers("high", authorization);
    value.user_authorization = choice(authorization, ["unknown", "low", "medium", "high"], 0.44, {
      unknown: 0.02,
      low: 0.02,
      medium: authorization === "medium" ? 0.49 : 0.47,
      high: authorization === "high" ? 0.49 : 0.47,
    });
    const result = await reviewEcoApproval({ route, envelope, fetcher: fetchAnswers(value) });
    expect(result.action).toBe("human_required");
  });
}

for (const authorization of ["low", "high"]) {
  test(`uncertainty across the high-risk boundary requires sufficient authorization: ${authorization}`, async () => {
    const value = answers("low", authorization);
    value.risk_level = choice("low", ["low", "medium", "high", "critical"], 0.4, {
      low: 0.49,
      medium: 0.02,
      high: 0.47,
      critical: 0.02,
    });
    const result = await reviewEcoApproval({
      route,
      envelope,
      locale: "zh-CN",
      fetcher: fetchAnswers(value),
    });
    expect(result.action).toBe("human_required");
    expect(result.policyMatches).toContain("system_one_high_risk_uncertain");
    expect(result.rationale).toContain("低/中风险概率为 51.0%");
  });
}

test("a confident authorization grade cannot override insufficient authorized probability", async () => {
  const value = answers("high", "medium");
  value.user_authorization = choice("medium", ["unknown", "low", "medium", "high"], 0.99, {
    unknown: 0.05,
    low: 0.1,
    medium: 0.8,
    high: 0.05,
  });
  const result = await reviewEcoApproval({
    route,
    envelope,
    locale: "en-US",
    fetcher: fetchAnswers(value),
  });
  expect(result.action).toBe("human_required");
  expect(result.policyMatches).toContain("model_recommendation_requires_human");
  expect(result.rationale).toContain("requires the user's decision");
});

test("critical-risk probability blocks automatic allow even with strong authorization", async () => {
  const value = answers("low", "high");
  value.risk_level = choice("low", ["low", "medium", "high", "critical"], 0.7, {
    low: 0.6,
    medium: 0.15,
    high: 0.05,
    critical: 0.2,
  });
  const result = await reviewEcoApproval({
    route,
    envelope,
    locale: "zh-CN",
    fetcher: fetchAnswers(value),
  });
  expect(result.action).toBe("human_required");
  expect(result.policyMatches).toContain("system_one_critical_risk_uncertain");
  expect(result.rationale).toContain("非严重风险概率为 80.0%");
});

for (const locale of ["zh-CN", "en-US"]) {
  test(`routine allow/human confidence does not block a confidently low-risk action: ${locale}`, async () => {
    const result = await reviewEcoApproval({
      route,
      envelope,
      locale,
      fetcher: fetchAnswers(answers("low", "high", "allow", 0.44)),
    });
    expect(result.action).toBe("allow");
    expect(result.rationale).toContain("44.0%");
    expect(result.rationale).not.toContain("below 90%");
    expect(result.rationale).not.toContain("置信度低于 90%");
  });
}

test("critical classification goes to the user even when the final decision is confident allow", async () => {
  const value = answers("critical", "high");
  value.risk_level = choice("critical", ["low", "medium", "high", "critical"], 0.3, {
    low: 0.2,
    medium: 0.2,
    high: 0.2,
    critical: 0.4,
  });
  const result = await reviewEcoApproval({ route, envelope, fetcher: fetchAnswers(value) });
  expect(result.action).toBe("human_required");
});

test("deny and human-required decisions are never upgraded by favorable risk or authorization", async () => {
  for (const decision of ["deny", "human_required"] as const) {
    const result = await reviewEcoApproval({
      route,
      envelope,
      fetcher: fetchAnswers(answers("low", "high", decision, 0.4)),
    });
    expect(result.action).toBe("human_required");
  }
});

test("policy probability thresholds include exactly 90%", async () => {
  const value = answers("low", "unknown", "allow", 0.4);
  value.risk_level = choice("low", ["low", "medium", "high", "critical"], 0.4, {
    low: 0.7,
    medium: 0.2,
    high: 0.1,
    critical: 0,
  });
  const result = await reviewEcoApproval({ route, envelope, fetcher: fetchAnswers(value) });
  expect(result.action).toBe("allow");
});

test("rounded probability totals cannot inflate a policy boundary above its threshold", async () => {
  const value = answers("low", "low");
  value.risk_level = choice("low", ["low", "medium", "high", "critical"], 0.4, {
    low: 0.47,
    medium: 0.438,
    high: 0.06,
    critical: 0.041,
  });
  const result = await reviewEcoApproval({ route, envelope, fetcher: fetchAnswers(value) });
  expect(result.action).toBe("human_required");
  expect(result.policyMatches).toContain("system_one_high_risk_uncertain");
});

test("adverse decision probability still requires a human despite a low-risk allow choice", async () => {
  const value = answers("low", "unknown", "allow", 0.44);
  value.decision = choice("allow", ["allow", "human_required", "deny"], 0.44, {
    allow: 0.5,
    human_required: 0.3,
    deny: 0.2,
  });
  const result = await reviewEcoApproval({ route, envelope, fetcher: fetchAnswers(value) });
  expect(result.action).toBe("human_required");
  expect(result.policyMatches).toContain("system_one_deny_uncertain");
  expect(result.rationale).toContain("20.0%");
});

test("malformed SystemOne distributions and HTTP failures stay visible and never allow", async () => {
  const invalid = answers();
  invalid.decision.probabilities.allow = 2;
  const result = await reviewEcoApproval({ route, envelope, fetcher: fetchAnswers(invalid) });
  expect(result.action).toBe("human_required");
  expect(result.policyMatches).toContain("review_failed_closed");
  expect(result.rationale).toContain("无效");
  const failed = await reviewEcoApproval({
    route,
    envelope,
    fetcher: async () => new Response("error", { status: 401 }),
  });
  expect(failed.action).toBe("human_required");
  expect(failed.rationale).toContain("HTTP 401");
});

test("SystemOne models discovery understands models/name and connection probes call systemone", async () => {
  const models = await fetchUpstreamModelsFromCredentials(
    "https://api.typesafe.test",
    "key",
    "",
    undefined,
    "system_one",
    undefined,
    "v1",
    async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
      return Response.json({ models: [{ name: "jev-latest", description: "Jev" }, { name: "jev-1.13" }] });
    },
  );
  expect(models).toEqual({ ok: true, models: [{ id: "jev-1.13" }, { id: "jev-latest" }] });
  const probe = await testProviderConnection(
    {} as never,
    {
      baseUrl: "https://api.typesafe.test",
      requestPath: "",
      apiCompat: "system_one",
      apiKey: "key",
      defaultModel: "jev-latest",
    },
    async (url) => {
      expect(String(url)).toBe("https://api.typesafe.test/v1/systemone");
      return Response.json({ answers: { connection: choice("connected", ["connected", "unavailable"]) } });
    },
  );
  expect(probe.ok).toBe(true);
});

test("SystemOne is available only to approval selection and cannot be overridden onto chat", async () => {
  expect(normalizeUpstreamApiCompat("system_one")).toBe("system_one");
  expect(() => resolveUpstreamApiCompat("anthropic", "system_one")).toThrow("仅可用于审批");
  const directory = await mkdtemp(path.join(os.tmpdir(), "eco-system-one-"));
  try {
    const store = await createProviderStore(path.join(directory, "providers.sqlite"));
    const provider = store.saveProvider({
      name: "Jev",
      baseUrl: "https://api.typesafe.test",
      apiCompat: "system_one",
      apiKey: "key",
      defaultModel: "jev-latest",
      enabled: true,
    });
    const candidate = store.saveCandidateModel({ providerId: provider.id, modelId: "jev-latest" });
    const selection = { providerId: provider.id, modelId: candidate.modelId, candidateModelId: candidate.id };
    expect(store.listProviders()[0]?.apiCompat).toBe("system_one");
    expect(
      listCommitMessageCandidateModels(store.listProviders(), (id) => store.listCandidateModels(id)),
    ).toEqual([]);
    expect(
      listCommitMessageCandidateModels(
        store.listProviders(),
        (id) => store.listCandidateModels(id),
        "approval",
      ),
    ).toHaveLength(1);
    expect(resolveApprovalModelRoute(selection, store)).toMatchObject({
      kind: "system_one",
      modelId: "jev-latest",
    });
    expect(() => resolveAuxiliaryModelRoute(selection, store)).toThrow("仅可用于审批");
    expect(() => resolveVisionModelRoute(selection, store)).toThrow("仅可用于审批");
    expect(() => resolveApprovalModelRoute(undefined, store)).toThrow("未配置审批模型");
    expect(() => resolveApprovalModelRoute({ ...selection, modelId: "wrong" }, store)).toThrow("发生变化");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow and runtime configs persist and clear approval independently without auxiliary fallback", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eco-approval-config-"));
  try {
    const store = await createWorkflowSettingsStore(path.join(directory, "workflow.sqlite"));
    const auxiliary = { providerId: "chat", modelId: "fast", candidateModelId: "fast-id" };
    const approval = { providerId: "jev", modelId: "jev-latest", candidateModelId: "jev-id" };
    const saved = store.save({
      ...store.get(),
      defaultAuxiliaryModel: auxiliary,
      defaultApprovalModel: approval,
    });
    expect(store.get().defaultApprovalModel).toEqual(approval);
    const config = normalizeThreadRuntimeConfig(
      buildAcpThreadRuntimeConfig({
        auxiliaryModel: auxiliary,
        approvalModel: approval,
        bashReviewMode: "auto",
      }),
    );
    expect(config.approvalModel).toEqual(approval);
    expect(config.auxiliaryModel).toEqual(auxiliary);
    expect(isThreadRuntimeConfig(config)).toBe(true);
    expect(isThreadRuntimeConfig({ ...config, approvalModel: { ...approval, candidateModelId: "" } })).toBe(
      false,
    );
    const { defaultApprovalModel: _clear, ...cleared } = saved;
    store.save(cleared);
    expect(store.get().defaultApprovalModel).toBeUndefined();
    expect(store.get().defaultAuxiliaryModel).toEqual(auxiliary);
    expect(buildAcpThreadRuntimeConfig({ auxiliaryModel: auxiliary }).approvalModel).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
