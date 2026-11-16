import { createHash, randomUUID } from "node:crypto";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  type CodexAccountShare,
  type CodexSharingSnapshot,
  type SharedCodexAccountProvider,
  type SharedCodexAccountSource,
  type SharedCodexTokens,
  sharedCodexAccountId,
} from "../shared/codex-account-sharing";
import type { OpenAIAccount, OpenAIAccountQuota } from "../shared/openai-account";

const EVENT = "codex-credentials";
const tokensSchema = z.strictObject({
  accessToken: z.string().min(1).max(32_768),
  chatgptAccountId: z.string().min(1).max(200),
  chatgptPlanType: z.string().max(100).optional(),
  expiresAt: z.number().finite().positive(),
  version: z.string().regex(/^[0-9a-f]{64}$/),
});
const requestSchema = z.strictObject({
  kind: z.literal("request"),
  id: z.string().uuid(),
  epoch: z.string().uuid(),
  operation: z.enum(["tokens", "quota"]),
  knownVersion: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
type ShareRequest = z.infer<typeof requestSchema>;
interface ShareReply {
  kind: "response";
  id: string;
  epoch: string;
  result?: unknown;
  error?: "reauthorization_required" | "revoked" | "failed";
}
interface Connection {
  client: SupabaseClient;
  userId: string;
  deviceId: string;
  deviceName: string;
  onlineDeviceIds: () => ReadonlySet<string>;
}
interface ChannelEntry {
  channel: RealtimeChannel;
  ready: Promise<void>;
  epoch: string;
}
interface Pending {
  shareId: string;
  epoch: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
export interface CodexAccountSharingOptions {
  localAccounts: () => Promise<OpenAIAccount[]>;
  accountIdentity: (accountId: string) => Promise<string>;
  tokens: (accountId: string, knownVersion?: string) => Promise<SharedCodexTokens>;
  quota: (accountId: string) => Promise<OpenAIAccountQuota>;
  changed: () => void;
  invalidated?: (accountId: string) => void;
  pollMs?: number;
}

const tokenVersion = (token: string) => createHash("sha256").update(token).digest("hex");
const readShare = (row: Record<string, unknown>): CodexAccountShare => ({
  id: String(row.id),
  ownerDeviceId: String(row.owner_device_id),
  recipientDeviceId: String(row.recipient_device_id),
  accountId: String(row.account_id),
  accountName: String(row.account_name),
  chatgptAccountId: String(row.chatgpt_account_id),
  grantEpoch: String(row.grant_epoch),
  createdAt: String(row.created_at),
  revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
});

/** Only the owning PC can issue tokens. Supabase stores references, never auth.json. */
export class CodexAccountSharing implements SharedCodexAccountProvider {
  private connection: Connection | undefined;
  private shares: CodexAccountShare[] = [];
  private devices: CodexSharingSnapshot["devices"] = [];
  private channels = new Map<string, ChannelEntry>();
  private pending = new Map<string, Pending>();
  private responses = new Map<string, Promise<ShareReply>>();
  private inflight = new Map<string, Promise<unknown>>();
  private cache = new Map<string, SharedCodexTokens>();
  private quotas = new Map<string, OpenAIAccountQuota>();
  private states = new Map<string, Pick<SharedCodexAccountSource, "state" | "error">>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshWork: Promise<void> | undefined;
  private error: string | undefined;

  constructor(private readonly options: CodexAccountSharingOptions) {}

  async connect(connection: Connection): Promise<void> {
    this.disconnect();
    this.connection = connection;
    await this.refresh();
    if (this.connection !== connection) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.options.pollMs ?? 10_000);
    this.timer.unref?.();
  }

  disconnect(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const connection = this.connection;
    for (const share of this.shares) {
      if (share.recipientDeviceId === connection?.deviceId)
        this.options.invalidated?.(sharedCodexAccountId(share.id));
    }
    this.connection = undefined;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("同步服务已断开，请重新连接后领取账号凭据。"));
    }
    this.pending.clear();
    for (const entry of this.channels.values())
      void connection?.client.removeChannel(entry.channel).catch(() => {});
    this.channels.clear();
    this.shares = [];
    this.devices = [];
    this.cache.clear();
    this.quotas.clear();
    this.states.clear();
    this.responses.clear();
    this.inflight.clear();
    this.refreshWork = undefined;
    this.error = undefined;
    this.options.changed();
  }

  snapshot(): CodexSharingSnapshot {
    const c = this.connection;
    return {
      connected: Boolean(c),
      deviceId: c?.deviceId ?? null,
      deviceName: c?.deviceName ?? "",
      devices: this.devices.map((d) => ({ ...d, online: c?.onlineDeviceIds().has(d.id) ?? false })),
      shares: this.shares.map((s) => ({ ...s })),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  refresh(): Promise<void> {
    if (this.refreshWork) return this.refreshWork;
    const work = this.refreshOnce();
    this.refreshWork = work;
    void work.finally(() => {
      if (this.refreshWork === work) this.refreshWork = undefined;
    });
    return work;
  }

  private async refreshOnce(): Promise<void> {
    const c = this.connection;
    if (!c) return;
    try {
      const [grants, devices, localAccounts] = await Promise.all([
        c.client.from("codex_account_shares").select("*"),
        c.client.from("devices_public").select("id,name,kind,disabled_at"),
        this.options.localAccounts(),
      ]);
      if (this.connection !== c) return;
      if (grants.error)
        throw new Error(
          grants.error.code === "42P01" || grants.error.code === "PGRST205"
            ? "同步服务尚未安装 PC 账号共享更新，请在同步服务部署页更新后重试。"
            : grants.error.message,
        );
      if (devices.error) throw new Error(devices.error.message);
      const previous = this.shares;
      const next = (grants.data ?? []).map(readShare);
      // An account may have been deleted while disconnected. Revoke its grants
      // when this host reconnects instead of leaving a permanently broken share.
      const localIds = new Set(localAccounts.map((account) => account.id));
      const orphaned = new Map(
        next
          .filter((s) => s.ownerDeviceId === c.deviceId && !s.revokedAt && !localIds.has(s.accountId))
          .map((s) => [s.accountId, s]),
      );
      for (const share of orphaned.values()) {
        const { error } = await c.client.rpc("eco_set_codex_account_shares", {
          p_account_id: share.accountId,
          p_account_name: share.accountName,
          p_chatgpt_account_id: share.chatgptAccountId,
          p_device_ids: [],
        });
        if (error) throw new Error("本机已删除账号，但同步服务未能撤销共享授权，请检查连接后重试。");
        if (this.connection !== c) return;
        for (const candidate of next)
          if (candidate.ownerDeviceId === c.deviceId && candidate.accountId === share.accountId)
            candidate.revokedAt ??= new Date().toISOString();
      }
      this.shares = next;
      this.devices = (devices.data ?? [])
        .filter((d) => d.kind === "desktop" && !d.disabled_at)
        .map((d) => ({ id: d.id, name: d.name, online: false }));
      this.error = undefined;
      for (const old of previous) {
        const current = next.find((s) => s.id === old.id);
        if (!current || (current.revokedAt && !old.revokedAt) || current.grantEpoch !== old.grantEpoch)
          this.invalidate(old.id);
      }
      for (const share of next) {
        const old = previous.find((s) => s.id === share.id);
        if (!share.revokedAt && (old?.revokedAt || (old && old.grantEpoch !== share.grantEpoch)))
          this.states.delete(share.id);
        if (!share.revokedAt && !this.channels.has(share.id)) {
          // One broken grant must not prevent the other accounts from working.
          void this.subscribe(c, share).catch(() => {
            if (
              this.connection === c &&
              this.shares.some((s) => s.id === share.id && s.grantEpoch === share.grantEpoch && !s.revokedAt)
            ) {
              this.states.set(share.id, { state: "error", error: "账号通信连接失败，请重试。" });
              this.options.changed();
            }
          });
        }
      }
    } catch (error) {
      if (this.connection !== c) return;
      this.error = error instanceof Error ? error.message : "无法读取账号共享授权。";
    }
    if (this.connection === c) this.options.changed();
  }

  private invalidate(shareId: string): void {
    this.options.invalidated?.(sharedCodexAccountId(shareId));
    this.cache.delete(shareId);
    this.quotas.delete(shareId);
    const prefix = `${sharedCodexAccountId(shareId)}:`;
    for (const key of this.inflight.keys()) if (key.startsWith(prefix)) this.inflight.delete(key);
    this.states.set(shareId, { state: "revoked" });
    const entry = this.channels.get(shareId);
    this.channels.delete(shareId);
    if (entry) void this.connection?.client.removeChannel(entry.channel).catch(() => {});
    for (const [id, pending] of this.pending) {
      if (pending.shareId !== shareId) continue;
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(new Error("此设备的账号使用授权已取消。"));
    }
  }

  async save(accountId: string, deviceIds: string[]): Promise<CodexSharingSnapshot> {
    const c = this.requireConnection();
    const account = (await this.options.localAccounts()).find((a) => a.id === accountId && !a.sharedSource);
    if (!account) throw new Error("只能共享本机管理的 Codex 账号。");
    const existing = this.shares.find((s) => s.ownerDeviceId === c.deviceId && s.accountId === accountId);
    const identity =
      deviceIds.length === 0 && existing
        ? existing.chatgptAccountId
        : await this.options.accountIdentity(accountId);
    const { error } = await c.client.rpc("eco_set_codex_account_shares", {
      p_account_id: accountId,
      p_account_name: account.name,
      p_chatgpt_account_id: identity,
      p_device_ids: deviceIds,
    });
    if (error) throw new Error(error.message);
    if (this.connection !== c) throw new Error("同步服务连接已变更，请重新操作。");
    // Re-read even if a poll started before this mutation committed.
    await this.refresh();
    await this.refresh();
    if (this.connection !== c) throw new Error("同步服务连接已变更，请重新操作。");
    return this.snapshot();
  }

  async revokeAccount(accountId: string): Promise<void> {
    const owned = this.shares.filter(
      (s) => s.ownerDeviceId === this.connection?.deviceId && s.accountId === accountId && !s.revokedAt,
    );
    if (owned.length) await this.save(accountId, []);
  }

  private requireConnection(): Connection {
    if (!this.connection) throw new Error("请先连接 Supabase 同步服务，并在各台 PC 登录同一个账号。");
    return this.connection;
  }

  private async validate(c: Connection, share: CodexAccountShare): Promise<void> {
    const { data, error } = await c.client
      .from("codex_account_shares")
      .select("*")
      .eq("id", share.id)
      .maybeSingle();
    if (this.connection !== c) throw new Error("同步服务连接已变更。");
    if (error) throw new Error("无法验证账号共享授权，请检查同步服务连接。");
    if (
      !data ||
      data.revoked_at ||
      data.grant_epoch !== share.grantEpoch ||
      data.owner_device_id !== share.ownerDeviceId ||
      data.recipient_device_id !== share.recipientDeviceId ||
      data.account_id !== share.accountId ||
      data.chatgpt_account_id !== share.chatgptAccountId
    ) {
      // A response from an old epoch must not tear down a newly restored grant.
      const current = this.shares.find((s) => s.id === share.id);
      if (!current || current.grantEpoch === share.grantEpoch) {
        this.invalidate(share.id);
        this.options.changed();
      }
      throw new Error("此设备的账号使用授权已取消或变更。");
    }
  }

  private subscribe(c: Connection, share: CodexAccountShare): Promise<void> {
    const existing = this.channels.get(share.id);
    if (existing) return existing.ready;
    const channel = c.client.channel(`eco:codex:${share.id}`, {
      config: { private: true, broadcast: { self: false, ack: true } },
    });
    let entry: ChannelEntry;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("账号通信连接超时。")), 8_000);
      channel.on("broadcast", { event: EVENT }, ({ payload }) => {
        void this.receive(c, share, payload);
      });
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          clearTimeout(timer);
          reject(new Error("账号通信连接中断。"));
          if (this.channels.get(share.id) === entry) {
            this.channels.delete(share.id);
            void c.client.removeChannel(channel).catch(() => {});
          }
        }
      });
    });
    entry = { channel, ready, epoch: share.grantEpoch };
    this.channels.set(share.id, entry);
    void ready.catch(() => {
      if (this.channels.get(share.id) === entry) this.channels.delete(share.id);
      void c.client.removeChannel(channel).catch(() => {});
    });
    return ready;
  }

  private async receive(c: Connection, share: CodexAccountShare, payload: unknown): Promise<void> {
    if (this.connection !== c || !payload || typeof payload !== "object") return;
    const message = payload as Partial<ShareReply>;
    if (c.deviceId === share.ownerDeviceId) {
      const parsed = requestSchema.safeParse(payload);
      if (!parsed.success || parsed.data.epoch !== share.grantEpoch) return;
      const request = parsed.data;
      const key = `${share.id}:${request.id}`;
      let response = this.responses.get(key);
      if (!response) {
        if (this.responses.size >= 1_000) return;
        response = this.issue(c, share, request);
        this.responses.set(key, response);
        const timer = setTimeout(() => this.responses.delete(key), 60_000);
        timer.unref?.();
      }
      const result = await response;
      // Recheck after a slow refresh: a grant may have been revoked meanwhile.
      try {
        await this.validate(c, share);
        await this.channels.get(share.id)?.channel.send({ type: "broadcast", event: EVENT, payload: result });
      } catch {
        /* Revoked/disconnected endpoints receive no credentials. */
      }
      return;
    }
    if (message.kind !== "response" || typeof message.id !== "string" || message.epoch !== share.grantEpoch)
      return;
    const pending = this.pending.get(message.id);
    if (!pending || pending.shareId !== share.id || pending.epoch !== share.grantEpoch) return;
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error) {
      const authRequired = message.error === "reauthorization_required";
      const error = authRequired
        ? "请在主设备上重新登录此 Codex 账号。"
        : "主设备未能提供账号凭据，请在主设备检查账号状态后重试。";
      if (authRequired) {
        this.cache.delete(share.id);
        this.options.invalidated?.(sharedCodexAccountId(share.id));
      }
      this.states.set(share.id, { state: authRequired ? "reauthorization_required" : "error", error });
      this.options.changed();
      pending.reject(new Error(error));
    } else pending.resolve(message.result);
  }

  private async issue(c: Connection, share: CodexAccountShare, request: ShareRequest): Promise<ShareReply> {
    const base = { kind: "response" as const, id: request.id, epoch: request.epoch };
    try {
      await this.validate(c, share);
      // The channel's immutable grant chooses the account; messages cannot choose another.
      if (request.operation === "quota")
        return { ...base, result: await this.options.quota(share.accountId) };
      const tokens = tokensSchema.parse(await this.options.tokens(share.accountId, request.knownVersion));
      if (tokens.chatgptAccountId !== share.chatgptAccountId) throw new Error("reauthorization_required");
      return { ...base, result: tokens };
    } catch (error) {
      // Never forward raw upstream errors that may contain private auth material.
      const reauth =
        /reauthorization|required.*login|重新登录|invalid_grant|refresh_token_(expired|reused|invalidated)/i.test(
          error instanceof Error ? error.message : "",
        );
      return { ...base, error: reauth ? "reauthorization_required" : "failed" };
    }
  }

  private async request(
    share: CodexAccountShare,
    operation: "tokens" | "quota",
    knownVersion?: string,
  ): Promise<unknown> {
    const c = this.requireConnection();
    await this.validate(c, share);
    await this.subscribe(c, share);
    if (this.connection !== c) throw new Error("同步服务连接已变更。");
    const channel = this.channels.get(share.id)?.channel;
    if (!channel) throw new Error("账号通信连接尚未建立，请重试。");
    const id = randomUUID();
    const payload: ShareRequest = {
      kind: "request",
      id,
      epoch: share.grantEpoch,
      operation,
      ...(knownVersion ? { knownVersion } : {}),
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.pending.delete(id);
          cleanup();
          reject(new Error("主设备未响应，请确认主设备上的 Mori 正在运行且已联网。"));
        },
        knownVersion ? 8_000 : 35_000,
      );
      const send = () => {
        void channel.send({ type: "broadcast", event: EVENT, payload }).catch(() => {});
      };
      // Broadcast has no offline queue. Retransmission covers startup/reconnect;
      // the request ID and the owner's account queue prevent duplicate refreshes.
      const retry = setInterval(send, 1_000);
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(retry);
      };
      this.pending.set(id, { shareId: share.id, epoch: share.grantEpoch, resolve, reject, cleanup });
      send();
    });
  }

  sharedDeviceCount(accountId: string): number {
    return this.shares.filter(
      (s) => s.ownerDeviceId === this.connection?.deviceId && s.accountId === accountId && !s.revokedAt,
    ).length;
  }

  listAccounts(): OpenAIAccount[] {
    const c = this.connection;
    if (!c) return [];
    return this.shares
      .filter((s) => s.recipientDeviceId === c.deviceId)
      .map((share) => {
        const cached = this.cache.get(share.id);
        const valid = Boolean(cached && cached.expiresAt > Date.now());
        const online = c.onlineDeviceIds().has(share.ownerDeviceId);
        const sourceState = this.states.get(share.id);
        const revoked = Boolean(share.revokedAt) || sourceState?.state === "revoked";
        const reauth = sourceState?.state === "reauthorization_required";
        const quota = this.quotas.get(share.id);
        return {
          id: sharedCodexAccountId(share.id),
          name: share.accountName,
          createdAt: share.createdAt,
          proxyMode: "system",
          hasProfileData: false,
          webAuthState: "missing",
          imageGenerationEnabled: false,
          isLoggedIn: valid && !revoked && !reauth,
          authState: revoked
            ? "missing"
            : reauth
              ? "reauthorization_required"
              : valid
                ? "configured"
                : online
                  ? "refreshable"
                  : "expired",
          sharedSource: {
            shareId: share.id,
            ownerDeviceId: share.ownerDeviceId,
            ownerDeviceName: this.devices.find((d) => d.id === share.ownerDeviceId)?.name ?? "主设备",
            online,
            state: revoked
              ? "revoked"
              : sourceState?.state === "requesting"
                ? "requesting"
                : reauth
                  ? "reauthorization_required"
                  : !online
                    ? "offline"
                    : (sourceState?.state ?? "ready"),
            ...(cached ? { expiresAt: cached.expiresAt } : {}),
            ...(sourceState?.error ? { error: sourceState.error } : {}),
          },
          ...(quota ? { quota } : {}),
        };
      });
  }

  private findShare(accountId: string): CodexAccountShare {
    const c = this.requireConnection();
    const share = this.shares.find(
      (s) => sharedCodexAccountId(s.id) === accountId && s.recipientDeviceId === c.deviceId,
    );
    if (!share || share.revokedAt || this.states.get(share.id)?.state === "revoked")
      throw new Error("此设备的账号使用授权已取消。");
    return share;
  }

  getTokens(accountId: string, previousAccessToken?: string): Promise<SharedCodexTokens> {
    const key = `${accountId}:tokens:${previousAccessToken ? tokenVersion(previousAccessToken) : ""}`;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<SharedCodexTokens>;
    const work = this.getTokensOnce(accountId, previousAccessToken);
    this.inflight.set(key, work);
    void work
      .finally(() => {
        if (this.inflight.get(key) === work) this.inflight.delete(key);
      })
      .catch(() => {});
    return work;
  }

  private async getTokensOnce(accountId: string, previousAccessToken?: string): Promise<SharedCodexTokens> {
    const share = this.findShare(accountId);
    const c = this.requireConnection();
    await this.validate(c, share);
    const cached = this.cache.get(share.id);
    if (cached && cached.expiresAt > Date.now() && cached.accessToken !== previousAccessToken)
      return { ...cached };
    this.states.set(share.id, { state: "requesting" });
    this.options.changed();
    try {
      const tokens = tokensSchema.parse(
        await this.request(
          share,
          "tokens",
          previousAccessToken ? tokenVersion(previousAccessToken) : undefined,
        ),
      );
      await this.validate(c, share);
      if (
        tokens.chatgptAccountId !== share.chatgptAccountId ||
        tokens.version !== tokenVersion(tokens.accessToken) ||
        tokens.expiresAt <= Date.now() ||
        tokens.accessToken === previousAccessToken
      )
        throw new Error("主设备未返回有效的新凭据，请重试。");
      const normalized: SharedCodexTokens = {
        accessToken: tokens.accessToken,
        chatgptAccountId: tokens.chatgptAccountId,
        expiresAt: tokens.expiresAt,
        version: tokens.version,
        ...(tokens.chatgptPlanType ? { chatgptPlanType: tokens.chatgptPlanType } : {}),
      };
      this.cache.set(share.id, normalized);
      this.states.set(share.id, { state: "ready" });
      return { ...normalized };
    } catch (error) {
      if (
        this.connection === c &&
        this.shares.some((s) => s.id === share.id && s.grantEpoch === share.grantEpoch) &&
        this.states.get(share.id)?.state === "requesting"
      )
        this.states.set(share.id, {
          state: "error",
          error: error instanceof Error ? error.message : "领取凭据失败。",
        });
      throw error;
    } finally {
      this.options.changed();
    }
  }

  async queryQuota(accountId: string): Promise<OpenAIAccountQuota> {
    const share = this.findShare(accountId);
    const c = this.requireConnection();
    const result = (await this.request(share, "quota")) as OpenAIAccountQuota;
    await this.validate(c, share);
    if (
      !result ||
      typeof result.planType !== "string" ||
      !Number.isFinite(result.fetchedAt) ||
      !result.rateLimit ||
      typeof result.rateLimit.allowed !== "boolean"
    )
      throw new Error("主设备返回的额度信息无效。");
    this.quotas.set(share.id, result);
    this.options.changed();
    return result;
  }
}
