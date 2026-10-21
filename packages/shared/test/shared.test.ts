import { expect, test } from "bun:test";
import {
  buildEcoJsonRpcRequest,
  createAgentEvent,
  decodeConversationCursor,
  ECO_RPC_METHODS,
  encodeConversationCursor,
  getRemoteCommandDefinition,
  hasCapabilities,
  isEcoInvokeParams,
  isRemoteCommandChannel,
  listRemoteCommandDefinitions,
  type ModelProfile,
  validateRemoteCommandArgs,
} from "../src";

const model: ModelProfile = {
  id: "sonnet",
  provider: "anthropic",
  displayName: "Claude Sonnet",
  baseUrl: "https://api.anthropic.com",
  modelId: "claude-sonnet",
  capabilities: ["messages_api", "streaming", "tool_use"],
  enabled: true,
};

test("checks required model capabilities", () => {
  expect(hasCapabilities(model, ["messages_api", "tool_use"])).toBe(true);
  expect(hasCapabilities(model, ["subagent_compatible"])).toBe(false);
});

test("creates timestamped agent events", () => {
  const event = createAgentEvent({
    id: "evt_1",
    threadId: "thr_1",
    agentId: "agt_1",
    role: "main",
    type: "agent.started",
    payload: { modelId: "sonnet" },
  });

  expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("round-trips the independent Conversation V2 tool cursor", () => {
  const encoded = encodeConversationCursor({
    kind: "tools",
    storeEpoch: "epoch_1",
    historyRevision: 3,
    createdSeq: 42,
    id: "tool_42",
  });
  expect(decodeConversationCursor(encoded, "tools")).toEqual({
    kind: "tools",
    storeEpoch: "epoch_1",
    historyRevision: 3,
    createdSeq: 42,
    id: "tool_42",
  });
});

test("registers explicit remote command definitions", () => {
  expect(isRemoteCommandChannel("thread:list")).toBe(true);
  expect(isRemoteCommandChannel("thread:list-initial")).toBe(true);
  expect(isRemoteCommandChannel("thread:list-more")).toBe(true);
  expect(isRemoteCommandChannel("thread:approve-plan")).toBe(true);
  expect(isRemoteCommandChannel("center-server:sign-in")).toBe(false);
  expect(listRemoteCommandDefinitions().map((definition) => definition.channel)).toContain(
    "workflow-settings:save",
  );
  expect(listRemoteCommandDefinitions().map((definition) => definition.channel)).toContain(
    "project-orchestration-settings:save",
  );
  expect(isRemoteCommandChannel("mcp-settings:get")).toBe(true);
  expect(isRemoteCommandChannel("settings:digest")).toBe(true);
  expect(isRemoteCommandChannel("cursor:models-list")).toBe(true);
  expect(isRemoteCommandChannel("candidate-model:list")).toBe(true);
  expect(listRemoteCommandDefinitions().map((definition) => definition.channel)).toEqual(
    expect.arrayContaining([
      "thread:get",
      "composer-draft:get",
      "composer-draft:delete",
      "thread:session-bootstrap",
      "thread:retry-from-message",
      "thread:user-message-edit-get",
      "thread:rewrite-from-message",
      "conversation:capabilities",
      "conversation:bootstrap",
      "conversation:projection",
    ]),
  );

  const approvePlan = getRemoteCommandDefinition("thread:approve-plan");
  expect(approvePlan).toMatchObject({
    risk: "privileged",
    requiresConfirmation: true,
  });
  expect(approvePlan?.requiredCapabilities).toContain("approval:decide");
});

test("validates remote command args", () => {
  expect(
    validateRemoteCommandArgs("thread:start", [
      { workspacePath: "/repo", prompt: "ship it", runtimeConfig: { sessionMode: "agent" } },
    ]),
  ).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("thread:start", [])).toMatchObject({ ok: false });
  expect(validateRemoteCommandArgs("thread:start", [{ workspacePath: "/repo" }])).toMatchObject({
    ok: false,
  });
  expect(
    validateRemoteCommandArgs("thread:follow-up-cancel", [
      {
        principalId: "user_1",
        clientCommandId: "follow_up_cancel_1",
        threadId: "thr_1",
        followUpId: "fup_1",
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("thread:follow-up-cancel", ["fup_1"])).toMatchObject({
    ok: false,
  });
  expect(validateRemoteCommandArgs("thread:get", ["thr_1"])).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("composer-draft:get", ["thread:thr_1"])).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("composer-draft:delete", [
      { contextKey: "thread:thr_1", expectedRevision: "revision_1" },
    ]),
  ).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("composer-draft:delete", ["thread:thr_1"])).toMatchObject({
    ok: false,
  });
  expect(
    validateRemoteCommandArgs("thread:delete", [
      {
        principalId: "user_1",
        clientCommandId: "delete_1",
        threadId: "thr_1",
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("thread:delete", [{ threadId: "thr_1" }])).toMatchObject({ ok: false });
  expect(validateRemoteCommandArgs("thread:session-bootstrap", ["thr_1"])).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("thread:user-message-edit-get", [
      { threadId: "thr_1", activityLineId: "act_1" },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("thread:rewrite-from-message", [
      {
        principalId: "user_1",
        clientCommandId: "rewrite_1",
        threadId: "thr_1",
        activityLineId: "act_1",
        prompt: "hello",
        attachments: [],
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("thread:rewrite-from-message", [{ threadId: "thr_1", prompt: "x" }]),
  ).toMatchObject({ ok: false });
  expect(
    validateRemoteCommandArgs("thread:retry-from-message", [
      {
        principalId: "user_1",
        clientCommandId: "retry_1",
        threadId: "thr_1",
        prompt: "retry",
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("thread:retry-from-message", [
      { threadId: "thr_1", prompt: "retry", expectedHistoryRevision: 3 },
    ]),
  ).toMatchObject({ ok: false });
  expect(
    validateRemoteCommandArgs("thread:cancel", [
      {
        principalId: "user_1",
        clientCommandId: "cancel_1",
        threadId: "thr_1",
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("thread:cancel", ["thr_1"])).toMatchObject({ ok: false });
  expect(
    validateRemoteCommandArgs("thread:cancel", [
      { principalId: "user_1", clientCommandId: "cancel_1", threadId: "thr_1" },
    ]),
  ).toMatchObject({ ok: false });
  expect(
    validateRemoteCommandArgs("thread:approve-plan", [
      {
        principalId: "user_1",
        clientCommandId: "plan_1",
        threadId: "thr_1",
        expectedHistoryRevision: 4,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("thread:dismiss-plan", [
      {
        principalId: "user_1",
        clientCommandId: "plan_2",
        threadId: "thr_1",
        expectedHistoryRevision: 4,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("clarification:submit", [
      {
        principalId: "user_1",
        clientCommandId: "clarification_1",
        threadId: "thr_1",
        toolUseId: "tool_1",
        selections: [["A"]],
        expectedHistoryRevision: 4,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("clarification:dismiss", [
      {
        principalId: "user_1",
        clientCommandId: "clarification_2",
        threadId: "thr_1",
        toolUseId: "tool_1",
        expectedHistoryRevision: 4,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("bash-approval:resolve", [
      {
        principalId: "user_1",
        clientCommandId: "approval_1",
        threadId: "thr_1",
        toolUseId: "tool_1",
        decision: "approved",
        expectedHistoryRevision: 4,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("project-orchestration-settings:save", [
      {
        workspacePath: "/repo",
        orchestrationSelection: {
          mainAgentConfigId: "main",
          mainPrompt: { mode: "builtin" },
          subagents: { mode: "none" },
        },
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("thread:follow-up-escalate", [
      {
        principalId: "user_1",
        clientCommandId: "follow_up_escalate_1",
        threadId: "thr_1",
        followUpId: "fup_1",
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("thread:follow-up-update", [
      {
        principalId: "user_1",
        clientCommandId: "follow_up_update_1",
        threadId: "thr_1",
        followUpId: "fup_1",
        prompt: "updated",
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(isRemoteCommandChannel("thread:follow-up-editing")).toBe(true);
  expect(
    validateRemoteCommandArgs("thread:follow-up-editing", [
      {
        principalId: "user_1",
        clientCommandId: "follow_up_editing_1",
        threadId: "thr_1",
        followUpId: "fup_1",
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("thread:follow-up-editing", [
      {
        principalId: "user_1",
        clientCommandId: "follow_up_editing_release_1",
        threadId: "thr_1",
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(isRemoteCommandChannel("thread:follow-up-queue-paused")).toBe(true);
  expect(
    validateRemoteCommandArgs("thread:follow-up-queue-paused", [
      {
        principalId: "user_1",
        clientCommandId: "follow_up_pause_1",
        threadId: "thr_1",
        paused: true,
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("thread:follow-up-queue-paused", [
      {
        principalId: "user_1",
        clientCommandId: "follow_up_resume_1",
        threadId: "thr_1",
        paused: false,
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("thread:follow-up-queue-paused", [{ threadId: "thr_1" }])).toMatchObject({
    ok: false,
  });
  expect(
    validateRemoteCommandArgs("thread:update-runtime-config", [
      {
        principalId: "user_1",
        clientCommandId: "runtime_config_1",
        threadId: "thr_1",
        runtimeConfig: { sessionMode: "agent" },
        expectedHistoryRevision: 3,
      },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("thread:update-runtime-config", [
      { threadId: "thr_1", runtimeConfig: { sessionMode: "agent" } },
    ]),
  ).toMatchObject({ ok: false });
  expect(validateRemoteCommandArgs("center-server:sign-in", [])).toMatchObject({ ok: false });
  expect(validateRemoteCommandArgs("candidate-model:list", ["provider-1"])).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("candidate-model:list", [])).toMatchObject({ ok: false });
  expect(validateRemoteCommandArgs("cursor:models-list", [])).toEqual({ ok: true });
});

test("registers workspace remote command definitions", () => {
  expect(isRemoteCommandChannel("workspace:get-home-path")).toBe(true);
  expect(validateRemoteCommandArgs("workspace:get-home-path", [])).toEqual({ ok: true });
  expect(isRemoteCommandChannel("workspace:get-user-home-path")).toBe(true);
  expect(validateRemoteCommandArgs("workspace:get-user-home-path", [])).toEqual({ ok: true });
  expect(isRemoteCommandChannel("workspace:list-directories")).toBe(true);
  expect(validateRemoteCommandArgs("workspace:list-directories", ["/Users/example"])).toEqual({ ok: true });
  expect(isRemoteCommandChannel("workspace:open-in-file-manager")).toBe(false);
});

test("registers git remote command definitions", () => {
  expect(isRemoteCommandChannel("git:get-status")).toBe(true);
  expect(isRemoteCommandChannel("git:get-workspace-diff")).toBe(true);
  expect(isRemoteCommandChannel("git:get-workspace-file-diff")).toBe(true);
  expect(isRemoteCommandChannel("git:commit")).toBe(true);
  expect(isRemoteCommandChannel("git:push")).toBe(true);
  expect(
    validateRemoteCommandArgs("git:commit", [
      { workspacePath: "/repo", mainAgentConfigId: "main_1", includeUnstaged: true },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("git:commit", [
      { workspacePath: "/repo", includeUnstaged: true, message: "feat: typed commit" },
    ]),
  ).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("git:commit", [{ workspacePath: "/repo" }])).toMatchObject({ ok: false });
  expect(validateRemoteCommandArgs("git:list-commit-model-options", [{}])).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("git:list-commit-model-options", [{ mainAgentConfigId: "main_1" }]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("git:save-commit-model-preference", [{ candidateModelId: "candidate_1" }]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("git:save-commit-model-preference", [
      { candidateModelId: "candidate_1", mainAgentConfigId: "main_1" },
    ]),
  ).toEqual({ ok: true });
  expect(
    validateRemoteCommandArgs("git:generate-commit-message", [
      { workspacePath: "/repo", includeUnstaged: true, candidateModelId: "candidate_1" },
    ]),
  ).toEqual({ ok: true });
  expect(validateRemoteCommandArgs("git:push", [{ workspacePath: "/repo" }])).toEqual({ ok: true });
  expect(isRemoteCommandChannel("git:fetch")).toBe(true);
  expect(validateRemoteCommandArgs("git:fetch", [{ workspacePath: "/repo" }])).toEqual({ ok: true });
  expect(isRemoteCommandChannel("git:pull")).toBe(true);
  expect(validateRemoteCommandArgs("git:pull", [{ workspacePath: "/repo" }])).toEqual({ ok: true });
  expect(isRemoteCommandChannel("thread:todo-list")).toBe(false);
  expect(isRemoteCommandChannel("workspace:list-package-scripts")).toBe(true);
  expect(isRemoteCommandChannel("workspace:save-package-script-args")).toBe(true);
  expect(isRemoteCommandChannel("workspace:start-package-script")).toBe(true);
  expect(isRemoteCommandChannel("background-terminal:open")).toBe(true);
  expect(validateRemoteCommandArgs("background-terminal:open", [{ taskId: "task-1" }])).toEqual({ ok: true });
  expect(isRemoteCommandChannel("background-terminal:stop")).toBe(true);
  expect(validateRemoteCommandArgs("background-terminal:stop", [{ taskId: "task-1" }])).toEqual({ ok: true });
});

test("validates eco.invoke params with desktop target", () => {
  const request = buildEcoJsonRpcRequest("req_1", ECO_RPC_METHODS.invoke, {
    desktopDeviceId: "dev_desktop",
    channel: "thread:list",
    args: [],
  });
  expect(isEcoInvokeParams(request.params)).toBe(true);
});
