import { expect, test } from "bun:test";
import {
  buildPlanHandoffContinuePlan,
  buildPlanHandoffForkThread,
  buildPlanHandoffSameThread,
  PLAN_IMPLEMENT_USER_MESSAGE,
  PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX,
} from "../src/codex-plan-handoff.js";
import { applyCodexTurnModel, buildCodexTurnOptions } from "../src/codex-prompt-materializer.js";

test("agent sessionMode maps to default + workspaceWrite", () => {
  const options = buildCodexTurnOptions({ sessionMode: "agent" });

  expect(options).toMatchSnapshot();
  expect(options.collaborationMode.mode).toBe("default");
  expect(options.sandboxPolicy).toBe("workspaceWrite");
  expect(options.approvalPolicy).toBe("on-request");
  expect(options.collaborationMode.settings.developer_instructions).toBeNull();
});

test("plan sessionMode maps to the built-in plan collaboration template", () => {
  const options = buildCodexTurnOptions({ sessionMode: "plan" });

  expect(options).toMatchSnapshot();
  expect(options.collaborationMode.mode).toBe("plan");
  expect(options.sandboxPolicy).toBe("workspaceWrite");
  expect(options.approvalPolicy).toBe("on-request");
  expect(options.collaborationMode.settings.developer_instructions).toBeNull();
});

test("ask sessionMode maps to built-in default + readOnly", () => {
  const options = buildCodexTurnOptions({ sessionMode: "ask" });

  expect(options).toMatchSnapshot();
  expect(options.collaborationMode.mode).toBe("default");
  expect(options.sandboxPolicy).toBe("readOnly");
  expect(options.collaborationMode.settings.developer_instructions).toBeNull();
});

test("plan handoff same thread switches to default execution", () => {
  const spec = buildPlanHandoffSameThread({ planMarkdown: "# Plan\n- step 1" });
  expect(spec.choice).toBe("same_thread");
  expect(spec.forkThread).toBe(false);
  expect(spec.sandboxPolicy).toBe("workspaceWrite");
  expect(spec.collaborationMode.mode).toBe("default");
  expect(spec.userMessage).toBe(PLAN_IMPLEMENT_USER_MESSAGE);
});

test("plan handoff fork thread injects clear-context prefix and plan body", () => {
  const plan = "# Plan\n- implement feature";
  const spec = buildPlanHandoffForkThread({ planMarkdown: plan, planUserEdited: true });
  expect(spec.choice).toBe("fork_thread");
  expect(spec.forkThread).toBe(true);
  expect(spec.userMessage).toContain(PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX);
  expect(spec.userMessage).toContain(plan);
  expect(spec.userMessage).toContain("user edited the plan");
});

test("plan handoff continue plan keeps plan collaboration mode", () => {
  const spec = buildPlanHandoffContinuePlan({
    planMarkdown: "# Plan",
    userFollowUp: "Add error handling section",
  });
  expect(spec.choice).toBe("continue_plan");
  expect(spec.forkThread).toBe(false);
  expect(spec.collaborationMode.mode).toBe("plan");
  expect(spec.userMessage).toBe("Add error handling section");
});

test("plan handoff does not import legacy plan tool or finalize-plan", async () => {
  const legacyPlanTool = "Exit" + "PlanMode";
  const source = await Bun.file(new URL("../src/codex-plan-handoff.ts", import.meta.url)).text();
  expect(source).not.toMatch(new RegExp(`import\\s+.*${legacyPlanTool}`));
  expect(source).not.toMatch(/import\s+.*finalize-plan/);
  expect(source).not.toMatch(/from\s+["'].*finalize-plan/);
});

test("applyCodexTurnModel requires model on collaborationMode.settings", () => {
  const draft = buildCodexTurnOptions({ sessionMode: "agent" }).collaborationMode;
  const wired = applyCodexTurnModel(draft, "claude-sonnet-4");
  expect(wired.settings.model).toBe("claude-sonnet-4");
  expect(wired.settings.developer_instructions).toBeNull();

  const planWired = applyCodexTurnModel(
    buildCodexTurnOptions({ sessionMode: "plan" }).collaborationMode,
    "gpt-test",
  );
  expect(planWired.mode).toBe("plan");
  expect(planWired.settings.model).toBe("gpt-test");
  expect(planWired.settings.developer_instructions).toBeNull();

  const noReasoningWired = applyCodexTurnModel(draft, "gpt-5.4", "none");
  expect(noReasoningWired.settings.reasoning_effort).toBe("none");
  const customReasoningWired = applyCodexTurnModel(draft, "gpt-5.4", " focused ");
  expect(customReasoningWired.settings.reasoning_effort).toBe("focused");

  expect(() => applyCodexTurnModel(draft, "   ")).toThrow(/model is required/);
  expect(() => applyCodexTurnModel(draft, "gpt-5.4", "   ")).toThrow(/non-empty string/);
});
