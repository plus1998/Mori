import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveApprovalModelRoute } from "../src/main/approval-model-route";
import { resolveAuxiliaryModelRoute } from "../src/main/auxiliary-model-route";
import { ChatGptModelCatalogService } from "../src/main/chatgpt-model-catalog";
import {
  handleGitGenerateCommitMessage,
  handleGitListCommitModelOptions,
  handleGitSaveCommitModelPreference,
  resolveCommitProxyRoute,
} from "../src/main/git-service";
import { createProviderStore } from "../src/main/provider-store";
import { resolveVisionModelRoute } from "../src/main/vision-model-route";
import { createWorkflowSettingsStore } from "../src/main/workflow-settings-store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-stateless-account-"));
  directories.push(dir);
  const dbPath = path.join(dir, "settings.sqlite");
  const store = await createProviderStore(dbPath);
  store.saveProvider({
    id: "eco-coding-chatgpt",
    name: "ChatGPT OAuth",
    enabled: true,
    baseUrl: "https://api.openai.com",
    apiCompat: "openai_responses",
    authMethod: "chatgpt_subscription",
    credentialPoolId: "chatgpt-default",
    apiKey: "",
    defaultModel: "vision/model:1",
  });
  let fetchCalls = 0;
  const options = {
    cachePath: path.join(dir, "catalog.json"),
    fetchModels: async () => {
      fetchCalls++;
      throw new Error("must stay offline");
    },
  };
  const catalog = new ChatGptModelCatalogService(options);
  await catalog.addManualModel({ modelId: "vision/model:1", displayName: "Account vision" });
  store.setChatGptModelCatalog(() => catalog.getLoadedModels());
  return { store, catalog, options, dbPath, fetchCalls: () => fetchCalls };
}

test("OAuth models are selectable and resolve auxiliary, vision and commit routes without API keys or database candidates", async () => {
  const f = await fixture();
  const result = await handleGitListCommitModelOptions({ includePricing: false }, {
    providerStore: f.store,
  } as Parameters<typeof handleGitListCommitModelOptions>[1]);
  expect(result.options).toHaveLength(1);
  const option = result.options[0]!;
  expect(option.modelLabel).toBe("Account vision");
  const selection = {
    providerId: option.providerId,
    modelId: option.modelId,
    candidateModelId: option.candidateModelId,
    accountId: "account-a",
  };
  for (const resolve of [resolveAuxiliaryModelRoute, resolveVisionModelRoute, resolveApprovalModelRoute]) {
    const route = resolve(selection, f.store);
    expect(route.modelId).toBe(selection.modelId);
    expect(route.provider.authMethod).toBe("chatgpt_subscription");
    expect(route.provider.credentialPoolId).toBe("chatgpt-default");
    expect(route.provider.apiKey).toBe("");
    expect(route.provider.apiCompat).toBe("openai_responses");
  }
  const workflow = await createWorkflowSettingsStore(f.dbPath);
  await handleGitSaveCommitModelPreference(
    { candidateModelId: selection.candidateModelId, accountId: selection.accountId },
    {
      providerStore: f.store,
      workflowSettingsStore: workflow,
    } as Parameters<typeof handleGitSaveCommitModelPreference>[1],
  );
  expect(workflow.get().defaultAuxiliaryModel).toEqual(selection);
  expect(f.store.listCandidateModels(selection.providerId)).toEqual([]);
  expect(f.fetchCalls()).toBe(0);
});

test("explicit account selections survive changes to the shared model cache", async () => {
  const f = await fixture();
  const first = f.store.listStatelessModelCandidates("eco-coding-chatgpt")[0]!;
  const catalog = new ChatGptModelCatalogService(f.options);
  await catalog.listModels();
  f.store.setChatGptModelCatalog(() => catalog.getLoadedModels());
  expect(f.store.listStatelessModelCandidates(first.providerId)[0]?.id).toBe(first.id);
  await catalog.addManualModel({ modelId: "new-model" });
  expect(f.store.listStatelessModelCandidates(first.providerId)).toHaveLength(2);
  await catalog.removeManualModel(first.modelId);
  const selection = {
    providerId: first.providerId,
    modelId: first.modelId,
    candidateModelId: first.id,
    accountId: "account-a",
  };
  expect(resolveAuxiliaryModelRoute(selection, f.store).modelId).toBe(first.modelId);
  expect(resolveVisionModelRoute(selection, f.store).accountId).toBe("account-a");
  expect(f.fetchCalls()).toBe(0);
});

test("cleared auxiliary and vision defaults stay cleared after saving and reloading", async () => {
  const f = await fixture();
  const candidate = f.store.listStatelessModelCandidates("eco-coding-chatgpt")[0]!;
  const selection = {
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    candidateModelId: candidate.id,
  };
  const workflow = await createWorkflowSettingsStore(f.dbPath);
  const saved = workflow.save({
    sessionMode: "agent",
    defaultAuxiliaryModel: selection,
    defaultVisionModel: selection,
  });
  const { defaultAuxiliaryModel: _a, defaultVisionModel: _v, ...cleared } = saved;
  workflow.save(cleared);
  const reloaded = (await createWorkflowSettingsStore(f.dbPath)).get();
  expect(reloaded.defaultAuxiliaryModel).toBeUndefined();
  expect(reloaded.defaultVisionModel).toBeUndefined();
});

test("Git OAuth generation keeps the selected account and validates it before changing Git", async () => {
  const f = await fixture();
  const selection = {
    providerId: "eco-coding-chatgpt",
    modelId: "vision/model:1",
    candidateModelId: "account:eco-coding-chatgpt:vision%2Fmodel%3A1",
    accountId: "account-b",
  };
  const resolved = await resolveCommitProxyRoute({ modelSelection: selection, providerStore: f.store });
  expect(resolved.route.accountId).toBe("account-b");
  expect(resolved.route.role).toBe("auxiliary");
  expect(resolved.route.apiCompat).toBe("openai_responses");
  expect(resolved.candidateModelId).toBe(selection.candidateModelId);
  const { accountId: _, ...unbound } = selection;
  let gitCalls = 0;
  await expect(
    handleGitGenerateCommitMessage(
      {
        workspacePath: "/unused",
        includeUnstaged: true,
        modelSelection: unbound,
      },
      {
        providerStore: f.store,
        run: async () => {
          gitCalls++;
          throw new Error("Git must not run");
        },
      } as unknown as Parameters<typeof handleGitGenerateCommitMessage>[1],
    ),
  ).rejects.toThrow("尚未选择账号");
  expect(gitCalls).toBe(0);
  const workflow = await createWorkflowSettingsStore(f.dbPath);
  workflow.save({ sessionMode: "agent", defaultAuxiliaryModel: selection });
  await expect(
    handleGitSaveCommitModelPreference({ candidateModelId: selection.candidateModelId }, {
      providerStore: f.store,
      workflowSettingsStore: workflow,
    } as Parameters<typeof handleGitSaveCommitModelPreference>[1]),
  ).rejects.toThrow("尚未选择账号");
  expect(workflow.get().defaultAuxiliaryModel).toEqual(selection);
});
