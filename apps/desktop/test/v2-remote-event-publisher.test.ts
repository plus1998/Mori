import { expect, test } from "bun:test";
import { MobileRemoteEventPublisher } from "../src/main/mobile-remote-event-publisher";
import type { EventCenterEnvelope, EventCenterJsonRpcNotification } from "../src/shared/event-center";

function notification(kind: EventCenterEnvelope["kind"], payload: unknown, threadId = "thr_1") {
  const envelope = {
    protocolVersion: 1,
    id: `evt_${kind}`,
    kind,
    source: "desktop",
    occurredAt: "2026-01-01T00:00:00.000Z",
    threadId,
    payload,
  } as EventCenterEnvelope;
  return {
    envelope,
    notification: { jsonrpc: "2.0", method: "eco.event", params: envelope } as EventCenterJsonRpcNotification,
  };
}

test("remote publisher drops retired V1 projection and metrics topics", () => {
  const delivered: EventCenterJsonRpcNotification[] = [];
  const publisher = new MobileRemoteEventPublisher({ deliver: (event) => delivered.push(event) });

  for (const kind of ["thread.context", "thread.usage"] as const) {
    const item = notification(kind, { threadId: "thr_1" });
    publisher.publish(item.envelope, item.notification);
  }

  expect(delivered).toEqual([]);
});

test("remote publisher forwards V2 effects and throttles V2 projection extras", async () => {
  const delivered: EventCenterJsonRpcNotification[] = [];
  const publisher = new MobileRemoteEventPublisher({
    deliver: (event) => delivered.push(event),
    projectionExtrasThrottleMs: 20,
  });
  const effect = notification(
    "conversation.sync_effect",
    { conversationId: "thr_1", storeEpoch: "epoch", effect: { seq: 1 } },
  );
  publisher.publish(effect.envelope, effect.notification);
  expect(delivered).toHaveLength(1);

  const extras1 = notification("conversation.projection_extras", { conversationId: "thr_1", revision: 1 });
  const extras2 = notification("conversation.projection_extras", { conversationId: "thr_1", revision: 2 });
  publisher.publish(extras1.envelope, extras1.notification);
  publisher.publish(extras2.envelope, extras2.notification);
  await Bun.sleep(40);

  expect(delivered).toHaveLength(2);
  expect((delivered[1]!.params as EventCenterEnvelope).payload).toEqual({
    conversationId: "thr_1",
    revision: 2,
  });
  publisher.reset();
});

test("account change signals reach mobile without publishing account credentials", () => {
  const delivered: EventCenterJsonRpcNotification[] = [];
  const publisher = new MobileRemoteEventPublisher({ deliver: (event) => delivered.push(event) });
  const item = notification("openai-accounts.changed", {});
  publisher.publish(item.envelope, item.notification);
  expect(delivered).toHaveLength(1);
  expect((delivered[0]!.params as EventCenterEnvelope).payload).toEqual({});
  publisher.reset();
});
