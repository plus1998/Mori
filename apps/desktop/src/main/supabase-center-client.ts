/**
 * Supabase Center Desktop client (Track C + D + E).
 *
 * Owns: project URL + anon key settings, Auth (signUp/signIn/refresh),
 * device registration via Edge Function `device-register`, connection status,
 * pairing / bindings / presence via PostgREST + Edge Functions, Realtime
 * Presence + `eco:bind:*` private Broadcast RPC (see supabase-realtime-rpc.ts),
 * and account settings / secrets sync + vault claim (Track E).
 *
 * Event fan-out uses MobileRemoteEventPublisher (projection / context throttling).
 *
 * The old Mongo/Redis Center Server WebSocket `/v1/rpc` client has been removed.
 */
import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import {
  buildCenterQrPayload,
  buildEcoAuthEmailConfirmRedirect,
  CENTER_SERVER_EMAIL_NOT_CONFIRMED_MESSAGE,
  CENTER_SERVER_INCOMPLETE_CONFIG_MESSAGE,
  CENTER_SERVER_REAUTH_MESSAGE,
  type CenterServerAccountAuthResult,
  type CenterServerAccountView,
  type CenterServerApproveVaultClaimResult,
  type CenterServerConnectionStatus,
  type CenterServerConnectQrResult,
  type CenterServerCreatePairingResult,
  type CenterServerDeviceBindingView,
  type CenterServerDevicePresenceView,
  type CenterServerDeviceView,
  type CenterServerRegisterDesktopRequest,
  type CenterServerRegisterDesktopResult,
  CenterServerRemoveConnectionError,
  type CenterServerRemoveConnectionOptions,
  type CenterServerRemoveConnectionResult,
  type CenterServerRequestVaultClaimResult,
  type CenterServerSettingsSnapshot,
  type CenterServerSignInRequest,
  type CenterServerSignUpRequest,
  type CenterServerSubmitVaultClaimCodeResult,
  type CenterServerSyncConfigResult,
  type CenterServerSyncDomain,
  type CenterServerSyncDomainResult,
  type CenterServerSyncStatusSnapshot,
  type CenterServerTestConnectionRequest,
  type CenterServerTestConnectionResult,
  type CenterServerUnlockVaultResult,
  type CenterServerVaultClaimView,
  type CenterServerVaultStatus,
  type CenterServerWrapVaultResult,
  type HtmlHostingCapability,
  centerServerAuthRecoveryMessage,
  classifyCenterServerAuthError,
  isCenterServerAuthCredentialError,
  normalizeSupabaseProjectUrl,
  recoveryForSessionRefreshFailure,
  resolveSupabaseProjectUrl,
} from "../shared/center-server";
import type { EventCenterEnvelope, EventCenterJsonRpcNotification } from "../shared/event-center";
import type { CenterServerSettingsSecret, CenterServerStore } from "./center-server-store";
import {
  collectDesktopDeviceProfile,
  defaultDesktopDeviceName,
  desktopDeviceMetadata,
} from "./desktop-device-profile";
import type {
  DesktopEventCenter,
  DesktopEventCenterSink,
} from "./event-center";
import { MobileRemoteEventPublisher } from "./mobile-remote-event-publisher";
import { SupabaseRealtimeRpc } from "./supabase-realtime-rpc";
import {
  computeDomainSyncStatuses,
  type DomainSettingsSyncHooks,
  decryptUserSecrets,
  isEcoSyncedSettingsPayload,
  markDeviceVaultSynced,
  pullUserSecrets,
  pullUserSettings,
  SettingsSyncConflictError,
  SettingsSyncVaultDecryptError,
  SettingsSyncVaultRequiredError,
  syncAccountConfig,
  syncAccountConfigDomain,
} from "./supabase-settings-sync";
import {
  accountHasCloudVaultMaterial,
  beginApproveVaultClaim,
  cancelVaultClaim,
  countOnlineVaultSyncedPeers,
  createVaultClaim,
  listPendingVaultClaims,
  startVaultClaimApproverSession,
  submitVaultClaimCodeAndReceiveKey,
  VaultClaimError,
} from "./supabase-vault-claim";
import {
  fetchUserVaultWrap,
  unlockVaultKeyWithPassword,
  VaultPasswordError,
  wrapAndUploadVaultKeyWithPassword,
} from "./supabase-vault-password";

type FetchLike = typeof fetch;

export interface SupabaseCenterDesktopClientOptions {
  store: CenterServerStore;
  eventCenter: DesktopEventCenter;
  fetch?: FetchLike;
  now?: () => Date;
  log?: (message: string) => void;
  onStatusChange?: (snapshot: CenterServerSettingsSnapshot) => void;
  onHtmlHostingCapabilityChange?: (
    capability: HtmlHostingCapability,
    previous: HtmlHostingCapability,
  ) => void;
  /** Optional hooks for pushing/pulling provider/ASR/image settings + secrets. */
  settingsSyncHooks?: DomainSettingsSyncHooks;
  /** Test/integration seam; production defaults to SupabaseRealtimeRpc. */
  realtimeFactory?: (options: SupabaseRealtimeRpcOptions) => CenterRealtimeTransport;
  /** Test seam for deterministic reconnect scheduling. */
  reconnectScheduler?: (callback: () => void, delayMs: number) => { cancel(): void };
  /** Test seam for deterministic access-token refresh scheduling. */
  accessTokenRefreshScheduler?: (callback: () => void, delayMs: number) => { cancel(): void };
}

interface SupabaseRealtimeRpcOptions {
  client: SupabaseClient;
  eventCenter: DesktopEventCenter;
  log: (message: string) => void;
  now: () => Date;
  onTransportUnhealthy?: (error: Error) => void;
  onBindingsChanged?: () => void | Promise<void>;
}

interface CenterRealtimeTransport {
  start(input: { userId: string; deviceId: string }): Promise<void>;
  stop(): Promise<void>;
  syncBindings(bindings: readonly CenterServerDeviceBindingView[]): Promise<void>;
  publishNotification(notification: EventCenterJsonRpcNotification): void;
  listOnlineDeviceIds(): ReadonlySet<string>;
}

interface DeviceRegisterResponse {
  device: CenterServerDeviceView;
  deviceSecret: string;
}

const DEVICE_REGISTER_FUNCTION = "device-register";
const DEVICE_DISABLE_FUNCTION = "device-disable";
const DEVICE_SESSION_REGISTER_FUNCTION = "device-session-register";
const HTML_PAGE_PUBLISH_FUNCTION = "html-page-publish";
const BINDINGS_REFRESH_INTERVAL_MS = 60_000;
const ACCESS_TOKEN_REFRESH_LEEWAY_MS = 60_000;
const ACCESS_TOKEN_REFRESH_RETRY_MS = 10_000;
const ACCESS_TOKEN_MIN_REMAINING_MS = 30_000;
const DEVICE_SESSION_REVALIDATE_INTERVAL_MS = 30_000;
/** Poll pending vault claims so approvers see requests without the requester being online. */
const VAULT_CLAIMS_REFRESH_INTERVAL_MS = 20_000;

/** Module singleton for Realtime / other modules to share the same client. */
let activeSupabaseClient: SupabaseClient | undefined;

export function getSupabaseClient(): SupabaseClient | undefined {
  return activeSupabaseClient;
}

export class SupabaseCenterDesktopClient implements DesktopEventCenterSink {
  private readonly store: CenterServerStore;
  private readonly eventCenter: DesktopEventCenter;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly onStatusChange: ((snapshot: CenterServerSettingsSnapshot) => void) | undefined;
  private readonly onHtmlHostingCapabilityChange:
    | ((capability: HtmlHostingCapability, previous: HtmlHostingCapability) => void)
    | undefined;
  private readonly realtimeFactory: (options: SupabaseRealtimeRpcOptions) => CenterRealtimeTransport;
  private readonly reconnectScheduler: (callback: () => void, delayMs: number) => { cancel(): void };
  private readonly accessTokenRefreshScheduler: (callback: () => void, delayMs: number) => { cancel(): void };
  private readonly unsubscribe: () => void;
  private settingsSyncHooks: DomainSettingsSyncHooks | undefined;
  private supabase: SupabaseClient | undefined;
  private realtime: CenterRealtimeTransport | undefined;
  private readonly remotePublisher: MobileRemoteEventPublisher;
  private bindingsRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private bindingsRefreshInFlight: Promise<void> | undefined;
  private bindingsRefreshRequested = false;
  private deviceSessionRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private vaultClaimsRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private intentionallyStopped = true;
  private connectInFlight: Promise<void> | undefined;
  private accessTokenRefreshInFlight: Promise<string> | undefined;
  private reconnectTimer: { cancel(): void } | undefined;
  private accessTokenRefreshTimer: { cancel(): void } | undefined;
  private reconnectAttempts = 0;
  private status: CenterServerConnectionStatus = { state: "disabled" };
  private vaultStatus: CenterServerVaultStatus = { hasVaultKey: false, state: "idle" };
  private pendingClaimPrivateKey: string | undefined;
  private pendingClaimId: string | undefined;
  private approverSessionStop: (() => Promise<void>) | undefined;
  private approvalCode: string | undefined;
  private approvalClaimId: string | undefined;
  private htmlHostingCapability: HtmlHostingCapability = {
    available: false,
    reason: "unchecked",
  };

  constructor(options: SupabaseCenterDesktopClientOptions) {
    this.store = options.store;
    this.eventCenter = options.eventCenter;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.onStatusChange = options.onStatusChange;
    this.onHtmlHostingCapabilityChange = options.onHtmlHostingCapabilityChange;
    this.realtimeFactory =
      options.realtimeFactory ?? ((realtimeOptions) => new SupabaseRealtimeRpc(realtimeOptions));
    this.reconnectScheduler =
      options.reconnectScheduler ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return { cancel: () => clearTimeout(timer) };
      });
    this.accessTokenRefreshScheduler =
      options.accessTokenRefreshScheduler ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return { cancel: () => clearTimeout(timer) };
      });
    this.settingsSyncHooks = options.settingsSyncHooks;
    this.remotePublisher = new MobileRemoteEventPublisher({
      deliver: (notification) => {
        this.realtime?.publishNotification(notification);
      },
      shouldDeliver: () => Boolean(this.realtime),
    });
    this.unsubscribe = this.eventCenter.subscribe(this);
    const pendingClaim = this.store.getPendingVaultClaim?.();
    this.pendingClaimId = pendingClaim?.claimId;
    this.pendingClaimPrivateKey = pendingClaim?.requesterPrivateKey;
    this.refreshVaultStatusFromStore();
  }

  setSettingsSyncHooks(hooks: DomainSettingsSyncHooks | undefined): void {
    this.settingsSyncHooks = hooks;
  }

  /** Forward V2 EventCenter notifications over Realtime bind channels. */
  publish(
    envelope: EventCenterEnvelope,
    notification: EventCenterJsonRpcNotification,
  ): void {
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.enabled) {
      return;
    }
    this.remotePublisher.publish(envelope, notification);
  }

  getSnapshot(): CenterServerSettingsSnapshot {
    return {
      ...this.store.getSettings(this.status),
      htmlHosting: this.htmlHostingCapability,
    };
  }

  getHtmlHostingCapability(): HtmlHostingCapability {
    return this.htmlHostingCapability;
  }

  async refreshHtmlHostingCapability(options?: { force?: boolean }): Promise<HtmlHostingCapability> {
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.enabled || !settings.supabaseUrl || !settings.anonKey) {
      return this.setHtmlHostingCapability({
        available: false,
        reason: "not_connected",
        checkedAt: this.now().toISOString(),
        detail: "Supabase Center is not connected.",
      });
    }
    if (
      !options?.force &&
      this.htmlHostingCapability.reason !== "unchecked" &&
      this.htmlHostingCapability.checkedAt
    ) {
      const age = this.now().getTime() - Date.parse(this.htmlHostingCapability.checkedAt);
      if (Number.isFinite(age) && age >= 0 && age < 5 * 60_000) {
        return this.htmlHostingCapability;
      }
    }
    const { probeHtmlHostingCapability } = await import("./html-host-store");
    return this.setHtmlHostingCapability(
      await probeHtmlHostingCapability({
        supabaseUrl: settings.supabaseUrl,
        anonKey: settings.anonKey,
        fetchImpl: this.fetchImpl as typeof fetch,
      }),
    );
  }

  private setHtmlHostingCapability(capability: HtmlHostingCapability): HtmlHostingCapability {
    const previous = this.htmlHostingCapability;
    this.htmlHostingCapability = capability;
    if (previous.available !== capability.available) {
      this.onHtmlHostingCapabilityChange?.(capability, previous);
    }
    this.onStatusChange?.(this.getSnapshot());
    return this.htmlHostingCapability;
  }

  async publishHtmlPage(input: {
    title: string;
    html: string;
    pageId?: string;
    threadId?: string;
  }): Promise<{
    pageId: string;
    slug: string;
    title: string;
    publicUrl: string;
    expiresAt: string;
    extendedAt?: string | null;
    canExtend: boolean;
    createdAt: string;
  }> {
    const capability = await this.refreshHtmlHostingCapability();
    if (!capability.available) {
      throw new Error(capability.detail ?? "HTML hosting is unavailable.");
    }
    const settings = this.store.getSettingsWithSecrets();
    const client = this.requireClient(settings);
    const accessToken = await this.ensureAccessToken(settings, client);
    const { data, error } = await client.functions.invoke(HTML_PAGE_PUBLISH_FUNCTION, {
      headers: { authorization: `Bearer ${accessToken}` },
      body: {
        title: input.title,
        html: input.html,
        ...(input.pageId ? { pageId: input.pageId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    });
    if (error) {
      throw new Error(
        isMissingEdgeFunctionError(error.message)
          ? `Edge Function "${HTML_PAGE_PUBLISH_FUNCTION}" is not deployed. ${error.message}`
          : error.message,
      );
    }
    if (!data || typeof data !== "object") {
      throw new Error("html-page-publish returned an empty response.");
    }
    const record = data as Record<string, unknown>;
    const pageId = typeof record.pageId === "string" ? record.pageId : "";
    const slug = typeof record.slug === "string" ? record.slug : "";
    const title = typeof record.title === "string" ? record.title : input.title;
    const publicUrl = typeof record.publicUrl === "string" ? record.publicUrl : "";
    const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : "";
    const createdAt = typeof record.createdAt === "string" ? record.createdAt : this.now().toISOString();
    if (!pageId || !slug || !publicUrl || !expiresAt) {
      throw new Error("html-page-publish response is missing required fields.");
    }
    return {
      pageId,
      slug,
      title,
      publicUrl,
      expiresAt,
      extendedAt: typeof record.extendedAt === "string" ? record.extendedAt : null,
      canExtend: record.canExtend === true,
      createdAt,
    };
  }

  async start(): Promise<void> {
    this.intentionallyStopped = false;
    await this.connect();
  }

  /**
   * OS sleep/wake or window focus after long idle: timers may have missed JWT
   * refresh and in-memory Auth session can be gone while refresh_token remains.
   * - resume/unlock: always renew when connected (Realtime often dies across sleep)
   * - focus: renew only when token is near expiry; always reconnect from error
   */
  async recoverAfterIdle(reason = "idle"): Promise<void> {
    if (this.intentionallyStopped) {
      return;
    }
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.enabled) {
      return;
    }
    if (!settings.refreshToken || !settings.deviceId || !settings.deviceSecret) {
      return;
    }

    this.log(`[eco] supabase center recoverAfterIdle (${reason})\n`);
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;

    const client = this.supabase;
    if (client && this.status.state === "connected") {
      const expiresAtMs = Date.parse(settings.accessTokenExpiresAt ?? "");
      const remainingMs = expiresAtMs - this.now().getTime();
      const tokenStale =
        !Number.isFinite(remainingMs) || remainingMs <= ACCESS_TOKEN_REFRESH_LEEWAY_MS;
      const forceNetworkRefresh = reason === "resume" || reason === "unlock-screen";
      if (!forceNetworkRefresh && !tokenStale) {
        return;
      }
      try {
        await this.refreshAccessToken(client);
        return;
      } catch (error) {
        this.log(`[eco] supabase center idle refresh failed: ${errorMessage(error)}\n`);
        if (this.intentionallyStopped || this.status.state === "connected") {
          return;
        }
      }
    }

    try {
      await this.connect();
    } catch (error) {
      this.log(`[eco] supabase center idle reconnect failed: ${errorMessage(error)}\n`);
    }
  }

  stop(): void {
    this.intentionallyStopped = true;
    this.clearReconnectTimer();
    this.accessTokenRefreshInFlight = undefined;
    this.reconnectAttempts = 0;
    void this.clearVaultClaimSessions();
    this.teardownClient();
    this.setStatus({ state: "disconnected", lastDisconnectedAt: this.now().toISOString() });
  }

  dispose(): void {
    this.stop();
    this.unsubscribe();
  }

  async reload(): Promise<void> {
    this.stop();
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.enabled) {
      this.setStatus({ state: "disabled" });
      return;
    }
    this.intentionallyStopped = false;
    await this.connect();
  }

  async saveSettings(
    input: Parameters<CenterServerStore["saveSettings"]>[0],
  ): Promise<CenterServerSettingsSnapshot> {
    const existing = this.store.getSettingsWithSecrets();
    const incomingName = input.deviceName?.trim();
    const shouldSyncCloudName =
      Boolean(
        existing.deviceId &&
          existing.deviceSecret &&
          existing.refreshToken &&
          (existing.supabaseUrl || existing.serverUrl) &&
          existing.anonKey,
      ) &&
      Boolean(incomingName) &&
      incomingName !== existing.deviceName.trim();

    if (shouldSyncCloudName && incomingName) {
      await this.syncDeviceProfile(incomingName);
    }

    this.store.saveSettings(input);
    await this.reload();
    return this.getSnapshot();
  }

  /** Push local device name + OS metadata to `devices` via RPC. */
  private async syncDeviceProfile(deviceName: string): Promise<void> {
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.deviceId) {
      throw new Error(CENTER_SERVER_INCOMPLETE_CONFIG_MESSAGE);
    }
    const { supabaseUrl, anonKey } = this.requireProjectCredentialsOrStored(settings);
    const client = this.createEphemeralClient(supabaseUrl, anonKey);
    await this.ensureAccessToken(settings, client);
    const profile = collectDesktopDeviceProfile();
    const { data, error } = await client.rpc("eco_update_device_profile", {
      p_device_id: settings.deviceId,
      p_name: deviceName,
      p_metadata: desktopDeviceMetadata(profile),
    });
    if (error) {
      throw new Error(error.message);
    }
    const rows = Array.isArray(data) ? data : data != null ? [data] : [];
    if (rows.length !== 1) {
      throw new Error(`eco_update_device_profile returned ${rows.length} rows.`);
    }
  }

  async registerDesktop(
    request: CenterServerRegisterDesktopRequest,
  ): Promise<CenterServerRegisterDesktopResult> {
    const refreshToken = request.refreshToken?.trim() ?? "";
    if (!refreshToken) {
      throw new Error("A refresh token is required. Sign in or sign up so Mori can store a renewing session.");
    }
    const { supabaseUrl, anonKey } = this.requireProjectCredentialsOrStored(request);
    const profile = collectDesktopDeviceProfile();
    const deviceName = request.deviceName.trim() || defaultDesktopDeviceName(profile);
    const client = this.createEphemeralClient(supabaseUrl, anonKey);
    const registered = await this.invokeDeviceRegister(client, request.userAccessToken, deviceName);
    // 从 JWT 解析过期时间，避免存储空值导致每次启动都尝试刷新
    const expiresAt = decodeJwtExpiry(request.userAccessToken);
    return this.persistRegisteredDevice({
      supabaseUrl,
      anonKey,
      accessToken: request.userAccessToken,
      refreshToken,
      accessTokenExpiresAt: expiresAt ? expiresAtIso(expiresAt) : "",
      device: registered.device,
      deviceSecret: registered.deviceSecret,
    });
  }

  async signUpAndRegisterDesktop(request: CenterServerSignUpRequest): Promise<CenterServerAccountAuthResult> {
    this.stop();
    const { supabaseUrl, anonKey } = this.requireProjectCredentialsOrStored(request);
    // Persist project credentials even when email confirmation is required,
    // so the user can sign in afterwards without re-entering the anon key.
    if (anonKey) {
      this.store.saveSettings({
        enabled: this.store.getSettingsWithSecrets().enabled,
        supabaseUrl,
        anonKey,
        deviceName:
          request.deviceName.trim() ||
          this.store.getSettingsWithSecrets().deviceName ||
          defaultDesktopDeviceName(collectDesktopDeviceProfile()),
      });
    }

    const client = this.createEphemeralClient(supabaseUrl, anonKey);
    const { data, error } = await client.auth.signUp({
      email: request.email.trim(),
      password: request.password,
      options: {
        ...(request.displayName?.trim() ? { data: { display_name: request.displayName.trim() } } : {}),
        emailRedirectTo: buildEcoAuthEmailConfirmRedirect(supabaseUrl),
      },
    });
    if (error) {
      throw new Error(error.message);
    }
    const session = data.session;
    const user = data.user;
    if (!session || !user) {
      const email = request.email.trim();
      return {
        emailConfirmationRequired: true,
        email,
        ...this.getSnapshot(),
      };
    }
    return this.registerAfterAuth({
      supabaseUrl,
      anonKey,
      session,
      user,
      deviceName: request.deviceName,
    });
  }

  async signInAndRegisterDesktop(request: CenterServerSignInRequest): Promise<CenterServerAccountAuthResult> {
    this.stop();
    const { supabaseUrl, anonKey } = this.requireProjectCredentialsOrStored(request);
    const client = this.createEphemeralClient(supabaseUrl, anonKey);
    const { data, error } = await client.auth.signInWithPassword({
      email: request.email.trim(),
      password: request.password,
    });
    if (error) {
      const message = error.message;
      if (/email\s*not\s*confirmed/i.test(message) || error.code === "email_not_confirmed") {
        throw new Error(CENTER_SERVER_EMAIL_NOT_CONFIRMED_MESSAGE);
      }
      throw new Error(message);
    }
    if (!data.session || !data.user) {
      throw new Error("Sign-in succeeded but no session was returned.");
    }
    return this.registerAfterAuth({
      supabaseUrl,
      anonKey,
      session: data.session,
      user: data.user,
      deviceName: request.deviceName,
    });
  }

  async createPairing(): Promise<CenterServerCreatePairingResult> {
    const qr = await this.buildConnectQr();
    const expiresAt = new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString();
    return {
      pairingId: "connect-qr",
      code: "",
      bootstrapToken: "",
      qrPayload: qr.qrPayload,
      expiresAt,
    };
  }

  /** Connect QR for Mobile: supabase URL + anon only (no pairing ceremony). */
  async buildConnectQr(): Promise<CenterServerConnectQrResult> {
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.supabaseUrl || !settings.anonKey) {
      throw new Error("Supabase project URL and anon key are required.");
    }
    return {
      qrPayload: buildCenterQrPayload({
        supabaseUrl: settings.supabaseUrl,
        anonKey: settings.anonKey,
      }),
    };
  }

  async listBindings(): Promise<CenterServerDeviceBindingView[]> {
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.deviceId) {
      throw new Error(CENTER_SERVER_REAUTH_MESSAGE);
    }
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);
    return this.fetchBindingsForDesktop(client, settings.deviceId, { activeOnly: false });
  }

  async listPresence(): Promise<CenterServerDevicePresenceView[]> {
    const settings = this.store.getSettingsWithSecrets();
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);
    const {
      data: { session },
      error: sessionError,
    } = await client.auth.getSession();
    if (sessionError) {
      throw new Error(sessionError.message);
    }
    const userId = session?.user.id;
    if (!userId) {
      throw new Error(CENTER_SERVER_REAUTH_MESSAGE);
    }

    const { data, error } = await client
      .from("devices_public")
      .select("id, user_id, kind, name, metadata, created_at, last_seen_at, disabled_at, vault_synced_at")
      .order("created_at", { ascending: true });
    if (error) {
      throw new Error(error.message);
    }

    const onlineFromPresence = this.realtime?.listOnlineDeviceIds() ?? new Set<string>();
    return (data ?? []).map((row): CenterServerDevicePresenceView => {
      const device = parseDeviceRow(row);
      const connectedAt = onlineFromPresence.has(device.id) ? device.lastSeenAt : null;
      return {
        ...device,
        online: onlineFromPresence.has(device.id),
        ...(connectedAt ? { connectedAt } : {}),
      };
    });
  }

  async revokeBinding(bindingId: string): Promise<CenterServerDeviceBindingView> {
    const trimmed = bindingId.trim();
    if (!trimmed) {
      throw new Error("bindingId is required.");
    }
    const settings = this.store.getSettingsWithSecrets();
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);
    const revokedAt = this.now().toISOString();
    const { data, error } = await client
      .from("device_bindings")
      .update({ revoked_at: revokedAt })
      .eq("id", trimmed)
      .select("id, user_id, desktop_device_id, mobile_device_id, capabilities, created_at, revoked_at")
      .single();
    if (error) {
      throw new Error(error.message);
    }
    const binding = parseBindingRow(data);
    void this.refreshRealtimeBindings().catch((refreshError) => {
      this.log(`[eco] bindings refresh after revoke failed: ${errorMessage(refreshError)}\n`);
    });
    return binding;
  }

  async testConnection(
    request: CenterServerTestConnectionRequest,
  ): Promise<CenterServerTestConnectionResult> {
    try {
      const supabaseUrl = resolveSupabaseProjectUrl(request);
      let anonKey = request.anonKey?.trim() ?? "";
      if (!supabaseUrl) {
        throw new Error("Supabase project URL is required.");
      }
      if (!anonKey) {
        const stored = this.store.getSettingsWithSecrets();
        if (
          stored.anonKey &&
          normalizeSupabaseProjectUrl(stored.supabaseUrl || stored.serverUrl) ===
            normalizeSupabaseProjectUrl(supabaseUrl)
        ) {
          anonKey = stored.anonKey;
        }
      }
      if (!anonKey) {
        throw new Error("Supabase anon key is required.");
      }
      const healthUrl = new URL("/auth/v1/health", `${normalizeSupabaseProjectUrl(supabaseUrl)}/`);
      const response = await this.fetchImpl(healthUrl, {
        method: "GET",
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${anonKey}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Supabase Auth health check failed with HTTP ${response.status}.`);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async removeConnection(
    options: CenterServerRemoveConnectionOptions = {},
  ): Promise<CenterServerRemoveConnectionResult> {
    const forceLocal = options.forceLocal ?? false;
    const settings = this.store.getSettingsWithSecrets();
    let notice: string | undefined;
    this.stop();

    if (!forceLocal && settings.deviceId && settings.supabaseUrl && settings.anonKey) {
      try {
        const accessToken = await this.ensureAccessToken(settings);
        const client = this.createEphemeralClient(settings.supabaseUrl, settings.anonKey);
        if (!settings.deviceSecret) {
          throw new Error(CENTER_SERVER_REAUTH_MESSAGE);
        }
        await this.invokeDeviceDisable(client, accessToken, settings.deviceId, settings.deviceSecret);
      } catch (error) {
        const message = errorMessage(error);
        const recovery = classifyCenterServerAuthError(message);
        // Edge Function may not exist yet (Track A gap).
        if (isMissingEdgeFunctionError(message)) {
          notice =
            "device-disable Edge Function is not available; cleared local connection only. Server device row may remain.";
        } else if (recovery === "device_inactive") {
          notice = centerServerAuthRecoveryMessage(recovery);
        } else {
          throw new CenterServerRemoveConnectionError(message, recovery);
        }
      }
    }

    await this.clearVaultClaimSessions();
    this.store.clearConnection();
    this.refreshVaultStatusFromStore();
    this.setStatus({ state: "disabled" });
    const snapshot = this.getSnapshot();
    return notice ? { ...snapshot, notice } : snapshot;
  }

  getVaultStatus(): CenterServerVaultStatus {
    return { ...this.vaultStatus, hasVaultKey: this.store.getVaultKey().length > 0 };
  }

  async syncConfig(mode: "pull" | "push" | "reconcile" = "reconcile"): Promise<CenterServerSyncConfigResult> {
    const settings = this.store.getSettingsWithSecrets();
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);
    const userId = await this.requireUserId(client);
    if (!settings.deviceId) {
      throw new Error(CENTER_SERVER_REAUTH_MESSAGE);
    }
    if (!this.settingsSyncHooks) {
      throw new Error("Settings sync hooks are not configured.");
    }

    const { error: _previousError, ...currentVaultStatus } = this.getVaultStatus();
    this.setVaultStatus({
      ...currentVaultStatus,
      state: "syncing",
    });

    try {
      const hasVaultKey = this.store.getVaultKey().length > 0;
      const result = await syncAccountConfig({
        client,
        userId,
        deviceId: settings.deviceId,
        getVaultKey: () => this.store.getVaultKey(),
        saveVaultKey: (vaultKey) => this.store.saveVaultKey(vaultKey),
        hooks: this.settingsSyncHooks,
        allowCreateVaultKey:
          mode !== "pull" && (hasVaultKey || (await this.shouldBootstrapVaultKey(client, settings.deviceId))),
        mode,
      });
      if (
        !result.needsUserChoice &&
        (result.settingsPulled ||
          result.settingsPushed ||
          result.secretsPulled > 0 ||
          result.secretsPushed > 0)
      ) {
        this.store.markSettingsSynced(result.syncedAt);
      }
      const wrapRow = await fetchUserVaultWrap(client, userId).catch(() => null);
      const hasVaultKeyNow = this.store.getVaultKey().length > 0;
      const status = {
        ...this.buildVaultStatusAfterSync(),
        hasPasswordWrap: Boolean(wrapRow),
        needsPasswordWrap: hasVaultKeyNow && !wrapRow,
        ...(hasVaultKeyNow && !wrapRow
          ? {
              hint: "Enter your login password once to wrap the vault key so other devices can unlock sync.",
            }
          : {}),
        ...(result.needsUserChoice ? { needsSyncChoice: true as const } : {}),
      };
      this.setVaultStatus(status);
      this.onStatusChange?.(this.getSnapshot());
      return {
        mode: result.mode,
        settingsPushed: result.settingsPushed,
        settingsPulled: result.settingsPulled,
        secretsPushed: result.secretsPushed,
        secretsPulled: result.secretsPulled,
        syncedAt: result.syncedAt,
        vaultStatus: status,
        ...(result.needsUserChoice ? { needsUserChoice: true } : {}),
        ...(result.vaultMarkFailed ? { vaultMarkFailed: result.vaultMarkFailed } : {}),
        ...(result.secretsSkipped ? { secretsSkipped: result.secretsSkipped } : {}),
        ...(result.cloudEmpty ? { cloudEmpty: true } : {}),
      };
    } catch (error) {
      if (error instanceof SettingsSyncVaultRequiredError) {
        const wrapRow = await fetchUserVaultWrap(client, userId).catch(() => null);
        this.setVaultStatus({
          hasVaultKey: false,
          state: "needs_password",
          error: error.code,
          hasPasswordWrap: Boolean(wrapRow),
          hint: wrapRow
            ? "Enter your account login password to unlock synced secrets on this device."
            : "No password-wrapped vault key yet. On a device that already synced, wrap the vault with your login password first.",
        });
        throw error;
      }
      if (error instanceof SettingsSyncVaultDecryptError) {
        this.setVaultStatus({
          ...this.getVaultStatus(),
          state: "error",
          error: error.message,
          hint: "The vault key was retained. No settings or API keys were applied; inspect the reported cloud secret before explicitly reauthorizing or resetting the vault.",
        });
        throw error;
      }
      const message =
        error instanceof SettingsSyncConflictError || error instanceof VaultClaimError
          ? error.message
          : errorMessage(error);
      const code =
        error instanceof SettingsSyncConflictError || error instanceof VaultClaimError
          ? error.code
          : undefined;
      this.setVaultStatus({
        ...this.getVaultStatus(),
        state: "error",
        error: code ? `${code}: ${message}` : message,
      });
      throw error;
    }
  }

  async syncConfigDomain(
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ): Promise<CenterServerSyncDomainResult> {
    const settings = this.store.getSettingsWithSecrets();
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);
    const userId = await this.requireUserId(client);
    if (!settings.deviceId) {
      throw new Error(CENTER_SERVER_REAUTH_MESSAGE);
    }
    if (!this.settingsSyncHooks) {
      throw new Error("Settings sync hooks are not configured.");
    }

    const { error: _previousError, ...currentVaultStatus } = this.getVaultStatus();
    this.setVaultStatus({
      ...currentVaultStatus,
      state: "syncing",
    });

    try {
      const hasVaultKey = this.store.getVaultKey().length > 0;
      const result = await syncAccountConfigDomain({
        client,
        userId,
        deviceId: settings.deviceId,
        domain,
        getVaultKey: () => this.store.getVaultKey(),
        saveVaultKey: (vaultKey) => this.store.saveVaultKey(vaultKey),
        hooks: this.settingsSyncHooks,
        allowCreateVaultKey:
          mode !== "pull" && (hasVaultKey || (await this.shouldBootstrapVaultKey(client, settings.deviceId))),
        mode,
      });

      if (
        result.settingsPulled ||
        result.settingsPushed ||
        result.secretsPulled > 0 ||
        result.secretsPushed > 0
      ) {
        this.store.markDomainSynced(domain, result.syncedAt);
      }

      const wrapRow = await fetchUserVaultWrap(client, userId).catch(() => null);
      const hasVaultKeyNow = this.store.getVaultKey().length > 0;
      const status = {
        ...this.buildVaultStatusAfterSync(),
        hasPasswordWrap: Boolean(wrapRow),
        needsPasswordWrap: hasVaultKeyNow && !wrapRow,
        ...(hasVaultKeyNow && !wrapRow
          ? {
              hint: "Enter your login password once to wrap the vault key so other devices can unlock sync.",
            }
          : {}),
      };
      this.setVaultStatus(status);
      this.onStatusChange?.(this.getSnapshot());
      return {
        domain: result.domain,
        mode,
        settingsPushed: result.settingsPushed,
        settingsPulled: result.settingsPulled,
        secretsPushed: result.secretsPushed,
        secretsPulled: result.secretsPulled,
        syncedAt: result.syncedAt,
        vaultStatus: status,
        ...(result.cloudEmpty ? { cloudEmpty: true } : {}),
      };
    } catch (error) {
      if (error instanceof SettingsSyncVaultRequiredError) {
        const wrapRow = await fetchUserVaultWrap(client, userId).catch(() => null);
        this.setVaultStatus({
          hasVaultKey: false,
          state: "needs_password",
          error: error.code,
          hasPasswordWrap: Boolean(wrapRow),
          hint: wrapRow
            ? "Enter your account login password to unlock synced secrets on this device."
            : "No password-wrapped vault key yet. On a device that already synced, wrap the vault with your login password first.",
        });
        throw error;
      }
      if (error instanceof SettingsSyncVaultDecryptError) {
        this.setVaultStatus({
          ...this.getVaultStatus(),
          state: "error",
          error: error.message,
          hint: "The vault key was retained. No settings or API keys were applied; inspect the reported cloud secret before explicitly reauthorizing or resetting the vault.",
        });
        throw error;
      }
      const message =
        error instanceof SettingsSyncConflictError || error instanceof VaultClaimError
          ? error.message
          : errorMessage(error);
      const code =
        error instanceof SettingsSyncConflictError || error instanceof VaultClaimError
          ? error.code
          : undefined;
      this.setVaultStatus({
        ...this.getVaultStatus(),
        state: "error",
        error: code ? `${code}: ${message}` : message,
      });
      throw error;
    }
  }

  async getSyncStatus(): Promise<CenterServerSyncStatusSnapshot> {
    if (!this.settingsSyncHooks) {
      return { domains: [] };
    }
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.enabled) {
      return { domains: [] };
    }
    try {
      const client = this.requireClient(settings);
      await this.ensureAccessToken(settings, client);
      const userId = await this.requireUserId(client);
      const localPayload = this.settingsSyncHooks.collectSettingsPayload();
      const localSecrets = this.settingsSyncHooks.collectPlainSecrets();
      const remote = await pullUserSettings(client, userId);
      const remotePayload = remote && isEcoSyncedSettingsPayload(remote.payload) ? remote.payload : null;
      let remoteSecrets: ReturnType<DomainSettingsSyncHooks["collectPlainSecrets"]> = [];
      const vaultKey = this.store.getVaultKey().trim();
      if (vaultKey && remotePayload) {
        const secretRows = await pullUserSecrets(client, userId);
        if (secretRows.length > 0) {
          const plain = await decryptUserSecrets(vaultKey, secretRows);
          remoteSecrets = plain.secrets;
        }
      }
      return {
        domains: computeDomainSyncStatuses({
          localPayload,
          remotePayload,
          localSecrets,
          remoteSecrets,
          hasVaultKey: vaultKey.length > 0,
          domainSyncTimes: this.store.getDomainSyncTimes(),
        }),
      };
    } catch {
      return { domains: [] };
    }
  }

  async unlockVaultWithPassword(password: string): Promise<CenterServerUnlockVaultResult> {
    const trimmed = password.trim();
    if (!trimmed) {
      throw new VaultPasswordError("Password is required.", "vault_password_required");
    }
    const settings = this.store.getSettingsWithSecrets();
    if (settings.vaultKey) {
      return { hasVaultKey: true, vaultStatus: this.getVaultStatus() };
    }
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);
    const userId = await this.requireUserId(client);
    const vaultKey = await unlockVaultKeyWithPassword({ client, userId, password: trimmed });
    this.store.saveVaultKey(vaultKey);
    this.setVaultStatus({
      ...this.buildVaultStatusAfterSync(),
      hasPasswordWrap: true,
      needsPasswordWrap: false,
    });
    return { hasVaultKey: true, vaultStatus: this.getVaultStatus() };
  }

  async wrapVaultWithPassword(password: string): Promise<CenterServerWrapVaultResult> {
    const trimmed = password.trim();
    if (!trimmed) {
      throw new VaultPasswordError("Password is required.", "vault_password_required");
    }
    const settings = this.store.getSettingsWithSecrets();
    const vaultKey = settings.vaultKey;
    if (!vaultKey) {
      throw new VaultPasswordError(
        "This device has no vault key to wrap. Unlock or sync first.",
        "vault_key_missing",
      );
    }
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);
    const userId = await this.requireUserId(client);
    await wrapAndUploadVaultKeyWithPassword({
      client,
      userId,
      vaultKey,
      password: trimmed,
    });
    this.setVaultStatus({
      ...this.getVaultStatus(),
      hasPasswordWrap: true,
      needsPasswordWrap: false,
      hint: "Vault key wrapped with your login password. Other devices can unlock with the same password.",
      state: "ready",
    });
    return { vaultStatus: this.getVaultStatus() };
  }

  async requestVaultClaim(): Promise<CenterServerRequestVaultClaimResult> {
    const settings = this.store.getSettingsWithSecrets();
    if (settings.vaultKey) {
      throw new Error("This device already has a vault key.");
    }
    if (this.pendingClaimId && this.pendingClaimPrivateKey) {
      throw new Error("A vault claim is already active. Cancel it before requesting another.");
    }
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);
    const userId = await this.requireUserId(client);
    if (!settings.deviceId) {
      throw new Error(CENTER_SERVER_REAUTH_MESSAGE);
    }

    const online = this.realtime?.listOnlineDeviceIds() ?? new Set<string>();
    const created = await createVaultClaim({
      client,
      userId,
      requesterDeviceId: settings.deviceId,
      onlineDeviceIds: online,
      now: this.now,
    });
    this.pendingClaimId = created.claim.id;
    this.pendingClaimPrivateKey = created.requesterPrivateKey;
    this.store.savePendingVaultClaim(created.claim.id, created.requesterPrivateKey);
    const { error: _previousError, ...currentVaultStatus } = this.getVaultStatus();
    this.setVaultStatus({
      ...currentVaultStatus,
      state: "claim_pending",
      activeClaimId: created.claim.id,
      hint: "Request sent. Open Mori on a device that already has your synced secrets, approve the request, then enter the 6-digit code here.",
    });
    return { claimId: created.claim.id, expiresAt: created.claim.expiresAt };
  }

  async listPendingVaultClaims(): Promise<CenterServerVaultClaimView[]> {
    const settings = this.store.getSettingsWithSecrets();
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);
    const claims = await listPendingVaultClaims(client, this.now);
    return claims.map((claim) => ({
      id: claim.id,
      requesterDeviceId: claim.requesterDeviceId,
      status: claim.status,
      expiresAt: claim.expiresAt,
      createdAt: claim.createdAt,
      approverDeviceId: claim.approverDeviceId,
    }));
  }

  async approveVaultClaim(claimId: string): Promise<CenterServerApproveVaultClaimResult> {
    const settings = this.store.getSettingsWithSecrets();
    const vaultKey = settings.vaultKey;
    if (!vaultKey) {
      throw new Error("This device does not have a vault key to share.");
    }
    if (!settings.deviceId) {
      throw new Error(CENTER_SERVER_REAUTH_MESSAGE);
    }
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);

    if (this.approverSessionStop) {
      await this.approverSessionStop();
      this.approverSessionStop = undefined;
    }

    const started = await beginApproveVaultClaim({
      client,
      claimId,
      approverDeviceId: settings.deviceId,
    });
    const session = await startVaultClaimApproverSession({
      client,
      claimId,
      approverDeviceId: settings.deviceId,
      vaultKey,
      log: this.log,
    });
    this.approverSessionStop = session.stop;
    this.approvalCode = started.code;
    this.approvalClaimId = claimId;
    const { error: _previousError, ...currentVaultStatus } = this.getVaultStatus();
    this.setVaultStatus({
      ...currentVaultStatus,
      approvalCode: started.code,
      approvalClaimId: claimId,
    });
    return {
      claimId,
      code: started.code,
      expiresAt: started.claim.expiresAt,
    };
  }

  async submitVaultClaimCode(code: string): Promise<CenterServerSubmitVaultClaimCodeResult> {
    const settings = this.store.getSettingsWithSecrets();
    if (settings.vaultKey) {
      throw new Error("This device already has a vault key.");
    }
    if (!this.pendingClaimId || !this.pendingClaimPrivateKey || !settings.deviceId) {
      throw new Error("No active vault claim. Request a claim first.");
    }
    const client = this.requireClient(settings);
    await this.ensureAccessToken(settings, client);

    try {
      const vaultKey = await submitVaultClaimCodeAndReceiveKey({
        client,
        claimId: this.pendingClaimId,
        requesterDeviceId: settings.deviceId,
        requesterPrivateKey: this.pendingClaimPrivateKey,
        code,
      });
      this.store.saveVaultKey(vaultKey);
      const claimId = this.pendingClaimId;
      this.pendingClaimId = undefined;
      this.pendingClaimPrivateKey = undefined;
      this.store.clearPendingVaultClaim();
      if (settings.deviceId) {
        await markDeviceVaultSynced(client, settings.deviceId);
      }
      this.setVaultStatus({
        hasVaultKey: true,
        state: "ready",
        lastSyncedAt: this.now().toISOString(),
      });
      return { claimId, hasVaultKey: true };
    } catch (error) {
      if (error instanceof VaultClaimError) {
        this.setVaultStatus({
          ...this.getVaultStatus(),
          state: "error",
          error: error.message,
        });
      }
      throw error;
    }
  }

  async cancelActiveVaultClaim(): Promise<void> {
    const claimId = this.pendingClaimId;
    if (!claimId) {
      return;
    }
    const settings = this.store.getSettingsWithSecrets();
    try {
      const client = this.requireClient(settings);
      await this.ensureAccessToken(settings, client);
      await cancelVaultClaim(client, claimId);
    } catch (error) {
      this.log(`[eco] cancel vault claim failed: ${errorMessage(error)}\n`);
    }
    this.pendingClaimId = undefined;
    this.pendingClaimPrivateKey = undefined;
    this.store.clearPendingVaultClaim();
    this.refreshVaultStatusFromStore();
  }

  private async shouldBootstrapVaultKey(client: SupabaseClient, selfDeviceId: string): Promise<boolean> {
    try {
      // Cloud already has vault material (synced device or user_secrets) → never mint a
      // second vault_key; decrypt would fail with OperationError and overwrite risk is high.
      if (await accountHasCloudVaultMaterial(client)) {
        return false;
      }
      const { data, error } = await client
        .from("devices_public")
        .select("id, vault_synced_at")
        .not("vault_synced_at", "is", null)
        .is("disabled_at", null);
      if (error) {
        throw new Error(error.message);
      }
      const others = (data ?? []).filter((row) => row.id !== selfDeviceId);
      return others.length === 0;
    } catch (error) {
      this.log(`[eco] vault bootstrap check failed: ${errorMessage(error)}\n`);
      return false;
    }
  }

  private buildVaultStatusAfterSync(): CenterServerVaultStatus {
    const hasVaultKey = this.store.getVaultKey().length > 0;
    const lastSyncedAt = this.store.getSettings().settings.lastSettingsSyncedAt;
    if (hasVaultKey) {
      return {
        hasVaultKey: true,
        state: "ready",
        ...(lastSyncedAt ? { lastSyncedAt } : {}),
        ...(typeof this.vaultStatus.pendingClaimCount === "number"
          ? { pendingClaimCount: this.vaultStatus.pendingClaimCount }
          : {}),
        ...(typeof this.vaultStatus.hasPasswordWrap === "boolean"
          ? { hasPasswordWrap: this.vaultStatus.hasPasswordWrap }
          : {}),
        ...(typeof this.vaultStatus.needsPasswordWrap === "boolean"
          ? { needsPasswordWrap: this.vaultStatus.needsPasswordWrap }
          : {}),
      };
    }
    return {
      hasVaultKey: false,
      state: this.pendingClaimId ? "claim_pending" : "needs_password",
      ...(this.pendingClaimId ? { activeClaimId: this.pendingClaimId } : {}),
      hint: this.pendingClaimId
        ? "Waiting for another device to approve (legacy claim). Prefer unlocking with your login password."
        : "Enter your account login password to unlock synced secrets on this device.",
      ...(typeof this.vaultStatus.hasPasswordWrap === "boolean"
        ? { hasPasswordWrap: this.vaultStatus.hasPasswordWrap }
        : {}),
    };
  }

  private refreshVaultStatusFromStore(): void {
    const hasVaultKey = this.store.getVaultKey().length > 0;
    const lastSyncedAt = this.store.getSettings().settings.lastSettingsSyncedAt;
    const pendingClaimCount = this.vaultStatus?.pendingClaimCount;
    this.vaultStatus = {
      hasVaultKey,
      state: hasVaultKey ? "ready" : this.pendingClaimId ? "claim_pending" : "idle",
      ...(lastSyncedAt ? { lastSyncedAt } : {}),
      ...(this.pendingClaimId ? { activeClaimId: this.pendingClaimId } : {}),
      ...(this.approvalCode ? { approvalCode: this.approvalCode } : {}),
      ...(this.approvalClaimId ? { approvalClaimId: this.approvalClaimId } : {}),
      ...(typeof pendingClaimCount === "number" ? { pendingClaimCount } : {}),
    };
  }

  private setVaultStatus(status: CenterServerVaultStatus): void {
    this.vaultStatus = status;
    this.onStatusChange?.(this.getSnapshot());
  }

  private async clearVaultClaimSessions(): Promise<void> {
    if (this.approverSessionStop) {
      try {
        await this.approverSessionStop();
      } catch {
        // ignore
      }
      this.approverSessionStop = undefined;
    }
    this.approvalCode = undefined;
    this.approvalClaimId = undefined;
  }

  private async requireUserId(client: SupabaseClient): Promise<string> {
    const { data, error } = await client.auth.getSession();
    if (error) {
      throw new Error(error.message);
    }
    const userId = data.session?.user.id;
    if (!userId) {
      throw new Error(CENTER_SERVER_REAUTH_MESSAGE);
    }
    return userId;
  }

  private connect(): Promise<void> {
    if (this.connectInFlight) {
      return this.connectInFlight;
    }
    this.connectInFlight = this.connectOnce().finally(() => {
      this.connectInFlight = undefined;
    });
    return this.connectInFlight;
  }

  private async connectOnce(): Promise<void> {
    this.clearReconnectTimer();
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.supabaseUrl.trim()) {
      const message = "Supabase project URL is required.";
      this.failConnection(message);
      throw new Error(message);
    }
    if (!settings.anonKey.trim()) {
      const message = "Supabase anon key is required.";
      this.failConnection(message);
      throw new Error(message);
    }
    if (!settings.deviceId || !settings.deviceSecret) {
      const message = CENTER_SERVER_INCOMPLETE_CONFIG_MESSAGE;
      this.failConnection(message);
      throw new Error(message);
    }

    this.setStatus({ state: "connecting" });

    try {
      const client = this.createPersistentClient(settings.supabaseUrl, settings.anonKey);
      const accessToken = await this.ensureAccessToken(settings, client);
      await this.registerDeviceSession(client, accessToken, settings);
      await client.realtime.setAuth(accessToken);
      if (this.intentionallyStopped) {
        throw new Error("Connection aborted.");
      }

      const { data, error } = await client.auth.getSession();
      if (error) {
        throw new Error(error.message);
      }
      let sessionUserId = data.session?.user?.id;
      if (!sessionUserId) {
        // persistSession:false — in-memory session can vanish after sleep while
        // refresh_token is still in the store. Force one renew before hard reauth.
        await this.ensureAccessToken(this.store.getSettingsWithSecrets(), client, {
          forceRefresh: true,
        });
        const recovered = await client.auth.getSession();
        if (recovered.error) {
          throw new Error(recovered.error.message);
        }
        sessionUserId = recovered.data.session?.user?.id;
      }
      if (!sessionUserId) {
        throw new Error(CENTER_SERVER_REAUTH_MESSAGE);
      }

      const userId = sessionUserId;
      const deviceId = settings.deviceId;
      const bindings = await this.fetchBindingsForDesktop(client, deviceId, { activeOnly: true });

      let realtime: CenterRealtimeTransport | undefined;
      realtime = this.realtimeFactory({
        client,
        eventCenter: this.eventCenter,
        log: this.log,
        now: this.now,
        onTransportUnhealthy: (transportError) => {
          this.handleRealtimeTransportUnhealthy(transportError, realtime);
        },
        onBindingsChanged: async () => {
          if (this.realtime !== realtime) return;
          await this.refreshRealtimeBindings();
        },
      });
      this.realtime = realtime;
      await realtime.start({ userId, deviceId });
      if (this.intentionallyStopped || this.realtime !== realtime) {
        throw new Error("Realtime transport was replaced during connection.");
      }
      await realtime.syncBindings(bindings);
      if (this.intentionallyStopped || this.realtime !== realtime) {
        throw new Error("Realtime transport was replaced during binding sync.");
      }
      this.startBindingsRefreshLoop();
      this.startDeviceSessionRefreshLoop();
      this.startVaultClaimsRefreshLoop();
      this.scheduleAccessTokenRefresh();

      const connectedAt = this.now().toISOString();
      this.reconnectAttempts = 0;
      this.store.markConnected(connectedAt);
      this.setStatus({ state: "connected", connectedAt });
      void this.refreshHtmlHostingCapability({ force: true });

      if (this.settingsSyncHooks) {
        void this.getSyncStatus()
          .then(async () => {
            if (this.store.getVaultKey()) {
              await this.refreshPendingVaultClaimCount(client);
              return;
            }
            const hasPeer = await accountHasCloudVaultMaterial(client);
            const online = this.realtime?.listOnlineDeviceIds() ?? new Set<string>();
            const peerCount = await countOnlineVaultSyncedPeers({
              client,
              selfDeviceId: deviceId,
              onlineDeviceIds: online,
            });
            this.setVaultStatus({
              hasVaultKey: false,
              state: this.pendingClaimId ? "claim_pending" : "needs_claim",
              syncedPeerOnline: peerCount > 0,
              ...(this.pendingClaimId ? { activeClaimId: this.pendingClaimId } : {}),
              ...(!hasPeer ? { error: "vault_no_synced_device" } : {}),
              ...(hasPeer
                ? {
                    hint: "Request authorization when ready. The other device does not need to be online right now — open Mori there later to approve.",
                  }
                : {}),
            });
          })
          .catch((syncError) => {
            this.log(`[eco] settings sync after connect failed: ${errorMessage(syncError)}\n`);
          });
      } else {
        this.refreshVaultStatusFromStore();
      }
    } catch (error) {
      this.stopBindingsRefreshLoop();
      this.stopDeviceSessionRefreshLoop();
      this.stopVaultClaimsRefreshLoop();
      this.clearAccessTokenRefreshTimer();
      if (this.realtime) {
        void this.realtime.stop().catch(() => {});
        this.realtime = undefined;
      }
      const message = errorMessage(error);
      if (this.status.state === "connecting") {
        this.failConnection(message);
      }
      if (!this.intentionallyStopped && !isCenterServerAuthCredentialError(message)) {
        this.scheduleReconnect();
      }
    }
  }

  private handleRealtimeTransportUnhealthy(
    error: Error,
    transport: CenterRealtimeTransport | undefined,
  ): void {
    if (this.intentionallyStopped || !transport || this.realtime !== transport) {
      return;
    }
    this.failConnection(error.message);
    this.teardownClient();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionallyStopped || this.reconnectTimer) {
      return;
    }
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts += 1;
    this.reconnectTimer = this.reconnectScheduler(() => {
      this.reconnectTimer = undefined;
      if (this.intentionallyStopped) {
        return;
      }
      void this.connect().catch((error) => {
        this.log(`[eco] supabase center reconnect failed: ${errorMessage(error)}\n`);
      });
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    this.reconnectTimer.cancel();
    this.reconnectTimer = undefined;
  }

  private scheduleAccessTokenRefresh(delayMs?: number): void {
    this.clearAccessTokenRefreshTimer();
    if (this.intentionallyStopped || !this.supabase) {
      return;
    }

    const settings = this.store.getSettingsWithSecrets();
    if (!settings.refreshToken) {
      return;
    }
    const expiresAtMs = Date.parse(settings.accessTokenExpiresAt ?? "");
    const refreshDelayMs =
      delayMs ??
      (Number.isFinite(expiresAtMs)
        ? Math.max(0, expiresAtMs - this.now().getTime() - ACCESS_TOKEN_REFRESH_LEEWAY_MS)
        : 0);
    const client = this.supabase;
    this.accessTokenRefreshTimer = this.accessTokenRefreshScheduler(() => {
      this.accessTokenRefreshTimer = undefined;
      if (this.intentionallyStopped || this.supabase !== client) {
        return;
      }
      void this.refreshAccessToken(client);
    }, refreshDelayMs);
  }

  private clearAccessTokenRefreshTimer(): void {
    if (!this.accessTokenRefreshTimer) {
      return;
    }
    this.accessTokenRefreshTimer.cancel();
    this.accessTokenRefreshTimer = undefined;
  }

  private async refreshAccessToken(client: SupabaseClient): Promise<void> {
    try {
      const settings = this.store.getSettingsWithSecrets();
      const accessToken = await this.ensureAccessToken(settings, client, { forceRefresh: true });
      await this.registerDeviceSession(client, accessToken, settings);
      await client.realtime.setAuth(accessToken);
      if (this.intentionallyStopped || this.supabase !== client) {
        return;
      }
      this.scheduleAccessTokenRefresh();
    } catch (error) {
      if (this.intentionallyStopped || this.supabase !== client) {
        return;
      }
      const message = errorMessage(error);
      if (isCenterServerAuthCredentialError(message)) {
        this.failConnection(message);
        this.teardownClient();
        return;
      }
      this.log(`[eco] supabase access token refresh failed: ${message}\n`);
      const expiresAtMs = Date.parse(this.store.getSettingsWithSecrets().accessTokenExpiresAt ?? "");
      const remainingMs = expiresAtMs - this.now().getTime();
      if (!Number.isFinite(remainingMs) || remainingMs <= ACCESS_TOKEN_MIN_REMAINING_MS) {
        this.failConnection(message);
        this.teardownClient();
        this.scheduleReconnect();
        return;
      }
      this.scheduleAccessTokenRefresh(
        Math.min(ACCESS_TOKEN_REFRESH_RETRY_MS, remainingMs - ACCESS_TOKEN_MIN_REMAINING_MS),
      );
    }
  }

  private async registerAfterAuth(input: {
    supabaseUrl: string;
    anonKey: string;
    session: Session;
    user: User;
    deviceName: string;
  }): Promise<CenterServerAccountAuthResult> {
    const profile = collectDesktopDeviceProfile();
    const deviceName = input.deviceName.trim() || defaultDesktopDeviceName(profile);
    const client = this.createEphemeralClient(input.supabaseUrl, input.anonKey);
    const existing = this.store.getSettingsWithSecrets();
    const canReuse =
      Boolean(existing.deviceId && existing.deviceSecret) &&
      normalizeSupabaseProjectUrl(existing.supabaseUrl || existing.serverUrl) ===
        normalizeSupabaseProjectUrl(input.supabaseUrl);

    if (canReuse && existing.deviceId && existing.deviceSecret) {
      try {
        await this.registerDeviceSession(client, input.session.access_token, {
          ...existing,
          supabaseUrl: input.supabaseUrl,
          anonKey: input.anonKey,
          accessToken: input.session.access_token,
          refreshToken: input.session.refresh_token,
          accessTokenExpiresAt: expiresAtIso(input.session.expires_at),
        });
        const persisted = await this.persistRegisteredDevice({
          supabaseUrl: input.supabaseUrl,
          anonKey: input.anonKey,
          accessToken: input.session.access_token,
          refreshToken: input.session.refresh_token,
          accessTokenExpiresAt: expiresAtIso(input.session.expires_at),
          device: {
            id: existing.deviceId,
            userId: input.user.id,
            kind: "desktop",
            name: existing.deviceName || deviceName,
            createdAt: new Date(0).toISOString(),
            lastSeenAt: null,
            disabledAt: null,
          },
          deviceSecret: existing.deviceSecret,
        });
        return {
          ...persisted,
          user: toAccountView(input.user),
        };
      } catch (error) {
        this.log(
          `[eco] device-session-register reuse failed, registering new device: ${errorMessage(error)}\n`,
        );
      }
    }

    const registered = await this.invokeDeviceRegister(client, input.session.access_token, deviceName);
    const persisted = await this.persistRegisteredDevice({
      supabaseUrl: input.supabaseUrl,
      anonKey: input.anonKey,
      accessToken: input.session.access_token,
      refreshToken: input.session.refresh_token,
      accessTokenExpiresAt: expiresAtIso(input.session.expires_at),
      device: registered.device,
      deviceSecret: registered.deviceSecret,
    });
    return {
      ...persisted,
      user: toAccountView(input.user),
    };
  }

  private async persistRegisteredDevice(input: {
    supabaseUrl: string;
    anonKey: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    device: CenterServerDeviceView;
    deviceSecret: string;
  }): Promise<CenterServerRegisterDesktopResult> {
    this.store.saveSettings({
      enabled: true,
      supabaseUrl: input.supabaseUrl,
      anonKey: input.anonKey,
      deviceId: input.device.id,
      deviceName: input.device.name,
      deviceSecret: input.deviceSecret,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
    });
    await this.reload();
    return {
      settings: this.store.getSettingsWithSecrets(),
      status: this.status,
      device: input.device,
    };
  }

  private async ensureAccessToken(
    settings: CenterServerSettingsSecret,
    client?: SupabaseClient,
    options: { forceRefresh?: boolean } = {},
  ): Promise<string> {
    let forceRefresh = options.forceRefresh === true;
    const tokenLooksValid =
      Boolean(settings.accessToken) && tokenStillValid(settings.accessTokenExpiresAt, this.now());

    if (!forceRefresh && tokenLooksValid && settings.accessToken) {
      if (client && settings.refreshToken) {
        const { error } = await client.auth.setSession({
          access_token: settings.accessToken,
          refresh_token: settings.refreshToken,
        });
        if (!error) {
          return settings.accessToken;
        }
        this.log(`[eco] supabase setSession failed, forcing refresh: ${error.message}\n`);
        forceRefresh = true;
      } else {
        return settings.accessToken;
      }
    }

    if (this.accessTokenRefreshInFlight) {
      return this.accessTokenRefreshInFlight;
    }

    const refreshPromise = this.refreshStoredSession(settings, client, { forceRefresh });
    this.accessTokenRefreshInFlight = refreshPromise;
    void refreshPromise
      .finally(() => {
        if (this.accessTokenRefreshInFlight === refreshPromise) {
          this.accessTokenRefreshInFlight = undefined;
        }
      })
      .catch(() => {
        // Rejection is observed by ensureAccessToken callers; avoid unhandled rejection from this probe.
      });
    return refreshPromise;
  }

  private async refreshStoredSession(
    settings: CenterServerSettingsSecret,
    client: SupabaseClient | undefined,
    options: { forceRefresh: boolean },
  ): Promise<string> {
    // Re-read in case a concurrent path already rotated tokens before we acquired the lock.
    const latest = this.store.getSettingsWithSecrets();
    const refreshToken = latest.refreshToken || settings.refreshToken;
    if (
      !options.forceRefresh &&
      latest.accessToken &&
      tokenStillValid(latest.accessTokenExpiresAt, this.now()) &&
      latest.refreshToken
    ) {
      if (client) {
        const { error } = await client.auth.setSession({
          access_token: latest.accessToken,
          refresh_token: latest.refreshToken,
        });
        if (!error) {
          return latest.accessToken;
        }
        this.log(`[eco] supabase setSession after wait failed: ${error.message}\n`);
      } else {
        return latest.accessToken;
      }
    }

    if (!refreshToken) {
      // 有 deviceId/deviceSecret 但无 refreshToken：之前注册过但会话过期，需要重新登录
      throw new Error(
        latest.deviceId && latest.deviceSecret
          ? CENTER_SERVER_REAUTH_MESSAGE
          : CENTER_SERVER_INCOMPLETE_CONFIG_MESSAGE,
      );
    }

    const supabase = client ?? this.createEphemeralClient(latest.supabaseUrl, latest.anonKey);
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session) {
      // Prefer server message; only wipe refresh token on genuine Auth rejection.
      const message = error?.message ?? CENTER_SERVER_REAUTH_MESSAGE;
      const recovery = recoveryForSessionRefreshFailure(message);
      if (
        recovery === "relogin" ||
        recovery === "device_inactive" ||
        recovery === "account_unusable"
      ) {
        this.store.clearRefreshToken();
      }
      throw new Error(message);
    }

    this.store.saveTokens({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      accessTokenExpiresAt: expiresAtIso(data.session.expires_at),
    });
    return data.session.access_token;
  }

  private async invokeDeviceRegister(
    client: SupabaseClient,
    accessToken: string,
    deviceName: string,
  ): Promise<DeviceRegisterResponse> {
    const profile = collectDesktopDeviceProfile();
    const { data, error } = await client.functions.invoke(DEVICE_REGISTER_FUNCTION, {
      headers: { authorization: `Bearer ${accessToken}` },
      body: {
        kind: "desktop",
        name: deviceName,
        metadata: desktopDeviceMetadata(profile),
      },
    });
    if (error) {
      throw new Error(
        isMissingEdgeFunctionError(error.message)
          ? `Edge Function "${DEVICE_REGISTER_FUNCTION}" is not deployed (Track A). ${error.message}`
          : error.message,
      );
    }
    return parseDeviceRegisterResponse(data);
  }

  private async registerDeviceSession(
    client: SupabaseClient,
    accessToken: string,
    settings: CenterServerSettingsSecret,
  ): Promise<void> {
    if (!settings.deviceId || !settings.deviceSecret) {
      throw new Error(CENTER_SERVER_INCOMPLETE_CONFIG_MESSAGE);
    }
    const { error } = await client.functions.invoke(DEVICE_SESSION_REGISTER_FUNCTION, {
      headers: { authorization: `Bearer ${accessToken}` },
      body: {
        deviceId: settings.deviceId,
        deviceSecret: settings.deviceSecret,
        kind: "desktop",
      },
    });
    if (error) {
      throw new Error(
        isMissingEdgeFunctionError(error.message)
          ? `Edge Function "${DEVICE_SESSION_REGISTER_FUNCTION}" is not deployed. ${error.message}`
          : error.message,
      );
    }
  }

  private async invokeDeviceDisable(
    client: SupabaseClient,
    accessToken: string,
    deviceId: string,
    deviceSecret: string,
  ): Promise<void> {
    const { error } = await client.functions.invoke(DEVICE_DISABLE_FUNCTION, {
      headers: { authorization: `Bearer ${accessToken}` },
      body: { deviceId, deviceSecret, kind: "desktop" },
    });
    if (error) {
      throw new Error(error.message);
    }
  }

  private requireProjectCredentialsOrStored(input: {
    supabaseUrl?: string;
    serverUrl?: string;
    anonKey?: string;
  }): { supabaseUrl: string; anonKey: string } {
    const supabaseUrl = resolveSupabaseProjectUrl(input);
    let anonKey = input.anonKey?.trim() ?? "";
    if (!supabaseUrl) {
      throw new Error("Supabase project URL is required.");
    }
    if (!anonKey) {
      const stored = this.store.getSettingsWithSecrets();
      if (
        stored.anonKey &&
        normalizeSupabaseProjectUrl(stored.supabaseUrl || stored.serverUrl) ===
          normalizeSupabaseProjectUrl(supabaseUrl)
      ) {
        anonKey = stored.anonKey;
      }
    }
    if (!anonKey) {
      throw new Error("Supabase anon key is required.");
    }
    return { supabaseUrl, anonKey };
  }

  private createPersistentClient(supabaseUrl: string, anonKey: string): SupabaseClient {
    this.teardownClient();
    const client = createBrowserlessClient(supabaseUrl, anonKey, this.fetchImpl);
    this.supabase = client;
    activeSupabaseClient = client;
    return client;
  }

  private createEphemeralClient(supabaseUrl: string, anonKey: string): SupabaseClient {
    return createBrowserlessClient(supabaseUrl, anonKey, this.fetchImpl);
  }

  private teardownClient(): void {
    this.stopBindingsRefreshLoop();
    this.stopDeviceSessionRefreshLoop();
    this.stopVaultClaimsRefreshLoop();
    this.clearAccessTokenRefreshTimer();
    this.remotePublisher.reset();
    const realtime = this.realtime;
    this.realtime = undefined;
    if (realtime) {
      void realtime.stop().catch((error) => {
        this.log(`[eco] realtime stop failed: ${errorMessage(error)}\n`);
      });
    }
    if (this.supabase && activeSupabaseClient === this.supabase) {
      activeSupabaseClient = undefined;
    }
    this.supabase = undefined;
  }

  private requireClient(settings: CenterServerSettingsSecret): SupabaseClient {
    if (this.supabase) {
      return this.supabase;
    }
    if (!settings.supabaseUrl || !settings.anonKey) {
      throw new Error("Supabase project URL and anon key are required.");
    }
    return this.createEphemeralClient(settings.supabaseUrl, settings.anonKey);
  }

  private startBindingsRefreshLoop(): void {
    this.stopBindingsRefreshLoop();
    this.bindingsRefreshTimer = setInterval(() => {
      void this.refreshRealtimeBindings().catch((error) => {
        this.log(`[eco] periodic bindings refresh failed: ${errorMessage(error)}\n`);
      });
    }, BINDINGS_REFRESH_INTERVAL_MS);
  }

  private stopBindingsRefreshLoop(): void {
    if (this.bindingsRefreshTimer) {
      clearInterval(this.bindingsRefreshTimer);
      this.bindingsRefreshTimer = undefined;
    }
  }

  private startDeviceSessionRefreshLoop(): void {
    this.stopDeviceSessionRefreshLoop();
    this.deviceSessionRefreshTimer = setInterval(() => {
      void this.refreshDeviceSessionAuthorization().catch((error) => {
        this.handleDeviceSessionRefreshFailure(error);
      });
    }, DEVICE_SESSION_REVALIDATE_INTERVAL_MS);
  }

  private stopDeviceSessionRefreshLoop(): void {
    if (this.deviceSessionRefreshTimer) {
      clearInterval(this.deviceSessionRefreshTimer);
      this.deviceSessionRefreshTimer = undefined;
    }
  }

  private async refreshDeviceSessionAuthorization(): Promise<void> {
    const client = this.supabase;
    if (!client || this.intentionallyStopped) {
      return;
    }
    const settings = this.store.getSettingsWithSecrets();
    const accessToken = await this.ensureAccessToken(settings, client);
    await this.registerDeviceSession(client, accessToken, settings);
    if (this.supabase !== client || this.intentionallyStopped) {
      return;
    }
    await client.realtime.setAuth(accessToken);
  }

  private handleDeviceSessionRefreshFailure(error: unknown): void {
    if (this.intentionallyStopped) {
      return;
    }
    const failure = error instanceof Error ? error : new Error(errorMessage(error));
    this.log(`[eco] device session revalidation failed: ${failure.message}\n`);
    const transport = this.realtime;
    if (transport) {
      this.handleRealtimeTransportUnhealthy(failure, transport);
    }
  }

  private startVaultClaimsRefreshLoop(): void {
    this.stopVaultClaimsRefreshLoop();
    this.vaultClaimsRefreshTimer = setInterval(() => {
      void this.refreshPendingVaultClaimCount().catch((error) => {
        this.log(`[eco] periodic vault claims refresh failed: ${errorMessage(error)}\n`);
      });
    }, VAULT_CLAIMS_REFRESH_INTERVAL_MS);
    void this.refreshPendingVaultClaimCount().catch((error) => {
      this.log(`[eco] initial vault claims refresh failed: ${errorMessage(error)}\n`);
    });
  }

  private stopVaultClaimsRefreshLoop(): void {
    if (this.vaultClaimsRefreshTimer) {
      clearInterval(this.vaultClaimsRefreshTimer);
      this.vaultClaimsRefreshTimer = undefined;
    }
  }

  private async refreshPendingVaultClaimCount(client?: SupabaseClient): Promise<void> {
    if (this.intentionallyStopped) {
      return;
    }
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.deviceId || !this.store.getVaultKey()) {
      return;
    }
    const supabase = client ?? this.supabase;
    if (!supabase) {
      return;
    }
    await this.ensureAccessToken(settings, supabase);
    const claims = await listPendingVaultClaims(supabase, this.now);
    const pendingClaimCount = claims.filter((claim) => claim.requesterDeviceId !== settings.deviceId).length;
    if (this.vaultStatus.pendingClaimCount === pendingClaimCount) {
      return;
    }
    const { hint: _previousHint, ...currentVaultStatus } = this.getVaultStatus();
    this.setVaultStatus({
      ...currentVaultStatus,
      pendingClaimCount,
      ...(pendingClaimCount > 0
        ? { hint: `${pendingClaimCount} device(s) waiting for vault authorization.` }
        : {}),
    });
  }

  private refreshRealtimeBindings(): Promise<void> {
    this.bindingsRefreshRequested = true;
    if (this.bindingsRefreshInFlight) return this.bindingsRefreshInFlight;
    const operation = (async () => {
      while (this.bindingsRefreshRequested) {
        this.bindingsRefreshRequested = false;
        await this.refreshRealtimeBindingsOnce();
      }
    })().finally(() => {
      if (this.bindingsRefreshInFlight === operation) {
        this.bindingsRefreshInFlight = undefined;
      }
    });
    this.bindingsRefreshInFlight = operation;
    return operation;
  }

  private async refreshRealtimeBindingsOnce(): Promise<void> {
    if (!this.realtime || !this.supabase || this.intentionallyStopped) {
      return;
    }
    const settings = this.store.getSettingsWithSecrets();
    if (!settings.deviceId) {
      return;
    }
    const client = this.supabase;
    const realtime = this.realtime;
    await this.ensureAccessToken(settings, client);
    const bindings = await this.fetchBindingsForDesktop(client, settings.deviceId, {
      activeOnly: true,
    });
    if (!this.intentionallyStopped && this.realtime === realtime && this.supabase === client) {
      await realtime.syncBindings(bindings);
    }
  }

  private async fetchBindingsForDesktop(
    client: SupabaseClient,
    desktopDeviceId: string,
    options: { activeOnly: boolean },
  ): Promise<CenterServerDeviceBindingView[]> {
    let query = client
      .from("device_bindings")
      .select("id, user_id, desktop_device_id, mobile_device_id, capabilities, created_at, revoked_at")
      .eq("desktop_device_id", desktopDeviceId)
      .order("created_at", { ascending: false });
    if (options.activeOnly) {
      query = query.is("revoked_at", null);
    }
    const { data, error } = await query;
    if (error) {
      throw new Error(error.message);
    }
    const bindings = (data ?? []).map(parseBindingRow);
    if (!options.activeOnly || bindings.length === 0) return bindings;
    // A disabled mobile can leave an unrevoked binding behind. Realtime RLS
    // correctly refuses that topic; do not let it tear down every healthy
    // channel on this desktop during connection or periodic refresh.
    const { data: mobiles, error: devicesError } = await client
      .from("devices_public")
      .select("id")
      .eq("kind", "mobile")
      .is("disabled_at", null)
      .in("id", bindings.map((binding) => binding.mobileDeviceId));
    if (devicesError) throw new Error(devicesError.message);
    const activeMobileIds = new Set((mobiles ?? []).map((device) => device.id));
    return bindings.filter((binding) => activeMobileIds.has(binding.mobileDeviceId));
  }

  private failConnection(message: string): void {
    this.log(`[eco] supabase center connection failed: ${message}\n`);
    this.store.markError(message);
    this.setStatus({
      state: "error",
      lastError: message,
      lastDisconnectedAt: this.now().toISOString(),
    });
  }

  private setStatus(status: CenterServerConnectionStatus): void {
    this.status = status;
    this.onStatusChange?.(this.getSnapshot());
  }
}

function createBrowserlessClient(supabaseUrl: string, anonKey: string, fetchImpl: FetchLike): SupabaseClient {
  return createClient(normalizeSupabaseProjectUrl(supabaseUrl), anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: fetchImpl,
    },
  });
}

function parseDeviceRegisterResponse(payload: unknown): DeviceRegisterResponse {
  if (!isRecord(payload)) {
    throw new Error("device-register returned an empty response.");
  }
  const deviceRaw = payload.device ?? payload;
  if (!isRecord(deviceRaw)) {
    throw new Error("device-register response is missing device.");
  }
  const deviceSecret =
    readString(payload.deviceSecret) ?? readString(payload.device_secret) ?? readString(payload.secret);
  if (!deviceSecret) {
    throw new Error("device-register response is missing deviceSecret.");
  }
  return { device: parseDeviceRow(deviceRaw), deviceSecret };
}

function parseBindingRow(row: unknown): CenterServerDeviceBindingView {
  if (!isRecord(row)) {
    throw new Error("device_bindings row is invalid.");
  }
  const id = readString(row.id);
  const userId = readString(row.userId) ?? readString(row.user_id);
  const desktopDeviceId = readString(row.desktopDeviceId) ?? readString(row.desktop_device_id);
  const mobileDeviceId = readString(row.mobileDeviceId) ?? readString(row.mobile_device_id);
  const createdAt = readString(row.createdAt) ?? readString(row.created_at);
  if (!id || !userId || !desktopDeviceId || !mobileDeviceId || !createdAt) {
    throw new Error("device_bindings row is missing required fields.");
  }
  const capabilitiesRaw = row.capabilities;
  const capabilities = Array.isArray(capabilitiesRaw)
    ? capabilitiesRaw.filter((value): value is string => typeof value === "string")
    : [];
  return {
    id,
    userId,
    desktopDeviceId,
    mobileDeviceId,
    capabilities,
    createdAt,
    revokedAt: readString(row.revokedAt) ?? readString(row.revoked_at) ?? null,
  };
}

function parseDeviceRow(row: unknown): CenterServerDeviceView {
  if (!isRecord(row)) {
    throw new Error("devices row is invalid.");
  }
  const id = readString(row.id);
  const userId = readString(row.userId) ?? readString(row.user_id);
  const name = readString(row.name);
  const kind = readString(row.kind);
  const createdAt = readString(row.createdAt) ?? readString(row.created_at) ?? new Date().toISOString();
  if (!id || !userId || !name || (kind !== "desktop" && kind !== "mobile")) {
    throw new Error("devices row shape is invalid.");
  }
  const device: CenterServerDeviceView = {
    id,
    userId,
    kind,
    name,
    createdAt,
    lastSeenAt: readString(row.lastSeenAt) ?? readString(row.last_seen_at) ?? null,
    disabledAt: readString(row.disabledAt) ?? readString(row.disabled_at) ?? null,
  };
  const metadata = row.metadata;
  if (isRecord(metadata)) {
    device.metadata = {
      ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
      ...(typeof metadata.ipAddress === "string"
        ? { ipAddress: metadata.ipAddress }
        : typeof metadata.ip_address === "string"
          ? { ipAddress: metadata.ip_address }
          : {}),
      ...(typeof metadata.platform === "string" ? { platform: metadata.platform } : {}),
      ...(typeof metadata.hostname === "string" ? { hostname: metadata.hostname } : {}),
    };
  }
  return device;
}

function toAccountView(user: User): CenterServerAccountView {
  const displayName =
    typeof user.user_metadata?.display_name === "string"
      ? user.user_metadata.display_name
      : typeof user.user_metadata?.displayName === "string"
        ? user.user_metadata.displayName
        : null;
  return {
    id: user.id,
    email: user.email ?? "",
    displayName,
    createdAt: user.created_at,
  };
}

function expiresAtIso(expiresAtSeconds: number | undefined): string {
  if (!expiresAtSeconds || !Number.isFinite(expiresAtSeconds)) {
    return "";
  }
  return new Date(expiresAtSeconds * 1000).toISOString();
}

function decodeJwtExpiry(accessToken: string): number | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) {
      return undefined;
    }
    const payload = parts[1];
    if (!payload) {
      return undefined;
    }
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    const exp = decoded?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}

function tokenStillValid(expiresAt: string | undefined, now: Date): boolean {
  if (!expiresAt) {
    return false;
  }
  return Date.parse(expiresAt) - now.getTime() > ACCESS_TOKEN_MIN_REMAINING_MS;
}

function isMissingEdgeFunctionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("not found") ||
    lower.includes("404") ||
    lower.includes("function not found") ||
    (lower.includes("failed to fetch") && lower.includes("functions"))
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
