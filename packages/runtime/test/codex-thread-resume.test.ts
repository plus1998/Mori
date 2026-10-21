import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CodexAppServerClient } from "../src/codex-app-server-client";
import { recordAppliedCodexThreadConfig } from "../src/codex-thread-config-fingerprint";
import type { CodexResumeDiagnostic } from "../src/codex-thread-resume";
import {
  buildCodexSubagentFollowupPrompt,
  buildCodexThreadResumeParams,
  CODEX_RESUME_METHOD,
  CODEX_THREAD_READ_METHOD,
  CodexResumeNotAvailable,
  isCodexThreadStatusTerminal,
  isCodexZeroTurnRolloutMissingError,
  parseCodexThreadStatus,
  readCodexThreadStatus,
  requireCodexSubagentThreadId,
  resumeCodexThread,
} from "../src/codex-thread-resume";
import { drainPassThroughText, parseJsonLines } from "./codex-mock-transport";

function writeResponse(stdout: PassThrough, message: unknown): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

test("buildCodexThreadResumeParams trims and locks request shape", () => {
  expect(
    buildCodexThreadResumeParams({
      threadId: " codex-thread-1 ",
      cwd: " /repo ",
      model: " claude-sonnet-4 ",
      modelProvider: " eco_main ",
      developerInstructions: " Keep Eco orchestration guidance. ",
      config: { mcp_servers: { browser: { enabled: false } } },
    }),
  ).toEqual({
    threadId: "codex-thread-1",
    cwd: "/repo",
    model: "claude-sonnet-4",
    modelProvider: "eco_main",
    developerInstructions: "Keep Eco orchestration guidance.",
    config: { mcp_servers: { browser: { enabled: false } } },
  });
});

test("buildCodexThreadResumeParams rejects missing thread id without fallback", () => {
  expect(() => buildCodexThreadResumeParams({ threadId: "  " })).toThrow(CodexResumeNotAvailable);
});

test("resumeCodexThread applies config only when thread/read proves notLoaded", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);

  const resume = resumeCodexThread(client, {
    threadId: "codex-thread-1",
    cwd: "/repo",
    config: { mcp_servers: { browser: { enabled: false } } },
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    result: { thread: { id: "codex-thread-1", status: { type: "notLoaded" } } },
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: {
      thread: { id: "codex-thread-1", status: { type: "idle" } },
    },
  });

  await expect(resume).resolves.toEqual({
    thread: { id: "codex-thread-1", status: { type: "idle" } },
  });
  const lines = parseJsonLines(drainPassThroughText(stdin));
  expect(lines).toEqual([
    {
      id: 1,
      method: CODEX_THREAD_READ_METHOD,
      params: {
        threadId: "codex-thread-1",
        includeTurns: false,
      },
    },
    {
      id: 2,
      method: CODEX_RESUME_METHOD,
      params: {
        threadId: "codex-thread-1",
        cwd: "/repo",
        config: { mcp_servers: { browser: { enabled: false } } },
      },
    },
  ]);
});

test("resumeCodexThread refuses configured idle resume because config reload is not provable", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);

  const diagnostics: CodexResumeDiagnostic[] = [];
  const resume = resumeCodexThread(client, {
    threadId: "codex-thread-idle",
    config: { mcp_servers: {} },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    result: { thread: { id: "codex-thread-idle", status: { type: "idle" } } },
  });

  await expect(resume).rejects.toThrow(/new thread/);
  expect(drainPassThroughText(stdin)).not.toContain(CODEX_RESUME_METHOD);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    threadId: "codex-thread-idle",
    clientInstanceId: client.diagnosticInstanceId,
    clientGeneration: 0,
    configAlreadyApplied: false,
    status: "idle",
    decision: "reject_loaded_config",
  });
  expect(diagnostics[0]?.nextConfigFingerprint).toMatch(/^[a-f0-9]{64}$/);
});

test("resumeCodexThread reuses a known config when the loaded thread is systemError", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const config = { mcp_servers: { browser: { enabled: true } } };
  recordAppliedCodexThreadConfig(client, "codex-thread-system-error", config);

  const diagnostics: CodexResumeDiagnostic[] = [];
  const resume = resumeCodexThread(client, {
    threadId: "codex-thread-system-error",
    cwd: "/repo",
    config,
    configAlreadyApplied: true,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    result: {
      thread: { id: "codex-thread-system-error", status: { type: "systemError" } },
    },
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: {
      thread: { id: "codex-thread-system-error", status: { type: "systemError" } },
    },
  });

  await expect(resume).resolves.toEqual({
    thread: { id: "codex-thread-system-error", status: { type: "systemError" } },
  });
  const lines = parseJsonLines(drainPassThroughText(stdin));
  expect(lines).toEqual([
    {
      id: 1,
      method: CODEX_THREAD_READ_METHOD,
      params: {
        threadId: "codex-thread-system-error",
        includeTurns: false,
      },
    },
    {
      id: 2,
      method: CODEX_RESUME_METHOD,
      params: {
        threadId: "codex-thread-system-error",
        cwd: "/repo",
      },
    },
  ]);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    status: "systemError",
    configAlreadyApplied: true,
    decision: "omit_known_config",
  });
  expect(diagnostics[0]?.previousConfigFingerprint).toBe(diagnostics[0]?.nextConfigFingerprint);
});

test("transferAppliedCodexThreadConfig lets forked idle threads omit known config on resume", async () => {
  const { transferAppliedCodexThreadConfig } = await import("../src/codex-thread-config-fingerprint");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);
  const config = { mcp_servers: { browser: { enabled: false } } };
  recordAppliedCodexThreadConfig(client, "codex-source-idle", config);
  expect(transferAppliedCodexThreadConfig(client, "codex-source-idle", "codex-forked-idle")).toBe(true);

  const diagnostics: CodexResumeDiagnostic[] = [];
  const resume = resumeCodexThread(client, {
    threadId: "codex-forked-idle",
    config,
    configAlreadyApplied: true,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    result: { thread: { id: "codex-forked-idle", status: { type: "idle" } } },
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 2,
    result: { thread: { id: "codex-forked-idle", status: { type: "idle" } } },
  });

  await expect(resume).resolves.toEqual({
    thread: { id: "codex-forked-idle", status: { type: "idle" } },
  });
  const lines = parseJsonLines(drainPassThroughText(stdin));
  expect(lines[1]).toEqual({
    id: 2,
    method: CODEX_RESUME_METHOD,
    params: { threadId: "codex-forked-idle" },
  });
  expect(diagnostics[0]).toMatchObject({
    status: "idle",
    configAlreadyApplied: true,
    decision: "omit_known_config",
  });
});

test("resumeCodexThread rejects a claimed config proof when its fingerprint was not recorded", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);

  const diagnostics: CodexResumeDiagnostic[] = [];
  const resume = resumeCodexThread(client, {
    threadId: "codex-thread-unproved",
    config: { mcp_servers: {} },
    configAlreadyApplied: true,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    result: { thread: { id: "codex-thread-unproved", status: { type: "systemError" } } },
  });

  await expect(resume).rejects.toThrow(/new thread/);
  expect(drainPassThroughText(stdin)).not.toContain(CODEX_RESUME_METHOD);
  expect(diagnostics[0]).toMatchObject({
    status: "systemError",
    configAlreadyApplied: false,
    decision: "reject_loaded_config",
  });
});

test("resumeCodexThread refuses configured resume while the loaded thread is active", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);

  const diagnostics: CodexResumeDiagnostic[] = [];
  const resume = resumeCodexThread(client, {
    threadId: "codex-thread-active",
    config: { mcp_servers: {} },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    result: { thread: { id: "codex-thread-active", status: { type: "active", activeFlags: [] } } },
  });

  await expect(resume).rejects.toThrow(CodexResumeNotAvailable);
  expect(drainPassThroughText(stdin)).not.toContain(CODEX_RESUME_METHOD);
  expect(diagnostics[0]).toMatchObject({
    status: "active",
    activeFlags: [],
    decision: "reject_loaded_config",
  });
});

test("requireCodexSubagentThreadId returns agent id when attribution exists", () => {
  const attributions = new Map([
    ["thr_codex_child", { parentThreadId: "thr_codex_parent", agentRole: "explore" }],
  ]);
  expect(requireCodexSubagentThreadId((id) => attributions.get(id), " thr_codex_child ")).toBe(
    "thr_codex_child",
  );
});

test("resumeCodexThread maps zero-turn missing rollout to CodexResumeNotAvailable", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);

  const resume = resumeCodexThread(client, {
    threadId: "codex-thread-zero-turn",
  });
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    error: {
      code: -32600,
      message: "no rollout found for thread id codex-thread-zero-turn",
    },
  });

  const error = await resume.catch((value) => value);
  expect(error).toBeInstanceOf(CodexResumeNotAvailable);
  expect(String(error)).toMatch(/no durable rollout/i);
});

test("isCodexZeroTurnRolloutMissingError detects Codex #42099 message", () => {
  expect(
    isCodexZeroTurnRolloutMissingError(new Error("thread/resume failed: no rollout found for thread id abc")),
  ).toBe(true);
  expect(isCodexZeroTurnRolloutMissingError(new Error("other failure"))).toBe(false);
});

test("requireCodexSubagentThreadId rejects missing attribution without inventing a thread", () => {
  expect(() => requireCodexSubagentThreadId(() => undefined, "thr_missing")).toThrow(CodexResumeNotAvailable);
  expect(() => requireCodexSubagentThreadId(() => undefined, "thr_missing")).toThrow(
    /no Codex thread attribution mapping/,
  );
});

test("requireCodexSubagentThreadId rejects empty agent id", () => {
  expect(() => requireCodexSubagentThreadId(() => undefined, "  ")).toThrow(CodexResumeNotAvailable);
});

test("buildCodexSubagentFollowupPrompt forwards only the user task", () => {
  expect(buildCodexSubagentFollowupPrompt("thr_child", "finish the auth audit")).toBe(
    "finish the auth audit",
  );
});

test("parseCodexThreadStatus and terminal classification", () => {
  expect(parseCodexThreadStatus({ type: "idle" })).toBe("idle");
  expect(parseCodexThreadStatus({ type: "active", activeFlags: [] })).toBe("active");
  expect(parseCodexThreadStatus({ type: "systemError" })).toBe("systemError");
  expect(parseCodexThreadStatus(null)).toBe("unknown");
  expect(isCodexThreadStatusTerminal("idle")).toBe(true);
  expect(isCodexThreadStatusTerminal("active")).toBe(false);
});

test("readCodexThreadStatus sends thread/read without turns", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new CodexAppServerClient(stdin, stdout);

  const status = readCodexThreadStatus(client, "codex-thread-1");
  await Bun.sleep(0);
  writeResponse(stdout, {
    id: 1,
    result: { thread: { id: "codex-thread-1", status: { type: "active", activeFlags: [] } } },
  });

  await expect(status).resolves.toBe("active");
  const lines = parseJsonLines(drainPassThroughText(stdin));
  expect(lines).toEqual([
    {
      id: 1,
      method: CODEX_THREAD_READ_METHOD,
      params: {
        threadId: "codex-thread-1",
        includeTurns: false,
      },
    },
  ]);
});
