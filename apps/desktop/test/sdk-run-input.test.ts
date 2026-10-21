import { expect, test } from "bun:test";
import type { ResolvedModelRoute } from "@eco/model-router";
import { buildSdkRunInput, sdkRunPhaseFromMode } from "../src/main/sdk-run-input";

function route(role: ResolvedModelRoute["role"] = "main"): ResolvedModelRoute {
  return {
    role,
    primary: {
      id: `${role}-profile`,
      provider: "custom",
      displayName: `${role} model`,
      baseUrl: "https://models.example.test",
      modelId: `${role}-model`,
      capabilities: ["messages_api"],
      enabled: true,
    },
    fallbacks: [],
  };
}

test("buildSdkRunInput keeps required SDK driver fields", () => {
  const routes = [route("main")];
  const signal = new AbortController().signal;

  const input = buildSdkRunInput({
    threadId: "thr_input",
    prompt: "implement feature",
    workspacePath: "/workspace",
    worktreePath: "/workspace/.worktree",
    routes,
    signal,
  });

  expect(input).toMatchObject({
    threadId: "thr_input",
    prompt: "implement feature",
    workspacePath: "/workspace",
    worktreePath: "/workspace/.worktree",
  });
  expect(input.routes).toBe(routes);
  expect(input.signal).toBe(signal);
  expect(Object.hasOwn(input, "sdkSession")).toBe(false);
  expect(Object.hasOwn(input, "resume")).toBe(false);
  expect(Object.hasOwn(input, "resumableSubagents")).toBe(false);
  expect(Object.hasOwn(input, "executionPromptOverride")).toBe(false);
});

test("buildSdkRunInput includes optional audit and resume fields without dropping empty refs", () => {
  const routes = [route("coder")];
  const signal = new AbortController().signal;
  const sdkSession = {
    settingSources: ["user", "project"] as const,
    mcpServers: {},
    mcpAllowedTools: ["AskUserQuestion"],
  };
  const resume = { resumeSessionId: "sess_123" };
  const resumableSubagents: [] = [];

  const input = buildSdkRunInput({
    threadId: "thr_resume",
    prompt: "continue",
    workspacePath: "/workspace",
    worktreePath: "/workspace/.worktree",
    routes,
    signal,
    sdkSession,
    resume,
    resumableSubagents,
    executionPromptOverride: "full execution prompt",
  });

  expect(input.sdkSession).toBe(sdkSession);
  expect(input.resume).toBe(resume);
  expect(input.resumableSubagents).toBe(resumableSubagents);
  expect(input.executionPromptOverride).toBe("full execution prompt");
});

test("buildSdkRunInput omits blank execution prompt override", () => {
  const input = buildSdkRunInput({
    threadId: "thr_blank",
    prompt: "continue",
    workspacePath: "/workspace",
    worktreePath: "/workspace",
    routes: [route()],
    signal: new AbortController().signal,
    executionPromptOverride: "",
  });

  expect(Object.hasOwn(input, "executionPromptOverride")).toBe(false);
});

test("sdkRunPhaseFromMode maps continuation modes to subagent phases", () => {
  expect(sdkRunPhaseFromMode("ask")).toBe("ask");
  expect(sdkRunPhaseFromMode("planning")).toBe("planning");
  expect(sdkRunPhaseFromMode("execution")).toBe("execution");
});
