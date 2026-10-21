import { expect, test } from "bun:test";
import type { WebContents } from "electron";
import { startMultiBrowserCdpProxy } from "../src/main/browser-cdp-proxy";

function guest(id: string) {
  return {
    id,
    webContents: {
      isDestroyed: () => false,
      getType: () => "webview",
      getURL: () => "https://example.test/same",
      getTitle: () => id,
      debugger: {
        isAttached: () => true,
        on: () => {},
        off: () => {},
        detach: () => {},
        sendCommand: async () => ({ result: { type: "string", value: id } }),
      },
    } as unknown as WebContents,
  };
}

async function connect(url: string) {
  const ws = new WebSocket(url);
  const events: unknown[] = [];
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let nextId = 0;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    } else events.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return {
    ws,
    events,
    command(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ): Promise<Record<string, unknown>> {
      const id = ++nextId;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
  };
}

test("bound CDP connections route only to their exact target, including same-URL tabs", async () => {
  let targets = [guest("a"), guest("b"), guest("c")];
  const proxy = await startMultiBrowserCdpProxy({ getTargets: () => targets });
  const bound = await connect(`ws://127.0.0.1:${proxy.port}/devtools/browser?targetId=c`);
  const unbound = await connect(`ws://127.0.0.1:${proxy.port}/devtools/browser`);
  try {
    expect(await bound.command("Target.getTargets")).toMatchObject({
      result: { targetInfos: [{ targetId: "c" }] },
    });
    expect(await unbound.command("Target.getTargets")).toMatchObject({
      result: { targetInfos: [{ targetId: "a" }, { targetId: "b" }, { targetId: "c" }] },
    });
    expect(await bound.command("Runtime.evaluate")).toMatchObject({ result: { result: { value: "c" } } });
    expect(await bound.command("Runtime.evaluate", {}, "a")).toMatchObject({
      error: { message: expect.stringContaining("No browser target") },
    });
    expect(await bound.command("Target.attachToTarget", { targetId: "a" })).toMatchObject({
      error: { message: expect.stringContaining("Target not found") },
    });
    expect(await bound.command("Target.createTarget", { url: "about:blank" })).toMatchObject({
      error: { message: expect.stringContaining("tab_new") },
    });

    proxy.notifyTargetInfoChanged("a");
    proxy.notifyTargetCreated("a");
    // A response on each socket is a barrier after the preceding target events.
    await bound.command("Browser.getVersion");
    await unbound.command("Browser.getVersion");
    expect(bound.events).toEqual([]);
    expect(unbound.events).toHaveLength(2);

    targets = targets.filter((t) => t.id !== "c");
    proxy.notifyTargetDestroyed("c");
    expect(await bound.command("Runtime.evaluate")).toMatchObject({
      error: { message: expect.stringContaining("No browser target") },
    });
    expect(await bound.command("Target.getTargets")).toMatchObject({ result: { targetInfos: [] } });
  } finally {
    bound.ws.close();
    unbound.ws.close();
    await proxy.close();
  }
});
