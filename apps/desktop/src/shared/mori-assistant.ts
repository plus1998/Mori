import type { ConversationMessage } from "@eco/shared";
import type { ComputerUseActionApprovalMode } from "./computer-use";
import type { ThreadSummary } from "./ipc";
import type { OpenAIAccount } from "./openai-account";

export interface MoriAssistantSettings {
  enabled: boolean;
  name: string;
  instructions: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  accountIds: string[];
  autoSwitchAccounts: boolean;
  floatingEnabled: boolean;
  petKey: string;
  petSizes: Record<string, number>;
  backgroundEnabled: boolean;
  shortcut: string;
  wechatEnabled: boolean;
}

export interface MoriAssistantSession {
  threadId: string;
  title: string;
  createdAt: string;
}

export interface MoriAssistantState {
  version: 1;
  settings: MoriAssistantSettings;
  sessions: MoriAssistantSession[];
  currentThreadId?: string;
  draft: string;
  taskIds: string[];
  taskOrigins?: Record<string, { channel: "desktop" | "wechat"; messageId?: string }>;
  sourceByMessage: Record<string, "desktop" | "wechat" | "task">;
  ballPosition?: { x: number; y: number };
}

export interface MoriAssistantPendingInput {
  id: string;
  kind: "question" | "approval";
  title: string;
  detail?: string;
  questions?: Array<{
    id: string;
    header: string;
    question: string;
    options?: Array<{ label: string; description: string }>;
  }>;
}

export interface MoriComputerUseStatus {
  enabled: boolean;
  available: boolean;
  reason?: string;
  actionApprovalMode: ComputerUseActionApprovalMode;
}

export interface MoriAssistantSnapshot {
  settings: MoriAssistantSettings;
  sessions: MoriAssistantSession[];
  currentThreadId?: string;
  draft: string;
  messages: ConversationMessage[];
  hasMoreMessages: boolean;
  messageCursor?: string;
  sourceByMessage: MoriAssistantState["sourceByMessage"];
  status: "idle" | "running" | "waiting" | "error";
  hasRunningTasks: boolean;
  hasPendingTasks: boolean;
  accountId?: string;
  error?: string;
  activity?: string;
  pendingInput?: MoriAssistantPendingInput;
  accounts: OpenAIAccount[];
  models: Array<{ id: string; label: string }>;
  projects: string[];
  tasks: ThreadSummary[];
  computerUse: MoriComputerUseStatus;
  wechat: {
    status: "disconnected" | "waiting" | "connected" | "error";
    qrContent?: string;
    error?: string;
    feedbackError?: string;
  };
}

export const MORI_ASSISTANT_CHANNELS = {
  snapshot: "mori-assistant:snapshot",
  saveSettings: "mori-assistant:save-settings",
  send: "mori-assistant:send",
  cancel: "mori-assistant:cancel",
  draft: "mori-assistant:draft",
  newSession: "mori-assistant:new-session",
  selectSession: "mori-assistant:select-session",
  respond: "mori-assistant:respond",
  floating: "mori-assistant:floating",
  toggleFloating: "mori-assistant:toggle-floating",
  show: "mori-assistant:show",
  openTask: "mori-assistant:open-task",
  changed: "mori-assistant:changed",
  openRequested: "mori-assistant:open-requested",
  projectOpenRequested: "mori-assistant:project-open-requested",
  wechatBind: "mori-assistant:wechat-bind",
  wechatDisconnect: "mori-assistant:wechat-disconnect",
  ballMove: "mori-assistant:ball-move",
  noticeGet: "mori-assistant:notice-get",
  noticeOpen: "mori-assistant:notice-open",
  petList: "mori-assistant:pet-list",
  petImport: "mori-assistant:pet-import",
  petAsset: "mori-assistant:pet-asset",
  petLook: "mori-assistant:pet-look",
  petReaction: "mori-assistant:pet-reaction",
} as const;

export const DEFAULT_MORI_ASSISTANT_SETTINGS: MoriAssistantSettings = {
  enabled: false,
  name: "Mori",
  instructions: "使用中文，简洁清楚地回答。需要操作桌面端时使用提供的工具；只有工具执行成功后才能确认完成。",
  model: "gpt-6-luna",
  reasoningEffort: "high",
  accountIds: [],
  autoSwitchAccounts: false,
  floatingEnabled: false,
  petKey: "",
  petSizes: {},
  backgroundEnabled: false,
  shortcut: "CommandOrControl+Shift+M",
  wechatEnabled: false,
};

export const MORI_PET_SIZE_MIN = 48;
export const MORI_PET_SIZE_MAX = 192;
export const MORI_PET_SIZE_DEFAULT = 64;

export function moriPetSize(settings: Pick<MoriAssistantSettings, "petKey" | "petSizes">): number {
  return settings.petSizes[settings.petKey || "builtin:mori"] ?? MORI_PET_SIZE_DEFAULT;
}
