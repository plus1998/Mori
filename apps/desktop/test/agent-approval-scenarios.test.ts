import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SystemOneApprovalRoute } from "../src/main/approval-model-route";
import { collectApprovalHostEvidence } from "../src/main/eco-approval-local-evidence";
import { buildThreadApprovalEnvelope, reviewEcoApproval } from "../src/main/eco-approval-reviewer";

const route: SystemOneApprovalRoute = {
  kind: "system_one",
  modelId: "jev-latest",
  provider: {
    id: "jev",
    name: "Jev",
    baseUrl: "https://typesafe.test",
    requestPath: "",
    version: "v1",
    apiCompat: "system_one",
    apiKey: "test-key",
    enabled: true,
    hasApiKey: true,
    defaultModel: "jev-latest",
    createdAt: "",
    updatedAt: "",
  },
};
const answer = (choice: string, choices: string[]) => ({
  type: "choice",
  choice,
  confidence: 0.99,
  probabilities: Object.fromEntries(
    choices.map((value) => [value, value === choice ? 0.99 : 0.01 / (choices.length - 1)]),
  ),
});
const allow = () =>
  Response.json({
    answers: {
      risk_level: answer("low", ["low", "medium", "high", "critical"]),
      user_authorization: answer("medium", ["unknown", "low", "medium", "high"]),
      decision: answer("allow", ["allow", "human_required", "deny"]),
    },
  });
let root: string, repo: string, scratch: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "eco-jev-wire-"));
  repo = path.join(root, "repo");
  scratch = path.join(root, "scratch");
  await mkdir(repo);
  await mkdir(scratch);
  await writeFile(path.join(scratch, "result.json"), "{}");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("SystemOne receives all scenario rules, exact host facts, SDK hints and advisory risk labels", async () => {
  const input = { command: `rm ${scratch}/result.json` };
  const hostEvidence = await collectApprovalHostEvidence({
    toolName: "Bash",
    toolInput: input,
    cwd: repo,
    workspacePath: repo,
    sdkHints: { defaultToNo: true, suppressAlwaysAllowRule: true },
  });
  const built = buildThreadApprovalEnvelope({
    activityLines: [],
    initialPrompt: "清理测试临时文件",
    toolName: "Bash",
    toolInput: input,
    cwd: repo,
    workspacePath: repo,
    reason: "File deletion",
    riskScore: 100,
    riskLevel: "critical",
    hostEvidence,
  });
  if (!built.ok) throw new Error(built.rationale);
  const result = await reviewEcoApproval({
    route,
    envelope: built.envelope,
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.state.evidence.hostEvidence).toEqual(hostEvidence);
      expect(body.state.evidence.riskLevel).toBe("critical");
      for (const scenario of [
        "repo_recoverable_change",
        "task_temporary_cleanup",
        "ordinary_memory_update",
        "generated_artifact_cleanup",
        "local_git_workflow",
        "development_dependencies_and_tools",
        "task_development_process",
        "isolated_test_resources",
        "task_reads_outputs_and_authentication",
        "bounded_task_permission",
      ])
        expect(body.state.policy).toContain(scenario);
      expect(body.questions.risk_level.instructions).toContain("not authoritative risk labels");
      expect(body.questions.decision.instructions).toContain("not automatic vetoes");
      return allow();
    },
  });
  expect(result.action).toBe("allow");
  expect(result.diagnostics?.decision.confidence).toBe(0.99);
});

test("file changes during model review invalidate the previous approval proof", async () => {
  const target = path.join(scratch, "changing.txt");
  await writeFile(target, "before");
  const input = { command: `rm ${target}` };
  const hostEvidence = await collectApprovalHostEvidence({
    toolName: "Bash",
    toolInput: input,
    cwd: repo,
    workspacePath: repo,
  });
  const built = buildThreadApprovalEnvelope({
    activityLines: [],
    initialPrompt: "清理临时文件",
    toolName: "Bash",
    toolInput: input,
    cwd: repo,
    workspacePath: repo,
    reason: "Deletion",
    hostEvidence,
  });
  if (!built.ok) throw new Error(built.rationale);
  const result = await reviewEcoApproval({
    route,
    envelope: built.envelope,
    fetcher: async () => {
      await writeFile(target, "concurrent user edit with different bytes");
      return allow();
    },
  });
  expect(result.action).toBe("human_required");
  expect(result.policyMatches).toContain("host_evidence_changed");
  expect(result.diagnostics?.decision.choice).toBe("allow");
});
