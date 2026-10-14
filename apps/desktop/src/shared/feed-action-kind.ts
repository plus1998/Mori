import { isEcoTtsToolName } from "./tts";
import { ecoAgentBrowserToolSuffix, hasNamedAgentBrowserLabel, isEcoAgentBrowserToolName } from "./browser";
import { isEcoComputerUseToolName } from "./computer-use";
import { isEcoHtmlHostToolName } from "./html-host-tool";
import { isEcoImageDisplayToolName } from "./image-display-tool";
import { isEcoImageGenerationToolName } from "./image-generation";
import { isEcoImageViewToolName } from "./image-view-tool";
import { isEcoWebSearchToolName } from "./integrated-web-search";

export type ActivityActionIcon =
  | "search"
  | "file"
  | "read"
  | "image"
  | "images"
  | "audio"
  | "browser"
  | "edit"
  | "terminal"
  | "agent"
  | "context"
  | "network"
  | "computer"
  | "code"
  | "tool";

export type ActionKind =
  | "read"
  | "write"
  | "edit"
  | "search"
  | "webSearch"
  | "webFetch"
  | "command"
  | "agent"
  | "taskCreate"
  | "taskUpdate"
  | "skill"
  | "mcp"
  | "mcpSearch"
  | "imageView"
  | "imageDisplay"
  | "htmlHost"
  | "imageCreate"
  | "speechCreate"
  | "browser"
  | "computerUse"
  | "codemode"
  | "tool";

export type ActionGroupBucket =
  | "readFiles"
  | "writtenFiles"
  | "editedFiles"
  | "searches"
  | "web"
  | "commands"
  | "taskCreates"
  | "taskUpdates"
  | "agents"
  | "skills"
  | "mcpTools"
  | "images"
  | "speech"
  | "browser"
  | "computerUse"
  | "scripts"
  | "otherTools";

export interface ActionKindPayload {
  fileChange?: { path?: string; fileName?: string };
  readTarget?: { filePath?: string; fileName?: string; lineRange?: string };
  grepTarget?: { path?: string; pattern?: string };
  webSearch?: { mode?: "search" | "fetch"; query?: string; url?: string };
  mcpDiscovery?: { kind?: "search" };
  imageView?: { path?: string };
  imageDisplay?: { artifactId?: string };
  htmlHost?: { pageId?: string; publicUrl?: string; title?: string };
  bashRun?: { command?: string };
  /** PI `codemode`: a script the model wrote; its nested calls are not model-issued calls. */
  codemodeRun?: { script?: string };
}

export interface ResolvedAction {
  kind: ActionKind;
  icon: ActivityActionIcon;
  bucket: ActionGroupBucket;
  /** 浏览器等专名 key 的 suffix，如 `agent_browser_open` */
  namedSuffix?: string;
  /** Real MCP identity, after the runtime unwraps Hub/proxy calls. */
  mcpTool?: { serverName: string; toolName: string };
}

const ALIASES: Record<string, ActionKind> = {
  read: "read",
  notebookread: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  grep: "search",
  glob: "search",
  find: "search",
  ls: "search",
  websearch: "webSearch",
  webfetch: "webFetch",
  bash: "command",
  shell: "command",
  cmd: "command",
  powershell: "command",
  agent: "agent",
  task: "agent",
  tasklist: "tool",
  taskget: "tool",
  taskoutput: "agent",
  taskcreate: "taskCreate",
  taskupdate: "taskUpdate",
  todowrite: "taskUpdate",
  codemode: "codemode",
  skill: "skill",
  skills: "skill",
  readskill: "skill",
  mcp: "mcp",
  mcp_tool: "mcp",
  mcpscript: "mcp",
  viewimage: "imageView",
  view_image: "imageView",
  displayimage: "imageDisplay",
  display_image: "imageDisplay",
  publishhtml: "htmlHost",
  publish_html: "htmlHost",
};

const KIND_ICON: Record<ActionKind, ActivityActionIcon> = {
  read: "read",
  write: "edit",
  edit: "edit",
  search: "search",
  webSearch: "network",
  webFetch: "network",
  command: "terminal",
  agent: "agent",
  taskCreate: "edit",
  taskUpdate: "edit",
  skill: "file",
  mcp: "network",
  mcpSearch: "network",
  imageView: "images",
  imageDisplay: "images",
  htmlHost: "browser",
  imageCreate: "image",
  speechCreate: "audio",
  browser: "browser",
  computerUse: "computer",
  codemode: "code",
  tool: "tool",
};

const KIND_BUCKET: Record<ActionKind, ActionGroupBucket> = {
  read: "readFiles",
  write: "writtenFiles",
  edit: "editedFiles",
  search: "searches",
  webSearch: "web",
  webFetch: "web",
  command: "commands",
  agent: "agents",
  taskCreate: "taskCreates",
  taskUpdate: "taskUpdates",
  skill: "skills",
  mcp: "mcpTools",
  mcpSearch: "mcpTools",
  imageView: "images",
  imageDisplay: "images",
  htmlHost: "browser",
  imageCreate: "images",
  speechCreate: "speech",
  browser: "browser",
  computerUse: "computerUse",
  codemode: "scripts",
  tool: "otherTools",
};

function resolved(kind: ActionKind, namedSuffix?: string): ResolvedAction {
  return {
    kind,
    icon: KIND_ICON[kind],
    bucket: KIND_BUCKET[kind],
    ...(namedSuffix ? { namedSuffix } : {}),
  };
}

function kindFromPayload(payload: ActionKindPayload | undefined): ActionKind | undefined {
  if (!payload) {
    return undefined;
  }
  if (payload.fileChange) {
    return "edit";
  }
  if (payload.readTarget) {
    return "read";
  }
  if (payload.grepTarget) {
    return "search";
  }
  if (payload.webSearch) {
    return payload.webSearch.mode === "fetch" ? "webFetch" : "webSearch";
  }
  if (payload.imageView) {
    return "imageView";
  }
  if (payload.imageDisplay) {
    return "imageDisplay";
  }
  if (payload.htmlHost) {
    return "htmlHost";
  }
  if (payload.bashRun) {
    return "command";
  }
  if (payload.codemodeRun) {
    return "codemode";
  }
  return undefined;
}

export function resolveActionKind(input: { toolName?: string; payload?: ActionKindPayload }): ResolvedAction {
  const toolName = input.toolName ?? "";
  const name = toolName.trim().toLowerCase();

  if (input.payload?.mcpDiscovery?.kind === "search") {
    return resolved("mcpSearch");
  }

  const aliasKind = name ? ALIASES[name] : undefined;
  if (aliasKind) {
    if (aliasKind === "webSearch" && input.payload?.webSearch?.mode === "fetch") {
      return resolved("webFetch");
    }
    return resolved(aliasKind);
  }

  const payloadKind = kindFromPayload(input.payload);
  if (payloadKind) {
    return resolved(payloadKind);
  }

  if (isEcoAgentBrowserToolName(toolName)) {
    return resolved("browser", ecoAgentBrowserToolSuffix(toolName));
  }
  if (isEcoComputerUseToolName(toolName)) {
    return resolved("computerUse");
  }
  if (isEcoTtsToolName(toolName)) return resolved("speechCreate");
  if (isEcoImageGenerationToolName(toolName)) {
    return resolved("imageCreate");
  }
  if (isEcoImageViewToolName(toolName)) {
    return resolved("imageView");
  }
  if (isEcoImageDisplayToolName(toolName)) {
    return resolved("imageDisplay");
  }
  if (isEcoHtmlHostToolName(toolName)) {
    return resolved("htmlHost");
  }
  if (isEcoWebSearchToolName(toolName)) {
    return resolved("webSearch");
  }

  if (name.startsWith("mcp__")) {
    const match = toolName.trim().match(/^mcp__(.+?)__(.+)$/i);
    return {
      ...resolved("mcp"),
      ...(match?.[1] && match[2]
        ? { mcpTool: { serverName: match[1], toolName: match[2] } }
        : {}),
    };
  }

  if (name.includes("skill")) {
    return resolved("skill");
  }

  return resolved("tool");
}

export type ActionKindTranslate = (key: string, vars?: Record<string, string | number>) => string;

export const ACTION_GROUP_ICON_PRIORITY: readonly ActivityActionIcon[] = [
  "edit",
  "read",
  "file",
  "search",
  "network",
  "terminal",
  "code",
  "browser",
  "computer",
  "images",
  "image",
  "audio",
  "agent",
  "tool",
];

const SUMMARY_BUCKET_ORDER: readonly ActionGroupBucket[] = [
  "readFiles",
  "writtenFiles",
  "editedFiles",
  "searches",
  "web",
  "commands",
  "scripts",
  "taskCreates",
  "taskUpdates",
  "agents",
  "skills",
  "mcpTools",
  "images",
  "speech",
  "browser",
  "computerUse",
  "otherTools",
];

const SUMMARY_I18N_KEY: Record<ActionGroupBucket, string> = {
  readFiles: "activity.summary.readFiles",
  writtenFiles: "activity.summary.writtenFiles",
  editedFiles: "activity.summary.editedFiles",
  searches: "activity.summary.searched",
  web: "activity.summary.web",
  commands: "activity.summary.commands",
  taskCreates: "activity.summary.createdTasks",
  taskUpdates: "activity.summary.updatedTasks",
  agents: "activity.summary.agents",
  skills: "activity.summary.skills",
  mcpTools: "activity.summary.mcpTools",
  images: "activity.summary.images",
  speech: "activity.summary.speech",
  browser: "activity.summary.browser",
  computerUse: "activity.summary.computerUse",
  scripts: "activity.summary.scripts",
  otherTools: "activity.summary.tools",
};

function clamp64(value: string): string {
  return value.length <= 64 ? value : value.slice(0, 64);
}

function hostFromUrl(value: string): string {
  try {
    const host = new URL(value).host;
    if (host) {
      return host;
    }
  } catch {
    // invalid URL — fall through and clamp the original string
  }
  return value;
}

export function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

export function resolveActionTarget(
  resolved: ResolvedAction,
  input: { payload?: ActionKindPayload; rawTarget?: string },
): string | undefined {
  const payload = input.payload;
  const raw = input.rawTarget?.trim() || undefined;

  switch (resolved.kind) {
    case "read": {
      const path = payload?.readTarget?.fileName || payload?.readTarget?.filePath || raw;
      if (!path) {
        return undefined;
      }
      const name = fileNameFromPath(path);
      const range = payload?.readTarget?.lineRange?.trim();
      return range ? `${name} ${range}` : name;
    }
    case "write":
    case "edit": {
      const path = payload?.fileChange?.fileName || payload?.fileChange?.path || raw;
      return path ? fileNameFromPath(path) : undefined;
    }
    case "search": {
      return payload?.grepTarget?.pattern || payload?.grepTarget?.path || raw;
    }
    case "webSearch": {
      return payload?.webSearch?.query || raw;
    }
    case "webFetch": {
      const value = payload?.webSearch?.url || raw;
      return value ? hostFromUrl(value) : undefined;
    }
    case "command": {
      return payload?.bashRun?.command || raw;
    }
    case "browser": {
      if (resolved.namedSuffix === "agent_browser_open" || resolved.namedSuffix === "agent_browser_get_url") {
        const value = payload?.webSearch?.url || raw;
        return value ? hostFromUrl(value) : undefined;
      }
      return undefined;
    }
    case "agent":
    case "skill":
    case "mcp":
    case "taskCreate":
    case "taskUpdate":
    case "tool": {
      return raw;
    }
    default:
      return undefined;
  }
}

export function formatActionLine(
  input: {
    resolved: ResolvedAction;
    phase: "running" | "done";
    rawTarget?: string;
    payload?: ActionKindPayload;
  },
  t: ActionKindTranslate,
): string {
  const { resolved, phase } = input;
  const { kind } = resolved;

  if (kind === "imageView") {
    return t(phase === "running" ? "activity.imageView.viewing" : "activity.imageView.viewed");
  }
  if (kind === "imageDisplay") {
    return t(phase === "running" ? "activity.imageDisplay.viewing" : "activity.imageDisplay.viewed");
  }
  if (kind === "htmlHost") {
    return t(phase === "running" ? "activity.htmlHost.publishing" : "activity.htmlHost.published");
  }
  if (kind === "speechCreate") return t(phase === "running" ? "activity.running.speechCreate" : "activity.done.speechCreate");
  if (kind === "imageCreate") {
    return t(phase === "running" ? "activity.running.imageCreate" : "activity.done.imageCreate");
  }
  if (kind === "computerUse") {
    return t(phase === "running" ? "activity.running.computerUse" : "activity.done.computerUse");
  }
  if (kind === "mcpSearch") {
    return t(phase === "running" ? "activity.running.mcpSearch" : "activity.done.mcpSearch");
  }
  if (kind === "mcp" && resolved.mcpTool) {
    const { serverName, toolName } = resolved.mcpTool;
    return t(`activity.${phase}.mcpNamed`, {
      name: serverName,
      suffix: ` · ${clamp64(toolName.replaceAll("_", " "))}`,
    });
  }
  if (kind === "browser") {
    const target = resolveActionTarget(resolved, input);
    const usesHostLine =
      (resolved.namedSuffix === "agent_browser_open" || resolved.namedSuffix === "agent_browser_get_url") &&
      Boolean(target);
    if (usesHostLine && target) {
      const suffix = ` ${clamp64(target)}`;
      return t(phase === "running" ? "activity.running.browserOpen" : "activity.done.browserOpen", {
        suffix,
      });
    }
    if (resolved.namedSuffix) {
      // Only the tool names the catalogs know get their own label; an unlisted one
      // (a new browser tool, for example) must not render the raw i18n key.
      return hasNamedAgentBrowserLabel(resolved.namedSuffix)
        ? t(`activity.named.${resolved.namedSuffix}`)
        : t("activity.named.browser");
    }
    return t("activity.done.tool.fallback");
  }

  const target = resolveActionTarget(resolved, input);
  if (target) {
    return t(`activity.${phase}.${kind}`, { suffix: ` ${clamp64(target)}` });
  }
  if (phase === "done") {
    return t(`activity.done.${kind}.fallback`);
  }
  return t(`activity.running.${kind}`, { suffix: "" });
}

export function summarizeActionGroup(
  items: readonly ResolvedAction[],
  t: ActionKindTranslate,
): { label: string; icon: ActivityActionIcon } {
  const clauses: string[] = [];
  for (const bucket of SUMMARY_BUCKET_ORDER) {
    const bucketItems = items.filter((item) => item.bucket === bucket);
    if (bucket === "mcpTools") {
      const servers = new Map<string, number>();
      let anonymousCount = 0;
      for (const item of bucketItems) {
        const server = item.mcpTool?.serverName;
        if (server) {
          servers.set(server, (servers.get(server) ?? 0) + 1);
        } else {
          anonymousCount += 1;
        }
      }
      for (const [name, count] of servers) {
        clauses.push(t("activity.summary.mcpNamed", { name, count }));
      }
      if (anonymousCount > 0) {
        clauses.push(t(SUMMARY_I18N_KEY[bucket], { count: anonymousCount }));
      }
    } else if (bucketItems.length > 0) {
      clauses.push(t(SUMMARY_I18N_KEY[bucket], { count: bucketItems.length }));
    }
  }

  let label = clauses[0] ?? "";
  if (clauses.length === 2) {
    label = t("activity.joinTwo", { first: clauses[0] ?? "", second: clauses[1] ?? "" });
  } else if (clauses.length > 2) {
    label = t("activity.joinMany", {
      head: clauses.slice(0, -1).join(t("activity.joinSeparator")),
      last: clauses[clauses.length - 1] ?? "",
    });
  }

  let icon: ActivityActionIcon = "tool";
  for (const candidate of ACTION_GROUP_ICON_PRIORITY) {
    if (items.some((item) => item.icon === candidate)) {
      icon = candidate;
      break;
    }
  }

  return { label, icon };
}
