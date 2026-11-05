import { expect, test } from "bun:test";
import { handleGitCommit, handleGitGenerateCommitMessage, handleGitListCommitModelOptions } from "../src/main/git-service";

const unusedDeps = {} as never;

for (const includePricing of [false, undefined]) {
  test(`model options ${includePricing === false ? "read local identities without pricing" : "retain pricing by default"}`, async () => {
    let pricingCalls = 0;
    const deps = {
      providerStore: {
        listProvidersWithSecrets: () => [{ id: "local", name: "Local", enabled: true, apiCompat: "openai_responses" }],
        listStatelessModelCandidates: () => [{ id: "local-model", modelId: "model", displayName: "Local model" }],
      },
      pricingCache: {
        lookupForRoute: async () => { pricingCalls += 1; return null; },
      },
    } as unknown as Parameters<typeof handleGitListCommitModelOptions>[1];
    const result = await handleGitListCommitModelOptions(
      includePricing === undefined ? {} : { includePricing }, deps,
    );
    expect(pricingCalls).toBe(includePricing === false ? 0 : 1);
    expect(result.options).toMatchObject([{
      candidateModelId: "local-model", providerId: "local", modelId: "model", modelLabel: "Local model",
    }]);
  });
}

test("commit message generation rejects a missing Git commit model before touching Git", async () => {
  await expect(
    handleGitGenerateCommitMessage(
      {
        workspacePath: "/workspace",
        includeUnstaged: true,
      },
      unusedDeps,
    ),
  ).rejects.toThrow(/Git 提交模型/);
});

test("commit without a message rejects a missing Git commit model before touching Git", async () => {
  await expect(
    handleGitCommit(
      {
        workspacePath: "/workspace",
        mainAgentConfigId: "main",
        includeUnstaged: true,
      },
      unusedDeps,
    ),
  ).rejects.toThrow(/Git 提交模型/);
});
