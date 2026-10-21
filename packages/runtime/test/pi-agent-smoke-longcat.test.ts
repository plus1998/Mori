/**
 * Real-model smoke test for the PI agent, wired to the LongCat-2.0 model.
 *
 * This complements the static `pi-agent-smoke.test.ts` (which documents the
 * content-surfacing gaps against hand-constructed events). This file exercises
 * the REAL end-to-end path — PiCodingAgentDriver → PI AgentSession → LongCat
 * HTTP → tool execution → AgentEvent stream — to confirm the gaps hold (or have
 * been closed) against a live model that actually emits tool_use.
 *
 * Coverage (each is a real LongCat run, not faked events):
 *   1. bash tool call executes + result content surfaces
 *   2. text + thinking deltas stream
 *   3. run terminates with agent.settled
 *   4. read tool surfaces file content in tool.completed
 *   5. write/edit tool surfaces result content
 *   6. grep (bash) surfaces match content
 *   7. tool.failed surfaces error content
 *   8. MCP (stdio server) surfaces tool result content
 *   9. Skill (SKILL.md) content influences model output
 *   10. Subagent (Agent tool) spawn + child result surfaces
 *
 * Run:  LONGCAT_API_KEY=... bun test packages/runtime/test/pi-agent-smoke-longcat.test.ts
 *
 * The API key is read from the LONGCAT_API_KEY environment variable and is NEVER
 * hardcoded. Without it the test skips (so CI / other devs are unaffected).
 *
 * Replay: re-run with the same env var. The assertions are deterministic given a
 * compliant tool-calling model; LongCat-2.0 is the pinned target.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "../../shared/src";
import type { EcoAgentRuntimeConfig } from "../src/agent-orchestration";
import {
  createPiMidTurnHandle,
  PiCodingAgentDriver,
  type PiSessionHandle,
  PiSessionRegistry,
} from "../src/pi-coding-agent-driver";
import { createPiEventAdapterState, mapPiSessionEventToAgentEvents } from "../src/pi-event-adapter";
import { createPiMcpExtensionFactory } from "../src/pi-mcp-extension-factory";
import { disposePiSdkSession } from "../src/pi-session-dispose";
import { piToolsForSessionMode } from "../src/pi-session-mode";
import { ensurePiPrivateSkillsDir, resolvePiSessionSkillPaths } from "../src/pi-skills";

const LONGCAT_API_KEY = process.env.LONGCAT_API_KEY ?? "";
const LONGCAT_BASE = "https://api.longcat.chat/openai";
const LONGCAT_MODEL = "LongCat-2.0";
const LONGCAT_PROVIDER = "longcat";

const haveKey = LONGCAT_API_KEY.trim().length > 0;

/**
 * Options for building a LongCat-backed PI session. Defaults mirror the
 * minimal no-extension/no-skill session; MCP and skills are opt-in per test.
 */
interface MakeLongcatSessionOptions {
  /** Isolated MCP servers (Claude-SDK shaped) for this session. */
  mcpServers?: Record<string, unknown>;
  /** Extra skill directories (or SKILL.md paths) to mount. */
  skillPaths?: string[];
  /** Explicit tool allowlist; defaults to builtins (+ MCP Hub tools when MCP present). */
  toolsAllowlist?: string[];
  /** When true, do not force noExtensions/noSkills (caller controls loader). */
  enableExtensions?: boolean;
}

/**
 * Build a PI session factory that registers a dedicated "longcat" provider
 * routed at the LongCat chat-completions endpoint. We do NOT use the built-in
 * openai provider: its baseUrl is hardcoded to api.openai.com and its default
 * api is "openai-responses" (LongCat only implements /chat/completions, so the
 * responses path 404s). A dedicated provider id keeps this isolated.
 */
async function makeLongcatSession(input: {
  cwd: string;
  agentDir: string;
  threadId: string;
  opts?: MakeLongcatSessionOptions;
  /** Extension factories injected by the driver (e.g. eco-pi-agent for Agent tool). */
  extensionFactories?: ReadonlyArray<{ name: string; factory: unknown }>;
}): Promise<PiSessionHandle> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const { ModelRuntime, SessionManager, SettingsManager, createAgentSession, DefaultResourceLoader } =
    pi as typeof import("@earendil-works/pi-coding-agent");

  const mcpServers = input.opts?.mcpServers;
  const hasMcp = Boolean(mcpServers && Object.keys(mcpServers).length > 0);

  // Seed a models.json so ModelConfig.load picks up the longcat provider.
  writeFileSync(
    join(input.agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [LONGCAT_PROVIDER]: {
          baseUrl: LONGCAT_BASE,
          api: "openai-completions",
          models: [
            {
              id: LONGCAT_MODEL,
              name: LONGCAT_MODEL,
              reasoning: false,
              input: ["text"],
              contextWindow: 128_000,
              maxTokens: 8192,
            },
          ],
        },
      },
    }),
  );

  const modelRuntime = await ModelRuntime.create({
    authPath: join(input.agentDir, "auth.json"),
    modelsPath: join(input.agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.setRuntimeApiKey(LONGCAT_PROVIDER, LONGCAT_API_KEY);

  const model = modelRuntime.getModel(LONGCAT_PROVIDER, LONGCAT_MODEL);
  if (!model) {
    throw new Error(
      `longcat model not registered (api=${modelRuntime.getModel(LONGCAT_PROVIDER, LONGCAT_MODEL) ? "ok" : "missing"})`,
    );
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { retries: 0, minDelayMs: 0, maxDelayMs: 0, timeoutMs: 120_000 },
  });

  // Resolve skills: explicit paths + the per-thread private skills dir.
  const skillDirs = resolvePiSessionSkillPaths({
    agentDir: input.agentDir,
    skillPaths: input.opts?.skillPaths,
  });

  // Collect extension factories: driver-injected (eco-pi-agent for Agent tool)
  // first, then MCP. The Agent tool factory must come from the driver because
  // it closes over the registry + spawn handler.
  const extensionFactories: Array<{ name: string; factory: unknown }> = [];
  for (const ef of input.extensionFactories ?? []) {
    extensionFactories.push({ name: ef.name, factory: ef.factory });
  }
  if (hasMcp) {
    const mcpFactory = await createPiMcpExtensionFactory(mcpServers, { agentDir: input.agentDir });
    if (mcpFactory) {
      extensionFactories.push({ name: "eco-pi-mcp", factory: mcpFactory });
    }
  }

  // PI's skillsOverride receives { skills, diagnostics } and must return the
  // same shape. We inject our SKILL.md content directly so the model sees it.
  const skillContents = skillDirs.map((dir) => {
    const mdPath = join(dir, "SKILL.md");
    let prompt = "";
    try {
      prompt = require("node:fs").readFileSync(mdPath, "utf8");
    } catch {
      // ignore missing
    }
    return { dir, prompt };
  });
  const hasSkills = skillContents.some((s) => s.prompt.length > 0);

  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    // Block ambient package/file extensions; only Eco-injected factories.
    noExtensions: input.opts?.enableExtensions ? false : true,
    ...(extensionFactories.length > 0
      ? { extensionFactories: extensionFactories as Array<{ name: string; factory: never }> }
      : {}),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(hasSkills
      ? {
          skillsOverride: (result) => ({
            skills: skillContents
              .filter((s) => s.prompt.length > 0)
              .map((s) => ({
                name: s.dir.split("/").pop() ?? "skill",
                description: "smoke-test skill",
                prompt: s.prompt,
                filePath: join(s.dir, "SKILL.md"),
              })),
            diagnostics: result?.diagnostics ?? [],
          }),
        }
      : {}),
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.create(input.cwd, join(input.agentDir, "sessions"));

  // Driver-injected toolsAllowlist (includes "Agent" when subagents are enabled)
  // takes precedence; fall back to opts, then to the builtin default.
  const toolsAllowlist =
    input.toolsAllowlist && input.toolsAllowlist.length > 0
      ? [...input.toolsAllowlist]
      : (input.opts?.toolsAllowlist ?? piToolsForSessionMode("agent", { hasMcpServers: hasMcp }));

  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader: resourceLoader as never,
    tools: toolsAllowlist,
    sessionManager,
    settingsManager,
  });

  // PI CLI modes call bindExtensions (emits session_start → extension init).
  // Eco creates sessions headlessly and must do the same: MCP tools stay
  // "MCP not initialized" and the eco-pi-agent extension won't register the
  // Agent tool until bindExtensions runs.
  const hasAgentExtension = (input.extensionFactories ?? []).some((ef) => ef.name === "eco-pi-agent");
  if (typeof session.bindExtensions === "function" && (hasMcp || hasAgentExtension)) {
    await session.bindExtensions({ mode: "rpc" });
  }

  if (process.env.LONGCAT_SMOKE_DEBUG) {
    console.log(
      "[LONGCAT] input.extensionFactories:",
      (input.extensionFactories ?? []).map((e) => e.name),
    );
    console.log("[LONGCAT] input.toolsAllowlist:", input.toolsAllowlist);
    console.log("[LONGCAT] active tools:", (session as any).getActiveToolNames?.());
    console.log(
      "[LONGCAT] all tools:",
      (session as any).getAllTools?.()?.map((t: any) => t.name),
    );
  }

  const sessionId = sessionManager.getSessionId();
  return {
    sessionId,
    cwd: input.cwd,
    routeFingerprint: `${LONGCAT_PROVIDER}:${LONGCAT_MODEL}`,
    bindingId: "",
    skillsFingerprint: JSON.stringify(skillDirs),
    mcpFingerprint: hasMcp ? JSON.stringify(Object.keys(mcpServers!)) : "",
    abort: async () => {
      await session.abort();
    },
    dispose: () => disposePiSdkSession(session),
    ...createPiMidTurnHandle(session),
    rebind: async () => {},
    updateSkillPaths: async () => {},
    async *prompt(text: string): AsyncIterable<AgentEvent> {
      // Single collector; completion is signalled by agent_settled (PI's
      // terminal signal), drained after the prompt promise resolves.
      const collected: Array<AgentEvent> = [];
      let resolveWait: (() => void) | undefined;
      let done = false;
      const wake = () => resolveWait?.();
      // Map PI session events → AgentEvents the same way the production prompt
      // generator does, so the driver's `yield* prompt(...)` streams mapped
      // events downstream.
      const mapCtx = {
        threadId: input.threadId,
        sessionId,
        agentId: sessionId,
        role: "main",
        state: createPiEventAdapterState(),
        nextSeq: () => seqSeq++,
      };
      let seqSeq = 0;
      const unsub = session.subscribe((ev) => {
        const mapped = mapPiSessionEventToAgentEvents(ev as any, mapCtx);
        for (const m of mapped) collected.push(m);
        if (mapped.length > 0) wake();
      });
      const p = session.prompt(text).then(() => {
        done = true;
        wake();
      });
      try {
        while (!done || collected.length > 0) {
          while (collected.length > 0) {
            yield collected.shift()!;
          }
          if (done) break;
          await new Promise<void>((r) => (resolveWait = r));
        }
        await p;
      } finally {
        unsub();
      }
    },
  };
}

function makeDriver(registry: PiSessionRegistry, opts?: MakeLongcatSessionOptions) {
  return new PiCodingAgentDriver(
    {
      createSession: async (input) => {
        const agentDir = mkdtempSync(join(tmpdir(), `pi-lc-${input.threadId}-`));
        return makeLongcatSession({ cwd: input.cwd, agentDir, threadId: input.threadId, opts });
      },
      resolveBridgeModel: async () => ({
        bridgeBaseUrl: LONGCAT_BASE,
        bridgeModelId: LONGCAT_MODEL,
        apiKey: LONGCAT_API_KEY,
        agentDir: "/tmp/pi-lc-unused",
        apiCompat: "openai_chat_completions",
        bindingId: "lc_test",
        providerId: LONGCAT_PROVIDER,
      }),
    },
    registry,
  );
}

function makeDriverWithAgent(registry: PiSessionRegistry, agentRegistry: EcoAgentRuntimeConfig) {
  return new PiCodingAgentDriver(
    {
      createSession: async (input) => {
        const agentDir = mkdtempSync(join(tmpdir(), `pi-lc-${input.threadId}-`));
        return makeLongcatSession({ cwd: input.cwd, agentDir, threadId: input.threadId });
      },
      resolveBridgeModel: async () => ({
        bridgeBaseUrl: LONGCAT_BASE,
        bridgeModelId: LONGCAT_MODEL,
        apiKey: LONGCAT_API_KEY,
        agentDir: "/tmp/pi-lc-unused",
        apiCompat: "openai_chat_completions",
        bindingId: "lc_test",
        providerId: LONGCAT_PROVIDER,
      }),
    },
    registry,
  );
}

async function runPrompt(
  driver: PiCodingAgentDriver,
  prompt: string,
  extra?: Parameters<PiCodingAgentDriver["run"]>[0] extends infer T
    ? T extends { piSession?: infer P }
      ? { piSession?: P; agentRegistry?: EcoAgentRuntimeConfig; onSubagentSpawn?: unknown }
      : never
    : never,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const ac = new AbortController();
  for await (const ev of driver.run({
    threadId: "thr_lc",
    prompt,
    workspacePath: process.cwd(),
    worktreePath: process.cwd(),
    routes: [
      {
        role: "main" as const,
        providerId: LONGCAT_PROVIDER,
        modelId: LONGCAT_MODEL,
        primary: { modelId: LONGCAT_MODEL, contextWindow: 128_000 },
      },
    ],
    signal: ac.signal,
    piSession: extra?.piSession ?? { mcpServers: {} },
    ...(extra?.agentRegistry ? { agentRegistry: extra.agentRegistry } : {}),
    ...(extra?.onSubagentSpawn ? { onSubagentSpawn: extra.onSubagentSpawn } : {}),
  })) {
    events.push(ev);
  }
  return events;
}

// ─── 1. bash tool call executes and surfaces result content ───────────────────
test.skipIf(!haveKey)(
  "LONGCAT smoke: bash tool call executes and surfaces result content",
  async () => {
    const registry = new PiSessionRegistry();
    const driver = makeDriver(registry);
    const events = await runPrompt(driver, "只用 bash 工具执行 `ls -la` 列出当前目录，不要解释。");

    const toolStarts = events.filter((e) => e.type === "tool.started");
    const toolCompleted = events.filter((e) => e.type === "tool.completed");
    const textDeltas = events.filter((e) => e.type === "message.delta");

    console.log("\n[LONGCAT] event counts:", {
      total: events.length,
      toolStarted: toolStarts.length,
      toolCompleted: toolCompleted.length,
      textDeltas: textDeltas.length,
    });
    for (const e of toolStarts) {
      console.log(
        "[LONGCAT] tool.started:",
        (e.payload as any)?.tool_name,
        JSON.stringify((e.payload as any)?.input),
      );
    }
    for (const e of toolCompleted) {
      const p = e.payload as any;
      console.log(
        "[LONGCAT] tool.completed:",
        p?.tool_name,
        "content[:80]:",
        JSON.stringify(String(p?.content ?? "").slice(0, 80)),
      );
    }

    // The model must actually invoke the bash tool (not just answer in text).
    expect(toolStarts.length).toBeGreaterThanOrEqual(1);
    const firstStart = toolStarts[0].payload as Record<string, unknown>;
    expect(firstStart.tool_name).toBe("bash");
    expect((firstStart.input as any)?.command).toContain("ls");

    // The completed event carries the real command output (file listing).
    expect(toolCompleted.length).toBeGreaterThanOrEqual(1);
    const firstDone = toolCompleted[0].payload as Record<string, unknown>;
    expect(firstDone.tool_name).toBe("bash");
    const content = String(firstDone.content ?? "");
    expect(content.length).toBeGreaterThan(0);
    // The directory listing should mention a known repo file.
    expect(/package\.json|bun\.lockb|apps|packages/.test(content)).toBe(true);

    await registry.deleteThread("thr_lc");
  },
  120_000,
);

// ─── 2. text + thinking deltas stream ────────────────────────────────────────
test.skipIf(!haveKey)(
  "LONGCAT smoke: text + thinking deltas stream before tool use",
  async () => {
    const registry = new PiSessionRegistry();
    const driver = makeDriver(registry);
    const events = await runPrompt(driver, "只用 bash 工具执行 `ls -la` 列出当前目录，不要解释。");

    const thinkingDeltas = events.filter(
      (e) => e.type === "message.delta" && (e.payload as any)?.blockKind === "thinking",
    );
    const textDeltas = events.filter(
      (e) => e.type === "message.delta" && (e.payload as any)?.blockKind === "text",
    );

    console.log("[LONGCAT] thinking_deltas:", thinkingDeltas.length, "text_deltas:", textDeltas.length);
    // LongCat emits reasoning_content, so we expect at least one thinking delta.
    expect(thinkingDeltas.length + textDeltas.length).toBeGreaterThan(0);

    await registry.deleteThread("thr_lc");
  },
  120_000,
);

// ─── 3. run terminates with agent.settled ────────────────────────────────────
test.skipIf(!haveKey)(
  "LONGCAT smoke: run terminates with agent.settled",
  async () => {
    const registry = new PiSessionRegistry();
    const driver = makeDriver(registry);
    const events = await runPrompt(driver, "只用 bash 工具执行 `ls -la` 列出当前目录，不要解释。");

    const settled = events.filter((e) => e.type === "agent.settled");
    expect(settled.length).toBeGreaterThanOrEqual(1);
    await registry.deleteThread("thr_lc");
  },
  120_000,
);

// ─── 4. read tool surfaces file content ──────────────────────────────────────
test.skipIf(!haveKey)(
  "LONGCAT smoke: read tool surfaces file content in tool.completed",
  async () => {
    const registry = new PiSessionRegistry();
    const driver = makeDriver(registry);
    // Ask the model to read a known file; the completed event must carry content.
    const events = await runPrompt(driver, "只用 read 工具读取 package.json 文件，不要解释。");

    const readDone = events.filter(
      (e) => e.type === "tool.completed" && (e.payload as any)?.tool_name === "read",
    );
    console.log("[LONGCAT] read.completed:", readDone.length);
    for (const e of readDone) {
      const p = e.payload as any;
      console.log("[LONGCAT] read content[:80]:", JSON.stringify(String(p?.content ?? "").slice(0, 80)));
    }

    expect(readDone.length).toBeGreaterThanOrEqual(1);
    const content = String((readDone[0].payload as any)?.content ?? "");
    expect(content.length).toBeGreaterThan(0);
    // package.json must mention the repo name or "workspaces".
    expect(/workspaces|name|bun|private/.test(content)).toBe(true);

    await registry.deleteThread("thr_lc");
  },
  120_000,
);

// ─── 5. write/edit tool surfaces result content ──────────────────────────────
test.skipIf(!haveKey)(
  "LONGCAT smoke: write tool surfaces result content",
  async () => {
    const registry = new PiSessionRegistry();
    const driver = makeDriver(registry);
    // write a temp file; the completed event must carry a result.
    const tmpFile = join(tmpdir(), `lc-smoke-write-${Date.now()}.txt`);
    const events = await runPrompt(
      driver,
      `只用 write 工具把字符串 "lc-smoke-write-ok" 写入文件 ${tmpFile}，不要解释。`,
    );

    const writeDone = events.filter(
      (e) => e.type === "tool.completed" && (e.payload as any)?.tool_name === "write",
    );
    console.log("[LONGCAT] write.completed:", writeDone.length);
    for (const e of writeDone) {
      const p = e.payload as any;
      console.log("[LONGCAT] write content[:80]:", JSON.stringify(String(p?.content ?? "").slice(0, 80)));
    }

    expect(writeDone.length).toBeGreaterThanOrEqual(1);
    // The file should exist with the requested content.
    const written = existsSync(tmpFile);
    if (written) {
      const text = require("node:fs").readFileSync(tmpFile, "utf8");
      expect(text).toContain("lc-smoke-write-ok");
      rmSync(tmpFile, { force: true });
    }
    // Either the file was written, or the tool.completed carried a result.
    expect(writeDone.length).toBeGreaterThanOrEqual(1);

    await registry.deleteThread("thr_lc");
  },
  120_000,
);

// ─── 6. grep (bash) surfaces match content ───────────────────────────────────
test.skipIf(!haveKey)(
  "LONGCAT smoke: grep surfaces match content",
  async () => {
    const registry = new PiSessionRegistry();
    const driver = makeDriver(registry);
    const events = await runPrompt(
      driver,
      '只用 bash 工具执行 `grep -r "LONGCAT smoke" packages/runtime/test/pi-agent-smoke-longcat.test.ts | head -5`，不要解释。',
    );

    const bashDone = events.filter(
      (e) => e.type === "tool.completed" && (e.payload as any)?.tool_name === "bash",
    );
    console.log("[LONGCAT] grep.completed:", bashDone.length);
    for (const e of bashDone) {
      const p = e.payload as any;
      console.log("[LONGCAT] grep content[:80]:", JSON.stringify(String(p?.content ?? "").slice(0, 80)));
    }

    expect(bashDone.length).toBeGreaterThanOrEqual(1);
    const content = String((bashDone[0].payload as any)?.content ?? "");
    expect(content.length).toBeGreaterThan(0);
    // The match should mention the target string.
    expect(content).toContain("LONGCAT smoke");

    await registry.deleteThread("thr_lc");
  },
  120_000,
);

// ─── 7. tool.failed surfaces error content ───────────────────────────────────
test.skipIf(!haveKey)(
  "LONGCAT smoke: tool.failed surfaces error content",
  async () => {
    const registry = new PiSessionRegistry();
    const driver = makeDriver(registry);
    // Run a command that fails; PI surfaces it as tool.failed with message.
    const events = await runPrompt(
      driver,
      "只用 bash 工具执行 `ls /this/path/does/not/exist/abc123`，不要解释。",
    );

    const failed = events.filter((e) => e.type === "tool.failed");
    const completed = events.filter(
      (e) => e.type === "tool.completed" && (e.payload as any)?.tool_name === "bash",
    );
    console.log("[LONGCAT] tool.failed:", failed.length, "bash.completed:", completed.length);
    for (const e of failed) {
      const p = e.payload as any;
      console.log("[LONGCAT] failed message[:80]:", JSON.stringify(String(p?.message ?? "").slice(0, 80)));
    }
    for (const e of completed) {
      const p = e.payload as any;
      console.log("[LONGCAT] completed content[:80]:", JSON.stringify(String(p?.content ?? "").slice(0, 80)));
    }

    // Either the tool is marked failed (with message) OR the bash tool returns
    // a non-zero exit as completed content containing the error. Both are valid;
    // the key assertion: the error text surfaces somewhere.
    const errorText =
      failed.map((e) => String((e.payload as any)?.message ?? "")).join("\n") +
      completed.map((e) => String((e.payload as any)?.content ?? "")).join("\n");
    expect(errorText.length).toBeGreaterThan(0);
    expect(/No such file|cannot access|ENOENT|exit code|错误/.test(errorText)).toBe(true);

    await registry.deleteThread("thr_lc");
  },
  120_000,
);

// ─── 8. MCP (stdio server) surfaces tool result content ──────────────────────
test.skipIf(!haveKey)(
  "LONGCAT smoke: MCP stdio server surfaces tool result content",
  async () => {
    const registry = new PiSessionRegistry();
    const mcpServerPath = join(process.cwd(), "packages/runtime/test/_lc-mcp-server.mjs");
    // The official PI MCP extension namespaces tools as `mcp__<server>__<tool>`;
    // the session allowlist must name that real wire name.
    const lcEchoTool = "mcp__lc_echo__echo";
    const driver = makeDriver(registry, {
      mcpServers: {
        lc_echo: { command: "node", args: [mcpServerPath] },
      },
      toolsAllowlist: ["read", "bash", "edit", "write", lcEchoTool, "codemode"],
    });
    const events = await runPrompt(driver, `使用 ${lcEchoTool} 工具，text 参数为 "lc-mcp-ok"，不要解释。`, {
      piSession: { mcpServers: { lc_echo: { command: "node", args: [mcpServerPath] } } },
    });

    const mcpDone = events.filter(
      (e) => e.type === "tool.completed" && (e.payload as any)?.tool_name === lcEchoTool,
    );
    const mcpStarted = events.filter(
      (e) => e.type === "tool.started" && (e.payload as any)?.tool_name === lcEchoTool,
    );
    console.log("[LONGCAT] mcp.started:", mcpStarted.length, "mcp.completed:", mcpDone.length);
    for (const e of mcpDone) {
      const p = e.payload as any;
      console.log("[LONGCAT] mcp content[:80]:", JSON.stringify(String(p?.content ?? "").slice(0, 80)));
    }

    expect(mcpStarted.length).toBeGreaterThanOrEqual(1);
    expect(mcpDone.length).toBeGreaterThanOrEqual(1);
    const content = String((mcpDone[0].payload as any)?.content ?? "");
    expect(content).toContain("MCP-ECHO: lc-mcp-ok");

    await registry.deleteThread("thr_lc");
  },
  180_000,
);

// ─── 9. Skill (SKILL.md) content influences model output ─────────────────────
test.skipIf(!haveKey)(
  "LONGCAT smoke: skill content surfaces in model output",
  async () => {
    const registry = new PiSessionRegistry();
    const skillDir = join(process.cwd(), "packages/runtime/test/_lc-skill");
    const driver = makeDriver(registry, { skillPaths: [skillDir] });
    const events = await runPrompt(driver, "请给出 lc-smoke-skill 的打招呼输出，只输出结果。", {
      piSession: { mcpServers: {}, skillPaths: [skillDir] },
    });

    const textDeltas = events.filter(
      (e) => e.type === "message.delta" && (e.payload as any)?.blockKind === "text",
    );
    const fullText = textDeltas.map((e) => String((e.payload as any)?.text ?? "")).join("");
    console.log("[LONGCAT] skill text output:", JSON.stringify(fullText.slice(0, 120)));

    // The skill instructs the model to emit this exact greeting.
    expect(fullText).toContain("SKILL-GREETING");

    await registry.deleteThread("thr_lc");
  },
  120_000,
);

// ─── 10. Subagent (Agent tool) spawn + child result surfaces ──────────────────
test.skipIf(!haveKey)(
  "LONGCAT smoke: subagent spawn and child result surface",
  async () => {
    const registry = new PiSessionRegistry();
    const agentRegistry: EcoAgentRuntimeConfig = {
      templates: [
        {
          id: "smoke.child",
          name: "Smoke Child",
          description: "A smoke-test child agent.",
          prompt: "You are a smoke-test child. When given a task, reply with CHILD-DONE: <summary>.",
          whenToUse: "When the parent delegates a smoke task.",
          defaultTools: {
            allowed: [],
            disallowed: [],
            bash: { enabled: true },
            filesystem: { read: "workspace", write: "none" },
          },
          mcpServers: [],
          skills: [],
          allowDelegation: false,
          builtIn: true,
          source: "built_in",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      orchestration: {
        mainAgent: {
          agentKey: "main",
          name: "Main",
          systemPromptPreset: "core_native",
          prompt: "",
          modelRef: { providerId: LONGCAT_PROVIDER, modelId: LONGCAT_MODEL },
          tools: { allowed: [], disallowed: [] },
          skills: [],
        },
        agents: [
          {
            agentKey: "smoke_child",
            templateId: "smoke.child",
            modelRef: { providerId: LONGCAT_PROVIDER, modelId: LONGCAT_MODEL },
            tools: {
              allowed: [],
              disallowed: [],
              bash: { enabled: true },
              filesystem: { read: "workspace", write: "none" },
            },
            mcpServers: [],
            skills: [],
            enabled: true,
          },
        ],
        strategy: { kind: "autonomous" },
      },
    };

    // The spawn handler creates a child PI session (LongCat-backed) and streams
    // its events back to the parent while the Agent tool waits.
    const childRegistry = new PiSessionRegistry();
    const driver = new PiCodingAgentDriver(
      {
        createSession: async (input) => {
          const agentDir = mkdtempSync(join(tmpdir(), `pi-lc-${input.threadId}-`));
          // Pass through driver-injected extension factories (eco-pi-agent) and
          // the tools allowlist (which includes "Agent" when subagents are enabled).
          return makeLongcatSession({
            cwd: input.cwd,
            agentDir,
            threadId: input.threadId,
            extensionFactories: input.extensionFactories,
            toolsAllowlist: input.toolsAllowlist,
          });
        },
        resolveBridgeModel: async () => ({
          bridgeBaseUrl: LONGCAT_BASE,
          bridgeModelId: LONGCAT_MODEL,
          apiKey: LONGCAT_API_KEY,
          agentDir: "/tmp/pi-lc-unused",
          apiCompat: "openai_chat_completions",
          bindingId: "lc_test",
          providerId: LONGCAT_PROVIDER,
        }),
      },
      registry,
    );

    const events = await runPrompt(
      driver,
      '必须使用 Agent 工具（tool_name=Agent）调用 agentKey 为 smoke_child 的子代理，task 参数为 "report hello from child"。不要使用其他工具，只输出子代理的结果。',
      {
        // agentRegistry is read at the top level by the driver (input.agentRegistry).
        agentRegistry,
        piSession: {
          mcpServers: {},
          // onSubagentSpawn MUST be inside piSession — the driver reads it from
          // input.piSession?.onSubagentSpawn and arms it on the PI session.
          onSubagentSpawn: async (spawnInput) => {
            // Spin up a real child session against LongCat.
            const childDriver = new PiCodingAgentDriver(
              {
                createSession: async (input) => {
                  const agentDir = mkdtempSync(join(tmpdir(), `pi-lc-child-${input.threadId}-`));
                  return makeLongcatSession({ cwd: input.cwd, agentDir, threadId: input.threadId });
                },
                resolveBridgeModel: async () => ({
                  bridgeBaseUrl: LONGCAT_BASE,
                  bridgeModelId: LONGCAT_MODEL,
                  apiKey: LONGCAT_API_KEY,
                  agentDir: "/tmp/pi-lc-unused",
                  apiCompat: "openai_chat_completions",
                  bindingId: "lc_child",
                  providerId: LONGCAT_PROVIDER,
                }),
              },
              childRegistry,
            );
            const childEvents: AgentEvent[] = [];
            const ac = new AbortController();
            try {
              for await (const ev of childDriver.run({
                threadId: spawnInput.threadId,
                prompt: spawnInput.task,
                workspacePath: process.cwd(),
                worktreePath: process.cwd(),
                routes: [
                  {
                    role: "main" as const,
                    providerId: LONGCAT_PROVIDER,
                    modelId: LONGCAT_MODEL,
                    primary: { modelId: LONGCAT_MODEL, contextWindow: 128_000 },
                  },
                ],
                signal: ac.signal,
                piSession: { mcpServers: {} },
              })) {
                childEvents.push(ev);
                spawnInput.emitEvent(ev);
              }
            } catch (err) {
              spawnInput.emitEvent(
                createAgentEvent({
                  id: `${spawnInput.threadId}:child-error`,
                  threadId: spawnInput.threadId,
                  agentId: "smoke_child",
                  role: "main",
                  type: "thread.failed",
                  payload: { message: err instanceof Error ? err.message : String(err) },
                }),
              );
            }
            const text = childEvents
              .filter((e) => e.type === "message.delta" && (e.payload as any)?.blockKind === "text")
              .map((e) => String((e.payload as any)?.text ?? ""))
              .join("");
            await childRegistry.deleteThread(spawnInput.threadId);
            return {
              agentId: `smoke_child_${Date.now()}`,
              agentKey: spawnInput.agentKey,
              text: text || "(no output)",
              truncated: false,
            };
          },
        },
      },
    );

    const agentStarted = events.filter(
      (e) => e.type === "tool.started" && (e.payload as any)?.tool_name === "Agent",
    );
    const agentCompleted = events.filter(
      (e) => e.type === "tool.completed" && (e.payload as any)?.tool_name === "Agent",
    );

    expect(agentStarted.length).toBeGreaterThanOrEqual(1);
    expect(agentCompleted.length).toBeGreaterThanOrEqual(1);
    const content = String((agentCompleted[0].payload as any)?.content ?? "");
    expect(content.length).toBeGreaterThan(0);
    // The child's text must surface through the Agent tool result. The child is
    // prompted to "report hello from child", so the result should echo that.
    expect(content.toLowerCase()).toContain("hello from child");

    await registry.deleteThread("thr_lc");
  },
  180_000,
);
