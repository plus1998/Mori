/**
 * Desktop Supabase Realtime Presence + bind-channel JSON-RPC (Track D).
 *
 * Presence: private `eco:user:{userId}`
 * RPC: private `eco:bind:{bindingId}` for each active binding of this desktop device
 */

import {
  buildEcoBindTopic,
  buildEcoJsonRpcFailure,
  buildEcoJsonRpcSuccess,
  buildEcoUserTopic,
  ECO_REALTIME_BROADCAST_EVENT,
  ECO_REALTIME_BINDINGS_CHANGED_EVENT,
  ECO_REALTIME_BINDING_READY_EVENT,
  ECO_RPC_ERROR,
  ECO_RPC_METHODS,
  type EcoJsonRpcMessage,
  type EcoJsonRpcResponse,
  isEcoJsonRpcMessage,
  isEcoJsonRpcNotification,
  isEcoJsonRpcRequest,
  isEcoJsonRpcResponse,
  unwrapEcoRpcFromBroadcast,
  wrapEcoRpcForBroadcast,
} from "@eco/shared";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { CenterServerDeviceBindingView } from "../shared/center-server";
import type { EventCenterJsonRpcNotification } from "../shared/event-center";
import type { DesktopEventCenter } from "./event-center";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CHANNEL_SUBSCRIBE_TIMEOUT_MS = 10_000;

export interface SupabaseRealtimeRpcOptions {
  client: SupabaseClient;
  eventCenter: DesktopEventCenter;
  log?: (message: string) => void;
  now?: () => Date;
  requestTimeoutMs?: number;
  /** Notify the owner after an already-subscribed channel becomes unhealthy. */
  onTransportUnhealthy?: (error: Error) => void;
  onBindingsChanged?: () => void | Promise<void>;
}

export interface SupabaseRealtimeRpcStartInput {
  userId: string;
  deviceId: string;
}

export interface EcoPresenceDeviceState {
  deviceId: string;
  deviceKind?: string;
  online?: boolean;
  connectedAt?: string;
  lastSeenAt?: string;
}

interface BindChannelEntry {
  channel: RealtimeChannel;
  mobileDeviceId: string;
  ready: Promise<void>;
  capabilities: string[];
}

interface PendingRequest {
  resolve: (response: EcoJsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Unwrap Broadcast callback payload (envelope may be nested under `.payload`). */
export function extractEcoRpcFromBroadcastPayload(payload: unknown): EcoJsonRpcMessage | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const raw = record.payload !== undefined ? record.payload : payload;
  const unwrapped = unwrapEcoRpcFromBroadcast(raw);
  if (unwrapped) {
    return unwrapped;
  }
  return isEcoJsonRpcMessage(raw) ? raw : null;
}

export function bindingHasEventsRead(capabilities: readonly string[]): boolean {
  return capabilities.includes("events:read");
}

export function bindingCanInvoke(capabilities: readonly string[]): boolean {
  return capabilities.includes("rpc:invoke");
}

export function invokeTargetsDesktop(message: EcoJsonRpcMessage, desktopDeviceId: string): boolean {
  if (!isEcoJsonRpcRequest(message) || message.method !== ECO_RPC_METHODS.invoke) {
    return true;
  }
  const params = message.params;
  if (!params || typeof params !== "object") {
    return false;
  }
  return (
    "desktopDeviceId" in params &&
    typeof params.desktopDeviceId === "string" &&
    params.desktopDeviceId === desktopDeviceId
  );
}

export class SupabaseRealtimeRpc {
  private readonly client: SupabaseClient;
  private readonly eventCenter: DesktopEventCenter;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly onTransportUnhealthy: ((error: Error) => void) | undefined;
  private readonly onBindingsChanged: (() => void | Promise<void>) | undefined;

  private userId: string | undefined;
  private deviceId: string | undefined;
  private userChannel: RealtimeChannel | undefined;
  private readonly bindChannels = new Map<string, BindChannelEntry>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly onlineDeviceIds = new Set<string>();
  private started = false;

  constructor(options: SupabaseRealtimeRpcOptions) {
    this.client = options.client;
    this.eventCenter = options.eventCenter;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onTransportUnhealthy = options.onTransportUnhealthy;
    this.onBindingsChanged = options.onBindingsChanged;
  }

  async start(input: SupabaseRealtimeRpcStartInput): Promise<void> {
    await this.stop();
    this.userId = input.userId;
    this.deviceId = input.deviceId;
    this.started = true;

    const topic = buildEcoUserTopic(input.userId);
    const channel = this.client.channel(topic, {
      config: {
        private: true,
        presence: { key: input.deviceId, enabled: true },
      },
    });

    channel.on("presence", { event: "sync" }, () => {
      this.refreshPresenceFromChannel(channel);
    });
    channel.on("presence", { event: "join" }, () => {
      this.refreshPresenceFromChannel(channel);
    });
    channel.on("presence", { event: "leave" }, () => {
      this.refreshPresenceFromChannel(channel);
    });
    channel.on("broadcast", { event: ECO_REALTIME_BINDINGS_CHANGED_EVENT }, ({ payload }) => {
      if (this.started && payload?.desktopDeviceId === this.deviceId) {
        void this.acknowledgeBindingReady(channel, payload).catch((error) => {
          this.log(`[eco] binding discovery failed: ${errorMessage(error)}\n`);
        });
      }
    });

    this.userChannel = channel;
    try {
      await this.subscribeChannel(channel, topic, async () => {
        const trackedAt = this.now().toISOString();
        const trackResult = await channel.track({
          deviceId: input.deviceId,
          deviceKind: "desktop",
          online: true,
          connectedAt: trackedAt,
          lastSeenAt: trackedAt,
        });
        if (trackResult !== "ok") {
          throw new Error(`Realtime presence track failed on ${topic}: ${trackResult}`);
        }
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.rejectAllPending(new Error("Realtime session stopped."));
    this.onlineDeviceIds.clear();

    const bindIds = [...this.bindChannels.keys()];
    for (const bindingId of bindIds) {
      await this.dropBindChannel(bindingId);
    }

    if (this.userChannel) {
      try {
        await this.client.removeChannel(this.userChannel);
      } catch (error) {
        this.log(`[eco] presence unsubscribe failed: ${errorMessage(error)}\n`);
      }
      this.userChannel = undefined;
    }

    this.userId = undefined;
    this.deviceId = undefined;
  }

  async syncBindings(bindings: readonly CenterServerDeviceBindingView[]): Promise<void> {
    if (!this.started || !this.deviceId) {
      return;
    }

    const active = bindings.filter(
      (binding) =>
        !binding.revokedAt &&
        binding.desktopDeviceId === this.deviceId &&
        typeof binding.id === "string" &&
        binding.id.length > 0,
    );
    const nextIds = new Set(active.map((binding) => binding.id));

    for (const bindingId of [...this.bindChannels.keys()]) {
      if (!nextIds.has(bindingId)) {
        await this.dropBindChannel(bindingId);
      }
    }

    for (const binding of active) {
      const existing = this.bindChannels.get(binding.id);
      if (existing) {
        existing.capabilities = [...binding.capabilities];
        existing.mobileDeviceId = binding.mobileDeviceId;
        await existing.ready;
        continue;
      }
      await this.subscribeBindChannel(binding);
    }
  }

  /**
   * Broadcast a JSON-RPC message on a bind channel.
   * Requests with an `id` wait for a matching response (pending map + timeout).
   */
  async sendOnBinding(
    bindingId: string,
    message: EcoJsonRpcMessage,
    options?: { timeoutMs?: number },
  ): Promise<EcoJsonRpcResponse | undefined> {
    const entry = this.bindChannels.get(bindingId);
    if (!entry) {
      throw new Error(`No active Realtime bind channel for binding ${bindingId}.`);
    }
    // RPC replies require the live socket. SDK HTTP Broadcast would hide a
    // disconnected channel and publish data with no return path.
    if (entry.channel.state !== "joined" || !this.client.realtime.isConnected()) {
      throw new Error(`Realtime bind channel ${bindingId} is not connected.`);
    }

    const isRequest = isEcoJsonRpcRequest(message);
    const requestId =
      isRequest && message.id !== undefined && message.id !== null ? String(message.id) : undefined;

    let pendingPromise: Promise<EcoJsonRpcResponse> | undefined;
    if (requestId) {
      pendingPromise = new Promise<EcoJsonRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`Realtime RPC timed out for id=${requestId}`));
        }, options?.timeoutMs ?? this.requestTimeoutMs);
        this.pending.set(requestId, { resolve, reject, timer });
      });
    }

    const envelope = wrapEcoRpcForBroadcast(message);
    let result: Awaited<ReturnType<RealtimeChannel["send"]>>;
    try {
      result = await entry.channel.send({
        type: "broadcast",
        event: ECO_REALTIME_BROADCAST_EVENT,
        payload: envelope,
      });
    } catch (error) {
      this.discardPending(requestId);
      throw error;
    }
    if (result !== "ok") {
      this.discardPending(requestId);
      throw new Error(`Realtime broadcast send failed: ${result}`);
    }

    return pendingPromise;
  }

  /** Fan-out `eco.event` notifications to bind channels with `events:read`. */
  publishNotification(notification: EventCenterJsonRpcNotification): void {
    for (const [bindingId, entry] of this.bindChannels) {
      if (
        !bindingHasEventsRead(entry.capabilities) ||
        !this.onlineDeviceIds.has(entry.mobileDeviceId)
      ) {
        continue;
      }
      void this.sendOnBinding(bindingId, notification).catch((error) => {
        this.log(`[eco] publish to bind ${bindingId} failed: ${errorMessage(error)}\n`);
      });
    }
  }

  listOnlineDeviceIds(): ReadonlySet<string> {
    return this.onlineDeviceIds;
  }

  getPresenceDevices(): EcoPresenceDeviceState[] {
    if (!this.userChannel) {
      return [];
    }
    return collectPresenceDevices(this.userChannel.presenceState());
  }

  private async subscribeBindChannel(binding: CenterServerDeviceBindingView): Promise<void> {
    const topic = buildEcoBindTopic(binding.id);
    const channel = this.client.channel(topic, {
      config: {
        private: true,
        broadcast: { self: false },
      },
    });

    channel.on("broadcast", { event: ECO_REALTIME_BROADCAST_EVENT }, (payload) => {
      void this.handleBindBroadcast(binding.id, payload);
    });

    const entry: BindChannelEntry = {
      channel,
      mobileDeviceId: binding.mobileDeviceId,
      capabilities: [...binding.capabilities],
      ready: Promise.resolve(),
    };
    this.bindChannels.set(binding.id, entry);

    try {
      entry.ready = this.subscribeChannel(channel, topic);
      await entry.ready;
    } catch (error) {
      this.bindChannels.delete(binding.id);
      await this.client.removeChannel(channel).catch((removeError) => {
        this.log(`[eco] failed channel cleanup ${topic}: ${errorMessage(removeError)}\n`);
      });
      throw error;
    }
  }

  private async acknowledgeBindingReady(channel: RealtimeChannel, payload: Record<string, unknown>): Promise<void> {
    await this.onBindingsChanged?.();
    const bindingId = payload.bindingId;
    const requestId = payload.requestId;
    if (typeof bindingId !== "string" || typeof requestId !== "string") return;
    const entry = this.bindChannels.get(bindingId);
    if (!entry || entry.mobileDeviceId !== payload.mobileDeviceId) return;
    await entry.ready;
    if (!this.started || channel !== this.userChannel || channel.state !== "joined" ||
      !this.client.realtime.isConnected() || this.bindChannels.get(bindingId) !== entry) return;
    const result = await channel.send({
      type: "broadcast", event: ECO_REALTIME_BINDING_READY_EVENT,
      payload: { desktopDeviceId: this.deviceId, mobileDeviceId: entry.mobileDeviceId, bindingId, requestId },
    });
    if (result !== "ok") throw new Error(`Binding readiness acknowledgement failed: ${result}`);
  }

  private subscribeChannel(
    channel: RealtimeChannel,
    topic: string,
    onSubscribed?: () => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let subscribed = false;
      let initialSettled = false;
      let handlingSubscribed = false;
      const settleInitialFailure = (failure: Error) => {
        if (initialSettled) {
          return false;
        }
        initialSettled = true;
        clearTimeout(timeout);
        reject(failure);
        return true;
      };
      const timeout = setTimeout(() => {
        settleInitialFailure(new Error(`Realtime channel ${topic} did not subscribe within 10 seconds.`));
      }, CHANNEL_SUBSCRIBE_TIMEOUT_MS);

      channel.subscribe((status, error) => {
        if (status === "SUBSCRIBED") {
          if (handlingSubscribed) {
            return;
          }
          handlingSubscribed = true;
          void (async () => {
            try {
              await onSubscribed?.();
              subscribed = true;
              if (!initialSettled) {
                initialSettled = true;
                clearTimeout(timeout);
                resolve();
              }
            } catch (subscribedError) {
              const failure =
                subscribedError instanceof Error ? subscribedError : new Error(String(subscribedError));
              if (!settleInitialFailure(failure)) {
                this.reportTransportUnhealthy(failure);
              }
            } finally {
              handlingSubscribed = false;
            }
          })();
          return;
        }
        if (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT" && status !== "CLOSED") {
          return;
        }
        const failure = new Error(
          `Realtime channel ${topic} status=${status}${error ? `: ${error.message}` : ""}`,
        );
        // removeChannel emits CLOSED too. A deliberately removed binding must
        // not trigger full transport recovery for the remaining devices.
        if (initialSettled && channel !== this.userChannel &&
          ![...this.bindChannels.values()].some((entry) => entry.channel === channel)) {
          return;
        }
        if (!subscribed && settleInitialFailure(failure)) {
          return;
        }
        this.reportTransportUnhealthy(failure);
      });
    });
  }

  private reportTransportUnhealthy(error: Error): void {
    if (!this.started) {
      return;
    }
    this.log(`[eco] ${error.message}\n`);
    this.rejectAllPending(error);
    this.onTransportUnhealthy?.(error);
  }

  private async dropBindChannel(bindingId: string): Promise<void> {
    const entry = this.bindChannels.get(bindingId);
    if (!entry) {
      return;
    }
    this.bindChannels.delete(bindingId);
    try {
      await this.client.removeChannel(entry.channel);
    } catch (error) {
      this.log(`[eco] bind unsubscribe failed (${bindingId}): ${errorMessage(error)}\n`);
    }
  }

  private async handleBindBroadcast(bindingId: string, payload: unknown): Promise<void> {
    const message = extractEcoRpcFromBroadcastPayload(payload);
    if (!message) {
      return;
    }

    if (isEcoJsonRpcResponse(message)) {
      const requestId = message.id === undefined || message.id === null ? undefined : String(message.id);
      if (requestId) {
        const pending = this.pending.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(requestId);
          pending.resolve(message);
        }
      }
      return;
    }

    if (isEcoJsonRpcNotification(message)) {
      // Desktop is the event publisher; ignore peer eco.event (and other) notifications.
      if (message.method === ECO_RPC_METHODS.event) {
        return;
      }
      return;
    }

    if (!isEcoJsonRpcRequest(message)) {
      return;
    }

    if (message.method === ECO_RPC_METHODS.ping) {
      const response = buildEcoJsonRpcSuccess(message.id ?? null, { ok: true });
      await this.sendOnBinding(bindingId, response).catch((error) => {
        this.log(`[eco] ping reply failed: ${errorMessage(error)}\n`);
      });
      return;
    }

    if (message.method === ECO_RPC_METHODS.invoke) {
      const entry = this.bindChannels.get(bindingId);
      if (!entry || !bindingCanInvoke(entry.capabilities)) {
        const response = buildEcoJsonRpcFailure(
          message.id ?? null,
          ECO_RPC_ERROR.forbidden,
          "Binding does not grant rpc:invoke.",
        );
        await this.sendOnBinding(bindingId, response).catch((error) => {
          this.log(`[eco] forbidden invoke reply failed: ${errorMessage(error)}\n`);
        });
        return;
      }
      if (!this.deviceId || !invokeTargetsDesktop(message, this.deviceId)) {
        const response = buildEcoJsonRpcFailure(
          message.id ?? null,
          ECO_RPC_ERROR.forbidden,
          "Invoke target does not match this desktop device.",
        );
        await this.sendOnBinding(bindingId, response).catch((error) => {
          this.log(`[eco] mismatched invoke target reply failed: ${errorMessage(error)}\n`);
        });
        return;
      }
      let response: EcoJsonRpcResponse | undefined;
      try {
        response = await this.eventCenter.handleJsonRpcMessage(message);
      } catch (error) {
        response = buildEcoJsonRpcFailure(
          message.id ?? null,
          ECO_RPC_ERROR.internalError,
          errorMessage(error),
        );
      }
      if (response) {
        await this.sendOnBinding(bindingId, response).catch((error) => {
          this.log(`[eco] invoke reply failed: ${errorMessage(error)}\n`);
        });
      }
      return;
    }

    if (message.id !== undefined) {
      const response = buildEcoJsonRpcFailure(
        message.id ?? null,
        ECO_RPC_ERROR.methodNotFound,
        `Unsupported Realtime RPC method: ${message.method}`,
      );
      await this.sendOnBinding(bindingId, response).catch(() => {});
    }
  }

  private refreshPresenceFromChannel(channel: RealtimeChannel): void {
    this.onlineDeviceIds.clear();
    for (const device of collectPresenceDevices(channel.presenceState())) {
      if (device.deviceId && device.online !== false) {
        this.onlineDeviceIds.add(device.deviceId);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private discardPending(requestId: string | undefined): void {
    if (!requestId) {
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
  }
}

function collectPresenceDevices(
  state: Record<string, Array<{ [key: string]: unknown }>>,
): EcoPresenceDeviceState[] {
  const devices: EcoPresenceDeviceState[] = [];
  for (const metas of Object.values(state)) {
    for (const meta of metas) {
      const deviceId =
        typeof meta.deviceId === "string"
          ? meta.deviceId
          : typeof meta.device_id === "string"
            ? meta.device_id
            : undefined;
      if (!deviceId) {
        continue;
      }
      devices.push({
        deviceId,
        ...(typeof meta.deviceKind === "string"
          ? { deviceKind: meta.deviceKind }
          : typeof meta.device_kind === "string"
            ? { deviceKind: meta.device_kind }
            : {}),
        ...(typeof meta.online === "boolean" ? { online: meta.online } : { online: true }),
        ...(typeof meta.connectedAt === "string"
          ? { connectedAt: meta.connectedAt }
          : typeof meta.connected_at === "string"
            ? { connectedAt: meta.connected_at }
            : {}),
        ...(typeof meta.lastSeenAt === "string"
          ? { lastSeenAt: meta.lastSeenAt }
          : typeof meta.last_seen_at === "string"
            ? { lastSeenAt: meta.last_seen_at }
            : {}),
      });
    }
  }
  return devices;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
