import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { parseCodexThreadTokenUsage } from "@eco/runtime";
import { CodexAppServerClient } from "@eco/runtime/codex-app-server-client";
import {
  buildCodexGatewayModelAlias,
  buildCodexGatewayProviderTomlLines,
  buildCodexModelProviderSlug,
} from "@eco/runtime/codex-config-sync";
import type { ChatApiCompat } from "../shared/api-compat";
import type { MoriAssistantSettings } from "../shared/mori-assistant";
import type { AccountUsageRecord } from "./account-usage-store";
import { CodexAccountUsageTracker } from "./codex-account-usage-tracker";
import { resolveCodexProxyUrl, type SystemProxyResolver } from "./codex-proxy";
import { buildCodexAppServerEnv } from "./codex-runtime-lifecycle";
import { MORI_TODO_TOOLS } from "./mori-assistant-todos";
import { isMoriModelTool, MORI_MODEL_MANAGEMENT_INSTRUCTIONS } from "./mori-assistant-models";
import { isMoriSchedulingTool, MORI_SCHEDULING_INSTRUCTIONS } from "./mori-assistant-scheduling";
import {
  MORI_COMPUTER_MCP_SERVER,
  MORI_TASK_MCP_SERVER,
  MORI_MODEL_MCP_SERVER,
  MORI_SCHEDULING_MCP_SERVER,
  MoriAssistantToolGateway,
} from "./mori-assistant-tool-gateway";
import { type OpenAIAccountService, startSocksToHttpBridge } from "./openai-account-service";

export interface AssistantTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AssistantRuntimeDeps {
  executable: string;
  home: string;
  cwd: string;
  connection:
    | { type: "chatgpt"; accountId: string; accounts: OpenAIAccountService }
    | ({ type: "custom" } & AssistantCustomProviderRoute);
  resolveSystemProxy: SystemProxyResolver;
  tools: AssistantTool[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    callId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  onText(itemId: string, text: string, final: boolean): void;
  onActivity(text: string): void;
  onUsage?(record: AccountUsageRecord, aggregate: boolean): void;
}

export interface AssistantCustomProviderRoute {
  providerId: string;
  apiCompat: ChatApiCompat;
  gatewayBaseUrl: string;
}

function isTaskTool(tool: AssistantTool): boolean {
  return (
    MORI_TODO_TOOLS.some((todoTool) => todoTool.name === tool.name) ||
    ["mori_start_task", "mori_send_to_task", "mori_read_thread_errors"].includes(tool.name)
  );
}

export class MoriAssistantRuntime {
  private child: ChildProcessWithoutNullStreams | undefined;
  private computerGateway: MoriAssistantToolGateway | undefined;
  private computerConfig: Record<string, unknown> | undefined;
  private taskGateway: MoriAssistantToolGateway | undefined;
  private taskConfig: Record<string, unknown> | undefined;
  private modelGateway: MoriAssistantToolGateway | undefined;
  private modelConfig: Record<string, unknown> | undefined;
  private schedulingGateway: MoriAssistantToolGateway | undefined;
  private schedulingConfig: Record<string, unknown> | undefined;
  private client: CodexAppServerClient | undefined;
  private bridge: { close(): void } | undefined;
  private accessToken: string | undefined;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private completion: { resolve(): void; reject(error: Error): void } | undefined;
  private readonly text = new Map<string, string>();
  private startPromise: Promise<void> | undefined;
  private closing = false;
  private readonly usage = new CodexAccountUsageTracker();
  private model = "";
  constructor(private readonly deps: AssistantRuntimeDeps) {}

  async start(): Promise<void> {
    if (this.client?.isInitialized) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce();
    try {
      await this.startPromise;
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startOnce(): Promise<void> {
    const { deps } = this;
    const connection = deps.connection;
    const computerTools = deps.tools.filter((tool) => tool.name.startsWith("mori_computer_"));
    const taskTools = deps.tools.filter(isTaskTool);
    const modelTools = deps.tools.filter(tool => isMoriModelTool(tool.name));
    const schedulingTools = deps.tools.filter(tool => isMoriSchedulingTool(tool.name));
    if (schedulingTools.length) {
      this.schedulingGateway = new MoriAssistantToolGateway(schedulingTools, deps.callTool, MORI_SCHEDULING_MCP_SERVER);
      this.schedulingConfig = await this.schedulingGateway.start();
    }
    if (modelTools.length) {
      this.modelGateway = new MoriAssistantToolGateway(modelTools, deps.callTool, MORI_MODEL_MCP_SERVER);
      this.modelConfig = await this.modelGateway.start();
    }
    if (taskTools.length) {
      this.taskGateway = new MoriAssistantToolGateway(taskTools, deps.callTool, MORI_TASK_MCP_SERVER);
      this.taskConfig = await this.taskGateway.start();
    }
    if (computerTools.length) {
      this.computerGateway = new MoriAssistantToolGateway(computerTools, deps.callTool);
      this.computerConfig = await this.computerGateway.start();
    }
    await fs.mkdir(deps.home, { recursive: true });
    await fs.mkdir(deps.cwd, { recursive: true });
    // An isolated home has no user/project coding settings, skills or refresh token.
    await fs.writeFile(
      `${deps.home}/config.toml`,
      [
        'cli_auth_credentials_store = "ephemeral"',
        'web_search = "disabled"',
        "[features]",
        "shell_tool = false",
        "multi_agent = false",
        ...(connection.type === "custom"
          ? buildCodexGatewayProviderTomlLines(connection.providerId, {
              gatewayBaseUrl: connection.gatewayBaseUrl,
            })
          : []),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    // Custom requests go to the local Gateway; it owns upstream proxy/auth handling.
    let proxy =
      connection.type === "chatgpt"
        ? await resolveCodexProxyUrl(
            await connection.accounts.getAccountProxyConfig(connection.accountId),
            deps.resolveSystemProxy,
          )
        : undefined;
    if (proxy && new URL(proxy).protocol.startsWith("socks")) {
      const bridge = await startSocksToHttpBridge(proxy);
      this.bridge = bridge;
      proxy = `http://127.0.0.1:${bridge.port}`;
    }
    const env = buildCodexAppServerEnv(
      process.env,
      deps.home,
      proxy ? { mode: "proxy", url: proxy } : { mode: "direct" },
    );
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
    const child = spawn(
      deps.executable,
      ["app-server", "--stdio", "-c", 'cli_auth_credentials_store="ephemeral"'],
      { env, stdio: ["pipe", "pipe", "pipe"], cwd: deps.cwd },
    );
    this.child = child;
    child.stderr.resume(); // Never forward credential-bearing protocol diagnostics to renderers.
    child.on("exit", () => {
      this.client = undefined;
      this.completion?.reject(new Error(this.closing ? "助手已停止。" : "助手运行进程已退出，请重试。"));
    });
    child.on("error", (error) => this.completion?.reject(error));
    const client = CodexAppServerClient.attachToProcess(child, {
      onNotification: (method, params) => this.notify(method, params),
      onServerRequest: async (method, params) => {
        if (method === "account/chatgptAuthTokens/refresh") {
          if (connection.type !== "chatgpt") throw new Error("自定义模型不使用 ChatGPT 登录。");
          const p = params as { previousAccountId?: string };
          const tokens = await connection.accounts.getExternalChatGptTokens(
            connection.accountId,
            this.accessToken,
          );
          if (p.previousAccountId && p.previousAccountId !== tokens.chatgptAccountId)
            throw new Error("刷新请求的账号身份不匹配。");
          this.accessToken = tokens.accessToken;
          return tokens;
        }
        if (method === "item/tool/call") {
          const p = params as {
            threadId: string;
            tool: string;
            arguments: Record<string, unknown>;
            callId: string;
          };
          if (p.threadId !== this.threadId) throw new Error("助手工具调用的会话不匹配。");
          try {
            const result = await deps.callTool(p.tool, p.arguments, p.callId);
            return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
          } catch (error) {
            return {
              success: false,
              contentItems: [
                { type: "inputText", text: error instanceof Error ? error.message : String(error) },
              ],
            };
          }
        }
        if (method === "mcpServer/elicitation/request") {
          const p = params as { threadId?: string; serverName?: string; mode?: string; message?: string };
          const match = p.message?.match(/run tool\s+["']([^"']+)["']/i);
          // Only the host's explicitly exposed, validated tools can use these endpoints.
          const tools =
            p.serverName === MORI_COMPUTER_MCP_SERVER
              ? computerTools
              : p.serverName === MORI_TASK_MCP_SERVER
                ? taskTools
                : p.serverName === MORI_MODEL_MCP_SERVER
                  ? modelTools
                  : p.serverName === MORI_SCHEDULING_MCP_SERVER
                    ? schedulingTools
                    : [];
          if (
            p.threadId === this.threadId &&
            p.mode === "form" &&
            tools.some((tool) => tool.name === match?.[1]?.replace(/^mcp__mori_(computer|tasks|models|scheduling)__/, ""))
          )
            return { action: "accept", content: {}, _meta: null };
          return { action: "decline", content: null, _meta: null };
        }
        // No hidden auto-approval of native filesystem/command tools.
        if (method.includes("requestApproval")) return { decision: "decline" };
        throw new Error(`助手不支持此交互：${method}`);
      },
    });
    this.client = client;
    try {
      await client.initialize();
      if (connection.type === "chatgpt") {
        const tokens = await connection.accounts.getExternalChatGptTokens(connection.accountId);
        this.accessToken = tokens.accessToken;
        await client.request("account/login/start", { type: "chatgptAuthTokens", ...tokens });
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private requireClient(): CodexAppServerClient {
    if (!this.client) throw new Error("助手运行实例尚未连接。");
    return this.client;
  }

  async listModels(): Promise<Array<{ id: string; label: string }>> {
    await this.start();
    const models: Array<{ id: string; label: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await this.requireClient().request<{
        data: Array<{ model: string; displayName?: string }>;
        nextCursor?: string | null;
      }>("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...page.data.map((item) => ({ id: item.model, label: item.displayName ?? item.model })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return models;
  }

  async openThread(settings: MoriAssistantSettings, existing?: string): Promise<string> {
    await this.start();
    const params = {
      model: this.requestModel(settings.model),
      modelProvider:
        this.deps.connection.type === "custom"
          ? buildCodexModelProviderSlug(this.deps.connection.providerId)
          : "openai",
      cwd: this.deps.cwd,
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      baseInstructions: `你是 ${settings.name}，Mori 桌面助手。通过 mori_ 开头的工具管理桌面端项目、待办、会话、任务、供应商、模型和定时任务。可以通过 mori_computer MCP 工具直接读取和操作用户的本机应用。\n${settings.instructions}\n不要直接运行 shell、读取系统文件或操作代码；需要具体工作时创建工作会话。只在工具成功后确认完成。没有配置长期记忆，不得声称记住了跨会话信息。`,
      developerInstructions:
        MORI_MODEL_MANAGEMENT_INSTRUCTIONS + "\n" + MORI_SCHEDULING_INSTRUCTIONS + "\n" +
        "优先保持对话简洁。创建任务后返回任务信息，用户可以继续对话；按需查询任务状态。工作会话 blocked/failed 或需要解释错误时，读取 mori_read_thread 的 diagnostics 或调用 mori_tasks MCP 中的 mori_read_thread_errors；区分当前错误和历史工具失败，只依据保存的错误说明原因，currentErrorMissing 时明确当前原因未保存；category=unknown 时只转述已保存的错误，不要推测模型或 MCP 故障。待办管理与派发统一使用 mori_tasks MCP 中提供的工具。通过 mori_list_todos / mori_read_todo / mori_create_todo / mori_update_todo / mori_delete_todo 增删改查，与 Agent 内部执行计划不同。修改、删除先读取最新 revision，版本冲突时重新读取，不得覆盖用户修改。用户要求把待办作为任务创建 Agent 时，调用 mori_start_task 并提供 todoId；要求交给已有 Agent 时，调用 mori_send_to_task 并提供 threadId 和 todoId。保留原待办引用，不要把文字预览当作全部任务或遗漏图片。待办所属项目已经明确，不必重复询问。发送或排队成功只表示 Agent 已接收，不得据此将待办标为完成。动态桌面状态通过工具读取。你始终在应用管理的独立工作区运行，不随用户打开的项目切换。工作任务在各自项目中执行，不得使用你的独立工作区。涉及项目但项目不明确时，先询问。电脑操作先调用 mori_computer_tools 获取真实工具参数，再用 mori_computer_call。应用状态要及时刷新，优先使用辅助功能元素索引。截图返回本地路径，需要时调用 mori_computer_view 传入 path 和具体问题，复用现有看图能力；不要自行读取截图文件或把图片编码塞进上下文。电脑操作审批交由主进程处理，不得绕过。不要自行批准工作会话的权限请求。",
      config: {
        web_search: "disabled",
        "features.shell_tool": false,
        "features.multi_agent": false,
        mcp_servers: {
          ...(this.computerConfig ? { [MORI_COMPUTER_MCP_SERVER]: this.computerConfig } : {}),
          ...(this.taskConfig ? { [MORI_TASK_MCP_SERVER]: this.taskConfig } : {}),
          ...(this.modelConfig ? { [MORI_MODEL_MCP_SERVER]: this.modelConfig } : {}),
          ...(this.schedulingConfig ? { [MORI_SCHEDULING_MCP_SERVER]: this.schedulingConfig } : {}),
        },
      },
    };
    const response = existing
      ? await this.requireClient().request<{ thread: { id: string } }>("thread/resume", {
          ...params,
          threadId: existing,
          excludeTurns: true,
        })
      : await this.requireClient().request<{ thread: { id: string } }>("thread/start", {
          ...params,
          dynamicTools: this.deps.tools.filter(
            (tool) => !tool.name.startsWith("mori_computer_") && !isTaskTool(tool) && !isMoriModelTool(tool.name) && !isMoriSchedulingTool(tool.name),
          ),
        });
    if (!response.thread.id) throw new Error("Codex 未返回助手会话 ID。");
    this.threadId = response.thread.id;
    return this.threadId;
  }

  async send(text: string, settings: MoriAssistantSettings): Promise<void> {
    if (!this.client || !this.threadId) throw new Error("助手会话尚未建立。");
    if (this.completion) throw new Error("助手正在回复，请等待或停止后再发送。");
    this.text.clear();
    this.model = settings.model;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void completion.catch(() => {});
    this.completion = { resolve, reject };
    const timer = setTimeout(
      () => reject(new Error("助手运行超过 30 分钟，请停止后检查任务状态。")),
      30 * 60_000,
    );
    try {
      const result = await this.client.request<{ turn: { id: string } }>(
        "turn/start",
        {
          threadId: this.threadId,
          model: this.requestModel(settings.model),
          effort: settings.reasoningEffort,
          input: [{ type: "text", text }],
        },
        {
          onResult: (result) => {
            this.turnId = result.turn.id;
          },
        },
      );
      this.turnId = result.turn.id;
      await completion;
    } finally {
      clearTimeout(timer);
      this.completion = undefined;
      this.turnId = undefined;
    }
  }

  private notify(method: string, value: unknown): void {
    try {
      this.handleNotification(method, value);
    } catch (error) {
      this.completion?.reject(error instanceof Error ? error : new Error(String(error)));
      void this.cancel().catch(() => {});
    }
  }

  private requestModel(model: string): string {
    const connection = this.deps.connection;
    return connection.type === "custom"
      ? buildCodexGatewayModelAlias(connection.providerId, model, connection.apiCompat)
      : model;
  }

  private handleNotification(method: string, value: unknown): void {
    const p = value as {
      threadId?: string;
      turnId?: string;
      tokenUsage?: unknown;
      itemId?: string;
      delta?: string;
      item?: { id: string; type: string; text?: string; tool?: string };
      turn?: { id: string; status: string; error?: { message?: string; codexErrorInfo?: unknown } };
    };
    if (!p || typeof p.threadId !== "string" || p.threadId !== this.threadId) return;
    if (method === "item/agentMessage/delta" && p.itemId && typeof p.delta === "string") {
      const text = (this.text.get(p.itemId) ?? "") + p.delta;
      this.text.set(p.itemId, text);
      this.deps.onText(p.itemId, text, false);
    }
    if (method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string") {
      this.text.set(p.item.id, p.item.text);
      this.deps.onText(p.item.id, p.item.text, true);
    }
    if (method === "item/started" && p.item?.type === "dynamicToolCall")
      this.deps.onActivity(p.item.tool ?? "正在处理");
    if (method === "turn/started" && p.turn) {
      this.turnId = p.turn.id;
      if (this.deps.connection.type === "chatgpt")
        this.usage.start(p.threadId, p.turn.id, {
          accountId: this.deps.connection.accountId,
          modelId: this.model,
        });
    }
    if (method === "thread/tokenUsage/updated" && p.turnId) {
      const usage = parseCodexThreadTokenUsage(p.tokenUsage);
      if (usage) {
        const update = this.usage.observe(p.threadId, p.turnId, usage, Date.now());
        if (update) this.deps.onUsage?.(update.record, update.aggregate);
      }
    }
    if (method === "turn/completed" && p.turn) {
      if (p.turn.status === "completed" && [...this.text.values()].some((text) => text.trim()))
        this.completion?.resolve();
      else if (p.turn.status === "completed")
        this.completion?.reject(new Error("助手本轮没有生成文字回复，请检查已执行的工具和工作会话状态。"));
      else
        this.completion?.reject(
          new Error(
            p.turn.error?.message ?? (p.turn.status === "interrupted" ? "助手已停止。" : "助手执行失败。"),
          ),
        );
    }
  }

  async cancel(): Promise<void> {
    if (this.client && this.threadId && this.turnId)
      await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    this.completion?.reject(new Error("助手已停止。"));
  }

  async close(): Promise<void> {
    this.closing = true;
    this.completion?.reject(new Error("助手已停止。"));
    this.client?.close();
    this.client = undefined;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 1500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.child = undefined;
    this.bridge?.close();
    await this.computerGateway?.close();
    this.computerGateway = undefined;
    this.computerConfig = undefined;
    await this.taskGateway?.close();
    this.taskGateway = undefined;
    this.taskConfig = undefined;
    await this.modelGateway?.close();
    this.modelGateway = undefined;
    this.modelConfig = undefined;
    await this.schedulingGateway?.close();
    this.schedulingGateway = undefined;
    this.schedulingConfig = undefined;
  }
}
