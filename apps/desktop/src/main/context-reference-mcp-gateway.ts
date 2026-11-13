import http from "node:http";
import type { AddressInfo } from "node:net";
import { BROWSER_REFERENCE_ACTION_VALUES } from "../shared/browser-reference-actions";
import { CONTEXT_MCP_SERVER, CONTEXT_REFERENCE_PROMPT } from "../shared/composer-references";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import type { ComposerReferenceService } from "./composer-reference-service";
import type { MultiAgentsService } from "./multi-agents-service";
import { PROJECT_TODO_STATUSES } from "../shared/project-todos";
import { buildEcoHttpInjection } from "./mcp-http-descriptor";
import {
  handleMcpStreamableHttpRequest,
  type McpToolDefinition,
  type McpToolCallResult,
} from "./mcp-streamable-http";

const string = { type: "string", minLength: 1 };
const limit = { type: "integer", minimum: 1, maximum: 50 };
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  readOnly = true,
): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly },
  };
}
export const contextReferenceTools = [
  tool("multi_agents_start", "Start collaboration in Agent mode using the exact saved configuration explicitly @Multi-Agents-referenced by the user. Pass configId and requestId from the reference. No approved plan is required. Returns the fixed roster and dispatch/acceptance instructions. Repeated calls for the same request are idempotent; unavailable configurations or native members fail explicitly.", { configId: string, requestId: string }, ["configId", "requestId"], false),
  tool("multi_agents_status", "Read the current Multi-Agents run, fixed member roster, tasks, results and worktree integration status. Main conversation only.", {}, []),
  tool("multi_agents_submit_tasks", "Dispatch the current Multi-Agents request or approved plan as structured tasks to configured independent member conversations. Host enforces member identity, concurrency, dependency DAG and isolated worktrees. End your turn after submission; the host delivers results as a follow-up.", {
    tasks: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", additionalProperties: false, required: ["id", "memberId", "title", "instructions", "scope", "dependsOn", "acceptance"], properties: {
      id: string, memberId: string, title: string, instructions: string, acceptance: string,
      scope: { type: "array", items: string }, dependsOn: { type: "array", items: string },
    } } },
  }, ["tasks"], false),
  tool("multi_agents_report", "Member conversation only: report actual changes, tests and unresolved issues for your own task, then end your turn. The host verifies turn completion before collecting worktree changes.", { result: string }, ["result"], false),
  tool("multi_agents_retry", "Main conversation only: return one task to the same member conversation with concrete rework instructions.", { taskId: string, instructions: string }, ["taskId", "instructions"], false),
  tool("multi_agents_integrate", "Main conversation only: apply a completed member's changes into the main working directory, in dependency order. Fails without applying changes when a patch conflicts. Review and test after integration.", { taskId: string }, ["taskId"], false),
  tool("multi_agents_resolve_integration", "Main conversation only: after an integration conflict, manually inspect and resolve the member changes in your working directory, then record concrete review/test evidence here. Host snapshots the actual resolved workspace; it does not apply or silently skip the conflicting patch.", { taskId: string, review: string }, ["taskId", "review"], false),
  tool("multi_agents_accept", "Main conversation only: mark Multi-Agents complete after actual code review and testing. Independent tasks must all have succeeded and been integrated. Supply concrete acceptance evidence.", { review: string }, ["review"], false),
  tool(
    "list_todos",
    "List user-owned project todos in the authenticated conversation's project, separate from internal Agent plans. Returns todoId, revision, status, text preview and imageCount. Supports status/query filters and pagination.",
    {
      query: { type: "string" },
      status: { type: "string", enum: PROJECT_TODO_STATUSES },
      limit,
      offset: { type: "integer", minimum: 0 },
    },
    [],
  ),
  tool(
    "read_todo",
    "Read the latest original user todo by todoId in the current project or explicitly @todo-referenced in this conversation. Returns revision for status updates, paginated text, status and image metadata. Set includeImages=true to view attached images.",
    {
      todoId: string,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 16000 },
      includeImages: { type: "boolean" },
    },
    ["todoId"],
  ),
  tool(
    "create_todo",
    "Create a user-owned todo in the authenticated conversation's project when requested by the user. Default status is pending. Returns the original todoId and revision; this is not an internal execution-plan tool.",
    {
      text: { type: "string", minLength: 1, maxLength: 100000 },
      status: { type: "string", enum: PROJECT_TODO_STATUSES },
    },
    ["text"],
    false,
  ),
  tool(
    "update_todo_status",
    "Update the original user todo to pending, in_progress or completed. Requires todoId and latest revision from read_todo; a stale revision fails without overwriting user edits. Mark in_progress when starting and completed only after the task is successfully finished. Current project or explicitly @todo-referenced entries only.",
    {
      todoId: string,
      revision: { type: "integer", minimum: 1 },
      status: { type: "string", enum: PROJECT_TODO_STATUSES },
    },
    ["todoId", "revision", "status"],
    false,
  ),
  tool(
    "read_plan",
    "Read an immutable referenced plan version by planId. Returns plan text, version and source conversation. Continue with nextOffset when hasMore is true; execution status is maintained by the host runtime.",
    { planId: string, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16000 } },
    ["planId"],
  ),
  tool(
    "read_conversation",
    "Read a local Mori conversation across projects by conversationId. Returns bounded user/assistant text, role, messageId, runId, status, timestamps, truncation flags, and an older-page cursor. Excludes thinking, system prompts, runtime configuration and inline attachments. Long text can be continued with read_conversation_message. includeTools adds bounded tool summaries.",
    { conversationId: string, beforeCursor: string, limit, includeTools: { type: "boolean" } },
    ["conversationId"],
  ),
  tool(
    "read_conversation_message",
    "Read the next text chunk of one user/assistant message from an Mori conversation. Use messageId from read_conversation, with offset / nextOffset to continue a truncated message.",
    {
      conversationId: string,
      messageId: string,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 16000 },
    },
    ["conversationId", "messageId"],
  ),
  tool(
    "read_conversation_tools",
    "Page through tool input/output summaries for a runId from read_conversation. Bodies are bounded by the transcript store; returned summaries are not a promise of complete raw tool output.",
    { conversationId: string, runId: string, cursor: string, limit },
    ["conversationId", "runId"],
  ),
  tool(
    "read_browser_selection",
    "Read the immutable text/element snapshot explicitly selected and referenced by the user. Returns captured text, surrounding context, exact browserId, frame URL, selector path, timestamp and current live availability. includeScreenshot adds the captured viewport image. Works after tab closure; a stale snapshot cannot authorize live actions.",
    { selectionId: string, includeScreenshot: { type: "boolean" } },
    ["selectionId"],
  ),
  tool(
    "browser_reference",
    "Read or interact with the exact existing browserId explicitly referenced by the user in this conversation. Use a listed action such as snapshot, screenshot, get_text, eval or cdp. Both the short name and its agent_browser_* spelling are accepted (for example snapshot and agent_browser_snapshot). eval arguments: {script} for live DOM/computed styles/inline SVG/JS state. cdp arguments: {method, params?, sessionId?, captureEvents?, waitMs? (0-5000), maxEvents? (1-10000), output? (inline/file)}; use Page.getResourceTree then Page.getResourceContent {frameId,url} to read browser-held JS/CSS/SVG/logo/image/font files including cross-origin resources. Resource URLs belong inside params, not top-level arguments. Debugger.enable with captureEvents:[Debugger.scriptParsed] discovers JS scriptIds for Debugger.getScriptSource; CSS.enable with captureEvents:[CSS.styleSheetAdded] discovers styleSheetIds for CSS.getStyleSheetText (DOM.enable first). Target.setAutoAttach with params:{autoAttach:true}, captureEvents:[Target.attachedToTarget] discovers child iframe/worker sessionIds for use in subsequent CDP calls. Large CDP results return a complete temporary JSON file. Use snapshot first for ref-based interaction. No new tabs or URL substitution. Page state and snapshot refs stay bound to browserId. Selection references require selectionId and original-document validation.",
    {
      browserId: string,
      selectionId: string,
      action: { ...string, enum: BROWSER_REFERENCE_ACTION_VALUES },
      arguments: { type: "object", additionalProperties: true },
    },
    ["browserId", "action"],
    false,
  ),
];
export class ContextReferenceMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly secret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private starting: Promise<void> | undefined;
  constructor(private readonly service: ComposerReferenceService, private readonly multiAgents?: MultiAgentsService) {}
  async resolveInjection(threadId: string) {
    this.starting ??= this.start();
    await this.starting;
    return buildEcoHttpInjection({
      name: CONTEXT_MCP_SERVER,
      controlBaseUrl: `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`,
      controlSecretHeader: "X-Eco-Context-Secret",
      controlSecret: this.secret,
      authToken: this.auth.ensure(threadId).token,
      enabledTools: contextReferenceTools.map((item) => item.name),
    });
  }
  revokeThread(id: string) {
    this.auth.revokeThread(id);
  }
  disposeThread(id: string) {
    this.revokeThread(id);
    this.service.disposeThread(id);
  }
  async close() {
    if (this.server)
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
  }
  private async start() {
    this.server = http.createServer((request, response) => {
      void handleMcpStreamableHttpRequest(
        request,
        response,
        {
          serverName: CONTEXT_MCP_SERVER,
          instructions: CONTEXT_REFERENCE_PROMPT,
          listTools: async ({ authToken }) => {
            if (!this.auth.resolve(authToken)) throw new Error("缺少当前会话认证。");
            return { tools: contextReferenceTools };
          },
          callTool: async ({ name, arguments: args, authToken, signal }) => {
            try {
              const threadId = this.auth.resolve(authToken)?.threadId;
              if (!threadId) throw new Error("缺少当前会话认证。");
              const definition = contextReferenceTools.find((item) => item.name === name);
              if (!definition) throw new Error("未知引用工具。");
              const fields = definition.inputSchema!.properties as Record<string, unknown>;
              if (Object.keys(args).some((key) => !Object.hasOwn(fields, key)))
                throw new Error("工具参数包含不允许的字段。");
              if (name.startsWith("multi_agents_")) {
                if (!this.multiAgents) throw new Error("Multi-Agents 尚未初始化。");
                const result = await this.multiAgents.tool(threadId, name, args);
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
              }
              if (name === "browser_reference")
                return (await this.service.browserTool(threadId, args, signal)) as McpToolCallResult;
              if (name === "read_browser_selection")
                return await this.service.readBrowserSelection(threadId, args);
              if (["list_todos", "read_todo", "create_todo", "update_todo_status"].includes(name))
                return this.service.todoTool(threadId, name, args);
              const result =
                name === "read_plan"
                  ? this.service.readPlan(args)
                  : name === "read_conversation"
                  ? this.service.readConversation(args)
                  : name === "read_conversation_message"
                    ? this.service.readMessage(args)
                    : this.service.readTools(args);
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            } catch (error) {
              return {
                isError: true,
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              };
            }
          },
        },
        { controlSecretHeader: "x-eco-context-secret", controlSecret: this.secret },
      ).catch((error) => {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
  }
}
