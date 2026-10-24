export interface OpenAIAccountProfile {
  email?: string;
  password?: string;
  pickupUrl?: string;
  twoFactorSecret?: string;
}

export type OpenAIAccountProxyMode = "system" | "direct" | "manual";

export interface OpenAIAccountCreateInput extends OpenAIAccountProfile {
  name: string;
  proxyMode?: OpenAIAccountProxyMode;
  proxyUrl?: string;
}

export interface OpenAIAccountUpdateInput extends OpenAIAccountProfile {
  accountId: string;
  name: string;
  proxyMode?: OpenAIAccountProxyMode;
  proxyUrl?: string;
}

export interface OpenAIAccountProxyConfig {
  mode: OpenAIAccountProxyMode;
  proxyUrl?: string;
}

export interface OpenAIAccountQuotaWindow {
  usedPercent: number;
  limitWindowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
}

export interface OpenAIAccountQuota {
  planType: string;
  email: string;
  rateLimit: {
    allowed: boolean;
    limitReached: boolean;
    primaryWindow: OpenAIAccountQuotaWindow | null;
    secondaryWindow: OpenAIAccountQuotaWindow | null;
  };
  resetCreditsAvailable: number;
  /** Time of the last successful quota refresh, in Unix milliseconds. */
  fetchedAt: number;
}

export type CodexQuotaResetOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";

export interface OpenAIAccountWakeResult {
  reply: string;
  /** A greeting succeeded even if the subsequent quota refresh failed. */
  quotaError?: string;
}

/** The image_gen balance queried by chatgpt2api, not a verified Codex-only balance. */
export interface OpenAIAccountImageQuota {
  source: "chatgpt_image_gen";
  status: "available" | "error";
  fetchedAt: number;
  remaining?: number;
  resetAt?: string;
  error?: string;
}

export interface OpenAIAccount {
  imageGenerationEnabled?: boolean;
  imageQuota?: OpenAIAccountImageQuota;
  id: string;
  name: string;
  email?: string;
  proxyMode: OpenAIAccountProxyMode;
  proxyUrl?: string;
  /** Whether this account has usable, non-expired Codex credentials. */
  isLoggedIn: boolean;
  authState: "missing" | "configured" | "expired";
  lastLogin?: string;
  createdAt: string;
  /** The list API exposes profile presence, not the profile secrets themselves. */
  hasProfileData: boolean;
  profileFields?: { email: boolean; password: boolean; pickupUrl: boolean; twoFactorSecret: boolean };
  quota?: OpenAIAccountQuota;
}

export interface OpenAIAccountAssistantState {
  accountId: string;
  name: string;
  email?: string;
  hasPassword: boolean;
  hasPickupUrl: boolean;
  pickupHost?: string;
  hasTwoFactorSecret: boolean;
  code?: string;
  remainingSeconds?: number;
  /** Seconds remaining before the active Codex OAuth login expires. */
  loginRemainingSeconds?: number;
  codeError?: string;
  canFill: boolean;
  hasLoginWindow: boolean;
  pinned: boolean;
}

export type OpenAIAccountAssistantAction =
  | { type: "copy" | "fill"; field: "email" | "password" | "code" }
  | { type: "openPickup" }
  | { type: "togglePin" }
  | { type: "revealPassword" };

export interface OpenAIAccountAssistantActionResult {
  message: string;
  value?: string;
}

export interface OpenAIAccountDetails extends OpenAIAccountProfile {
  imageGenerationEnabled?: boolean;
  imageQuota?: OpenAIAccountImageQuota;
  id: string;
  name: string;
  proxyMode: OpenAIAccountProxyMode;
  proxyUrl?: string;
  createdAt: string;
  updatedAt: string;
  authJson: string | null;
  quota?: OpenAIAccountQuota;
}

export interface OpenAIAccountSyncStatus {
  state: "ok" | "error" | "conflict";
  message?: string;
  updatedAt?: string;
}

export interface OpenAIAccountImportResult {
  added: number;
  updated: number;
}
