import { expect, test } from "bun:test";
import { generateVaultKey } from "@eco/shared";
import type { CenterServerSettingsSecret, CenterServerStore } from "../src/main/center-server-store";
import { DesktopEventCenter } from "../src/main/event-center";
import { SupabaseCenterDesktopClient } from "../src/main/supabase-center-client";
import { emptyEcoSyncedSettingsPayload } from "../src/main/supabase-settings-sync";
import type {
  CenterServerConnectionStatus,
  CenterServerDeviceBindingView,
  CenterServerSettingsView,
} from "../src/shared/center-server";
import { isCenterServerAuthCredentialError } from "../src/shared/center-server";

const fixedNow = () => new Date("2030-01-01T00:00:00.000Z");
const USER_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const DEVICE_ID = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

/** Minimal JWT so @supabase/supabase-js setSession accepts the token structure. */
function testAccessJwt(sub = USER_ID, expiresInSeconds = 3600, tokenId = "initial"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(fixedNow().getTime() / 1000) + expiresInSeconds,
      iat: Math.floor(fixedNow().getTime() / 1000),
      jti: tokenId,
      session_id: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    }),
  ).toString("base64url");
  return `${header}.${payload}.test_sig`;
}

const ACCESS_JWT = testAccessJwt();
const REFRESHED_ACCESS_JWT = testAccessJwt(USER_ID, 7200, "refreshed");

test("supabase center client reports HTML hosting availability transitions once", async () => {
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
  });
  let available = true;
  const transitions: boolean[] = [];
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: (async () =>
      available
        ? new Response("<!doctype html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
        : new Response("missing", { status: 404 })) as typeof fetch,
    now: fixedNow,
    onHtmlHostingCapabilityChange: (capability) => transitions.push(capability.available),
  });

  await client.refreshHtmlHostingCapability({ force: true });
  await client.refreshHtmlHostingCapability({ force: true });
  available = false;
  await client.refreshHtmlHostingCapability({ force: true });

  expect(transitions).toEqual([true, false]);
  client.dispose();
});

test("supabase center client signs in, registers device, and marks connected", async () => {
  const store = createFakeStore();
  const fetchCalls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.includes("/auth/v1/token") || url.includes("/auth/v1/signup")) {
      return jsonResponse({
        access_token: ACCESS_JWT,
        refresh_token: "refresh_jwt",
        expires_in: 3600,
        expires_at: Math.floor(fixedNow().getTime() / 1000) + 3600,
        token_type: "bearer",
        user: authUser(),
      });
    }
    if (url.includes("/functions/v1/device-register")) {
      expect(init?.headers && new Headers(init.headers).get("authorization")).toContain(ACCESS_JWT);
      return jsonResponse({
        device: {
          id: DEVICE_ID,
          user_id: USER_ID,
          kind: "desktop",
          name: "Eco Desktop",
          metadata: { hostname: "host", platform: "win32" },
          created_at: "2030-01-01T00:00:00.000Z",
          last_seen_at: null,
          disabled_at: null,
        },
        device_secret: "device_secret_once",
      });
    }
    if (url.includes("/auth/v1/user")) {
      return jsonResponse(authUser());
    }
    if (url.includes("/functions/v1/device-session-register")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body).toEqual({
        deviceId: DEVICE_ID,
        deviceSecret: "device_secret_once",
        kind: "desktop",
      });
      return jsonResponse({
        sessionId: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        deviceId: DEVICE_ID,
        verifiedAt: fixedNow().toISOString(),
      });
    }
    if (url.includes("/rest/v1/device_bindings")) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const eventCenter = new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" });
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter,
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
    realtimeFactory: createFakeRealtimeTransport,
  });

  const result = await client.signInAndRegisterDesktop({
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    email: "you@example.com",
    password: "secret",
    deviceName: "Eco Desktop",
  });

  expect(result.device.id).toBe(DEVICE_ID);
  expect(result.user.email).toBe("you@example.com");
  expect(result.settings.hasDeviceSecret).toBe(true);
  expect(result.settings.supabaseUrl).toBe("https://example.supabase.co");
  expect(store.getSettingsWithSecrets().deviceSecret).toBe("device_secret_once");
  expect(store.getSettingsWithSecrets().anonKey).toBe("anon_key");
  expect(client.getSnapshot().status.state).toBe("connected");
  expect(fetchCalls.some((url) => url.includes("device-register"))).toBe(true);
  expect(fetchCalls.some((url) => url.includes("/rest/v1/device_bindings"))).toBe(true);

  client.dispose();
});

test("supabase center client removeConnection proves the desktop device secret", async () => {
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
  });
  let disableBody: unknown;
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/functions/v1/device-disable")) {
        disableBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return jsonResponse({
          device: {
            id: DEVICE_ID,
            userId: USER_ID,
            kind: "desktop",
            name: "Eco Desktop",
            metadata: {},
            createdAt: fixedNow().toISOString(),
            lastSeenAt: null,
            disabledAt: fixedNow().toISOString(),
            vaultSyncedAt: null,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch,
    now: fixedNow,
  });

  const result = await client.removeConnection();

  expect(disableBody).toEqual({
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    kind: "desktop",
  });
  expect(result.status.state).toBe("disabled");
  expect(store.getSettingsWithSecrets().deviceId).toBe("");
  client.dispose();
});

test("supabase center client testConnection hits auth health", async () => {
  const store = createFakeStore({
    supabaseUrl: "https://example.supabase.co",
    anonKey: "stored_anon",
  });
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/auth/v1/health");
      return jsonResponse({ version: "v1", name: "GoTrue" });
    }) as typeof fetch,
    now: fixedNow,
  });

  const result = await client.testConnection({
    supabaseUrl: "https://example.supabase.co",
    anonKey: "",
  });
  expect(result.ok).toBe(true);
  client.dispose();
});

test("supabase center client signup without session asks for email confirmation", async () => {
  const store = createFakeStore({
    enabled: false,
    supabaseUrl: "",
    anonKey: "",
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/v1/signup")) {
      return jsonResponse({
        access_token: null,
        token_type: "bearer",
        expires_in: 0,
        refresh_token: null,
        user: {
          id: USER_ID,
          email: "new@example.com",
          created_at: "2030-01-01T00:00:00.000Z",
          user_metadata: {},
          app_metadata: {},
          aud: "authenticated",
          role: "authenticated",
        },
      });
    }
    return jsonResponse({ message: `unexpected ${url}` }, 500);
  };
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
  });

  const result = await client.signUpAndRegisterDesktop({
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    email: "new@example.com",
    password: "password123",
    deviceName: "Eco Desktop",
  });
  expect(result.emailConfirmationRequired).toBe(true);
  expect(result.email).toBe("new@example.com");
  expect(result.device).toBeUndefined();
  expect(store.getSettingsWithSecrets().anonKey).toBe("anon_key");
  client.dispose();
});

test("supabase center client createPairing builds connect QR without pairing-create", async () => {
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
  });

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) {
      return jsonResponse(authUser());
    }
    if (url.includes("/functions/v1/device-session-register")) {
      return jsonResponse({
        sessionId: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        deviceId: DEVICE_ID,
        verifiedAt: fixedNow().toISOString(),
      });
    }
    if (url.includes("/rest/v1/device_bindings")) {
      return jsonResponse([]);
    }
    if (url.includes("/functions/v1/pairing-create")) {
      throw new Error("pairing-create should not be called for connect QR");
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
    realtimeFactory: createFakeRealtimeTransport,
  });

  await client.start();
  expect(client.getSnapshot().status.state).toBe("connected");

  const pairing = await client.createPairing();
  expect(pairing.code).toBe("");
  expect(pairing.bootstrapToken).toBe("");
  expect(pairing.qrPayload).toContain("eco://center?");
  expect(pairing.qrPayload).toContain("supabase=");
  expect(pairing.qrPayload).toContain("anon=");
  expect(pairing.qrPayload).not.toContain("code=");
  expect(pairing.qrPayload).not.toContain("token=");

  const connectQr = await client.buildConnectQr();
  expect(connectQr.qrPayload).toBe(pairing.qrPayload);

  client.dispose();
});

test("supabase center client reconnects and rebuilds bindings after transport failure", async () => {
  const bindingId = "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
  });
  let bindingFetches = 0;
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) {
      return jsonResponse(authUser());
    }
    if (url.includes("/functions/v1/device-session-register")) {
      return jsonResponse({
        sessionId: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        deviceId: DEVICE_ID,
        verifiedAt: fixedNow().toISOString(),
      });
    }
    if (url.includes("/rest/v1/device_bindings")) {
      bindingFetches += 1;
      return jsonResponse([
        {
          id: bindingId,
          user_id: USER_ID,
          desktop_device_id: DEVICE_ID,
          mobile_device_id: "d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          capabilities: ["rpc:invoke", "events:read"],
          created_at: "2030-01-01T00:00:00.000Z",
          revoked_at: null,
        },
        {
          id: "e4eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          user_id: USER_ID,
          desktop_device_id: DEVICE_ID,
          mobile_device_id: "disabled_mobile",
          capabilities: ["rpc:invoke", "events:read"],
          created_at: "2030-01-01T00:00:00.000Z",
          revoked_at: null,
        },
      ]);
    }
    if (url.includes("/rest/v1/devices_public")) {
      return jsonResponse([{ id: "d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const transports: Array<{
    stopped: boolean;
    syncedBindingIds: string[];
    fail(error: Error): void;
    bindingsChanged(): void;
  }> = [];
  const reconnects: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
    realtimeFactory: (options) => {
      const transport = {
        stopped: false,
        syncedBindingIds: [] as string[],
        async start() {},
        async stop() {
          transport.stopped = true;
        },
        async syncBindings(bindings: readonly CenterServerDeviceBindingView[]) {
          transport.syncedBindingIds = bindings.map((binding) => binding.id);
        },
        publishNotification() {},
        listOnlineDeviceIds() {
          return new Set<string>();
        },
        fail(error: Error) {
          options.onTransportUnhealthy?.(error);
        },
        bindingsChanged() {
          options.onBindingsChanged?.();
        },
      };
      transports.push(transport);
      return transport as never;
    },
    reconnectScheduler: (callback, delayMs) => {
      const reconnect = { callback, delayMs, cancelled: false };
      reconnects.push(reconnect);
      return {
        cancel() {
          reconnect.cancelled = true;
        },
      };
    },
  });

  await client.start();
  expect(client.getSnapshot().status.state).toBe("connected");
  expect(transports).toHaveLength(1);
  expect(transports[0]?.syncedBindingIds).toEqual([bindingId]);
  expect(bindingFetches).toBe(1);

  transports[0]?.bindingsChanged();
  await waitFor(() => bindingFetches === 2);

  transports[0]?.fail(new Error("presence channel token expired"));
  expect(client.getSnapshot().status).toMatchObject({
    state: "error",
    lastError: "presence channel token expired",
  });
  expect(transports[0]?.stopped).toBe(true);
  expect(reconnects).toHaveLength(1);
  expect(reconnects[0]?.delayMs).toBe(1000);

  reconnects[0]?.callback();
  await waitFor(() => transports.length === 2 && bindingFetches === 3);
  expect(client.getSnapshot().status.state).toBe("connected");
  expect(transports[1]?.syncedBindingIds).toEqual([bindingId]);

  transports[0]?.fail(new Error("stale transport failure"));
  expect(client.getSnapshot().status.state).toBe("connected");
  expect(reconnects).toHaveLength(1);

  client.dispose();
});

test("supabase center client stop cancels a pending reconnect", async () => {
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) return jsonResponse(authUser());
    if (url.includes("/functions/v1/device-session-register")) {
      return jsonResponse({
        sessionId: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        deviceId: DEVICE_ID,
        verifiedAt: fixedNow().toISOString(),
      });
    }
    if (url.includes("/rest/v1/device_bindings")) return jsonResponse([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  let failTransport: ((error: Error) => void) | undefined;
  let reconnect: { callback: () => void; delayMs: number; cancelled: boolean } | undefined;
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
    realtimeFactory: (options) => {
      failTransport = (error) => options.onTransportUnhealthy?.(error);
      return createFakeRealtimeTransport();
    },
    reconnectScheduler: (callback, delayMs) => {
      reconnect = { callback, delayMs, cancelled: false };
      return {
        cancel() {
          if (reconnect) reconnect.cancelled = true;
        },
      };
    },
  });

  await client.start();
  failTransport?.(new Error("channel closed"));
  expect(reconnect?.delayMs).toBe(1000);
  client.stop();
  expect(reconnect?.cancelled).toBe(true);

  reconnect?.callback();
  await Bun.sleep(0);
  expect(client.getSnapshot().status.state).toBe("disconnected");
  client.dispose();
});

test("supabase center client proactively refreshes access token before expiry", async () => {
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
  });
  const refreshes: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  let refreshRequests = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) return jsonResponse(authUser());
    if (url.includes("/functions/v1/device-session-register")) {
      return jsonResponse({
        sessionId: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        deviceId: DEVICE_ID,
        verifiedAt: fixedNow().toISOString(),
      });
    }
    if (url.includes("/rest/v1/device_bindings")) return jsonResponse([]);
    if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
      refreshRequests += 1;
      expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "refresh_jwt" });
      return jsonResponse({
        access_token: REFRESHED_ACCESS_JWT,
        refresh_token: "refresh_jwt_rotated",
        expires_in: 7200,
        expires_at: Math.floor(fixedNow().getTime() / 1000) + 7200,
        token_type: "bearer",
        user: authUser(),
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
    realtimeFactory: createFakeRealtimeTransport,
    accessTokenRefreshScheduler: (callback, delayMs) => {
      const refresh = { callback, delayMs, cancelled: false };
      refreshes.push(refresh);
      return {
        cancel() {
          refresh.cancelled = true;
        },
      };
    },
  });

  await client.start();
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0]?.delayMs).toBe(59 * 60 * 1000);

  refreshes[0]?.callback();
  await waitFor(() => refreshRequests === 1 && refreshes.length === 2);
  expect(store.getSettingsWithSecrets()).toMatchObject({
    accessToken: REFRESHED_ACCESS_JWT,
    refreshToken: "refresh_jwt_rotated",
    accessTokenExpiresAt: "2030-01-01T02:00:00.000Z",
  });
  expect(refreshes[1]?.delayMs).toBe(119 * 60 * 1000);

  client.stop();
  expect(refreshes[1]?.cancelled).toBe(true);
  client.dispose();
});

test("supabase center client retries transient token refresh before expiry", async () => {
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T00:02:00.000Z",
  });
  const refreshes: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  let refreshRequests = 0;
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) return jsonResponse(authUser());
    if (url.includes("/functions/v1/device-session-register")) {
      return jsonResponse({
        sessionId: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        deviceId: DEVICE_ID,
        verifiedAt: fixedNow().toISOString(),
      });
    }
    if (url.includes("/rest/v1/device_bindings")) return jsonResponse([]);
    if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
      refreshRequests += 1;
      return jsonResponse({ msg: "Temporary upstream error", code: 429 }, 429);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
    realtimeFactory: createFakeRealtimeTransport,
    accessTokenRefreshScheduler: (callback, delayMs) => {
      const refresh = { callback, delayMs, cancelled: false };
      refreshes.push(refresh);
      return {
        cancel() {
          refresh.cancelled = true;
        },
      };
    },
  });

  await client.start();
  expect(refreshes[0]?.delayMs).toBe(60_000);
  refreshes[0]?.callback();
  await waitFor(() => refreshRequests >= 1, 5000);
  await waitFor(() => refreshes.length === 2, 5000);

  expect(client.getSnapshot().status.state).toBe("connected");
  expect(store.getSettingsWithSecrets().refreshToken).toBe("refresh_jwt");
  expect(refreshes[1]?.delayMs).toBe(10_000);

  client.dispose();
});

test("supabase center client stops on rejected refresh credentials", async () => {
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T00:02:00.000Z",
  });
  let refreshCallback: (() => void) | undefined;
  let transportStopped = false;
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) return jsonResponse(authUser());
      if (url.includes("/functions/v1/device-session-register")) {
        return jsonResponse({
          sessionId: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          deviceId: DEVICE_ID,
          verifiedAt: fixedNow().toISOString(),
        });
      }
      if (url.includes("/rest/v1/device_bindings")) return jsonResponse([]);
      if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
        return jsonResponse({ msg: "Invalid Refresh Token", code: "refresh_token_not_found" }, 400);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch,
    now: fixedNow,
    realtimeFactory: () => ({
      async start() {},
      async stop() {
        transportStopped = true;
      },
      async syncBindings() {},
      publishNotification() {},
      listOnlineDeviceIds() {
        return new Set<string>();
      },
    }),
    accessTokenRefreshScheduler: (callback) => {
      refreshCallback = callback;
      return { cancel() {} };
    },
  });

  await client.start();
  refreshCallback?.();
  await waitFor(() => client.getSnapshot().status.state === "error");

  expect(client.getSnapshot().status.lastError?.toLowerCase()).toContain("refresh token");
  expect(store.getSettingsWithSecrets().refreshToken).toBe("");
  expect(transportStopped).toBe(true);
  client.dispose();
});

test("supabase center client single-flights concurrent access token refreshes", async () => {
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
  });
  let refreshRequests = 0;
  let releaseRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refreshes: Array<{ callback: () => void; delayMs: number }> = [];
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) return jsonResponse(authUser());
      if (url.includes("/functions/v1/device-session-register")) {
        return jsonResponse({
          sessionId: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          deviceId: DEVICE_ID,
          verifiedAt: fixedNow().toISOString(),
        });
      }
      if (url.includes("/rest/v1/device_bindings")) return jsonResponse([]);
      if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
        refreshRequests += 1;
        await refreshGate;
        return jsonResponse({
          access_token: REFRESHED_ACCESS_JWT,
          refresh_token: "refresh_jwt_rotated",
          expires_in: 7200,
          expires_at: Math.floor(fixedNow().getTime() / 1000) + 7200,
          token_type: "bearer",
          user: authUser(),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch,
    now: fixedNow,
    realtimeFactory: createFakeRealtimeTransport,
    accessTokenRefreshScheduler: (callback, delayMs) => {
      refreshes.push({ callback, delayMs });
      return { cancel() {} };
    },
  });

  await client.start();
  expect(refreshes).toHaveLength(1);
  const first = refreshes[0];
  expect(first).toBeDefined();
  first?.callback();
  first?.callback();
  await waitFor(() => refreshRequests === 1, 5000);
  releaseRefresh?.();
  await waitFor(() => store.getSettingsWithSecrets().refreshToken === "refresh_jwt_rotated", 5000);
  expect(refreshRequests).toBe(1);
  client.dispose();
});

test("supabase center client recoverAfterIdle reconnects after false session expiry", async () => {
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    // Expired so connect must refresh; first attempt simulates in-memory session loss.
    accessTokenExpiresAt: "2029-12-31T23:59:00.000Z",
  });
  let refreshRequests = 0;
  let refreshPhase: "fail" | "ok" = "fail";
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) return jsonResponse(authUser());
      if (url.includes("/functions/v1/device-session-register")) {
        return jsonResponse({
          sessionId: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          deviceId: DEVICE_ID,
          verifiedAt: fixedNow().toISOString(),
        });
      }
      if (url.includes("/rest/v1/device_bindings")) return jsonResponse([]);
      if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
        refreshRequests += 1;
        if (refreshPhase === "fail") {
          return jsonResponse({ msg: "Auth session missing!", status: 400 }, 400);
        }
        return jsonResponse({
          access_token: REFRESHED_ACCESS_JWT,
          refresh_token: "refresh_jwt_kept",
          expires_in: 7200,
          expires_at: Math.floor(fixedNow().getTime() / 1000) + 7200,
          token_type: "bearer",
          user: authUser(),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch,
    now: fixedNow,
    realtimeFactory: createFakeRealtimeTransport,
    reconnectScheduler: () => ({ cancel() {} }),
  });

  await client.start();
  await waitFor(() => client.getSnapshot().status.state === "error", 5000);
  expect(store.getSettingsWithSecrets().refreshToken).toBe("refresh_jwt");
  expect(client.getSnapshot().status.lastError?.toLowerCase()).toContain("session missing");

  refreshPhase = "ok";
  await client.recoverAfterIdle("resume");
  await waitFor(() => client.getSnapshot().status.state === "connected", 5000);
  expect(store.getSettingsWithSecrets().refreshToken).toBe("refresh_jwt_kept");
  expect(refreshRequests).toBeGreaterThanOrEqual(2);
  client.dispose();
});

test("supabase center client keeps refresh token on Auth session missing refresh failure", async () => {
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2029-12-31T23:59:00.000Z",
  });
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) return jsonResponse(authUser());
      if (url.includes("/functions/v1/device-session-register")) {
        return jsonResponse({
          sessionId: "f5eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          deviceId: DEVICE_ID,
          verifiedAt: fixedNow().toISOString(),
        });
      }
      if (url.includes("/rest/v1/device_bindings")) return jsonResponse([]);
      if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
        return jsonResponse({ msg: "Auth session missing!", status: 400 }, 400);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch,
    now: fixedNow,
    realtimeFactory: createFakeRealtimeTransport,
    reconnectScheduler: () => ({ cancel() {} }),
  });

  await client.start();
  await waitFor(() => client.getSnapshot().status.state === "error", 5000);

  expect(store.getSettingsWithSecrets().refreshToken).toBe("refresh_jwt");
  expect(client.getSnapshot().status.lastError?.toLowerCase()).toContain("session missing");
  // Recoverable network-class error must still allow reconnect (not hard relogin stop).
  expect(isCenterServerAuthCredentialError(client.getSnapshot().status.lastError)).toBe(false);
  client.dispose();
});

test("supabase center client retains vault key when a cloud secret is corrupt", async () => {
  const vaultKey = await generateVaultKey();
  const store = createFakeStore({
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
    vaultKey,
  });
  const remotePayload = {
    ...emptyEcoSyncedSettingsPayload(),
    providers: [
      {
        id: "provider-corrupt",
        name: "Cloud",
        baseUrl: "https://api.example.com",
        requestPath: "/v1",
        version: "1",
        apiCompat: "openai",
        defaultModel: "model",
        enabled: true,
      },
    ],
  };
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) {
      return jsonResponse(authUser());
    }
    if (url.includes("/rest/v1/user_settings")) {
      return jsonResponse([
        {
          user_id: USER_ID,
          payload: remotePayload,
          updated_at: "2030-01-01T00:00:00.000Z",
          revision: 2,
        },
      ]);
    }
    if (url.includes("/rest/v1/user_secrets")) {
      return jsonResponse([
        {
          id: "secret-1",
          user_id: USER_ID,
          secret_kind: "provider",
          secret_key: "provider-corrupt",
          ciphertext: "not-valid-ciphertext",
          nonce: "not-valid-nonce",
          key_version: 1,
          updated_at: "2030-01-01T00:00:00.000Z",
        },
      ]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  let settingsApplied = false;
  let secretsApplied = false;
  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
    settingsSyncHooks: {
      collectSettingsPayload: emptyEcoSyncedSettingsPayload,
      applySettingsPayload: () => {
        settingsApplied = true;
      },
      collectPlainSecrets: () => [],
      applyPlainSecrets: () => {
        secretsApplied = true;
      },
    },
  });

  await expect(client.syncConfig("pull")).rejects.toMatchObject({
    code: "settings_sync_vault_decrypt",
  });
  expect(store.getVaultKey()).toBe(vaultKey);
  expect(client.getVaultStatus()).toMatchObject({
    hasVaultKey: true,
    state: "error",
  });
  expect(client.getVaultStatus().error).toContain("provider:provider-corrupt");
  expect(settingsApplied).toBe(false);
  expect(secretsApplied).toBe(false);
  client.dispose();
});

test("supabase center client syncs renamed device to eco_update_device_profile before local save", async () => {
  const store = createFakeStore({
    enabled: false,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    deviceName: "Old Desktop",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
  });

  let rpcBody: Record<string, unknown> | undefined;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) {
      return jsonResponse(authUser());
    }
    if (url.includes("/rest/v1/rpc/eco_update_device_profile")) {
      rpcBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      expect(rpcBody?.p_device_id).toBe(DEVICE_ID);
      expect(rpcBody?.p_name).toBe("Studio PC");
      expect(rpcBody?.p_metadata).toMatchObject({
        hostname: expect.any(String),
        platform: expect.any(String),
      });
      return jsonResponse([
        {
          id: DEVICE_ID,
          user_id: USER_ID,
          kind: "desktop",
          name: "Studio PC",
          metadata: rpcBody?.p_metadata,
          created_at: "2030-01-01T00:00:00.000Z",
          last_seen_at: "2030-01-01T00:00:00.000Z",
          disabled_at: null,
        },
      ]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
    realtimeFactory: createFakeRealtimeTransport,
  });

  const snapshot = await client.saveSettings({
    enabled: false,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceName: "Studio PC",
  });

  expect(rpcBody?.p_name).toBe("Studio PC");
  expect(snapshot.settings.deviceName).toBe("Studio PC");
  expect(store.getSettingsWithSecrets().deviceName).toBe("Studio PC");
  client.dispose();
});

test("supabase center client skips cloud rename sync when device name is unchanged", async () => {
  const store = createFakeStore({
    enabled: false,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    deviceName: "Studio PC",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
  });

  const fetchImpl = async (input: RequestInfo | URL) => {
    throw new Error(`Unexpected fetch: ${String(input)}`);
  };

  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
    realtimeFactory: createFakeRealtimeTransport,
  });

  const snapshot = await client.saveSettings({
    enabled: false,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceName: "Studio PC",
  });

  expect(snapshot.settings.deviceName).toBe("Studio PC");
  client.dispose();
});

test("supabase center client leaves local name unchanged when cloud rename sync fails", async () => {
  const store = createFakeStore({
    enabled: false,
    supabaseUrl: "https://example.supabase.co",
    anonKey: "anon_key",
    deviceId: DEVICE_ID,
    deviceSecret: "device_secret_once",
    deviceName: "Old Desktop",
    accessToken: ACCESS_JWT,
    refreshToken: "refresh_jwt",
    accessTokenExpiresAt: "2030-01-01T01:00:00.000Z",
  });

  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) {
      return jsonResponse(authUser());
    }
    if (url.includes("/rest/v1/rpc/eco_update_device_profile")) {
      return jsonResponse({ message: "Active device not found for current user.", code: "42501" }, 403);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const client = new SupabaseCenterDesktopClient({
    store,
    eventCenter: new DesktopEventCenter({ now: fixedNow, idPrefix: "test_evt" }),
    fetch: fetchImpl as typeof fetch,
    now: fixedNow,
    realtimeFactory: createFakeRealtimeTransport,
  });

  await expect(
    client.saveSettings({
      enabled: false,
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon_key",
      deviceName: "Studio PC",
    }),
  ).rejects.toThrow();

  expect(store.getSettingsWithSecrets().deviceName).toBe("Old Desktop");
  client.dispose();
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await Bun.sleep(1);
  }
}

function authUser() {
  return {
    id: USER_ID,
    email: "you@example.com",
    created_at: "2030-01-01T00:00:00.000Z",
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: { display_name: "You" },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFakeRealtimeTransport() {
  return {
    async start() {},
    async stop() {},
    async syncBindings() {},
    publishNotification() {},
    listOnlineDeviceIds() {
      return new Set<string>();
    },
  };
}

function createFakeStore(initial: Partial<CenterServerSettingsSecret> = {}): CenterServerStore {
  let settings: CenterServerSettingsSecret = {
    enabled: false,
    supabaseUrl: "",
    serverUrl: "",
    hasAnonKey: false,
    anonKey: "",
    deviceName: "Eco Desktop",
    hasDeviceSecret: false,
    hasRefreshToken: false,
    hasVaultKey: false,
    deviceSecret: "",
    accessToken: "",
    refreshToken: "",
    vaultKey: "",
    ...initial,
  };
  settings = normalize(settings);

  return {
    getSettings(status: CenterServerConnectionStatus = { state: "disconnected" }) {
      return { settings: toView(settings), status };
    },
    getSettingsWithSecrets() {
      return settings;
    },
    getVaultKey() {
      return settings.vaultKey;
    },
    saveVaultKey(vaultKey: string) {
      settings = normalize({ ...settings, vaultKey });
    },
    clearVaultKey() {
      settings = normalize({ ...settings, vaultKey: "" });
    },
    markSettingsSynced(syncedAt: string) {
      settings = { ...settings, lastSettingsSyncedAt: syncedAt };
    },
    saveSettings(input: Partial<CenterServerSettingsSecret> & { anonKey?: string }) {
      settings = normalize({
        ...settings,
        ...input,
        anonKey: input.anonKey && input.anonKey.length > 0 ? input.anonKey : settings.anonKey,
        deviceSecret: input.deviceSecret || settings.deviceSecret,
        refreshToken: input.refreshToken || settings.refreshToken,
      });
      return toView(settings);
    },
    saveTokens(input: { accessToken: string; refreshToken?: string; accessTokenExpiresAt: string }) {
      settings = normalize({
        ...settings,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? settings.refreshToken,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
      });
      return toView(settings);
    },
    markConnected(connectedAt: string) {
      settings = { ...settings, lastConnectedAt: connectedAt, lastError: undefined };
    },
    markError(message: string) {
      settings = { ...settings, lastError: message };
    },
    clearRefreshToken() {
      settings = normalize({
        ...settings,
        refreshToken: "",
        accessToken: "",
        accessTokenExpiresAt: "",
      });
    },
    clearDeviceCredentials() {
      settings = normalize({
        ...settings,
        deviceId: "",
        deviceSecret: "",
        refreshToken: "",
        accessToken: "",
        accessTokenExpiresAt: "",
        vaultKey: "",
      });
    },
    clearConnection() {
      settings = normalize({
        enabled: false,
        supabaseUrl: "",
        serverUrl: "",
        hasAnonKey: false,
        anonKey: "",
        deviceName: "Eco Desktop",
        deviceId: "",
        deviceSecret: "",
        refreshToken: "",
        accessToken: "",
        accessTokenExpiresAt: "",
        vaultKey: "",
        hasDeviceSecret: false,
        hasRefreshToken: false,
        hasVaultKey: false,
      });
    },
  } as unknown as CenterServerStore;
}

function normalize(settings: CenterServerSettingsSecret): CenterServerSettingsSecret {
  const supabaseUrl = settings.supabaseUrl || settings.serverUrl || "";
  return {
    ...settings,
    supabaseUrl,
    serverUrl: supabaseUrl,
    hasAnonKey: Boolean(settings.anonKey),
    hasDeviceSecret: Boolean(settings.deviceSecret),
    hasRefreshToken: Boolean(settings.refreshToken),
    hasVaultKey: Boolean(settings.vaultKey),
  };
}

function toView(settings: CenterServerSettingsSecret): CenterServerSettingsView {
  return {
    enabled: settings.enabled,
    supabaseUrl: settings.supabaseUrl,
    serverUrl: settings.serverUrl,
    hasAnonKey: Boolean(settings.anonKey),
    deviceName: settings.deviceName,
    hasDeviceSecret: Boolean(settings.deviceSecret),
    hasRefreshToken: Boolean(settings.refreshToken),
    hasVaultKey: Boolean(settings.vaultKey),
    ...(settings.deviceId ? { deviceId: settings.deviceId } : {}),
    ...(settings.accessTokenExpiresAt ? { accessTokenExpiresAt: settings.accessTokenExpiresAt } : {}),
    ...(settings.lastConnectedAt ? { lastConnectedAt: settings.lastConnectedAt } : {}),
    ...(settings.lastSettingsSyncedAt ? { lastSettingsSyncedAt: settings.lastSettingsSyncedAt } : {}),
    ...(settings.lastError ? { lastError: settings.lastError } : {}),
  };
}
