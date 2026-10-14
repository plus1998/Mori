import { expect, test } from "bun:test";
import type { AnthropicProxyRoute } from "../src/main/anthropic-proxy";
import { reviewEcoApproval } from "../src/main/eco-approval-reviewer";

const route: AnthropicProxyRoute = {
  role: "auxiliary",
  provider: {
    id: "provider",
    name: "Provider",
    baseUrl: "https://provider.test",
    requestPath: "",
    version: "v1",
    apiCompat: "anthropic",
    tokenCountMode: "auto",
    defaultModel: "review-model",
    enabled: true,
    hasApiKey: true,
    apiKey: "secret",
    createdAt: "",
    updatedAt: "",
  },
  modelId: "review-model",
};

function envelope(command: string) {
  return {
    userRequest: "更新当前项目",
    toolName: "Bash",
    toolInput: { command },
    cwd: "/workspace",
    workspacePath: "/workspace",
    reason: "Run command",
  };
}

test("reviewer accepts a valid low-risk JSON decision", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const result = await reviewEcoApproval({
    route,
    envelope: envelope("git status"),
    fetcher: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          type: "message",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                risk_level: "low",
                user_authorization: "medium",
                decision: "allow",
                policy_matches: [],
                rationale: "Read-only repository inspection.",
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  expect(result.action).toBe("allow");
  expect(requestBody?.system).toContain("risk_level");
  expect(requestBody?.system).toContain("user_authorization");
  expect(requestBody?.system).toContain("decision");
  expect(requestBody?.system).toContain("human_required");
  expect(requestBody?.system).toContain("rationale");
});

test("reviewer accepts identical adjacent JSON objects from a duplicated upstream stream", async () => {
  const review = JSON.stringify({
    risk_level: "low",
    user_authorization: "medium",
    decision: "allow",
    policy_matches: [],
    rationale: "Read-only repository inspection.",
  });
  const result = await reviewEcoApproval({
    route,
    envelope: envelope("git status"),
    fetcher: async () =>
      new Response(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: `${review}${review}` }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  expect(result.action).toBe("allow");
});

test("reviewer rejects conflicting adjacent JSON objects", async () => {
  const base = {
    risk_level: "low",
    user_authorization: "medium",
    policy_matches: [],
    rationale: "Repository inspection.",
  };
  const result = await reviewEcoApproval({
    route,
    envelope: envelope("git status"),
    fetcher: async () =>
      new Response(
        JSON.stringify({
          type: "message",
          content: [
            {
              type: "text",
              text: `${JSON.stringify({ ...base, decision: "allow" })}${JSON.stringify({
                ...base,
                decision: "deny",
              })}`,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  expect(result.action).toBe("human_required");
  expect(result.policyMatches).toContain("review_failed_closed");
});

test("reviewer retains model-classified critical risk and transfers the final decision to the user", async () => {
  const result = await reviewEcoApproval({
    route,
    envelope: envelope("custom-admin-command"),
    fetcher: async () =>
      new Response(
        JSON.stringify({
          type: "message",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                risk_level: "critical",
                user_authorization: "high",
                decision: "human_required",
                policy_matches: ["critical_secret_exfiltration"],
                rationale: "The action would disclose credentials to an untrusted destination.",
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  expect(result.action).toBe("human_required");
  expect(result).toMatchObject({ riskLevel: "critical" });
  expect(result.policyMatches).toContain("model_recommendation_requires_human");
});

test("reviewer fails closed to human approval on invalid model output", async () => {
  let calls = 0;
  const result = await reviewEcoApproval({
    route,
    envelope: envelope("git status"),
    fetcher: async () => {
      calls += 1;
      return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "allow" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  expect(calls).toBe(2);
  expect(result.action).toBe("human_required");
  expect(result.policyMatches).toContain("review_failed_closed");
});
