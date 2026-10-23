import type { EcoCommandRisk, EcoDeviceCapability } from "./event-rpc";

export type RemoteCommandArgKind = "any" | "array" | "boolean" | "number" | "object" | "string";

export interface RemoteCommandArgSchema {
  kind: RemoteCommandArgKind;
  requiredKeys?: readonly string[];
  optional?: boolean;
}

export interface RemoteCommandDefinition {
  channel: string;
  title: string;
  risk: EcoCommandRisk;
  requiredCapabilities: readonly EcoDeviceCapability[];
  requiresConfirmation: boolean;
  auditAction: string;
  args: readonly RemoteCommandArgSchema[];
}

export interface RemoteCommandArgsValidation {
  ok: boolean;
  message?: string;
}

const RPC_INVOKE = ["rpc:invoke"] as const;
const APPROVAL_DECIDE = ["rpc:invoke", "approval:decide"] as const;

export const REMOTE_COMMAND_DEFINITIONS = [
  command("project-todo:list", "List project todos", "read", RPC_INVOKE, []),
  command("project-todo:get", "Get project todo", "read", RPC_INVOKE, [stringArg(), { kind: "boolean", optional: true }]),
  command("project-todo:image-read", "Read project todo image chunk", "read", RPC_INVOKE, [
    objectArg(["id", "revision", "imageId", "offset"]),
  ]),
  command("project-todo:save", "Save project todo", "write_safe", RPC_INVOKE, [
    objectArg(["projectPath", "text", "images", "completed"]),
  ]),
  command("project-todo:trash", "Delete or restore project todo", "write_safe", RPC_INVOKE, [
    objectArg(["id", "revision", "deleted"]),
  ]),
  command("scheduling:list", "List schedules", "read", RPC_INVOKE, []),
  command("scheduling:create", "Create schedule", "write_safe", RPC_INVOKE, [
    objectArg(["requestId", "kind", "name", "prompt", "trigger"]),
  ]),
  command("scheduling:update", "Update schedule", "write_safe", RPC_INVOKE, [
    objectArg(["id", "expectedRevision"]),
  ]),
  command("scheduling:delete", "Delete schedule", "write_safe", RPC_INVOKE, [stringArg()]),
  command("scheduling:run-now", "Run schedule now", "execute", RPC_INVOKE, [
    objectArg(["id", "requestId"]),
  ]),
  command("scheduling:preview", "Preview schedule", "read", RPC_INVOKE, [objectArg(["type"])]),
  command("thread:list", "List threads", "read", RPC_INVOKE, []),
  command("thread:list-initial", "List initial threads", "read", RPC_INVOKE, []),
  command("thread:list-more", "List more threads", "read", RPC_INVOKE, [
    objectArg(["workspacePath", "cursor"]),
  ]),
  command("thread:get", "Get thread", "read", RPC_INVOKE, [stringArg()]),
  command("composer-draft:get", "Get composer draft", "read", RPC_INVOKE, [stringArg()]),
  command("composer-draft:delete", "Delete composer draft", "write_safe", RPC_INVOKE, [
    objectArg(["contextKey", "expectedRevision"]),
  ]),
  command("prompt-image:upload-begin", "Begin chunked prompt image upload", "write_safe", RPC_INVOKE, [
    objectArg(["contextKey", "imageId", "mediaType", "totalBytes"]),
  ]),
  command("prompt-image:upload-chunk", "Append prompt image upload chunk", "write_safe", RPC_INVOKE, [
    objectArg(["contextKey", "imageId", "mediaType", "offset", "data"]),
  ]),
  command("prompt-image:upload-finish", "Finish chunked prompt image upload", "write_safe", RPC_INVOKE, [
    objectArg(["contextKey", "imageId", "mediaType", "totalBytes"]),
  ]),
  command("prompt-image:read-chunk", "Read a durable prompt image chunk", "read", RPC_INVOKE, [
    objectArg(["contextKey", "contentRef", "mediaType", "offset"]),
  ]),
  command("prompt-image:release", "Release staged prompt images", "write_safe", RPC_INVOKE, [
    objectArg(["paths"]),
  ]),
  command("thread:session-bootstrap", "Bootstrap thread session", "read", RPC_INVOKE, [stringArg()]),
  command("conversation:capabilities", "Get conversation V2 capabilities", "read", RPC_INVOKE, []),
  command("conversation:bootstrap", "Bootstrap conversation V2", "read", RPC_INVOKE, [
    objectArg(["conversationId"]),
  ]),
  command("conversation:projection", "Read Conversation V2 projection extras", "read", RPC_INVOKE, [
    objectArg(["conversationId"]),
  ]),
  command("conversation:messages-page", "Page conversation V2 messages", "read", RPC_INVOKE, [
    objectArg(["conversationId"]),
  ]),
  command("conversation:details-page", "Page conversation V2 details", "read", RPC_INVOKE, [
    objectArg(["conversationId", "runId"]),
  ]),
  command("conversation:tools-page", "Page conversation V2 tool summaries", "read", RPC_INVOKE, [
    objectArg(["conversationId", "runId"]),
  ]),
  command("conversation:sync", "Synchronize conversation V2 effects", "read", RPC_INVOKE, [
    objectArg(["conversationId", "storeEpoch", "afterSeq"]),
  ]),
  command("conversation:head", "Read conversation V2 head", "read", RPC_INVOKE, [stringArg()]),
  command("conversation:message-get", "Read a conversation V2 message", "read", RPC_INVOKE, [
    objectArg(["conversationId", "messageId"]),
  ]),
  command("conversation:run-get", "Read a conversation V2 run", "read", RPC_INVOKE, [
    objectArg(["conversationId", "runId"]),
  ]),
  command("conversation:detail-get", "Read a conversation V2 detail", "read", RPC_INVOKE, [
    objectArg(["conversationId", "itemId"]),
  ]),
  command("conversation:send-message", "Send a conversation V2 message", "execute", RPC_INVOKE, [
    objectArg(["principalId", "conversationId", "clientCommandId", "text"]),
  ]),
  command("thread:start", "Start thread", "execute", RPC_INVOKE, [
    objectArg(["workspacePath", "prompt", "runtimeConfig"]),
  ]),
  command("thread:retry-from-message", "Retry failed request from user message", "execute", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "prompt", "expectedHistoryRevision"]),
  ]),
  command("thread:user-message-edit-get", "Get user message edit state", "read", RPC_INVOKE, [
    objectArg(["threadId", "activityLineId"]),
  ]),
  command("thread:rewrite-from-message", "Rewrite thread from user message", "execute", RPC_INVOKE, [
    objectArg([
      "principalId",
      "clientCommandId",
      "threadId",
      "activityLineId",
      "prompt",
      "attachments",
      "expectedHistoryRevision",
    ]),
  ]),
  command(
    "thread:fork-from-message",
    "Fork an independent conversation from a user message",
    "execute",
    RPC_INVOKE,
    [objectArg(["principalId", "clientCommandId", "threadId", "activityLineId", "expectedHistoryRevision"])],
  ),
  command("thread:cancel", "Cancel thread", "execute", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "expectedHistoryRevision"]),
  ]),
  command("thread:delete", "Delete thread", "write_safe", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "expectedHistoryRevision"]),
  ]),
  command("thread:regenerate-title", "Regenerate thread title", "write_safe", RPC_INVOKE, [stringArg()]),
  command("thread:get-pending-plan", "Get pending plan", "read", RPC_INVOKE, [stringArg()]),
  command("thread:get-approved-plan", "Get approved plan", "read", RPC_INVOKE, [stringArg()]),
  command("thread:approve-plan", "Approve pending plan", "privileged", APPROVAL_DECIDE, [
    objectArg(["principalId", "clientCommandId", "threadId", "expectedHistoryRevision"]),
  ]),
  command("thread:dismiss-plan", "Dismiss pending plan", "privileged", APPROVAL_DECIDE, [
    objectArg(["principalId", "clientCommandId", "threadId", "expectedHistoryRevision"]),
  ]),
  command("thread:follow-up-list", "List follow-ups", "read", RPC_INVOKE, [stringArg()]),
  command("thread:follow-up-enqueue", "Enqueue follow-up", "execute", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "prompt", "expectedHistoryRevision"]),
  ]),
  command("thread:follow-up-cancel", "Cancel follow-up", "write_safe", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "followUpId", "expectedHistoryRevision"]),
  ]),
  command("thread:follow-up-escalate", "Escalate follow-up", "execute", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "expectedHistoryRevision"]),
  ]),
  command("thread:follow-up-editing", "Set follow-up editing lock", "write_safe", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "expectedHistoryRevision"]),
  ]),
  command("thread:follow-up-queue-paused", "Pause or resume follow-up queue", "write_safe", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "paused", "expectedHistoryRevision"]),
  ]),
  command("thread:follow-up-update", "Update follow-up", "write_safe", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "followUpId", "prompt", "expectedHistoryRevision"]),
  ]),
  command("thread:follow-up-reorder", "Reorder follow-ups", "write_safe", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "followUpIds", "expectedHistoryRevision"]),
  ]),
  command("thread:update-runtime-config", "Update thread runtime config", "write_safe", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "runtimeConfig", "expectedHistoryRevision"]),
  ]),
  command("bash-approval:get-pending", "Get pending bash approval", "read", RPC_INVOKE, [stringArg()]),
  command("bash-approval:resolve", "Resolve bash approval", "privileged", APPROVAL_DECIDE, [
    objectArg([
      "principalId",
      "clientCommandId",
      "threadId",
      "toolUseId",
      "decision",
      "expectedHistoryRevision",
    ]),
  ]),

  command("clarification:get-pending", "Get pending clarification", "read", RPC_INVOKE, [stringArg()]),
  command("clarification:submit", "Submit clarification", "write_safe", RPC_INVOKE, [
    objectArg([
      "principalId",
      "clientCommandId",
      "threadId",
      "toolUseId",
      "selections",
      "expectedHistoryRevision",
    ]),
  ]),
  command("clarification:dismiss", "Dismiss clarification", "write_safe", RPC_INVOKE, [
    objectArg(["principalId", "clientCommandId", "threadId", "toolUseId", "expectedHistoryRevision"]),
  ]),

  command("workspace:get-current", "Get current workspace", "read", RPC_INVOKE, []),
  command("workspace:get-home-path", "Get home project path", "read", RPC_INVOKE, []),
  command("workspace:get-user-home-path", "Get desktop user home path", "read", RPC_INVOKE, []),
  command("workspace:list-directories", "List workspace directories", "read", RPC_INVOKE, [stringArg()]),
  command("workspace:open-path", "Open workspace by path", "write_safe", RPC_INVOKE, [stringArg()]),
  command("workspace:inspect", "Inspect workspace", "read", RPC_INVOKE, [stringArg()]),
  command("workspace:list-package-scripts", "List npm scripts", "read", RPC_INVOKE, [stringArg()]),
  command("workspace:save-package-script-args", "Save npm script extra args", "write_safe", RPC_INVOKE, [
    objectArg(["workspacePath", "script", "args"]),
  ]),
  command("workspace:start-package-script", "Start npm script", "execute", RPC_INVOKE, [
    objectArg(["workspacePath", "script"]),
  ]),

  command("background-terminal:open", "Read background terminal task", "read", RPC_INVOKE, [
    objectArg(["taskId"]),
  ]),
  command("background-terminal:stop", "Stop background terminal task", "execute", RPC_INVOKE, [
    objectArg(["taskId"]),
  ]),

  command("model-settings:get", "Get model settings", "read", RPC_INVOKE, []),
  command("openai-accounts:list", "List Codex accounts and saved quotas", "read", RPC_INVOKE, []),
  command("openai-accounts:get-active", "Get active Codex account", "read", RPC_INVOKE, []),
  command("openai-accounts:query-quota", "Refresh Codex account quota", "read", RPC_INVOKE, [objectArg(["accountId"])]),
  command("openai-accounts:set-active", "Switch Codex account", "write_safe", RPC_INVOKE, [objectArg(["accountId"])]),
  command("openai-accounts:reset-quota", "Use a Codex quota reset credit", "execute", RPC_INVOKE, [objectArg(["accountId", "idempotencyKey"])]),
  command("settings:digest", "Get global settings content digest", "read", RPC_INVOKE, []),
  command("cursor:models-list", "List Cursor Agent CLI models", "read", RPC_INVOKE, []),
  command("candidate-model:list", "List candidate models", "read", RPC_INVOKE, [stringArg()]),
  command("mcp-settings:get", "Get MCP settings", "read", RPC_INVOKE, []),
  command("tts-read-aloud:status", "Get reading status", "read", RPC_INVOKE, []),
  command("tts-read-aloud:start", "Start reading", "execute", RPC_INVOKE, [objectArg(["requestId", "threadId", "entryId", "sourceText"])]),
  command("tts-read-aloud:segment", "Synthesize reading segment", "execute", RPC_INVOKE, [objectArg(["requestId", "index"])]),
  command("tts-read-aloud:read", "Read audio chunk", "read", RPC_INVOKE, [objectArg(["requestId", "index", "offset", "length"])]),
  command("tts-read-aloud:cancel", "Cancel reading", "write_safe", RPC_INVOKE, [objectArg(["requestId"])]),
  command("tts-artifacts:list", "List speech artifacts", "read", RPC_INVOKE, [objectArg(["threadId"])]),
  command("tts-artifact:read", "Read a speech artifact", "read", RPC_INVOKE, [objectArg(["artifactId", "audioIndex"])]),
  command("integration-availability:get", "Get integration availability", "read", RPC_INVOKE, []),
  command("skills:list", "List Skills", "read", RPC_INVOKE, [optionalStringArg()]),
  command("cursor-agents:list", "List Cursor ACP subagent definitions (read-only)", "read", RPC_INVOKE, [
    optionalStringArg(),
  ]),
  command("project-skills-settings:get", "Get project Skills settings", "read", RPC_INVOKE, [stringArg()]),
  command("project-skills-settings:save", "Save project Skills settings", "write_safe", RPC_INVOKE, [
    objectArg(["workspacePath", "enabledByPath"]),
  ]),
  command("project-integrations-settings:get", "Get project integrations settings", "read", RPC_INVOKE, [
    stringArg(),
  ]),
  command(
    "project-integrations-settings:save",
    "Save project integrations settings",
    "write_safe",
    RPC_INVOKE,
    [objectArg(["workspacePath", "enabled"])],
  ),
  command("project-orchestration-settings:get", "Get project orchestration settings", "read", RPC_INVOKE, [
    stringArg(),
  ]),
  command(
    "project-orchestration-settings:save",
    "Save project orchestration settings",
    "write_safe",
    RPC_INVOKE,
    [objectArg(["workspacePath", "orchestrationSelection"])],
  ),
  command("workflow-settings:get", "Get workflow settings", "read", RPC_INVOKE, []),
  command("workflow-settings:save", "Save workflow settings", "write_safe", RPC_INVOKE, [
    objectArg(["sessionMode"]),
  ]),
  command("asr-settings:get-status", "Get ASR settings status", "read", RPC_INVOKE, []),
  command("asr:transcribe", "Transcribe audio", "execute", RPC_INVOKE, [objectArg(["audioWavBase64"])]),
  command("image-view:read", "Read image for image view", "read", RPC_INVOKE, [objectArg(["path"])]),
  command("image-display:read", "Read image display artifact", "read", RPC_INVOKE, [
    // offset/length are optional chunking fields; requiredKeys only enforces presence of listed keys.
    objectArg(["artifactId"]),
  ]),
  command("image-display-artifacts:list", "List image display artifacts for a thread", "read", RPC_INVOKE, [
    objectArg(["threadId"]),
  ]),

  command("git:get-status", "Get git working tree status", "read", RPC_INVOKE, [stringArg()]),
  command("git:get-workspace-diff", "Get workspace diff", "read", RPC_INVOKE, [
    stringArg(),
    { ...objectArg([]), optional: true },
  ]),
  command("git:get-workspace-file-diff", "Get workspace file diff", "read", RPC_INVOKE, [
    objectArg(["workspacePath", "path"]),
  ]),
  command("git:checkout-branch", "Checkout git branch", "execute", RPC_INVOKE, [
    objectArg(["workspacePath", "branch"]),
  ]),
  command("git:create-branch", "Create git branch", "execute", RPC_INVOKE, [
    objectArg(["workspacePath", "branch"]),
  ]),
  command("git:generate-commit-message", "Generate commit message", "read", RPC_INVOKE, [
    objectArg(["workspacePath", "includeUnstaged"]),
  ]),
  command("git:list-commit-model-options", "List commit message model options", "read", RPC_INVOKE, [
    objectArg([]),
  ]),
  command("approval:list-model-options", "List approval model options", "read", RPC_INVOKE, [objectArg([])]),
  command(
    "git:save-commit-model-preference",
    "Save commit message model preference",
    "write_safe",
    RPC_INVOKE,
    [objectArg(["candidateModelId"])],
  ),
  command("git:commit", "Commit workspace changes", "execute", RPC_INVOKE, [
    objectArg(["workspacePath", "includeUnstaged"]),
  ]),
  command("git:push", "Push commits to remote", "execute", RPC_INVOKE, [objectArg(["workspacePath"])]),
  command("git:fetch", "Fetch from remote", "execute", RPC_INVOKE, [objectArg(["workspacePath"])]),
  command("git:pull", "Pull from remote", "execute", RPC_INVOKE, [objectArg(["workspacePath"])]),
] as const satisfies readonly RemoteCommandDefinition[];

const REMOTE_COMMANDS_BY_CHANNEL = new Map(
  REMOTE_COMMAND_DEFINITIONS.map((definition) => [definition.channel, definition]),
);

export function listRemoteCommandDefinitions(): readonly RemoteCommandDefinition[] {
  return REMOTE_COMMAND_DEFINITIONS;
}

export function getRemoteCommandDefinition(channel: string): RemoteCommandDefinition | undefined {
  return REMOTE_COMMANDS_BY_CHANNEL.get(channel);
}

export function isRemoteCommandChannel(channel: string): boolean {
  return REMOTE_COMMANDS_BY_CHANNEL.has(channel);
}

export function validateRemoteCommandArgs(
  channel: string,
  args: unknown[] | undefined,
): RemoteCommandArgsValidation {
  const definition = getRemoteCommandDefinition(channel);
  if (!definition) {
    return { ok: false, message: `Remote command is not registered: ${channel}` };
  }
  const actualArgs = args ?? [];
  const requiredArgCount = definition.args.filter((arg) => !arg.optional).length;
  const maxArgCount = definition.args.length;
  if (actualArgs.length < requiredArgCount || actualArgs.length > maxArgCount) {
    const expected =
      requiredArgCount === maxArgCount ? `${requiredArgCount}` : `${requiredArgCount} to ${maxArgCount}`;
    return {
      ok: false,
      message: `Remote command ${channel} expects ${expected} args, got ${actualArgs.length}.`,
    };
  }
  for (const [index, schema] of definition.args.entries()) {
    if (index >= actualArgs.length) {
      continue;
    }
    const value = actualArgs[index];
    if (!matchesArgSchema(value, schema)) {
      return {
        ok: false,
        message: `Remote command ${channel} arg ${index + 1} must be ${schema.kind}.`,
      };
    }
    if (schema.kind === "object" && schema.requiredKeys) {
      const record = value as Record<string, unknown>;
      const missingKey = schema.requiredKeys.find((key) => !(key in record));
      if (missingKey) {
        return {
          ok: false,
          message: `Remote command ${channel} arg ${index + 1} is missing ${missingKey}.`,
        };
      }
    }
  }
  return { ok: true };
}

function command(
  channel: string,
  title: string,
  risk: EcoCommandRisk,
  requiredCapabilities: readonly EcoDeviceCapability[],
  args: readonly RemoteCommandArgSchema[],
): RemoteCommandDefinition {
  return {
    channel,
    title,
    risk,
    requiredCapabilities,
    requiresConfirmation: risk === "privileged",
    auditAction: channel.replace(/[:_-]+/g, "."),
    args,
  };
}

function stringArg(): RemoteCommandArgSchema {
  return { kind: "string" };
}

function optionalStringArg(): RemoteCommandArgSchema {
  return { kind: "string", optional: true };
}

function objectArg(requiredKeys: readonly string[]): RemoteCommandArgSchema {
  return { kind: "object", requiredKeys };
}

function matchesArgSchema(value: unknown, schema: RemoteCommandArgSchema): boolean {
  switch (schema.kind) {
    case "any":
      return true;
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "string":
      return typeof value === "string";
  }
}
