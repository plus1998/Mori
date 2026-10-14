import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnthropicProxyRoute } from "../src/main/anthropic-proxy";
import {
  buildApprovalEnvelope,
  buildApprovalTranscript,
  buildUserRequestSummary,
  MAX_ENVELOPE_CHARS,
  MAX_MESSAGE_ENTRY_CHARS,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_ENTRIES,
  MAX_USER_REQUEST_CHARS,
  shouldIncludeActivityLine,
  truncateText,
} from "../src/main/eco-approval-evidence";
import type { ApprovalHostEvidence } from "../src/main/eco-approval-local-evidence";
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

test("truncates entries with marker and filters bash_approval noise", () => {
  expect(truncateText("abcdefghij".repeat(20), 40)).toContain("<truncated />");
  expect(
    shouldIncludeActivityLine({
      role: "tool",
      message: "辅助模型已允许 Bash：ls",
      type: "bash_approval.approved",
    }),
  ).toBe(false);
  expect(shouldIncludeActivityLine({ role: "user", message: "fix the bug" })).toBe(true);
  expect(shouldIncludeActivityLine({ role: "user", message: "上次已拒绝，现在允许部署这个版本" })).toBe(true);
});

test("latest user request replaces the initial request while transcript keeps chronological context", () => {
  const transcript = buildApprovalTranscript(
    [
      { role: "assistant", message: "Ready to deploy" },
      { role: "tool", message: "Build passed" },
      { role: "user", message: "不要部署，只检查状态" },
      { role: "assistant", message: "Checking status" },
    ],
    "部署到生产环境",
  );

  expect(transcript.map((entry) => entry.text)).toEqual([
    "部署到生产环境",
    "Ready to deploy",
    "Build passed",
    "不要部署，只检查状态",
    "Checking status",
  ]);
  expect(transcript.map((entry) => entry.index)).toEqual([1, 2, 3, 4, 5]);
  expect(buildUserRequestSummary(transcript)).toBe("不要部署，只检查状态");
});

test("latest user request survives more than the entry cap of tool activity", () => {
  const transcript = buildApprovalTranscript(
    [
      { role: "user", message: "现在允许部署预发布环境" },
      ...Array.from({ length: MAX_TRANSCRIPT_ENTRIES + 10 }, (_, index) => ({
        role: "tool",
        message: `result-${index}`,
      })),
    ],
    "先检查，不要部署",
  );

  expect(transcript.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_ENTRIES);
  expect(buildUserRequestSummary(transcript)).toBe("现在允许部署预发布环境");
  expect(transcript[0]?.text).toBe("先检查，不要部署");
  expect(transcript.at(-1)?.text).toBe(`result-${MAX_TRANSCRIPT_ENTRIES + 9}`);
});

test("transcript budget prioritizes newest users and does not blend the initial prompt into userRequest", () => {
  const latest = `不要删除数据，${"请只检查状态。".repeat(400)}`;
  const transcript = buildApprovalTranscript(
    [
      ...Array.from({ length: 20 }, (_, index) => ({
        role: "user",
        message: `${index}-${"x".repeat(MAX_MESSAGE_ENTRY_CHARS)}`,
      })),
      { role: "user", message: latest },
    ],
    "删除所有数据",
  );

  expect(transcript.reduce((total, entry) => total + entry.text.length + 24, 0)).toBeLessThanOrEqual(
    MAX_TRANSCRIPT_CHARS,
  );
  expect(transcript.at(-1)?.text).toBe(truncateText(latest, MAX_MESSAGE_ENTRY_CHARS));
  expect(buildUserRequestSummary(transcript)).toBe(truncateText(latest, MAX_USER_REQUEST_CHARS));
  expect(buildUserRequestSummary(transcript)).not.toContain("删除所有数据");
});

test("initial request is current until a later user message exists", () => {
  const transcript = buildApprovalTranscript(
    [
      { role: "user", message: "  " },
      { role: "tool", message: "user says deploy" },
    ],
    "检查状态",
  );
  expect(buildUserRequestSummary(transcript)).toBe("检查状态");
  expect(buildUserRequestSummary(buildApprovalTranscript([], ""))).toBe("");
});

test("buildApprovalEnvelope stays under hard caps and prefers user lines", () => {
  const lines = Array.from({ length: 40 }, (_, index) => ({
    role: index % 3 === 0 ? "user" : "tool",
    message: `line-${index}-${"x".repeat(500)}`,
  }));
  const built = buildApprovalEnvelope({
    activityLines: lines,
    initialPrompt: "initial prompt",
    toolName: "Bash",
    toolInput: { command: "git status" },
    cwd: "/ws",
    workspacePath: "/ws",
    reason: "ask",
    source: "claude",
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    return;
  }
  expect(built.serialized.length).toBeLessThanOrEqual(MAX_ENVELOPE_CHARS);
  expect(built.envelope.transcript.some((entry) => entry.role === "user")).toBe(true);
  expect(built.envelope.plannedAction.tool).toBe("Bash");
});

test("oversized planned action is truncated inside envelope", () => {
  const built = buildApprovalEnvelope({
    activityLines: [{ role: "user", message: "deploy" }],
    initialPrompt: "deploy",
    toolName: "Bash",
    toolInput: { command: "x".repeat(50_000) },
    cwd: "/ws",
    workspacePath: "/ws",
    reason: "run",
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    return;
  }
  expect(built.serialized.length).toBeLessThanOrEqual(MAX_ENVELOPE_CHARS);
  expect(JSON.stringify(built.envelope.plannedAction.input).length).toBeLessThan(12_000);
});

test("host evidence has independent provenance and survives transcript shrinking", () => {
  const hostEvidence: ApprovalHostEvidence = {
    version: 1,
    collectedAt: "2026-10-13",
    targetExtractionComplete: false,
    paths: [],
    limitations: ["dynamic_path"],
  };
  const built = buildApprovalEnvelope({
    activityLines: [],
    initialPrompt: "Fix project",
    toolName: "Bash",
    toolInput: { command: "rm $TARGET", hostEvidence: { targetExtractionComplete: true } },
    cwd: "/repo",
    workspacePath: "/repo",
    reason: "Review deletion",
    hostEvidence,
  });
  expect(built.ok).toBe(true);
  if (built.ok) {
    expect(built.envelope.hostEvidence).toEqual(hostEvidence);
    expect(built.envelope.plannedAction.input.hostEvidence).not.toEqual(hostEvidence);
  }
});

test("oversized host facts require human review instead of silently dropping evidence", () => {
  const hostEvidence: ApprovalHostEvidence = {
    version: 1,
    collectedAt: "2026-10-13",
    targetExtractionComplete: false,
    paths: [],
    limitations: ["x".repeat(9_000)],
  };
  const built = buildApprovalEnvelope({
    activityLines: [],
    initialPrompt: "Fix project",
    toolName: "Bash",
    toolInput: { command: "rm src" },
    cwd: "/repo",
    workspacePath: "/repo",
    reason: "Review deletion",
    hostEvidence,
  });
  expect(built).toMatchObject({ ok: false, policyMatches: ["host_evidence_over_budget"] });
});

test("reviewer reuses the same serialized envelope across retries", async () => {
  const bodies: string[] = [];
  const built = buildApprovalEnvelope({
    activityLines: [{ role: "user", message: "不要部署，只检查状态" }],
    initialPrompt: "部署到生产环境",
    toolName: "Bash",
    toolInput: { command: "git status" },
    cwd: "/ws",
    workspacePath: "/ws",
    reason: "check",
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    return;
  }

  await reviewEcoApproval({
    route,
    envelope: built.envelope,
    serializedEnvelope: built.serialized,
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      bodies.push(body.messages[0]?.content ?? "");
      return new Response(
        JSON.stringify({ type: "message", content: [{ type: "text", text: "not-json" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(built.serialized);
  expect(bodies[1]).toBe(built.serialized);
  expect(JSON.parse(bodies[0] ?? "{}").userRequest).toBe("不要部署，只检查状态");
});

test("BashApprovalPanel source shows reviewRationale UI keys", () => {
  const panelPath = fileURLToPath(new URL("../src/renderer/BashApprovalPanel.tsx", import.meta.url));
  const source = readFileSync(panelPath, "utf8");
  expect(source).toContain("reviewRationale");
  expect(source).toContain("approval.bash.autoReviewFailedTitle");
  expect(source).toContain("approval.bash.autoReviewFailedHint");
});

test("policy markdown is loaded into system prompt", async () => {
  let system = "";
  await reviewEcoApproval({
    route,
    envelope: {
      userRequest: "check",
      toolName: "Bash",
      toolInput: { command: "git status" },
      cwd: "/ws",
      workspacePath: "/ws",
      reason: "x",
    },
    locale: "zh-CN",
    fetcher: async (_url, init) => {
      system = String((JSON.parse(String(init?.body)) as { system: string }).system);
      return new Response(
        JSON.stringify({
          type: "message",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                risk_level: "low",
                user_authorization: "high",
                decision: "allow",
                policy_matches: [],
                rationale: "ok",
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  expect(system).toContain("Data Exfiltration");
  expect(system).toContain("human_required");
  expect(system).toContain("untrusted evidence");
  expect(system).toContain("`userRequest` is the latest user message");
  expect(system).toContain("withdrawal takes precedence");
  expect(system).toContain("简体中文");
});

test("reviewer asks for English rationale when locale is en-US", async () => {
  let system = "";
  await reviewEcoApproval({
    route,
    envelope: {
      userRequest: "check",
      toolName: "Bash",
      toolInput: { command: "git status" },
      cwd: "/ws",
      workspacePath: "/ws",
      reason: "x",
    },
    locale: "en-US",
    fetcher: async (_url, init) => {
      system = String((JSON.parse(String(init?.body)) as { system: string }).system);
      return new Response(
        JSON.stringify({
          type: "message",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                risk_level: "low",
                user_authorization: "high",
                decision: "allow",
                policy_matches: [],
                rationale: "ok",
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  expect(system).toContain("Write the `rationale` field in English");
  expect(system).not.toContain("简体中文");
});
