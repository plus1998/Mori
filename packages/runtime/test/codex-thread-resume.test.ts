import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CodexAppServerClient } from "../src/codex-app-server-client";
import {
  getAppliedCodexThreadConfigFingerprint,
  recordAppliedCodexThreadConfig,
} from "../src/codex-thread-config-fingerprint";
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

for (const status of ["idle", "systemError"] as const) {
  test(`resumeCodexThread unloads a ${status} thread before applying changed config`, async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let reads = 0;
    const diagnostics: CodexResumeDiagnostic[] = [];
    const client = {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params });
        if (method === "thread/read")
          return {
            thread: {
              id: "existing",
              status: { type: reads++ === 0 ? status : "notLoaded" },
              modelProvider: "openai",
            },
          } as T;
        if (method === "thread/unsubscribe") return { status: "unsubscribed" } as T;
        return {
          thread: { id: "existing", status: { type: "idle" } },
          model: "new-model",
          modelProvider: "eco_vendor",
        } as T;
      },
    };
    const original = { mcp_servers: {}, features: { view_image: true } };
    recordAppliedCodexThreadConfig(client, "existing", original);
    const changed = { mcp_servers: {}, features: { view_image: false } };
    await expect(
      resumeCodexThread(client, {
        threadId: "existing",
        model: "new-model",
        modelProvider: "eco_vendor",
        config: changed,
        configAlreadyApplied: true,
        onDiagnostic: (item) => diagnostics.push(item),
      }),
    ).resolves.toMatchObject({ thread: { id: "existing" }, modelProvider: "eco_vendor" });
    expect(calls.map((call) => call.method)).toEqual([
      "thread/read",
      "thread/unsubscribe",
      "thread/read",
      "thread/resume",
    ]);
    expect(calls.at(-1)?.params).toEqual({
      threadId: "existing",
      model: "new-model",
      modelProvider: "eco_vendor",
      config: changed,
    });
    expect(diagnostics[0]).toMatchObject({
      status,
      configAlreadyApplied: false,
      decision: "reload_loaded_config",
    });
  });
}

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

test("resumeCodexThread reloads when claimed config proof was not recorded", async () => {
  let reads = 0;
  const calls: string[] = [];
  const client = {
    async request<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "thread/read")
        return {
          thread: { id: "existing", status: { type: reads++ === 0 ? "systemError" : "notLoaded" } },
        } as T;
      if (method === "thread/unsubscribe") return { status: "unsubscribed" } as T;
      return { thread: { id: "existing" } } as T;
    },
  };
  await resumeCodexThread(client, {
    threadId: "existing",
    config: { mcp_servers: {} },
    configAlreadyApplied: true,
  });
  expect(calls).toEqual(["thread/read", "thread/unsubscribe", "thread/read", "thread/resume"]);
});

test("a provider switch reloads even when the static config fingerprint is unchanged", async () => {
  let reads = 0;
  const calls: string[] = [];
  const config = { mcp_servers: {} };
  const client = {
    async request<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "thread/read")
        return {
          thread: {
            id: "existing",
            modelProvider: "openai",
            status: { type: reads++ === 0 ? "systemError" : "notLoaded" },
          },
        } as T;
      if (method === "thread/unsubscribe") return { status: "unsubscribed" } as T;
      return { thread: { id: "existing" }, modelProvider: "eco_vendor", model: "new-model" } as T;
    },
  };
  recordAppliedCodexThreadConfig(client, "existing", config);
  await resumeCodexThread(client, {
    threadId: "existing",
    modelProvider: "eco_vendor",
    model: "new-model",
    config,
    configAlreadyApplied: true,
  });
  expect(calls).toEqual(["thread/read", "thread/unsubscribe", "thread/read", "thread/resume"]);
});

for (const failure of [
  "timeout",
  "rpc",
  "active",
  "unknown",
  "bad_ack",
  "wrong_model",
  "wrong_provider",
  "wrong_thread",
  "abort",
] as const) {
  test(`config reload stops before continuing when unload/resume fails: ${failure}`, async () => {
    let reads = 0;
    let resumes = 0;
    const controller = new AbortController();
    const diagnostics: CodexResumeDiagnostic[] = [];
    const client = {
      async request<T>(method: string): Promise<T> {
        if (method === "thread/read") {
          const type =
            reads++ === 0
              ? "systemError"
              : failure === "timeout"
                ? "idle"
                : failure === "active"
                  ? "active"
                  : failure === "unknown"
                    ? "unknown"
                    : "notLoaded";
          return { thread: { id: "existing", status: { type } } } as T;
        }
        if (method === "thread/unsubscribe") {
          if (failure === "rpc") throw new Error("shutdown rejected");
          if (failure === "abort") controller.abort(new Error("user stopped"));
          return { status: failure === "bad_ack" ? "unexpected" : "notLoaded" } as T;
        }
        resumes += 1;
        return {
          thread: { id: failure === "wrong_thread" ? "different" : "existing" },
          model: failure === "wrong_model" ? "old" : "new",
          modelProvider: failure === "wrong_provider" ? "openai" : "eco_vendor",
        } as T;
      },
    };
    recordAppliedCodexThreadConfig(client, "existing", { mcp_servers: {} });
    await expect(
      resumeCodexThread(client, {
        threadId: "existing",
        model: "new",
        modelProvider: "eco_vendor",
        config: { mcp_servers: { browser: { enabled: true } } },
        configReloadTimeoutMs: 5,
        signal: controller.signal,
        onDiagnostic: (item) => diagnostics.push(item),
      }),
    ).rejects.toThrow();
    expect(resumes).toBe(failure.startsWith("wrong_") ? 1 : 0);
    expect(getAppliedCodexThreadConfigFingerprint(client, "existing")).toBeUndefined();
    if (!failure.startsWith("wrong_")) expect(diagnostics.at(-1)?.decision).toBe("reload_failed");
  });
}

test("same-provider same-config retries keep their thread loaded", async () => {
  const calls: string[] = [];
  const config = { mcp_servers: {} };
  const client = {
    async request<T>(method: string): Promise<T> {
      calls.push(method);
      return {
        thread: { id: "existing", status: { type: "systemError" }, modelProvider: "openai" },
        modelProvider: "openai",
      } as T;
    },
  };
  recordAppliedCodexThreadConfig(client, "existing", config);
  await resumeCodexThread(client, {
    threadId: "existing",
    config,
    modelProvider: "openai",
    configAlreadyApplied: true,
  });
  expect(calls).toEqual(["thread/read", "thread/resume"]);
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
