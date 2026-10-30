import type { HtmlHostingCapability } from "./html-host";

export type { HtmlHostingCapability } from "./html-host";

export type CenterServerConnectionState = "disabled" | "disconnected" | "connecting" | "connected" | "error";

export interface CenterServerConnectionStatus {
  state: CenterServerConnectionState;
  connectedAt?: string;
  lastDisconnectedAt?: string;
  lastError?: string;
  lastPresenceChangedAt?: string;
}

export interface CenterServerSettingsView {
  enabled: boolean;
  /**
   * Supabase project URL. Prefer this over serverUrl.
   * serverUrl is kept in sync for migration / display compatibility.
   */
  supabaseUrl: string;
  /** @deprecated Alias of supabaseUrl; kept for gradual migration away from Center Server. */
  serverUrl: string;
  hasAnonKey: boolean;
  anonKeyPreview?: string;
  deviceId?: string;
  deviceName: string;
  hasDeviceSecret: boolean;
  deviceSecretPreview?: string;
  hasRefreshToken: boolean;
  /** Local vault_key present (required to decrypt synced API keys). */
  hasVaultKey: boolean;
  accessTokenExpiresAt?: string;
  lastConnectedAt?: string;
  lastSettingsSyncedAt?: string;
  lastError?: string;
}

export interface CenterServerSettingsInput {
  enabled: boolean;
  /** Preferred project URL field. */
  supabaseUrl?: string;
  /**
   * @deprecated Prefer supabaseUrl. If supabaseUrl is empty, serverUrl is used.
   */
  serverUrl?: string;
  /** Empty string keeps the stored anon key. */
  anonKey?: string;
  deviceId?: string;
  deviceName?: string;
  /** Empty string keeps the stored secret. */
  deviceSecret?: string;
  /** Empty string keeps the stored refresh token. */
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
}

export interface CenterServerSettingsSnapshot {
  settings: CenterServerSettingsView;
  status: CenterServerConnectionStatus;
  /** HTML Artifacts hosting probe status (availability + optional render risk). */
  htmlHosting?: HtmlHostingCapability;
}

export interface CenterServerRegisterDesktopRequest {
  supabaseUrl: string;
  anonKey: string;
  userAccessToken: string;
  /** Required for session renewal after token-only device registration. */
  refreshToken?: string;
  deviceName: string;
  /** @deprecated Prefer supabaseUrl. */
  serverUrl?: string;
}

export interface CenterServerDeviceMetadataView {
  model?: string;
  ipAddress?: string;
  platform?: string;
  hostname?: string;
}

export interface CenterServerDeviceView {
  id: string;
  userId: string;
  kind: "desktop" | "mobile";
  name: string;
  metadata?: CenterServerDeviceMetadataView;
  createdAt: string;
  lastSeenAt: string | null;
  disabledAt: string | null;
}

export interface CenterServerRegisterDesktopResult {
  settings: CenterServerSettingsView;
  status: CenterServerConnectionStatus;
  device: CenterServerDeviceView;
}

export interface CenterServerAccountView {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface CenterServerSignUpRequest {
  supabaseUrl: string;
  /** Optional when anon key was already saved for this project URL. */
  anonKey?: string;
  email: string;
  password: string;
  deviceName: string;
  displayName?: string;
  /** @deprecated Prefer supabaseUrl. */
  serverUrl?: string;
}

/**
 * Build the Auth email-confirmation redirect for a given Supabase project URL.
 * Hosted as Edge Function `auth-email-confirmed` (no JWT).
 */
export function buildEcoAuthEmailConfirmRedirect(supabaseUrl: string): string {
  const base = normalizeSupabaseProjectUrl(supabaseUrl).replace(/\/+$/, "");
  return `${base}/functions/v1/auth-email-confirmed`;
}

export interface CenterServerSignInRequest {
  supabaseUrl: string;
  /** Optional when anon key was already saved for this project URL. */
  anonKey?: string;
  email: string;
  password: string;
  deviceName: string;
  /** @deprecated Prefer supabaseUrl. */
  serverUrl?: string;
}

export interface CenterServerAccountAuthResult {
  /**
   * True when Auth created the user but email confirmation is required before a session exists.
   * Caller should keep the account form open and switch to sign-in after the user confirms.
   */
  emailConfirmationRequired?: boolean;
  email?: string;
  notice?: string;
  /** Present when registration completed (session available). */
  settings?: CenterServerSettingsView;
  status?: CenterServerConnectionStatus;
  device?: CenterServerDeviceView;
  user?: CenterServerAccountView;
}

export interface CenterServerCreatePairingResult {
  pairingId: string;
  code: string;
  bootstrapToken: string;
  qrPayload: string;
  expiresAt: string;
}

/** Mobile connect QR — server URL + anon only (no pairing code). */
export interface CenterServerConnectQrResult {
  qrPayload: string;
}

export interface CenterServerUnlockVaultResult {
  hasVaultKey: boolean;
  vaultStatus: CenterServerVaultStatus;
}

export interface CenterServerWrapVaultResult {
  vaultStatus: CenterServerVaultStatus;
}

export interface CenterServerTestConnectionRequest {
  supabaseUrl: string;
  /** Optional when anon key was already saved for this project URL. */
  anonKey?: string;
  /** @deprecated Prefer supabaseUrl. */
  serverUrl?: string;
}

export interface CenterServerTestConnectionResult {
  ok: boolean;
  error?: string;
}

export interface CenterServerRemoveConnectionOptions {
  forceLocal?: boolean;
}

export interface CenterServerRemoveConnectionResult extends CenterServerSettingsSnapshot {
  notice?: string;
}

export class CenterServerRemoveConnectionError extends Error {
  readonly recovery: CenterServerAuthRecovery;

  constructor(message: string, recovery: CenterServerAuthRecovery) {
    super(message);
    this.name = "CenterServerRemoveConnectionError";
    this.recovery = recovery;
  }
}

export interface CenterServerDeviceBindingView {
  id: string;
  userId: string;
  desktopDeviceId: string;
  mobileDeviceId: string;
  capabilities: string[];
  createdAt: string;
  revokedAt: string | null;
}

export interface CenterServerDevicePresenceView extends CenterServerDeviceView {
  online?: boolean;
  connectedAt?: string;
}

export interface CenterServerListBindingsResult {
  bindings: CenterServerDeviceBindingView[];
}

export interface CenterServerListPresenceResult {
  devices: CenterServerDevicePresenceView[];
}

export interface CenterServerRevokeBindingResult {
  binding: CenterServerDeviceBindingView;
}

export type CenterServerVaultSyncState =
  | "idle"
  | "syncing"
  | "ready"
  | "needs_claim"
  | "needs_password"
  | "claim_pending"
  | "error";

export interface CenterServerVaultStatus {
  hasVaultKey: boolean;
  state: CenterServerVaultSyncState;
  lastSyncedAt?: string;
  error?: string;
  /** Non-error guidance (e.g. enter password to unlock, wrap for other devices). */
  hint?: string;
  /** Pending vault claims visible to this account (legacy approver UI). */
  pendingClaimCount?: number;
  /** True when at least one other vault-synced device appears online (presence). */
  syncedPeerOnline?: boolean;
  activeClaimId?: string;
  /** Approver-only: 6-digit code currently shown for an open approve session. */
  approvalCode?: string;
  approvalClaimId?: string;
  /** Local vs cloud settings differ; user must choose pull or push. */
  needsSyncChoice?: boolean;
  /** Cloud has a password wrap ready for unlock. */
  hasPasswordWrap?: boolean;
  /** Local vault_key exists but cloud wrap is missing — prompt to wrap with login password. */
  needsPasswordWrap?: boolean;
}

export interface CenterServerVaultClaimView {
  id: string;
  requesterDeviceId: string;
  requesterDeviceName?: string;
  status: "pending" | "approved" | "consumed" | "expired" | "cancelled";
  expiresAt: string;
  createdAt: string;
  approverDeviceId?: string | null;
}

export interface CenterServerRequestVaultClaimResult {
  claimId: string;
  expiresAt: string;
}

export interface CenterServerApproveVaultClaimResult {
  claimId: string;
  /** 6-digit code for the requester to enter on the new device. */
  code: string;
  expiresAt: string;
}

export interface CenterServerSubmitVaultClaimCodeResult {
  claimId: string;
  hasVaultKey: boolean;
}

export interface CenterServerSyncConfigResult {
  mode: "pull" | "push" | "reconcile";
  settingsPushed: boolean;
  settingsPulled: boolean;
  secretsPushed: number;
  secretsPulled: number;
  syncedAt: string;
  vaultStatus: CenterServerVaultStatus;
  /** Local and cloud both have settings and differ — choose pull or push explicitly. */
  needsUserChoice?: boolean;
  /** Cloud write succeeded but vault_synced_at mark failed (deploy eco_mark_device_vault_synced). */
  vaultMarkFailed?: string;
  /** Some cloud secret rows were skipped (undecryptable with this vault key). */
  secretsSkipped?: number;
  /** Pull found no cloud settings snapshot to apply. */
  cloudEmpty?: boolean;
}

export type CenterServerSyncConfigMode = "pull" | "push" | "reconcile";

export type CenterServerSyncDomain =
  | "providers"
  | "proxyBridge"
  | "asr"
  | "imageGeneration"
  | "defaultAgent"
  | "orchestration"
  | "agentLibrary"
  | "git"
  | "packageScriptArgs"
  | "sshBookmarks"
  | "personalization";

export type CenterServerDomainSyncState = "synced" | "dirty" | "never_synced" | "cloud_empty" | "needs_vault";

export interface CenterServerDomainSyncStatusEntry {
  domain: CenterServerSyncDomain;
  state: CenterServerDomainSyncState;
  summary?: string;
  lastSyncedAt?: string;
}

export interface CenterServerSyncStatusSnapshot {
  domains: CenterServerDomainSyncStatusEntry[];
}

export interface CenterServerSyncDomainResult {
  domain: CenterServerSyncDomain;
  mode: "pull" | "push";
  settingsPushed: boolean;
  settingsPulled: boolean;
  secretsPushed: number;
  secretsPulled: number;
  syncedAt: string;
  vaultStatus: CenterServerVaultStatus;
  cloudEmpty?: boolean;
}

export function resolveSupabaseProjectUrl(input: { supabaseUrl?: string; serverUrl?: string }): string {
  const raw = (input.supabaseUrl ?? input.serverUrl ?? "").trim();
  return raw ? normalizeSupabaseProjectUrl(raw) : "";
}

export function validateCenterServerSettingsInput(input: CenterServerSettingsInput): void {
  const projectUrl = resolveSupabaseProjectUrl(input);
  if (input.enabled && !projectUrl) {
    throw new Error("Supabase project URL is required when enabled.");
  }
  if (projectUrl) {
    normalizeSupabaseProjectUrl(projectUrl);
  }
}

/** @deprecated Prefer normalizeSupabaseProjectUrl. */
export function normalizeCenterServerHttpUrl(serverUrl: string): string {
  return normalizeSupabaseProjectUrl(serverUrl);
}

export function normalizeSupabaseProjectUrl(projectUrl: string): string {
  const trimmed = projectUrl.trim();
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Supabase project URL must use http or https.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function buildCenterServerWebSocketUrl(serverUrl: string, accessToken: string): string {
  const parsed = new URL(normalizeCenterServerHttpUrl(serverUrl));
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/v1/rpc`;
  parsed.searchParams.set("access_token", accessToken);
  return parsed.toString();
}

export const APP_LINK_SCHEMES = ["mori", "eco"] as const;

/** New links use mori://; keep accepting eco:// links from older releases. */
export function isAppDeepLink(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return Boolean(parsed.hostname) && APP_LINK_SCHEMES.some((scheme) => parsed.protocol === `${scheme}:`);
  } catch {
    return false;
  }
}

/**
 * `mori://connect` deep link — import a Supabase project from the schema.
 * `mori://connect?url={baseUrl}&token={token}` where token is the anon key.
 * `supabase`/`anon` are accepted as aliases (used by the mobile connect QR).
 */
export interface EcoConnectDeepLink {
  /** Normalized Supabase project URL, or empty when missing/invalid. */
  supabaseUrl: string;
  /** Raw anon key value, or empty when missing. */
  anonKey: string;
}

export function parseEcoConnectDeepLink(rawUrl: string): EcoConnectDeepLink | undefined {
  try {
    const parsed = new URL(rawUrl.trim());
    if (!isAppDeepLink(rawUrl)) {
      return undefined;
    }
    const host = parsed.host || parsed.hostname;
    // mori://connect?url=...&token=... — the project lives in the path host.
    if (host !== "connect") {
      return undefined;
    }
    const rawUrlValue =
      parsed.searchParams.get("url") ?? parsed.searchParams.get("supabase") ?? "";
    const rawToken =
      parsed.searchParams.get("token") ?? parsed.searchParams.get("anon") ?? "";
    let supabaseUrl = "";
    try {
      supabaseUrl = rawUrlValue ? normalizeSupabaseProjectUrl(rawUrlValue) : "";
    } catch {
      supabaseUrl = "";
    }
    return { supabaseUrl, anonKey: rawToken.trim() };
  } catch {
    return undefined;
  }
}

/**
 * Connect QR for Mobile — project URL + anon key only.
 * Scheme: `mori://center?supabase=...&anon=...`
 * Password login is still required on the phone; QR does not grant control.
 */
export function buildCenterQrPayload(input: { supabaseUrl: string; anonKey: string }): string {
  const supabaseUrl = input.supabaseUrl.trim();
  const anonKey = input.anonKey.trim();
  if (!supabaseUrl || !anonKey) {
    throw new Error("supabaseUrl and anonKey are required for the connect QR.");
  }
  const params = new URLSearchParams({
    supabase: normalizeSupabaseProjectUrl(supabaseUrl),
    anon: anonKey,
  });
  return `mori://center?${params.toString()}`;
}

/**
 * @deprecated Prefer buildCenterQrPayload. Legacy pairing QR with code+token.
 * Supabase-aware: `mori://pair?supabase=...&anon=...&code=...&token=...`
 */
export function buildPairingQrPayload(input: {
  /** @deprecated Prefer supabaseUrl + anonKey for Supabase Center. */
  serverUrl?: string;
  supabaseUrl?: string;
  anonKey?: string;
  code: string;
  bootstrapToken: string;
}): string {
  const params = new URLSearchParams({
    code: input.code,
    token: input.bootstrapToken,
  });
  const supabaseUrl = (input.supabaseUrl ?? "").trim();
  const anonKey = (input.anonKey ?? "").trim();
  if (supabaseUrl && anonKey) {
    params.set("supabase", normalizeSupabaseProjectUrl(supabaseUrl));
    params.set("anon", anonKey);
  } else {
    const serverUrl = (input.serverUrl ?? input.supabaseUrl ?? "").trim();
    if (!serverUrl) {
      throw new Error("supabaseUrl+anonKey or serverUrl is required for pairing QR.");
    }
    params.set("server", normalizeSupabaseProjectUrl(serverUrl));
  }
  return `mori://pair?${params.toString()}`;
}

export function isLocalhostCenterServerUrl(serverUrl: string): boolean {
  try {
    const hostname = new URL(normalizeCenterServerHttpUrl(serverUrl)).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export function previewCenterServerSecret(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length <= 4) {
    return "••••";
  }
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

export const CENTER_SERVER_REAUTH_MESSAGE = "登录已失效，请重新登录。";

/**
 * Local connection credentials are missing (never registered, or cleared).
 * Distinct from REAUTH: the login session may be fine, but this device has
 * no refresh token / device secret to prove its identity, so it must sign in again.
 */
export const CENTER_SERVER_INCOMPLETE_CONFIG_MESSAGE = "连接配置不完整，请重新登录。";

/** Stable marker for UI i18n when Auth rejects unconfirmed email. */
export const CENTER_SERVER_EMAIL_NOT_CONFIRMED_MESSAGE = "CENTER_SERVER_EMAIL_NOT_CONFIRMED";

export type CenterServerAuthRecovery =
  | "network"
  | "device_inactive"
  | "account_unusable"
  | "relogin"
  | "unknown";

export function classifyCenterServerAuthError(message: string | undefined): CenterServerAuthRecovery {
  if (!message?.trim()) {
    return "unknown";
  }
  if (message === CENTER_SERVER_REAUTH_MESSAGE) {
    return "relogin";
  }
  if (message === CENTER_SERVER_INCOMPLETE_CONFIG_MESSAGE) {
    return "relogin";
  }
  const lower = message.toLowerCase();
  if (looksLikeTransientNetworkFailure(lower)) {
    return "network";
  }
  if (lower.includes("token user is not active") || lower.includes("refresh token subject is not active")) {
    return "account_unusable";
  }
  if (
    lower.includes("device is not active") ||
    lower.includes("token device is not active") ||
    lower.includes("refresh token device is not active")
  ) {
    return "device_inactive";
  }
  // supabase-js "Auth session missing!" means the in-memory session was dropped
  // (persistSession: false). A stored refresh token can still recover — do not
  // force relogin or wipe credentials.
  if (lower.includes("auth session missing")) {
    return "network";
  }
  // Do not treat bare "unauthorized" as relogin — Realtime/Edge blips often
  // use that wording and must not wipe a still-valid refresh token.
  if (
    lower.includes("refresh token is invalid or expired") ||
    lower.includes("invalid refresh token") ||
    lower.includes("refresh_token_not_found") ||
    lower.includes("invalid login credentials") ||
    lower.includes("credentials are missing") ||
    lower.includes("credentials are invalid") ||
    lower.includes("device credentials are invalid") ||
    lower.includes("device credentials are missing") ||
    lower.includes("user session expired")
  ) {
    return "relogin";
  }
  return "unknown";
}

/**
 * Access JWTs are short-lived; refresh tokens are long-lived. Transient refresh
 * failures must keep the stored refresh token so the client can retry.
 */
export function recoveryForSessionRefreshFailure(message: string | undefined): CenterServerAuthRecovery {
  if (isCenterServerAuthCredentialError(message)) {
    return classifyCenterServerAuthError(message);
  }
  return "network";
}

function looksLikeTransientNetworkFailure(lower: string): boolean {
  return (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("network request failed") ||
    lower.includes("networkerror") ||
    lower.includes("socketexception") ||
    lower.includes("clientexception") ||
    lower.includes("httpexception") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("econnreset") ||
    lower.includes("connection reset") ||
    lower.includes("connection refused") ||
    lower.includes("connection closed") ||
    lower.includes("connection abort") ||
    lower.includes("failed host lookup") ||
    lower.includes("failed to lookup") ||
    lower.includes("no address associated") ||
    lower.includes("network is unreachable") ||
    lower.includes("software caused connection abort") ||
    lower.includes("failed to fetch") ||
    lower.includes("request failed with http 5") ||
    lower.includes("statuscode: 5") ||
    lower.includes("status code: 5") ||
    lower.includes("http 502") ||
    lower.includes("http 503") ||
    lower.includes("http 504")
  );
}

export function isCenterServerAuthCredentialError(message: string | undefined): boolean {
  const recovery = classifyCenterServerAuthError(message);
  return recovery === "relogin" || recovery === "device_inactive" || recovery === "account_unusable";
}

export function isCenterServerReloginError(message: string | undefined): boolean {
  return classifyCenterServerAuthError(message) === "relogin";
}

export function centerServerAuthRecoveryMessage(recovery: CenterServerAuthRecovery): string {
  switch (recovery) {
    case "network":
      return "无法连接服务端，请检查网络后重试。";
    case "device_inactive":
      return "设备已在服务端注销或禁用，请重新配置连接。";
    case "account_unusable":
      return "账号已停用，请联系管理员。";
    case "relogin":
      return CENTER_SERVER_REAUTH_MESSAGE;
    default:
      return "连接失败，请稍后重试。";
  }
}
