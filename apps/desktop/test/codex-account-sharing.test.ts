import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAccountSharing } from "../src/main/codex-account-sharing";
import { OpenAIAccountService } from "../src/main/openai-account-service";
import { sharedCodexAccountId } from "../src/shared/codex-account-sharing";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const version = (token: string) => createHash("sha256").update(token).digest("hex");
const jwt = (label: string, exp = Math.floor(Date.now() / 1000) + 3600) =>
  `e30.${Buffer.from(JSON.stringify({ exp, label })).toString("base64url")}.sig`;

class Relay {
  shares: Array<Record<string, any>> = [];
  devices = ["host", "pc-b", "pc-c"].map((id) => ({ id, name: id, kind: "desktop", disabled_at: null }));
  channels = new Set<any>();
  messages: any[] = [];
  grant(recipient: string, accountId: string) {
    const row = {
      id: randomUUID(),
      owner_device_id: "host",
      recipient_device_id: recipient,
      account_id: accountId,
      account_name: "Work",
      chatgpt_account_id: "chatgpt-work",
      grant_epoch: randomUUID(),
      revoked_at: null,
      created_at: new Date().toISOString(),
    };
    this.shares.push(row);
    return row;
  }
  client(deviceId: string): any {
    const relay = this;
    return {
      async rpc(name: string, args: any) {
        expect(name).toBe("eco_set_codex_account_shares");
        expect(args.p_device_ids).toEqual([]);
        for (const share of relay.shares)
          if (share.owner_device_id === deviceId && share.account_id === args.p_account_id)
            share.revoked_at = new Date().toISOString();
        return { error: null };
      },
      from(table: string) {
        let id: string | undefined;
        const result = () => ({
          data:
            table === "devices_public"
              ? relay.devices
              : relay.shares
                  .filter(
                    (s) =>
                      (s.owner_device_id === deviceId || s.recipient_device_id === deviceId) &&
                      (!id || s.id === id),
                  )
                  .map((s) => ({ ...s })),
          error: null,
        });
        const query: any = {
          select: () => query,
          eq: (_: string, value: string) => {
            id = value;
            return query;
          },
          maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
          then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
        };
        return query;
      },
      channel(topic: string, config: any) {
        const entry: any = {
          topic,
          deviceId,
          config,
          handler: undefined,
          status: undefined,
          on(_type: string, _filter: unknown, handler: any) {
            entry.handler = handler;
            return entry;
          },
          subscribe(callback: any) {
            entry.status = callback;
            relay.channels.add(entry);
            queueMicrotask(() => callback("SUBSCRIBED"));
            return entry;
          },
          async send(message: any) {
            relay.messages.push(structuredClone(message.payload));
            for (const other of relay.channels) {
              if (other !== entry && other.topic === topic)
                queueMicrotask(() => other.handler?.({ payload: structuredClone(message.payload) }));
            }
            return "ok";
          },
        };
        return entry;
      },
      async removeChannel(channel: any) {
        relay.channels.delete(channel);
        channel.status?.("CLOSED");
      },
    };
  }
}

async function fixture(onRefresh?: () => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-share-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const oldAccess = jwt("old");
  const newAccess = jwt("new");
  let refreshes = 0;
  const service = new OpenAIAccountService(
    root,
    "fake-codex",
    undefined,
    undefined,
    undefined,
    async (input, operation) =>
      operation({
        request: async <T>(method: string) => {
          expect(method).toBe("account/read");
          refreshes++;
          await onRefresh?.();
          const raw = JSON.parse(await readFile(path.join(input.codexHomeDir, "auth.json"), "utf8"));
          raw.tokens.access_token = newAccess;
          raw.tokens.refresh_token = "private-refresh-rotated";
          await writeFile(path.join(input.codexHomeDir, "auth.json"), JSON.stringify(raw));
          return {} as T;
        },
      }),
  );
  await service.initialize({ startBackground: false });
  cleanups.push(() => service.dispose());
  const account = await service.createAccount("Work");
  await service.setAuthJson(
    account.id,
    JSON.stringify({
      tokens: {
        access_token: oldAccess,
        refresh_token: "private-refresh-original",
        account_id: "chatgpt-work",
        id_token: "private-id-token",
      },
    }),
  );
  const relay = new Relay();
  const bGrant = relay.grant("pc-b", account.id);
  const cGrant = relay.grant("pc-c", account.id);
  const invalidated: string[] = [];
  const make = () => {
    const broker = new CodexAccountSharing({
      localAccounts: () => service.listLocalAccounts(),
      accountIdentity: async () => "chatgpt-work",
      tokens: (id, known) => service.getShareableTokens(id, known),
      quota: async () => {
        throw new Error("no quota requested");
      },
      changed: () => {},
      invalidated: (id) => invalidated.push(id),
      pollMs: 60_000,
    });
    cleanups.push(() => broker.disconnect());
    return broker;
  };
  const host = make();
  const b = make();
  const c = make();
  const online = new Set(["host", "pc-b", "pc-c"]);
  for (const [broker, id] of [
    [host, "host"],
    [b, "pc-b"],
    [c, "pc-c"],
  ] as const) {
    await broker.connect({
      client: relay.client(id),
      userId: "user",
      deviceId: id,
      deviceName: id,
      onlineDeviceIds: () => online,
    });
  }
  return {
    service,
    relay,
    host,
    b,
    c,
    bGrant,
    cGrant,
    oldAccess,
    newAccess,
    online,
    invalidated,
    refreshes: () => refreshes,
  };
}

test("multiple PCs receive only access tokens and concurrent 401s rotate the host credential once", async () => {
  const f = await fixture(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const bId = sharedCodexAccountId(f.bGrant.id);
  const cId = sharedCodexAccountId(f.cGrant.id);
  expect(f.b.listAccounts()).toHaveLength(1);
  expect(f.b.listAccounts()[0]?.authState).toBe("refreshable");
  const [firstB, firstC] = await Promise.all([f.b.getTokens(bId), f.c.getTokens(cId)]);
  expect(firstB.accessToken).toBe(f.oldAccess);
  expect(firstC.accessToken).toBe(f.oldAccess);
  expect(f.refreshes()).toBe(0);
  const same = f.b.getTokens(bId, f.oldAccess);
  expect(f.b.getTokens(bId, f.oldAccess)).toBe(same);
  const result = await Promise.all([same, f.c.getTokens(cId, f.oldAccess)]);
  expect(result.map((t) => t.accessToken)).toEqual([f.newAccess, f.newAccess]);
  expect(f.refreshes()).toBe(1);
  expect(await f.service.getAuthJsonContent(f.bGrant.account_id)).toContain("private-refresh-rotated");
  const wire = JSON.stringify(f.relay.messages);
  expect(wire).not.toContain("private-refresh");
  expect(wire).not.toContain("private-id-token");
  expect(
    f.relay.messages.filter((m) => m.kind === "request").every((m) => !Object.hasOwn(m, "accessToken")),
  ).toBe(true);
  expect(f.b.listAccounts()[0]?.sharedSource?.state).toBe("ready");
});

test("a revoked grant clears cached access and invalidates the recipient runtime", async () => {
  const f = await fixture();
  const id = sharedCodexAccountId(f.bGrant.id);
  await f.b.getTokens(id);
  f.bGrant.revoked_at = new Date().toISOString();
  await expect(f.b.getTokens(id)).rejects.toThrow("授权已取消");
  expect(f.invalidated).toContain(id);
  expect(f.b.listAccounts()[0]?.isLoggedIn).toBe(false);
  expect(f.b.listAccounts()[0]?.sharedSource?.expiresAt).toBeUndefined();
});

test("revocation during a refresh prevents any refreshed token from being sent", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(async () => {
    entered();
    await gate;
  });
  const id = sharedCodexAccountId(f.bGrant.id);
  await f.b.getTokens(id);
  const refreshing = f.b.getTokens(id, f.oldAccess);
  const outcome = refreshing.then(
    () => null,
    (error) => error as Error,
  );
  await started;
  f.bGrant.revoked_at = new Date().toISOString();
  await f.b.refresh();
  release();
  expect((await outcome)?.message).toContain("授权已取消");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(f.refreshes()).toBe(1);
  expect(JSON.stringify(f.relay.messages)).not.toContain(f.newAccess);
});

test("remote accounts use the provider without materializing local auth.json or refresh credentials", async () => {
  const f = await fixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-share-recipient-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const recipient = new OpenAIAccountService(
    root,
    "must-not-spawn",
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error("recipient attempted a native refresh");
    },
  );
  await recipient.initialize({ startBackground: false });
  cleanups.push(() => recipient.dispose());
  recipient.setSharedAccountProvider(f.b);
  const id = sharedCodexAccountId(f.bGrant.id);
  expect(await recipient.listLocalAccounts()).toEqual([]);
  expect((await recipient.listAccounts())[0]?.id).toBe(id);
  expect((await recipient.getExternalChatGptTokens(id)).accessToken).toBe(f.oldAccess);
  expect((await recipient.getAccountDetails(id)).authJson).toBeNull();
  await expect(recipient.getAuthJsonContent(id)).rejects.toThrow("无法在本机导出");
  await expect(recipient.getShareableTokens(id)).rejects.toThrow("不能再次共享");
  expect(await recipient.getAccountProxyConfig(id)).toEqual({ mode: "system" });
  const db = await readFile(path.join(root, "eco-coding.sqlite"));
  expect(db.includes(Buffer.from("private-refresh"))).toBe(false);
});

test("restoring a grant starts a new authorization epoch and never reuses the revoked cache", async () => {
  const f = await fixture();
  const id = sharedCodexAccountId(f.bGrant.id);
  await f.b.getTokens(id);
  f.bGrant.revoked_at = new Date().toISOString();
  await f.b.refresh();
  expect(f.b.listAccounts()[0]?.sharedSource?.state).toBe("revoked");
  f.bGrant.revoked_at = null;
  f.bGrant.grant_epoch = randomUUID();
  await f.host.refresh();
  await f.b.refresh();
  expect(f.b.listAccounts()[0]?.authState).toBe("refreshable");
  expect(f.b.listAccounts()[0]?.sharedSource?.expiresAt).toBeUndefined();
  expect((await f.b.getTokens(id)).accessToken).toBe(f.oldAccess);
});

test("an offline host permits valid cached access, while signing out clears it and stops the runtime", async () => {
  const f = await fixture();
  const id = sharedCodexAccountId(f.bGrant.id);
  await f.b.getTokens(id);
  f.host.disconnect();
  f.online.delete("host");
  expect((await f.b.getTokens(id)).accessToken).toBe(f.oldAccess);
  expect(f.b.listAccounts()[0]?.sharedSource?.state).toBe("offline");
  expect(f.b.listAccounts()[0]?.isLoggedIn).toBe(true);
  f.b.disconnect();
  expect(f.b.listAccounts()).toEqual([]);
  expect(f.invalidated).toContain(id);
  await expect(f.b.getTokens(id)).rejects.toThrow("请先连接");
});

test("a late refresh from an old epoch cannot revoke a newly restored grant", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(async () => {
    entered();
    await gate;
  });
  const id = sharedCodexAccountId(f.bGrant.id);
  await f.b.getTokens(id);
  const oldResult = f.b.getTokens(id, f.oldAccess).then(
    () => null,
    (error) => error as Error,
  );
  await started;
  f.bGrant.grant_epoch = randomUUID();
  await f.host.refresh();
  await f.b.refresh();
  const renewed = f.b.getTokens(id);
  release();
  expect((await oldResult)?.message).toContain("授权已取消");
  expect((await renewed).accessToken).toBe(f.newAccess);
  expect(f.b.listAccounts()[0]?.sharedSource?.state).toBe("ready");
});

test("a rejected host refresh clears the recipient cache without forwarding private error details", async () => {
  const f = await fixture(async () => {
    throw new Error("refresh_token_reused private-refresh-original");
  });
  const id = sharedCodexAccountId(f.bGrant.id);
  await f.b.getTokens(id);
  await expect(f.b.getTokens(id, f.oldAccess)).rejects.toThrow("主设备上重新登录");
  expect(f.b.listAccounts()[0]?.sharedSource?.state).toBe("reauthorization_required");
  expect(f.b.listAccounts()[0]?.sharedSource?.expiresAt).toBeUndefined();
  expect(f.b.listAccounts()[0]?.isLoggedIn).toBe(false);
  expect(JSON.stringify(f.relay.messages)).not.toContain("private-refresh-original");
});

test("reconnecting a host revokes grants for accounts deleted while disconnected", async () => {
  const f = await fixture();
  const id = sharedCodexAccountId(f.bGrant.id);
  await f.b.getTokens(id);
  f.host.disconnect();
  await f.service.deleteAccount(f.bGrant.account_id);
  await f.host.connect({
    client: f.relay.client("host"),
    userId: "user",
    deviceId: "host",
    deviceName: "host",
    onlineDeviceIds: () => f.online,
  });
  await f.b.refresh();
  expect(f.bGrant.revoked_at).not.toBeNull();
  expect(f.b.listAccounts()[0]?.sharedSource?.state).toBe("revoked");
  await expect(f.b.getTokens(id)).rejects.toThrow("授权已取消");
});

test("expired request epochs and attempts to select another account never reach the host refresh service", async () => {
  const f = await fixture();
  const client = f.relay.client("pc-b");
  const channel = client.channel(`eco:codex:${f.bGrant.id}`, {}).subscribe(() => {});
  await channel.send({
    payload: { kind: "request", id: randomUUID(), epoch: randomUUID(), operation: "tokens" },
  });
  await channel.send({
    payload: {
      kind: "request",
      id: randomUUID(),
      epoch: f.bGrant.grant_epoch,
      operation: "tokens",
      accountId: f.cGrant.account_id,
      knownVersion: version(f.oldAccess),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.refreshes()).toBe(0);
  expect(f.relay.messages.some((m) => m.kind === "response")).toBe(false);
});
