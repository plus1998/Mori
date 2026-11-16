import type { OpenAIAccount, OpenAIAccountQuota } from "./openai-account";

export interface SharedCodexTokens {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string;
  expiresAt: number;
  version: string;
}

export interface CodexAccountShare {
  id: string;
  ownerDeviceId: string;
  recipientDeviceId: string;
  accountId: string;
  accountName: string;
  chatgptAccountId: string;
  grantEpoch: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface CodexSharingDevice {
  id: string;
  name: string;
  online: boolean;
}

export interface CodexSharingSnapshot {
  connected: boolean;
  deviceId: string | null;
  deviceName: string;
  devices: CodexSharingDevice[];
  shares: CodexAccountShare[];
  error?: string;
}

export interface SharedCodexAccountSource {
  shareId: string;
  ownerDeviceId: string;
  ownerDeviceName: string;
  online: boolean;
  state: "ready" | "offline" | "requesting" | "reauthorization_required" | "revoked" | "error";
  expiresAt?: number;
  error?: string;
}

export interface SharedCodexAccountProvider {
  listAccounts(): OpenAIAccount[];
  sharedDeviceCount?(accountId: string): number;
  getTokens(accountId: string, previousAccessToken?: string): Promise<SharedCodexTokens>;
  queryQuota(accountId: string): Promise<OpenAIAccountQuota>;
}

export const sharedCodexAccountId = (shareId: string): string => `oa_shared_${shareId.replaceAll("-", "")}`;
export const isSharedCodexAccountId = (id: string): boolean => /^oa_shared_[0-9a-f]{32}$/.test(id);
