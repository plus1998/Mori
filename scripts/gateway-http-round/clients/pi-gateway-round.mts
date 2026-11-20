/**
 * Full conversation-round scenario via PI (π) → Eco Bridge → Gateway.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EcoAgentRuntimeConfig } from "../../../packages/runtime/src/agent-orchestration";
import {
  createPiMidTurnHandle,
  PiCodingAgentDriver,
  PiSessionRegistry,
} from "../../../packages/runtime/src/pi-coding-agent-driver";
import {
  createPiEventAdapterState,
  mapPiSessionEventToAgentEvents,
} from "../../../packages/runtime/src/pi-event-adapter";
import { createPiMcpExtensionFactory } from "../../../packages/runtime/src/pi-mcp-extension-factory";
import { disposePiSdkSession } from "../../../packages/runtime/src/pi-session-dispose";
import {
  type EcoApiCompat,
  mapApiCompatToPiApi,
  mapApiCompatToPiAuthProvider,
} from "../../../packages/runtime/src/pi-model-bridge";
import { piToolsForSessionMode } from "../../../packages/runtime/src/pi-session-mode";
import { resolvePiSessionSkillPaths } from "../../../packages/runtime/src/pi-skills";
import { collectPiSubagentFinalText } from "../../../packages/runtime/src/pi-subagent";
import type { AgentEvent } from "../../../packages/shared/src";
import { createAgentEvent } from "../../../packages/shared/src";
import {
  appendJsonl,
  ensureDir,
  redactSecrets,
  snapshotWorkspace,
  writeJson,
} from "../../conversation-round/lib/fixture-io.mjs";
import {
  resolveMcpEchoServerPath,
  resolveNodeExecutable,
} from "../../conversation-round/lib/resolve-executables.mjs";
import { buildScenarioPrompt } from "../../conversation-round/lib/scenario-prompt.mjs";
import { setupScenarioWorkspace } from "../../conversation-round/lib/scenario-workspace.mjs";
import { evaluateSdkScenarioChecklist } from "../../conversation-round/lib/sdk-checklist.mjs";
import { FULL_ROUND_SCENARIO_ID } from "../lib/client-matrix.mjs";
import {
  type GatewayRecordingStack,
  resolveProfileApiCompat,
  resolveProfileModelAlias,
} from "../lib/gateway-stack.mts";
import { resolveProfile } from "../lib/profiles.mjs";

const GATEWAY_LOCAL_CLIENT_KEY = "gateway-local";

export interface PiGatewayRoundInput {
  stack: GatewayRecordingStack;
  profileId: string;
  outDir: string;
  marker: string;
  timeoutMs?: number;
}

export interface PiGatewayRoundResult {
  ok: boolean;
  checklist: ReturnType<typeof evaluateSdkScenarioChecklist> | null;
  upstreamExchangeCount: number;
  errors: string[];
}

export async function runPiGatewayRound(input: PiGatewayRoundInput): Promise<PiGatewayRoundResult> {
  const profile = resolveProfile(input.profileId);
  const modelAlias = resolveProfileModelAlias(input.profileId);
  const apiCompat = resolveProfileApiCompat(input.profileId) as EcoApiCompat;
  const piApi = mapApiCompatToPiApi(apiCompat);
  const piProvider = mapApiCompatToPiAuthProvider(apiCompat);
  const bridgeBaseUrl = input.stack.bridgeBaseUrl;
  const timeoutMs = input.timeoutMs ?? Number.parseInt(process.env.ECO_PI_SMOKE_TIMEOUT_MS ?? "600000", 10);

  input.stack.setActiveCell({
    client: "pi",
    profileId: input.profileId,
    scenarioId: FULL_ROUND_SCENARIO_ID,
  });

  ensureDir(input.outDir);
  const workspace = path.join(input.outDir, "workspace");
  if (fs.existsSync(workspace)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  fs.mkdirSync(workspace, { recursive: true });
  const mcpServerPath = resolveMcpEchoServerPath();
  const nodeExe = resolveNodeExecutable();
  const mcpLogPath = path.join(input.outDir, "mcp-server.log");
  const piSdkEventsPath = path.join(input.outDir, "pi-sdk-events.jsonl");
  const agentEventsPath = path.join(input.outDir, "agent-events.jsonl");

  const mcpServers = {
    eco_smoke: {
      command: nodeExe,
      args: [mcpServerPath],
      env: { ECO_SMOKE_MCP_LOG: mcpLogPath },
    },
  };

  const { skillDir } = setupScenarioWorkspace({ workspace, marker: input.marker });
  const prompt = buildScenarioPrompt(input.marker);
  fs.writeFileSync(path.join(input.outDir, "prompt.txt"), prompt);

  let piSeq = 0;
  let agentSeq = 0;
  function logPiEvent(event: unknown) {
    appendJsonl(piSdkEventsPath, {
      seq: ++piSeq,
      ts: new Date().toISOString(),
      event: redactSecrets(event, input.stack.secrets),
    });
  }
  function logAgentEvent(event: AgentEvent) {
    appendJsonl(agentEventsPath, {
      seq: ++agentSeq,
      ts: new Date().toISOString(),
      event: redactSecrets(event, input.stack.secrets),
    });
  }

  const bridgeResolution = {
    bridgeBaseUrl,
    bridgeModelId: modelAlias,
    apiKey: GATEWAY_LOCAL_CLIENT_KEY,
    agentDir: "/tmp/pi-gw-round-unused",
    apiCompat,
    bindingId: `cbb_pi_gw_${input.profileId}`,
    providerId: profile.id,
  };

  async function makeGatewayPiSession(sessionInput: {
    cwd: string;
    agentDir: string;
    threadId: string;
    extensionFactories?: ReadonlyArray<{ name: string; factory: unknown }>;
    toolsAllowlist?: string[];
    includeMcp?: boolean;
  }) {
    const hasMcp = sessionInput.includeMcp !== false && Object.keys(mcpServers).length > 0;
    fs.writeFileSync(
      path.join(sessionInput.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [piProvider]: {
            baseUrl: bridgeBaseUrl,
            api: piApi,
            models: [
              {
                id: modelAlias,
                name: modelAlias,
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
      authPath: path.join(sessionInput.agentDir, "auth.json"),
      modelsPath: path.join(sessionInput.agentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    modelRuntime.setRuntimeApiKey(piProvider, GATEWAY_LOCAL_CLIENT_KEY);
    const model = modelRuntime.getModel(piProvider, modelAlias);
    if (!model) {
      throw new Error(`Gateway PI model not registered: ${piProvider}/${modelAlias}`);
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { retries: 0, minDelayMs: 0, maxDelayMs: 0, timeoutMs },
    });

    const skillDirs = resolvePiSessionSkillPaths({
      agentDir: sessionInput.agentDir,
      skillPaths: [skillDir],
    });

    const extensionFactories: Array<{ name: string; factory: unknown }> = [];
    for (const ef of sessionInput.extensionFactories ?? []) {
      extensionFactories.push({ name: ef.name, factory: ef.factory });
    }
    if (hasMcp) {
      const mcpFactory = await createPiMcpExtensionFactory(mcpServers, {
        agentDir: sessionInput.agentDir,
      });
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
      cwd: sessionInput.cwd,
      agentDir: sessionInput.agentDir,
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

    const sessionManager = SessionManager.create(
      sessionInput.cwd,
      path.join(sessionInput.agentDir, "sessions"),
    );
    const toolsAllowlist =
      sessionInput.toolsAllowlist && sessionInput.toolsAllowlist.length > 0
        ? [...sessionInput.toolsAllowlist]
        : piToolsForSessionMode("agent", { hasMcpServers: hasMcp });

    const { session } = await createAgentSession({
      cwd: sessionInput.cwd,
      agentDir: sessionInput.agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader: resourceLoader as never,
      tools: [...new Set([...toolsAllowlist, ...(hasMcp && toolsAllowlist.includes("mcp__mori_mcp__call_tool") ? ["mcp__eco_smoke__smoke_ping", "mcp__eco_smoke__smoke_echo"] : [])])],
      sessionManager,
      settingsManager,
    });

    const hasAgentExtension = (sessionInput.extensionFactories ?? []).some(
      (ef) => ef.name === "eco-pi-agent",
    );
    if (typeof session.bindExtensions === "function" && (hasMcp || hasAgentExtension)) {
      await session.bindExtensions({ mode: "rpc" });
    }

    return { session, sessionId: sessionManager.getSessionId() };
  }

  function buildPromptIterable(
    session: Awaited<ReturnType<typeof makeGatewayPiSession>>["session"],
    sessionId: string,
    threadId: string,
  ) {
    return async function* prompt(text: string): AsyncIterable<AgentEvent> {
      const collected: AgentEvent[] = [];
      let resolveWait: (() => void) | undefined;
      let done = false;
      const wake = () => resolveWait?.();
      const mapCtx = {
        threadId,
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
    };
  }

  const agentRegistry: EcoAgentRuntimeConfig = {
    templates: [
      {
        id: "smoke.worker",
        name: "Smoke Worker",
        description: "Short-lived worker for Eco gateway client round.",
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
        modelRef: { providerId: profile.id, modelId: modelAlias },
        tools: { allowed: [], disallowed: [] },
        skills: [],
      },
      agents: [
        {
          agentKey: "smoke_worker",
          templateId: "smoke.worker",
          modelRef: { providerId: profile.id, modelId: modelAlias },
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

  const registry = new PiSessionRegistry();
  const childRegistry = new PiSessionRegistry();
  const threadId = `thr_pi_gw_${input.marker}_${profile.id}`;

  const driver = new PiCodingAgentDriver(
    {
      createSession: async (sessionInput) => {
        const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-gw-${sessionInput.threadId}-`));
        const { session, sessionId } = await makeGatewayPiSession({
          cwd: sessionInput.cwd,
          agentDir,
          threadId: sessionInput.threadId,
          extensionFactories: sessionInput.extensionFactories,
          toolsAllowlist: sessionInput.toolsAllowlist,
        });
        return {
          sessionId,
          cwd: sessionInput.cwd,
          routeFingerprint: `${profile.id}:${modelAlias}:${apiCompat}`,
          bindingId: bridgeResolution.bindingId,
          skillsFingerprint: skillDir,
          mcpFingerprint: JSON.stringify(Object.keys(mcpServers)),
          abort: async () => {
            await session.abort();
          },
          dispose: () => disposePiSdkSession(session),
          ...createPiMidTurnHandle(session),
          rebind: async () => {},
          updateSkillPaths: async () => {},
          prompt: buildPromptIterable(session, sessionId, sessionInput.threadId),
        };
      },
      resolveBridgeModel: async () => bridgeResolution,
    },
    registry,
  );

  const errors: string[] = [];
  let checklist: ReturnType<typeof evaluateSdkScenarioChecklist> | null = null;

  try {
    const agentEvents: AgentEvent[] = [];
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), timeoutMs);

    for await (const event of driver.run({
      threadId,
      prompt,
      workspacePath: workspace,
      worktreePath: workspace,
      routes: [
        {
          role: "planner",
          providerId: profile.id,
          modelId: modelAlias,
          apiCompat,
          primary: { modelId: modelAlias, contextWindow: 128_000 },
          fallbacks: [],
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
                  path.join(os.tmpdir(), `pi-gw-child-${childInput.threadId}-`),
                );
                const { session, sessionId } = await makeGatewayPiSession({
                  cwd: childInput.cwd,
                  agentDir,
                  threadId: childInput.threadId,
                  includeMcp: false,
                });
                return {
                  sessionId,
                  cwd: childInput.cwd,
                  routeFingerprint: `${profile.id}:${modelAlias}:${apiCompat}`,
                  bindingId: `${bridgeResolution.bindingId}_child`,
                  skillsFingerprint: "",
                  mcpFingerprint: "",
                  abort: async () => {
                    await session.abort();
                  },
                  dispose: () => disposePiSdkSession(session),
                  ...createPiMidTurnHandle(session),
                  rebind: async () => {},
                  updateSkillPaths: async () => {},
                  prompt: buildPromptIterable(session, sessionId, childInput.threadId),
                };
              },
              resolveBridgeModel: async () => ({
                ...bridgeResolution,
                bindingId: `${bridgeResolution.bindingId}_child`,
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
                  providerId: profile.id,
                  modelId: modelAlias,
                  apiCompat,
                  primary: { modelId: modelAlias, contextWindow: 128_000 },
                  fallbacks: [],
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
    writeJson(path.join(input.outDir, "workspace-files.json"), workspaceFiles);

    checklist = evaluateSdkScenarioChecklist({
      agentEvents,
      workspaceFiles,
      marker: input.marker,
      skillsListed: true,
    });
    writeJson(path.join(input.outDir, "checklist.json"), checklist);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await registry.deleteThread(threadId);
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  const ok = Boolean(checklist?.ok);
  return { ok, checklist, upstreamExchangeCount: 0, errors };
}
