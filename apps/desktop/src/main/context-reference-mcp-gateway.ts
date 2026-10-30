import http from "node:http";
import type { AddressInfo } from "node:net";
import { CONTEXT_MCP_SERVER, CONTEXT_REFERENCE_PROMPT } from "../shared/composer-references";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import type { ComposerReferenceService } from "./composer-reference-service";
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
    "Read or interact with the exact existing browserId explicitly referenced by the user in this conversation. action is an agent_browser_* tool (snapshot, read, click, fill, type, press, check, uncheck, select, scroll, get_text, get_url, get_title, screenshot, wait_for_selector/text/load, reload, back, forward). Use snapshot first. No new tabs or URL substitution. Page state and snapshot refs stay bound to browserId.",
    {
      browserId: string,
      selectionId: string,
      action: string,
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
  constructor(private readonly service: ComposerReferenceService) {}
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
              if (name === "browser_reference")
                return (await this.service.browserTool(threadId, args, signal)) as McpToolCallResult;
              if (name === "read_browser_selection")
                return await this.service.readBrowserSelection(threadId, args);
              if (["list_todos", "read_todo", "create_todo", "update_todo_status"].includes(name))
                return this.service.todoTool(threadId, name, args);
              const result =
                name === "read_conversation"
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
