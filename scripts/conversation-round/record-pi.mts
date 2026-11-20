/**
 * Record a live PI (π) conversation round against LongCat 2.0.
 *
 *   LONGCAT_API_KEY=... bun run round -- conversation record --core=pi
 *   (or: bun scripts/conversation-round/record-pi.mts)
 *
 * Writes:
 *   scripts/conversation-round/fixtures/<runId>-pi/
 *     pi-sdk-events.jsonl
 *     agent-events.jsonl
 *     workspace-files.json
 *     summary.json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EcoAgentRuntimeConfig } from "../../packages/runtime/src/agent-orchestration";
import {
  createPiMidTurnHandle,
  PiCodingAgentDriver,
  PiSessionRegistry,
} from "../../packages/runtime/src/pi-coding-agent-driver";
import {
  createPiEventAdapterState,
  mapPiSessionEventToAgentEvents,
} from "../../packages/runtime/src/pi-event-adapter";
import { createPiMcpExtensionFactory } from "../../packages/runtime/src/pi-mcp-extension-factory";
import { disposePiSdkSession } from "../../packages/runtime/src/pi-session-dispose";
import { piToolsForSessionMode } from "../../packages/runtime/src/pi-session-mode";
import { resolvePiSessionSkillPaths } from "../../packages/runtime/src/pi-skills";
import { collectPiSubagentFinalText } from "../../packages/runtime/src/pi-subagent";
import type { AgentEvent } from "../../packages/shared/src";
import { createAgentEvent } from "../../packages/shared/src";
import { appendJsonl, ensureDir, redactSecrets, snapshotWorkspace, writeJson } from "./lib/fixture-io.mjs";
import { resolveMcpEchoServerPath, resolveNodeExecutable } from "./lib/resolve-executables.mjs";
import { buildScenarioPrompt } from "./lib/scenario-prompt.mjs";
import { setupScenarioWorkspace } from "./lib/scenario-workspace.mjs";
import { evaluateSdkScenarioChecklist } from "./lib/sdk-checklist.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(__dirname, "fixtures");

const LONGCAT_API_KEY =
  process.env.LONGCAT_API_KEY?.trim() || process.env.ECO_CODEX_SMOKE_API_KEY?.trim() || "";
const LONGCAT_BASE = (process.env.ECO_PI_SMOKE_BASE_URL ?? "https://api.longcat.chat/openai").replace(
  /\/$/,
  "",
);
const LONGCAT_MODEL = process.env.ECO_PI_SMOKE_MODEL?.trim() || "LongCat-2.0";
const LONGCAT_PROVIDER = "longcat";
const TIMEOUT_MS = Number.parseInt(process.env.ECO_PI_SMOKE_TIMEOUT_MS ?? "600000", 10);

if (!LONGCAT_API_KEY) {
  console.error("Missing LONGCAT_API_KEY or ECO_CODEX_SMOKE_API_KEY");
  process.exit(2);
}

const marker = process.env.ECO_SMOKE_MARKER?.trim() || `LC${Date.now().toString(36).toUpperCase()}`;
const runId =
  process.env.ECO_PI_SMOKE_RUN_ID?.trim() || `${new Date().toISOString().replace(/[:.]/g, "-")}-${marker}-pi`;
const outDir = process.env.ECO_PI_SMOKE_FIXTURE_DIR?.trim()
  ? path.resolve(process.env.ECO_PI_SMOKE_FIXTURE_DIR)
  : path.join(fixturesRoot, runId);

ensureDir(outDir);
ensureDir(fixturesRoot);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eco-pi-round-ws-"));
const mcpServerPath = resolveMcpEchoServerPath();
const nodeExe = resolveNodeExecutable();
const mcpLogPath = path.join(outDir, "mcp-server.log");

const mcpServers = {
  eco_smoke: {
    command: nodeExe,
    args: [mcpServerPath],
    env: { ECO_SMOKE_MCP_LOG: mcpLogPath },
  },
};

const { skillDir } = setupScenarioWorkspace({ workspace, marker });
const prompt = buildScenarioPrompt(marker);
fs.writeFileSync(path.join(outDir, "prompt.txt"), prompt);

const piSdkEventsPath = path.join(outDir, "pi-sdk-events.jsonl");
const agentEventsPath = path.join(outDir, "agent-events.jsonl");
let piSeq = 0;
let agentSeq = 0;

function logPiEvent(event: unknown) {
  appendJsonl(piSdkEventsPath, {
    seq: ++piSeq,
    ts: new Date().toISOString(),
    event: redactSecrets(event, LONGCAT_API_KEY),
  });
}

function logAgentEvent(event: AgentEvent) {
  appendJsonl(agentEventsPath, {
    seq: ++agentSeq,
    ts: new Date().toISOString(),
    event: redactSecrets(event, LONGCAT_API_KEY),
  });
}

const agentRegistry: EcoAgentRuntimeConfig = {
  templates: [
    {
      id: "smoke.worker",
      name: "Smoke Worker",
      description: "Short-lived worker for Eco scenario smoke.",
      prompt:
        "You are smoke_worker. Reply with exactly the marker string the parent asked for. Do not call tools unless required.",
      whenToUse: "When the parent delegates a smoke task.",
      defaultTools: {
        allowed: [],
        disallowed: [],
        bash: { enabled: false },
        filesystem: { read: "none", write: "none" },
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
      agentKey: "planner",
      name: "Main",
      systemPromptPreset: "core_native",
      prompt: "",
      modelRef: { providerId: LONGCAT_PROVIDER, modelId: LONGCAT_MODEL },
      tools: { allowed: [], disallowed: [] },
      skills: [],
    },
    agents: [
      {
        agentKey: "smoke_worker",
        templateId: "smoke.worker",
        modelRef: { providerId: LONGCAT_PROVIDER, modelId: LONGCAT_MODEL },
        tools: {
          allowed: [],
          disallowed: [],
          bash: { enabled: false },
          filesystem: { read: "none", write: "none" },
        },
        mcpServers: [],
        skills: [],
        enabled: true,
      },
    ],
    strategy: { kind: "autonomous" },
  },
};

async function makeLongcatSession(input: {
  cwd: string;
  agentDir: string;
  threadId: string;
  extensionFactories?: ReadonlyArray<{ name: string; factory: unknown }>;
  toolsAllowlist?: string[];
}) {
  const hasMcp = Object.keys(mcpServers).length > 0;
  fs.writeFileSync(
    path.join(input.agentDir, "models.json"),
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
    authPath: path.join(input.agentDir, "auth.json"),
    modelsPath: path.join(input.agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.setRuntimeApiKey(LONGCAT_PROVIDER, LONGCAT_API_KEY);
  const model = modelRuntime.getModel(LONGCAT_PROVIDER, LONGCAT_MODEL);
  if (!model) {
    throw new Error(`LongCat model not registered: ${LONGCAT_PROVIDER}/${LONGCAT_MODEL}`);
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { retries: 0, minDelayMs: 0, maxDelayMs: 0, timeoutMs: TIMEOUT_MS },
  });

  const skillDirs = resolvePiSessionSkillPaths({
    agentDir: input.agentDir,
    skillPaths: [skillDir],
  });

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

  const skillContents = skillDirs.map((dir) => {
    const mdPath = path.join(dir, "SKILL.md");
    let content = "";
    try {
      content = fs.readFileSync(mdPath, "utf8");
    } catch {
      // ignore
    }
    return { dir, prompt: content };
  });
  const hasSkills = skillContents.some((s) => s.prompt.length > 0);

  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    noExtensions: extensionFactories.length === 0,
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
                name: path.basename(s.dir),
                description: "smoke-skill",
                prompt: s.prompt,
                filePath: path.join(s.dir, "SKILL.md"),
              })),
            diagnostics: result?.diagnostics ?? [],
          }),
        }
      : {}),
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.create(input.cwd, path.join(input.agentDir, "sessions"));
  const toolsAllowlist =
    input.toolsAllowlist && input.toolsAllowlist.length > 0
      ? [...input.toolsAllowlist]
      : piToolsForSessionMode("agent", { hasMcpServers: hasMcp });

  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader: resourceLoader as never,
    tools: [...new Set([...toolsAllowlist, ...(hasMcp && toolsAllowlist.includes("mcp__mori_mcp__call_tool") ? ["mcp__eco_smoke__smoke_ping", "mcp__eco_smoke__smoke_echo"] : [])])],
    sessionManager,
    settingsManager,
  });

  const hasAgentExtension = (input.extensionFactories ?? []).some((ef) => ef.name === "eco-pi-agent");
  if (typeof session.bindExtensions === "function" && (hasMcp || hasAgentExtension)) {
    await session.bindExtensions({ mode: "rpc" });
  }

  const sessionId = sessionManager.getSessionId();
  return { session, sessionId };
}

const registry = new PiSessionRegistry();
const childRegistry = new PiSessionRegistry();
const threadId = `thr_pi_${marker}`;

const driver = new PiCodingAgentDriver(
  {
    createSession: async (input) => {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-round-${input.threadId}-`));
      const { session, sessionId } = await makeLongcatSession({
        cwd: input.cwd,
        agentDir,
        threadId: input.threadId,
        extensionFactories: input.extensionFactories,
        toolsAllowlist: input.toolsAllowlist,
      });

      return {
        sessionId,
        cwd: input.cwd,
        routeFingerprint: `${LONGCAT_PROVIDER}:${LONGCAT_MODEL}`,
        bindingId: "",
        skillsFingerprint: skillDir,
        mcpFingerprint: JSON.stringify(Object.keys(mcpServers)),
        abort: async () => {
          await session.abort();
        },
        dispose: () => disposePiSdkSession(session),
        ...createPiMidTurnHandle(session),
        rebind: async () => {},
        updateSkillPaths: async () => {},
        async *prompt(text: string): AsyncIterable<AgentEvent> {
          const collected: AgentEvent[] = [];
          let resolveWait: (() => void) | undefined;
          let done = false;
          const wake = () => resolveWait?.();
          const mapCtx = {
            threadId: input.threadId,
            sessionId,
            agentId: sessionId,
            role: "planner" as const,
            state: createPiEventAdapterState(),
            nextSeq: (() => {
              let seq = 0;
              return () => seq++;
            })(),
          };
          const unsub = session.subscribe((ev) => {
            logPiEvent(ev);
            const mapped = mapPiSessionEventToAgentEvents(ev as never, mapCtx);
            for (const event of mapped) {
              collected.push(event);
            }
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
              await new Promise<void>((resolve) => {
                resolveWait = resolve;
              });
            }
            await p;
          } finally {
            unsub();
          }
        },
      };
    },
    resolveBridgeModel: async () => ({
      bridgeBaseUrl: LONGCAT_BASE,
      bridgeModelId: LONGCAT_MODEL,
      apiKey: LONGCAT_API_KEY,
      agentDir: "/tmp/pi-round-unused",
      apiCompat: "openai_chat_completions",
      bindingId: "pi_round",
      providerId: LONGCAT_PROVIDER,
    }),
  },
  registry,
);

const report = {
  core: "pi",
  runId,
  marker,
  model: LONGCAT_MODEL,
  baseUrl: LONGCAT_BASE,
  startedAt: new Date().toISOString(),
  ok: false,
  checklist: null as ReturnType<typeof evaluateSdkScenarioChecklist> | null,
  errors: [] as string[],
};

try {
  const agentEvents: AgentEvent[] = [];
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), TIMEOUT_MS);

  for await (const event of driver.run({
    threadId,
    prompt,
    workspacePath: workspace,
    worktreePath: workspace,
    routes: [
      {
        role: "planner",
        providerId: LONGCAT_PROVIDER,
        modelId: LONGCAT_MODEL,
        primary: { modelId: LONGCAT_MODEL, contextWindow: 128_000 },
      },
    ],
    signal: ac.signal,
    agentRegistry,
    piSession: {
      mcpServers,
      skillPaths: [skillDir],
      onSubagentSpawn: async (spawnInput) => {
        const childDriver = new PiCodingAgentDriver(
          {
            createSession: async (childInput) => {
              const agentDir = fs.mkdtempSync(
                path.join(os.tmpdir(), `pi-round-child-${childInput.threadId}-`),
              );
              const { session, sessionId } = await makeLongcatSession({
                cwd: childInput.cwd,
                agentDir,
                threadId: childInput.threadId,
              });
              return {
                sessionId,
                cwd: childInput.cwd,
                routeFingerprint: `${LONGCAT_PROVIDER}:${LONGCAT_MODEL}`,
                bindingId: "",
                skillsFingerprint: "",
                mcpFingerprint: "",
                abort: async () => {
                  await session.abort();
                },
                dispose: () => disposePiSdkSession(session),
                ...createPiMidTurnHandle(session),
                rebind: async () => {},
                updateSkillPaths: async () => {},
                async *prompt(text: string): AsyncIterable<AgentEvent> {
                  const collected: AgentEvent[] = [];
                  let resolveWait: (() => void) | undefined;
                  let done = false;
                  const wake = () => resolveWait?.();
                  const mapCtx = {
                    threadId: childInput.threadId,
                    sessionId,
                    agentId: sessionId,
                    role: "planner" as const,
                    state: createPiEventAdapterState(),
                    nextSeq: (() => {
                      let seq = 0;
                      return () => seq++;
                    })(),
                  };
                  const unsub = session.subscribe((ev) => {
                    logPiEvent(ev);
                    const mapped = mapPiSessionEventToAgentEvents(ev as never, mapCtx);
                    for (const event of mapped) collected.push(event);
                    if (mapped.length > 0) wake();
                  });
                  const p = session.prompt(text).then(() => {
                    done = true;
                    wake();
                  });
                  try {
                    while (!done || collected.length > 0) {
                      while (collected.length > 0) yield collected.shift()!;
                      if (done) break;
                      await new Promise<void>((resolve) => {
                        resolveWait = resolve;
                      });
                    }
                    await p;
                  } finally {
                    unsub();
                  }
                },
              };
            },
            resolveBridgeModel: async () => ({
              bridgeBaseUrl: LONGCAT_BASE,
              bridgeModelId: LONGCAT_MODEL,
              apiKey: LONGCAT_API_KEY,
              agentDir: "/tmp/pi-round-child-unused",
              apiCompat: "openai_chat_completions",
              bindingId: "pi_round_child",
              providerId: LONGCAT_PROVIDER,
            }),
          },
          childRegistry,
        );
        const childEvents: AgentEvent[] = [];
        const childAc = new AbortController();
        try {
          for await (const ev of childDriver.run({
            threadId: spawnInput.threadId,
            prompt: spawnInput.task,
            workspacePath: workspace,
            worktreePath: workspace,
            routes: [
              {
                role: "planner",
                providerId: LONGCAT_PROVIDER,
                modelId: LONGCAT_MODEL,
                primary: { modelId: LONGCAT_MODEL, contextWindow: 128_000 },
              },
            ],
            signal: childAc.signal,
            piSession: { mcpServers: {} },
          })) {
            childEvents.push(ev);
            logAgentEvent(ev);
            spawnInput.emitEvent(ev);
          }
        } catch (error) {
          spawnInput.emitEvent(
            createAgentEvent({
              id: `${spawnInput.threadId}:child-error`,
              threadId: spawnInput.threadId,
              agentId: spawnInput.agentKey,
              role: "planner",
              type: "thread.failed",
              payload: { message: error instanceof Error ? error.message : String(error) },
            }),
          );
        } finally {
          await childRegistry.deleteThread(spawnInput.threadId);
        }
        const text = collectPiSubagentFinalText(childEvents);
        return {
          agentId: `${spawnInput.agentKey}_${Date.now()}`,
          agentKey: spawnInput.agentKey,
          text: text || "(no output)",
          truncated: false,
        };
      },
    },
  })) {
    agentEvents.push(event);
    logAgentEvent(event);
  }
  clearTimeout(timeout);

  const workspaceFiles = snapshotWorkspace(workspace);
  writeJson(path.join(outDir, "workspace-files.json"), workspaceFiles);

  const evaluation = evaluateSdkScenarioChecklist({
    agentEvents,
    workspaceFiles,
    marker,
    skillsListed: true,
  });
  report.checklist = evaluation;
  report.ok = evaluation.ok;
  report.finishedAt = new Date().toISOString();
  report.agentEventCount = agentEvents.length;
  report.piSdkEventCount = piSeq;

  writeJson(path.join(outDir, "summary.json"), report);
  writeJson(path.join(outDir, "meta.json"), {
    core: "pi",
    runId,
    marker,
    model: LONGCAT_MODEL,
    baseUrl: LONGCAT_BASE,
    workspace,
    recordedAt: report.finishedAt,
    apiKeyRedacted: true,
  });

  writeJson(path.join(fixturesRoot, "latest-pi.json"), {
    runId,
    path: outDir,
    marker,
    ok: report.ok,
    recordedAt: report.finishedAt,
  });

  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        runId,
        outDir,
        failed: evaluation.failed,
        checklist: evaluation.checklist,
      },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.errors.push(String(error));
  report.finishedAt = new Date().toISOString();
  writeJson(path.join(outDir, "summary.json"), report);
  console.error(error);
  process.exitCode = 1;
} finally {
  await registry.deleteThread(threadId);
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
