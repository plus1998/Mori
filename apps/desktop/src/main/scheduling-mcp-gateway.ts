import http from "node:http";
import type { AddressInfo } from "node:net";
import { SCHEDULING_MCP_SERVER, SCHEDULING_PROMPT, type ScheduleCreateInput, type ScheduleTrigger, type ScheduleUpdateInput } from "../shared/scheduling";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest, type McpToolDefinition } from "./mcp-streamable-http";
import type { SchedulingService } from "./scheduling-service";

const triggerSchema = { oneOf: [
  { type: "object", properties: { type: { const: "at" }, at: { type: "string" } }, required: ["type", "at"], additionalProperties: false },
  { type: "object", properties: { type: { const: "interval" }, everySeconds: { type: "integer", minimum: 60 }, anchorAt: { type: "string" } }, required: ["type", "everySeconds", "anchorAt"], additionalProperties: false },
  { type: "object", properties: { type: { const: "cron" }, expression: { type: "string" }, timezone: { type: "string" } }, required: ["type", "expression", "timezone"], additionalProperties: false },
] };
const string = { type: "string", minLength: 1 };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): McpToolDefinition => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
});
export const schedulingToolDefinitions: McpToolDefinition[] = [
  tool("schedule_message", "Wake this existing conversation once after a delay, preserving its latest context. Never interrupts the active turn. Use this for follow-ups and self-wakeup. Delay is 60–86400 seconds; at most 24 Agent wakeups per conversation per rolling 24 hours. Confirm creation only after success.", { requestId: string, name: string, prompt: string, delaySeconds: { type: "integer", minimum: 60, maximum: 86400 } }, ["requestId", "name", "prompt", "delaySeconds"]),
  tool("create_scheduled_task", "Create an independent task. Every occurrence starts a fresh conversation without this history. Include all necessary context in prompt. Host inherits current Core/model; user can edit them later. Use an ISO timestamp including timezone, a fixed interval, or five-field cron with an explicit IANA timezone. Confirm creation only after success.", { requestId: string, name: string, prompt: string, trigger: triggerSchema, maxLatenessSeconds: { type: "integer", minimum: 0, maximum: 86400 } }, ["requestId", "name", "prompt", "trigger"]),
  tool("list_schedules", "List schedules created from this conversation, including their revisions and saved execution configuration.", {}, []),
  tool("update_scheduled_task", "Update task instructions or timing, preserving the user's saved Core/model. Requires latest expectedRevision from list_schedules.", { id: string, expectedRevision: { type: "integer", minimum: 1 }, name: string, prompt: string, trigger: triggerSchema, enabled: { type: "boolean" } }, ["id", "expectedRevision"]),
  tool("cancel_schedule", "Cancel/delete a schedule created from this conversation. An already running occurrence continues.", { id: string }, ["id"]),
];

export class SchedulingMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly secret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private startPromise: Promise<void> | undefined;
  constructor(private readonly service: SchedulingService) {}

  async resolveInjection(threadId: string) {
    if (!this.startPromise) this.startPromise = this.start();
    await this.startPromise;
    const port = (this.server!.address() as AddressInfo).port;
    const injection = buildEcoHttpInjection({
      name: SCHEDULING_MCP_SERVER, controlBaseUrl: `http://127.0.0.1:${port}`,
      controlSecretHeader: "X-Eco-Scheduling-Secret", controlSecret: this.secret,
      authToken: this.auth.ensure(threadId).token,
      enabledTools: schedulingToolDefinitions.map(item => item.name),
    });
    return { ...injection, promptAppend: SCHEDULING_PROMPT };
  }
  disposeThread(threadId: string): void { this.auth.revokeThread(threadId); }
  async close(): Promise<void> {
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
  }
  private async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void handleMcpStreamableHttpRequest(request, response, {
        serverName: SCHEDULING_MCP_SERVER, instructions: SCHEDULING_PROMPT,
        listTools: async ({ authToken }) => {
          if (!this.auth.resolve(authToken)) throw new Error("缺少当前会话认证。");
          return { tools: schedulingToolDefinitions };
        },
        callTool: async ({ name, arguments: args, authToken }) => {
          try {
            const threadId = this.auth.resolve(authToken)?.threadId;
            if (!threadId) throw new Error("缺少当前会话认证。");
            const definition = schedulingToolDefinitions.find(item => item.name === name);
            if (!definition) throw new Error("未知定时工具。");
            const schema = definition.inputSchema!;
            const fields = schema.properties as Record<string, unknown>;
            if (Object.keys(args).some(key => !(key in fields))) throw new Error("工具参数包含不允许的字段。");
            const actor = { source: "agent" as const, threadId };
            let result: unknown;
            if (name === "list_schedules") result = this.service.store.list().filter(item => this.service.canManage(item, threadId));
            else if (name === "cancel_schedule") { this.service.remove(args.id as string, actor); result = { cancelled: true }; }
            else if (name === "update_scheduled_task") result = this.service.update(args as unknown as ScheduleUpdateInput, actor);
            else if (name === "schedule_message") {
              if (!Number.isSafeInteger(args.delaySeconds)) throw new Error("delaySeconds 必须是整数。");
              const schedule = this.service.create({ ...args, kind: "session_message", threadId, trigger: { type: "at", at: new Date(Date.now() + Number(args.delaySeconds) * 1000).toISOString() } } as ScheduleCreateInput, { ...actor, wakeDelaySeconds: Number(args.delaySeconds) });
              result = { schedule, limits: { minimumDelaySeconds: 60, maximumDelaySeconds: 86400, wakeupsPerRolling24Hours: 24 } };
            } else result = this.service.create({ ...args, kind: "scheduled_task", trigger: args.trigger as ScheduleTrigger } as ScheduleCreateInput, actor);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
          }
        },
      }, { controlSecretHeader: "x-eco-scheduling-secret", controlSecret: this.secret }).catch(error => {
        if (!response.headersSent) response.writeHead(500).end(String(error));
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
  }
}
