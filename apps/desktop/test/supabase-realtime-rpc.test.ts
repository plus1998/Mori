import { expect, test } from "bun:test";
import {
  ECO_JSON_RPC_VERSION,
  ECO_REALTIME_BROADCAST_EVENT,
  ECO_RPC_METHODS,
  wrapEcoRpcForBroadcast,
} from "@eco/shared";
import { DesktopEventCenter } from "../src/main/event-center";
import {
  bindingCanInvoke,
  bindingHasEventsRead,
  extractEcoRpcFromBroadcastPayload,
  invokeTargetsDesktop,
  SupabaseRealtimeRpc,
} from "../src/main/supabase-realtime-rpc";
import { IPC_CHANNELS } from "../src/shared/ipc";

test("extractEcoRpcFromBroadcastPayload unwraps nested and flat envelopes", () => {
  const message = {
    jsonrpc: ECO_JSON_RPC_VERSION,
    id: "ping_1",
    method: ECO_RPC_METHODS.ping,
    params: {},
  };
  const envelope = wrapEcoRpcForBroadcast(message);

  expect(extractEcoRpcFromBroadcastPayload({ payload: envelope })).toEqual(message);
  expect(
    extractEcoRpcFromBroadcastPayload({
      type: "broadcast",
      event: ECO_REALTIME_BROADCAST_EVENT,
      payload: envelope,
    }),
  ).toEqual(message);
  expect(extractEcoRpcFromBroadcastPayload(envelope)).toEqual(message);
  expect(extractEcoRpcFromBroadcastPayload({ junk: true })).toBeNull();
});

test("bindingHasEventsRead checks capability", () => {
  expect(bindingHasEventsRead(["rpc:invoke", "events:read"])).toBe(true);
  expect(bindingHasEventsRead(["rpc:invoke"])).toBe(false);
});

test("bindingCanInvoke requires rpc:invoke capability", () => {
  expect(bindingCanInvoke(["events:read", "rpc:invoke"])).toBe(true);
  expect(bindingCanInvoke(["events:read"])).toBe(false);
});

test("invokeTargetsDesktop rejects a different or missing desktop target", () => {
  const desktopDeviceId = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  expect(
    invokeTargetsDesktop(
      {
        jsonrpc: ECO_JSON_RPC_VERSION,
        id: "invoke_1",
        method: ECO_RPC_METHODS.invoke,
        params: { desktopDeviceId, channel: "thread:list", args: [] },
      },
      desktopDeviceId,
    ),
  ).toBe(true);
  expect(
    invokeTargetsDesktop(
      {
        jsonrpc: ECO_JSON_RPC_VERSION,
        id: "invoke_2",
        method: ECO_RPC_METHODS.invoke,
        params: {
          desktopDeviceId: "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          channel: "thread:list",
          args: [],
        },
      },
      desktopDeviceId,
    ),
  ).toBe(false);
  expect(
    invokeTargetsDesktop(
      {
        jsonrpc: ECO_JSON_RPC_VERSION,
        id: "invoke_3",
        method: ECO_RPC_METHODS.invoke,
        params: { channel: "thread:list", args: [] },
      },
      desktopDeviceId,
    ),
  ).toBe(false);
});

test("SupabaseRealtimeRpc rejects invoke addressed to another desktop", async () => {
  const callbacks = new Map<string, (status: string, error?: Error) => void>();
  const broadcastHandlers = new Map<string, (payload: unknown) => void>();
  const sent: unknown[] = [];
  const client = createRealtimeClient(callbacks, async () => "ok", broadcastHandlers, sent);
  let invoked = false;
  const realtime = new SupabaseRealtimeRpc({
    client: client as never,
    eventCenter: {
      async handleJsonRpcMessage() {
        invoked = true;
        return undefined;
      },
    } as never,
  });
  const desktopDeviceId = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const bindingId = "d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const presenceTopic = "eco:user:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const bindTopic = `eco:bind:${bindingId}`;

  const startPromise = realtime.start({
    userId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    deviceId: desktopDeviceId,
  });
  await Bun.sleep(0);
  callbacks.get(presenceTopic)?.("SUBSCRIBED");
  await startPromise;
  const syncPromise = realtime.syncBindings([
    {
      id: bindingId,
      userId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      desktopDeviceId,
      mobileDeviceId: "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      capabilities: ["rpc:invoke"],
      createdAt: "2030-01-01T00:00:00.000Z",
      revokedAt: null,
    },
  ]);
  await Bun.sleep(0);
  callbacks.get(bindTopic)?.("SUBSCRIBED");
  await syncPromise;

  broadcastHandlers.get(bindTopic)?.({
    payload: wrapEcoRpcForBroadcast({
      jsonrpc: ECO_JSON_RPC_VERSION,
      id: "invoke_wrong_target",
      method: ECO_RPC_METHODS.invoke,
      params: {
        desktopDeviceId: "e4eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        channel: "thread:list",
        args: [],
      },
    }),
  });
  await Bun.sleep(0);

  expect(invoked).toBe(false);
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent[0])).toContain("Invoke target does not match this desktop device.");
  await realtime.stop();
});

test("SupabaseRealtimeRpc carries a V2 command through EventCenter and returns its envelope", async () => {
  const callbacks = new Map<string, (status: string, error?: Error) => void>();
  const broadcastHandlers = new Map<string, (payload: unknown) => void>();
  const sent: unknown[] = [];
  const center = new DesktopEventCenter();
  center.registerCommand(IPC_CHANNELS.conversationHead, (args) => {
    expect(args).toEqual(["thread_1"]);
    return {
      protocolVersion: 2,
      storeEpoch: "epoch_1",
      conversationId: "thread_1",
      lastSeq: 9,
      historyRevision: 0,
    };
  });
  const client = createRealtimeClient(callbacks, async () => "ok", broadcastHandlers, sent);
  const realtime = new SupabaseRealtimeRpc({ client: client as never, eventCenter: center });
  const userId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const desktopDeviceId = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const mobileDeviceId = "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const bindingId = "d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const startPromise = realtime.start({ userId, deviceId: desktopDeviceId });
  await Bun.sleep(0);
  callbacks.get(`eco:user:${userId}`)?.("SUBSCRIBED");
  await startPromise;
  const syncPromise = realtime.syncBindings([
    {
      id: bindingId,
      userId,
      desktopDeviceId,
      mobileDeviceId,
      capabilities: ["rpc:invoke"],
      createdAt: "2030-01-01T00:00:00.000Z",
      revokedAt: null,
    },
  ]);
  await Bun.sleep(0);
  callbacks.get(`eco:bind:${bindingId}`)?.("SUBSCRIBED");
  await syncPromise;

  broadcastHandlers.get(`eco:bind:${bindingId}`)?.({
    payload: wrapEcoRpcForBroadcast({
      jsonrpc: ECO_JSON_RPC_VERSION,
      id: "conversation_head_1",
      method: ECO_RPC_METHODS.invoke,
      params: {
        desktopDeviceId,
        channel: IPC_CHANNELS.conversationHead,
        args: ["thread_1"],
      },
    }),
  });
  for (let attempt = 0; attempt < 20 && sent.length === 0; attempt += 1) {
    await Bun.sleep(1);
  }

  expect(sent).toHaveLength(1);
  expect(extractEcoRpcFromBroadcastPayload(sent[0])).toEqual({
    jsonrpc: ECO_JSON_RPC_VERSION,
    id: "conversation_head_1",
    result: {
      channel: IPC_CHANNELS.conversationHead,
      result: {
        protocolVersion: 2,
        storeEpoch: "epoch_1",
        conversationId: "thread_1",
        lastSeq: 9,
        historyRevision: 0,
      },
    },
  });
  await realtime.stop();
});

test("SupabaseRealtimeRpc clears request timeout state when broadcast send throws", async () => {
  const callbacks = new Map<string, (status: string, error?: Error) => void>();
  const realtime = new SupabaseRealtimeRpc({
    client: createRealtimeClient(
      callbacks,
      async () => "ok",
      new Map(),
      [],
      async () => {
        throw new Error("socket closed during send");
      },
    ) as never,
    eventCenter: {} as never,
    requestTimeoutMs: 10,
  });
  const userId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const desktopDeviceId = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const bindingId = "d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const startPromise = realtime.start({ userId, deviceId: desktopDeviceId });
  await Bun.sleep(0);
  callbacks.get(`eco:user:${userId}`)?.("SUBSCRIBED");
  await startPromise;
  const syncPromise = realtime.syncBindings([
    {
      id: bindingId,
      userId,
      desktopDeviceId,
      mobileDeviceId: "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      capabilities: ["rpc:invoke"],
      createdAt: "2030-01-01T00:00:00.000Z",
      revokedAt: null,
    },
  ]);
  await Bun.sleep(0);
  callbacks.get(`eco:bind:${bindingId}`)?.("SUBSCRIBED");
  await syncPromise;

  await expect(
    realtime.sendOnBinding(
      bindingId,
      {
        jsonrpc: ECO_JSON_RPC_VERSION,
        id: "send_failure_1",
        method: ECO_RPC_METHODS.ping,
        params: {},
      },
      { timeoutMs: 10 },
    ),
  ).rejects.toThrow("socket closed during send");
  await Bun.sleep(30);
  await realtime.stop();
});

test("SupabaseRealtimeRpc start waits for presence subscription and tracking", async () => {
  const callbacks = new Map<string, (status: string, error?: Error) => void>();
  let trackCalls = 0;
  const client = createRealtimeClient(callbacks, async () => {
    trackCalls += 1;
    return "ok";
  });
  const realtime = new SupabaseRealtimeRpc({
    client: client as never,
    eventCenter: {} as never,
  });

  let started = false;
  const startPromise = realtime
    .start({
      userId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      deviceId: "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    })
    .then(() => {
      started = true;
    });
  await Bun.sleep(0);
  expect(started).toBe(false);

  callbacks.get("eco:user:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")?.("SUBSCRIBED");
  await startPromise;
  expect(started).toBe(true);
  expect(trackCalls).toBe(1);

  callbacks.get("eco:user:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")?.("SUBSCRIBED");
  await Bun.sleep(0);
  expect(trackCalls).toBe(2);
  await realtime.stop();
});

test("SupabaseRealtimeRpc reports an unhealthy subscribed channel", async () => {
  const callbacks = new Map<string, (status: string, error?: Error) => void>();
  const failures: Error[] = [];
  const client = createRealtimeClient(callbacks, async () => "ok");
  const realtime = new SupabaseRealtimeRpc({
    client: client as never,
    eventCenter: {} as never,
    onTransportUnhealthy: (error) => failures.push(error),
  });
  const topic = "eco:user:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const startPromise = realtime.start({
    userId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    deviceId: "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  });
  await Bun.sleep(0);
  callbacks.get(topic)?.("SUBSCRIBED");
  await startPromise;

  callbacks.get(topic)?.("CHANNEL_ERROR", new Error("token expired"));
  expect(failures).toHaveLength(1);
  expect(failures[0]?.message).toContain("token expired");
  await realtime.stop();
});

test("SupabaseRealtimeRpc publishes only to online bound mobiles and never falls back to HTTP", async () => {
  const callbacks = new Map<string, (status: string, error?: Error) => void>();
  const broadcasts = new Map<string, (payload: unknown) => void>();
  const sent: unknown[] = [];
  const controls = {
    presence: {} as Record<string, Array<Record<string, unknown>>>,
    presenceHandlers: new Map<string, () => void>(),
    connected: true,
    state: "joined",
  };
  const userId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const desktopId = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const mobileId = "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const bindingId = "d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  let refreshes = 0;
  const failures: Error[] = [];
  const realtime = new SupabaseRealtimeRpc({
    client: createRealtimeClient(callbacks, async () => "ok", broadcasts, sent, async () => "ok", controls) as never,
    eventCenter: {} as never,
    onBindingsChanged: () => { refreshes++; },
    onTransportUnhealthy: (error) => failures.push(error),
  });
  const started = realtime.start({ userId, deviceId: desktopId });
  await Bun.sleep(0);
  callbacks.get(`eco:user:${userId}`)?.("SUBSCRIBED");
  await started;
  const synced = realtime.syncBindings([{
    id: bindingId, userId, desktopDeviceId: desktopId, mobileDeviceId: mobileId,
    capabilities: ["events:read"], createdAt: "2030-01-01T00:00:00.000Z", revokedAt: null,
  }]);
  await Bun.sleep(0);
  callbacks.get(`eco:bind:${bindingId}`)?.("SUBSCRIBED");
  await synced;
  const notification = { jsonrpc: "2.0", method: "eco.event", params: {} } as never;
  for (let i = 0; i < 250; i++) realtime.publishNotification(notification);
  expect(sent).toHaveLength(0);
  // An unrelated online device cannot enable delivery to an offline binding.
  controls.presence = { other: [{ deviceId: "other", deviceKind: "mobile", online: true }] };
  controls.presenceHandlers.get(`eco:user:${userId}:sync`)?.();
  realtime.publishNotification(notification);
  expect(sent).toHaveLength(0);
  controls.presence = { [mobileId]: [{ deviceId: mobileId, deviceKind: "mobile", online: true }] };
  controls.presenceHandlers.get(`eco:user:${userId}:sync`)?.();
  realtime.publishNotification(notification);
  await Bun.sleep(0);
  expect(sent).toHaveLength(1);
  controls.presence = {};
  controls.presenceHandlers.get(`eco:user:${userId}:leave`)?.();
  realtime.publishNotification(notification);
  expect(sent).toHaveLength(1);
  controls.state = "errored";
  await expect(realtime.sendOnBinding(bindingId, notification)).rejects.toThrow("not connected");
  controls.state = "joined";
  controls.connected = false;
  await expect(realtime.sendOnBinding(bindingId, notification)).rejects.toThrow("not connected");
  expect(sent).toHaveLength(1);
  broadcasts.get(`eco:user:${userId}`)?.({ payload: { desktopDeviceId: "other" } });
  expect(refreshes).toBe(0);
  broadcasts.get(`eco:user:${userId}`)?.({ payload: { desktopDeviceId: desktopId } });
  expect(refreshes).toBe(1);
  controls.connected = true;
  broadcasts.get(`eco:user:${userId}`)?.({ payload: {
    desktopDeviceId: desktopId, mobileDeviceId: mobileId, bindingId, requestId: "ready_1",
  } });
  await Bun.sleep(0);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({
    event: "eco.binding.ready",
    payload: { desktopDeviceId: desktopId, mobileDeviceId: mobileId, bindingId, requestId: "ready_1" },
  });
  await realtime.syncBindings([]);
  callbacks.get(`eco:bind:${bindingId}`)?.("CLOSED");
  expect(failures).toHaveLength(0);
  await realtime.stop();
});

test("SupabaseRealtimeRpc rejects a private channel authorization failure", async () => {
  const callbacks = new Map<string, (status: string, error?: Error) => void>();
  const client = createRealtimeClient(callbacks, async () => "ok");
  const realtime = new SupabaseRealtimeRpc({
    client: client as never,
    eventCenter: {} as never,
  });
  const topic = "eco:user:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const startPromise = realtime.start({
    userId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    deviceId: "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  });
  await Bun.sleep(0);
  callbacks.get(topic)?.("CHANNEL_ERROR", new Error("Unauthorized"));

  await expect(startPromise).rejects.toThrow(`Realtime channel ${topic} status=CHANNEL_ERROR: Unauthorized`);
});

function createRealtimeClient(
  callbacks: Map<string, (status: string, error?: Error) => void>,
  track: () => Promise<string>,
  broadcastHandlers = new Map<string, (payload: unknown) => void>(),
  sent: unknown[] = [],
  sendImpl: (payload: unknown) => Promise<string> = async () => "ok",
  controls: {
    presence?: Record<string, Array<Record<string, unknown>>>;
    presenceHandlers?: Map<string, () => void>;
    connected?: boolean;
    state?: string;
  } = {},
) {
  return {
    realtime: { isConnected: () => controls.connected !== false },
    channel(topic: string) {
      const channel = {
        get state() { return controls.state ?? "joined"; },
        on(type: string, filter: { event: string }, callback: (payload: unknown) => void) {
          if (type === "broadcast") {
            broadcastHandlers.set(topic, callback);
          }
          if (type === "presence") {
            controls.presenceHandlers?.set(`${topic}:${filter.event}`, () => callback(undefined));
          }
          return channel;
        },
        subscribe(callback: (status: string, error?: Error) => void) {
          callbacks.set(topic, callback);
          return channel;
        },
        async send(payload: unknown) {
          sent.push(payload);
          return sendImpl(payload);
        },
        track,
        presenceState() {
          return controls.presence ?? {};
        },
      };
      return channel;
    },
    async removeChannel() {
      return "ok";
    },
  };
}
