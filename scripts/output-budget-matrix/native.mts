import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentLifecycleService } from "../../apps/desktop/src/main/agent-lifecycle-service";
import { createConversationStore } from "../../apps/desktop/src/main/conversation-store";
import { buildPiGatewayRequestHeaders } from "../../apps/desktop/src/main/gateway-route-binding";
import { defaultIntegratedWebSearchSettings } from "../../apps/desktop/src/main/integrated-web-search-settings-store";
import { createPiSubagentSpawnHandler } from "../../apps/desktop/src/main/pi-subagent-host";
import { ClaudeAgentSdkDriver } from "../../packages/runtime/src/claude-agent-sdk";
import { CodexAppServerClient } from "../../packages/runtime/src/codex-app-server-client";
import { buildCodexGatewayModelAlias } from "../../packages/runtime/src/codex-config-sync";
import {
  globalPiSessionRegistry,
  PiCodingAgentDriver,
} from "../../packages/runtime/src/pi-coding-agent-driver";
import type { EcoApiCompat } from "../../packages/runtime/src/pi-model-bridge";
import {
  resolveClaudeExecutable,
  resolveCodexExecutable,
} from "../conversation-round/lib/resolve-executables.mjs";
import { assertTraceBudgets, makeStack, protocols, roles } from "./stack";

const prompt = "MATRIX_DELEGATE_ALL: Use all five configured subagents, then reply OUTPUT_BUDGET_OK.";
const requestedCore = process.argv.find((a) => a.startsWith("--core="))?.slice(7);
const requestedProtocol = process.argv.find((a) => a.startsWith("--protocol="))?.slice(11);
if (requestedCore && !["claude", "codex", "pi"].includes(requestedCore))
  throw new Error(`Unknown core: ${requestedCore}`);
if (requestedProtocol && !protocols.some((protocol) => protocol === requestedProtocol))
  throw new Error(`Unknown protocol: ${requestedProtocol}`);
const outDir = path.resolve("apps/desktop/.smoke-artifacts/output-budget-matrix");
await fs.mkdir(outDir, { recursive: true });
const report: any[] = [];
for (const core of ["claude", "codex", "pi"])
  for (const protocol of protocols) {
    if ((requestedCore && core !== requestedCore) || (requestedProtocol && protocol !== requestedProtocol))
      continue;
    const stack = await makeStack(protocol, core, true);
    const errors: string[] = [];
    console.log(`START ${core}/${protocol}`);
    try {
      if (core === "claude") await runClaude(stack);
      else if (core === "pi") await runPi(stack);
      else await runCodex(stack);
      assertTraceBudgets(stack.traces);
      for (const role of roles)
        if (!stack.traces.some((t) => t.role === role))
          throw new Error(`Missing real SDK request for ${role}`);
    } catch (e) {
      errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
    const cell = {
      core,
      protocol,
      ok: !errors.length,
      childCompletionsVerified: !errors.length,
      errors,
      roles: Object.fromEntries(
        roles.map((role) => [
          role,
          stack.traces
            .filter((t) => t.role === role)
            .map((t) => ({
              path: t.path,
              input: t.input,
              precision: t.precision,
              requestedOutput: t.requestedOutput,
              output: t.output,
              stream: t.stream,
            })),
        ]),
      ),
      traces: stack.traces,
    };
    report.push(cell);
    await fs.writeFile(path.join(outDir, `${core}-${protocol}.json`), JSON.stringify(cell, null, 2));
    console.log(
      JSON.stringify({
        core,
        protocol,
        ok: cell.ok,
        errors,
        calls: stack.traces.length,
        roles: Object.keys(cell.roles).filter((r) => stack.traces.some((t) => t.role === r)),
      }),
    );
    try {
      await fs.copyFile(
        path.join(stack.directory, "tool-results.json"),
        path.join(outDir, `${core}-${protocol}-tool-results.json`),
      );
    } catch (e) {
      if ((e as any).code !== "ENOENT") throw e;
    }
    await stack.stop();
  }
await fs.writeFile(
  path.join(
    outDir,
    `report${requestedCore ? `-${requestedCore}` : ""}${requestedProtocol ? `-${requestedProtocol}` : ""}.json`,
  ),
  JSON.stringify(
    {
      kind: "real SDK/CLI; deterministic local upstream; no remote model calls",
      formula:
        "min(effective window - current full input tokens - 1, model output ceiling, client requested output)",
      inputCounting: "Production local_heuristic provider mode; estimates are not exact tokenizer counts",
      ok: report.every((c) => c.ok),
      cells: report,
    },
    null,
    2,
  ),
);
await fs.writeFile(
  path.join(
    outDir,
    `report${requestedCore ? `-${requestedCore}` : ""}${requestedProtocol ? `-${requestedProtocol}` : ""}.md`,
  ),
  [
    "# 每次请求动态输出验证",
    "",
    "公式：min(有效窗口 − 本次完整输入 tokens − 1, 模型输出上限, 客户端请求上限)。有效窗口为 min(模型窗口, 全局上下文上限)。",
    "",
    "真实 Claude SDK/CLI、Codex app-server、PI SDK；每组都实际启动并验证五个子 agent 完成。上游为本地模拟服务。输入计数使用生产 local_heuristic 模式，属于估算。",
    "",
    "| Core | 上游 | 状态 | 请求数 | 已验证角色 |",
    "|---|---|---|---:|---|",
    ...report.map(
      (cell) =>
        `| ${cell.core} | ${cell.protocol} | ${cell.ok ? "通过" : "失败"} | ${cell.traces.length} | ${roles.join("、")} |`,
    ),
    "",
    "HTTP 回归矩阵另覆盖 648 个请求，包括流式/非流式、短输入/模拟接近满窗口的计数、缺省/超大/较小输出参数。接近满窗口场景使用受控计数结果，不是远端模型实测。",
    "",
    "计数端点失败不会退回估算；窗口耗尽或 thinking 最低预算放不下时拒绝发送生成。ChatGPT 订阅不支持输出限制参数，动态模式明确报错。",
    "",
    "未验证：远端服务对参数的实际执行、远端模型接近满窗口时的压缩。详见同目录 report.json 与各组请求记录。",
    "",
  ].join("\n"),
);
process.exitCode = report.every((c) => c.ok) ? 0 : 1;

type Stack = Awaited<ReturnType<typeof makeStack>>;
async function runClaude(stack: Stack) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const sdkMessages: any[] = [];
  const executable = resolveClaudeExecutable();
  const driver = new ClaudeAgentSdkDriver({
    onSdkMessage: (message) => sdkMessages.push(message),
    apiKey: stack.binding.apiKey,
    baseUrl: stack.binding.baseUrl,
    anthropicAuthMode: "bearer",
    ...(executable && { pathToClaudeCodeExecutable: executable }),
    executionPermissionMode: "bypassPermissions",
    toolPermissionHandler: async () => ({ behavior: "allow" }),
  });
  let completed = false;
  try {
    for await (const event of driver.run({
      threadId: "matrix_claude",
      prompt,
      workspacePath: stack.directory,
      worktreePath: stack.directory,
      routes: stack.driverRoutes,
      agentRegistry: stack.registry,
      signal: controller.signal,
      sdkSession: { settingSources: [] },
    })) {
      if (event.type === "thread.failed") throw new Error(JSON.stringify(event.payload));
      if (event.type === "run.terminal") {
        completed = true;
        controller.abort();
      }
    }
    if (!completed) throw new Error("Claude SDK did not complete");
    const result = sdkMessages.findLast((message) => message.type === "result");
    if (
      result?.subtype !== "success" ||
      result.subagent_stats?.completed !== roles.length - 1 ||
      result.subagent_stats?.failed !== 0
    ) {
      throw new Error(`Claude child completion check failed: ${JSON.stringify(result?.subagent_stats)}`);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    await fs.writeFile(
      path.join(outDir, `claude-${stack.protocol}-sdk.json`),
      JSON.stringify(sdkMessages, null, 2),
    );
  }
}
async function runPi(stack: Stack) {
  const threadId = `matrix_pi_${stack.traces.length}`;
  const store = await createConversationStore(path.join(stack.directory, "conversation.sqlite"));
  const now = new Date().toISOString();
  store.saveThread({
    id: threadId,
    title: "Output budget matrix",
    prompt,
    workspacePath: stack.directory,
    coreKind: "pi",
    status: "running",
    message: "",
    createdAt: now,
    updatedAt: now,
  });
  const lifecycle = new AgentLifecycleService(store);
  lifecycle.startRunAttempt({ attemptId: "matrix-attempt", threadId, phase: "execution", retryIndex: 0 });
  const armed = {
    binding: stack.binding,
    driverRoutes: stack.driverRoutes,
    globalContextWindowLimit: 262_144,
    runAttemptId: "matrix-attempt",
  };
  const onSubagentSpawn = createPiSubagentSpawnHandler({
    threadId,
    ecoDataDir: stack.directory,
    getArmedBinding: () => armed,
    registry: stack.registry,
    conversationStore: store,
    lifecycle,
    toolPermissionHandler: async () => ({ behavior: "allow" }),
    getIntegratedWebSearchRuntime: () => ({ settings: defaultIntegratedWebSearchSettings() }),
  });
  const driver = new PiCodingAgentDriver({
    resolveBridgeModel: async () => {
      const route = stack.binding.routes[0]!;
      return {
        bridgeBaseUrl: stack.binding.baseUrl,
        bridgeModelId: route.aliasModelId,
        apiKey: stack.binding.apiKey,
        agentDir: path.join(stack.directory, "pi-parent"),
        apiCompat: route.apiCompat as EcoApiCompat,
        bindingId: stack.binding.bindingId,
        providerId: stack.provider.id,
        ...(route.contextTokens !== undefined && { contextWindow: route.contextTokens }),
        ...(route.maxOutputTokens !== undefined && {
          maxOutputTokens: route.maxOutputTokens,
          globalMaxOutputTokens: route.maxOutputTokens,
        }),
        headers: buildPiGatewayRequestHeaders({
          bindingId: stack.binding.bindingId,
          threadId,
          providerId: stack.provider.id,
          requestedModel: route.aliasModelId,
          apiCompat: route.apiCompat,
        }),
      };
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let completed = false;
  const finishedChildren = new Set<string>();
  try {
    for await (const event of driver.run({
      threadId,
      prompt,
      workspacePath: stack.directory,
      worktreePath: stack.directory,
      routes: stack.driverRoutes,
      agentRegistry: stack.registry,
      signal: controller.signal,
      piSession: {
        sessionMode: "agent",
        onSubagentSpawn,
        toolPermissionHandler: async () => ({ behavior: "allow" }),
      },
    })) {
      if (event.type === "agent.completed" && (event.payload as any)?.agentKey)
        finishedChildren.add((event.payload as any).agentKey);
      if (event.type === "thread.failed") throw new Error(JSON.stringify(event.payload));
      if (event.type === "run.terminal") completed = true;
    }
    if (!completed) throw new Error("PI SDK did not complete");
    for (const role of roles.slice(1))
      if (!finishedChildren.has(role)) throw new Error(`PI child did not complete: ${role}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await globalPiSessionRegistry.deleteThread(threadId);
  }
}
async function runCodex(stack: Stack) {
  const codexHome = path.join(stack.directory, "codex");
  const agentDir = path.join(codexHome, "agents");
  await fs.mkdir(agentDir, { recursive: true });
  const provider = "matrix";
  const aliases = roles.map((role) =>
    buildCodexGatewayModelAlias(stack.provider.id, `${stack.protocol}__${role}`),
  );
  const config: string[] = [
    `model = ${JSON.stringify(aliases[0])}`,
    `model_provider = "${provider}"`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    "[features]",
    "remote_plugin = false",
    "plugins = false",
    "multi_agent = true",
    "[agents]",
    "max_threads = 8",
    "max_depth = 1",
  ];
  for (const [i, role] of roles.entries())
    if (i) {
      const file = path.join(agentDir, `${role}.toml`);
      await fs.writeFile(
        file,
        `name = "${role}"\nmodel = ${JSON.stringify(aliases[i])}\nmodel_provider = "${provider}"\ndeveloper_instructions = "Reply OUTPUT_BUDGET_OK only."\napproval_policy = "never"\nsandbox_mode = "read-only"\n`,
      );
      config.push(
        `[agents.${role}]`,
        `description = "Verify ${role} output budget"`,
        `config_file = ${JSON.stringify(file)}`,
      );
    }
  config.push(
    `[model_providers.${provider}]`,
    'name = "Output budget local matrix"',
    `base_url = ${JSON.stringify(`${stack.binding.baseUrl}/v1`)}`,
    'wire_api = "responses"',
    "request_max_retries = 0",
    "stream_idle_timeout_ms = 10000",
  );
  await fs.writeFile(path.join(codexHome, "config.toml"), config.join("\n") + "\n");
  const child = spawn(resolveCodexExecutable(), ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = CodexAppServerClient.attachToProcess(child, {
    timeoutMs: 60_000,
    onServerRequest: async () => ({ decision: "accept" }),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const childIds = new Set<string>();
  client.addNotificationHandler((method, params: any) => {
    if (method === "item/completed") for (const id of params.item?.receiverThreadIds ?? []) childIds.add(id);
  });
  try {
    await client.initialize({
      clientInfo: { name: "eco_output_budget_matrix", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    const started = (await client.request("thread/start", {
      cwd: stack.directory,
      model: aliases[0],
      modelProvider: provider,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    })) as any;
    const done = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Codex main/child turn timeout")), 60_000);
      client.addNotificationHandler((method, params: any) => {
        if (method === "turn/completed" && params.threadId === started.thread.id) {
          if (params.turn?.status === "failed") reject(new Error(JSON.stringify(params.turn)));
          else resolve();
        }
      });
    });
    await client.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: prompt }],
      model: aliases[0],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    await done;
    const deadline = Date.now() + 10_000;
    const finished = new Set<string>();
    while (Date.now() < deadline && finished.size < roles.length - 1) {
      for (const childId of childIds) {
        const read = (await client.request("thread/read", { threadId: childId, includeTurns: true })) as any;
        const turns = read.thread?.turns ?? [];
        if (turns.some((turn: any) => turn.status === "failed"))
          throw new Error(`Codex child failed: ${childId}`);
        if (
          turns.some(
            (turn: any) =>
              turn.status === "completed" && JSON.stringify(turn.items).includes("OUTPUT_BUDGET_OK"),
          )
        )
          finished.add(childId);
      }
      if (finished.size < roles.length - 1) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (finished.size !== roles.length - 1)
      throw new Error(`Only ${finished.size}/5 Codex child turns completed`);
  } finally {
    if (timer) clearTimeout(timer);
    client.close();
    child.kill("SIGTERM");
    await fs.writeFile(path.join(outDir, `codex-${stack.protocol}-stderr.log`), stderr);
  }
}
