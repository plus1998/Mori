import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  prepareClaudeBridgeMessagesRequest,
  resolveProxyRoute,
  runtimeRouteToProxyRoute,
} from "../../apps/desktop/src/main/anthropic-proxy";
import {
  configureEcoGatewayLifecycle,
  stopGlobalEcoGateway,
} from "../../apps/desktop/src/main/eco-gateway-lifecycle";
import { startGatewayRouteBinding } from "../../apps/desktop/src/main/gateway-route-binding";
import { countGatewayInputTokens } from "../../apps/desktop/src/main/provider-token-counter";
import { buildDriverRoutes } from "../../apps/desktop/src/main/thread-runtime-routes";
import { AGENT_ROLES } from "../../apps/desktop/src/shared/ipc";
import { dispatchNodeRequest } from "../../apps/gateway/src/server";
import type { EcoAgentRuntimeConfig } from "../../packages/runtime/src/agent-orchestration";
import { resolveAppliedMaxOutputTokens } from "../../packages/runtime/src/models-dev-limits";
import { type Call, type Protocol, toolsIn, wireReply } from "./upstream";

export const protocols = ["responses", "anthropic", "chat"] as const;
export const roles = AGENT_ROLES;
export const windows = [200_000, 65_536, 200_000, 200_000, 32_768, 200_000];
export const modelOutputs = [64_000, 64_000, 64_000, 4_096, 64_000, 128_000];
export const compatFor = {
  responses: "openai_responses",
  anthropic: "anthropic",
  chat: "openai_chat_completions",
} as const;
export type Trace = {
  role: string;
  protocol: Protocol;
  path: string;
  stream: boolean;
  output: unknown;
  tools: string[];
  model: string;
  input: number;
  precision: string;
  requestedOutput: number;
  sdkRequestedOutput?: number;
};

export async function makeStack(protocol: Protocol, core: string, native = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-output-matrix-"));
  const traces: Trace[] = [];
  const counted = new Map<string, { tokens: number; precision: string; requestedOutput: number }>();
  const sdkRequested = new Map<string, number>();
  let mainTurns = 0;
  const handleUpstream = async (request: Request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith("count_tokens")) return Response.json({ input_tokens: 100 });
    const body = (await request.json()) as Record<string, any>;
    const role = String(body.model).split("__").at(-1) ?? "unknown";
    const tools = toolsIn(body);
    traces.push({
      role,
      protocol,
      path: pathname,
      stream: body.stream === true,
      output: body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens,
      tools: tools.map((t) => (t.namespace ? `${t.namespace}.${t.name}` : t.name)),
      model: body.model,
      input: counted.get(body.model)!.tokens,
      precision: counted.get(body.model)!.precision,
      requestedOutput: counted.get(body.model)!.requestedOutput,
      ...(sdkRequested.has(body.model) && { sdkRequestedOutput: sdkRequested.get(body.model)! }),
    });
    if (native && role === "main") {
      const results = (body.messages ?? []).flatMap((m: any) =>
        Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : [],
      );
      if (results.length)
        await fs.writeFile(path.join(directory, "tool-results.json"), JSON.stringify(results));
    }
    let calls: Call[] = [];
    const tool = tools.find((t) => (core === "codex" ? /spawn_agent$/.test(t.name) : t.name === "Agent"));
    if (
      native &&
      role === "main" &&
      tool &&
      JSON.stringify(body).includes("MATRIX_DELEGATE_ALL") &&
      mainTurns++ === 0
    ) {
      calls = roles.slice(1).map((child) => ({
        ...tool,
        input:
          core === "codex"
            ? { agent_type: child, message: `Reply OUTPUT_BUDGET_OK as ${child}.` }
            : core === "claude"
              ? {
                  subagent_type: child,
                  description: `Verify ${child} output budget`,
                  prompt: "Reply OUTPUT_BUDGET_OK only.",
                }
              : { agent: child, task: "Reply OUTPUT_BUDGET_OK only." },
      }));
    }
    return wireReply(protocol, body, calls);
  };
  const server = http.createServer((request, response) => {
    void dispatchNodeRequest(request, response, handleUpstream).catch((error) =>
      response.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Output matrix upstream did not bind a TCP port");
  const upstreamBaseUrl = `http://127.0.0.1:${address.port}`;
  const provider = {
    id: "matrix",
    name: "Matrix",
    baseUrl: upstreamBaseUrl,
    apiKey: "local-output-test",
    apiCompat: compatFor[protocol],
    defaultModel: `${protocol}__main`,
    enabled: true,
    hasApiKey: true,
    version: "v1",
    requestPath: "",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
  const models = roles.map((role, i) => ({
    modelId: `${protocol}__${role}`,
    contextTokens: windows[i]!,
    maxOutputTokens: modelOutputs[i]!,
  }));
  configureEcoGatewayLifecycle({
    ecoDataDir: directory,
    gatewayPort: 0,
    listProviders: () => [{ ...provider, models }],
    getGlobalMaxOutputTokens: () => "dynamic",
    prepareClaudeMessages: async ({ path, body, model, headers }) => {
      if (!path.includes("count_tokens")) {
        const route = resolveProxyRoute(binding.routes, model);
        if (route && typeof body.max_tokens === "number") sdkRequested.set(route.modelId, body.max_tokens);
      }
      return prepareClaudeBridgeMessagesRequest({ path, body, requestedModel: model, headers });
    },
    countInputTokens: async (input) => {
      const count = native
        ? await countGatewayInputTokens(input)
        : {
            tokens: Number(/MATRIX_INPUT_(\d+)/.exec(JSON.stringify(input.body))?.[1] ?? 100),
            precision: "provider_exact" as const,
            source: "matrix:controlled_input_count",
          };
      counted.set(input.route.upstreamModelId, {
        ...count,
        requestedOutput: Number(
          input.body.max_output_tokens ?? input.body.max_completion_tokens ?? input.body.max_tokens,
        ),
      });
      return count;
    },
  });
  const proxyRoutes = models.map((model, i) =>
    runtimeRouteToProxyRoute(
      {
        role: roles[i]!,
        provider,
        modelId: model.modelId,
        manualSpec: { maxOutputTokens: model.maxOutputTokens },
      },
      { globalMaxOutputTokens: "dynamic", contextTokens: model.contextTokens },
    ),
  );
  const binding = await startGatewayRouteBinding(proxyRoutes, {
    threadId: `matrix_${core}_${protocol}`,
    resolveCountTokensInput: () => 100,
  });
  const registry: EcoAgentRuntimeConfig = {
    templates: roles.slice(1).map((role) => ({
      id: `matrix.${role}`,
      name: role,
      description: `Verify ${role}`,
      prompt: "Reply OUTPUT_BUDGET_OK only.",
      whenToUse: "For output budget verification",
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
      updatedAt: "2026-10-12T00:00:00.000Z",
    })),
    orchestration: {
      mainAgent: {
        agentKey: "main",
        name: "Main",
        systemPromptPreset: "core_native",
        prompt: "Use each configured subagent once.",
        modelRef: { providerId: provider.id, modelId: binding.routes[0]!.aliasModelId },
        tools: { allowed: [], disallowed: [] },
        skills: [],
      },
      agents: roles.slice(1).map((role) => ({
        agentKey: role,
        templateId: `matrix.${role}`,
        modelRef: {
          providerId: provider.id,
          modelId: binding.routes.find((r) => r.role === role)!.aliasModelId,
        },
        tools: {
          allowed: [],
          disallowed: [],
          bash: { enabled: false },
          filesystem: { read: "none", write: "none" },
        },
        mcpServers: [],
        skills: [],
        enabled: true,
      })),
      strategy: { kind: "autonomous" },
    },
  };
  return {
    protocol,
    directory,
    provider,
    binding,
    registry,
    models,
    traces,
    driverRoutes: buildDriverRoutes(binding.routes),
    async stop() {
      await binding.close();
      await stopGlobalEcoGateway();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
export function assertTraceBudgets(traces: Trace[]) {
  for (const trace of traces) {
    const i = roles.indexOf(trace.role as (typeof roles)[number]);
    if (i < 0) throw new Error(`Unknown model role: ${trace.role}`);
    const ceiling = resolveAppliedMaxOutputTokens({
      globalMaxOutputTokens: "dynamic",
      contextTokens: windows[i]!,
      modelMaxOutputTokens: modelOutputs[i]!,
    });
    const reserve = trace.precision === "heuristic" ? Math.max(8_192, Math.ceil(windows[i]! / 10)) : 1_024;
    const expected = Math.min(ceiling, windows[i]! - trace.input - reserve);
    if (typeof trace.output !== "number" || trace.output !== expected || trace.output < 1)
      throw new Error(
        `${trace.role}/${trace.protocol}: expected ${expected} with input=${trace.input}, received ${trace.output}`,
      );
  }
}
