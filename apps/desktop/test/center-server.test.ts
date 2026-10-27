import { expect, test } from "bun:test";
import {
  buildCenterServerWebSocketUrl,
  buildCenterQrPayload,
  buildPairingQrPayload,
  buildEcoAuthEmailConfirmRedirect,
  CENTER_SERVER_INCOMPLETE_CONFIG_MESSAGE,
  CENTER_SERVER_REAUTH_MESSAGE,
  classifyCenterServerAuthError,
  isCenterServerAuthCredentialError,
  isAppDeepLink,
  normalizeCenterServerHttpUrl,
  parseEcoConnectDeepLink,
  recoveryForSessionRefreshFailure,
  validateCenterServerSettingsInput,
} from "../src/shared/center-server";

test("buildEcoAuthEmailConfirmRedirect points at project Edge Function", () => {
  expect(buildEcoAuthEmailConfirmRedirect("https://abc.supabase.co/")).toBe(
    "https://abc.supabase.co/functions/v1/auth-email-confirmed",
  );
});

test("normalizeCenterServerHttpUrl trims trailing slashes", () => {
  expect(normalizeCenterServerHttpUrl("https://center.example.com/api/")).toBe(
    "https://center.example.com/api",
  );
});

test("buildCenterServerWebSocketUrl maps http to ws and appends access token", () => {
  const url = buildCenterServerWebSocketUrl("http://127.0.0.1:8787", "token_abc");
  expect(url).toBe("ws://127.0.0.1:8787/v1/rpc?access_token=token_abc");
});

test("validateCenterServerSettingsInput requires URL when enabled", () => {
  expect(() => validateCenterServerSettingsInput({ enabled: true, supabaseUrl: "" })).toThrow(
    /Supabase project URL is required/,
  );
});

const authRecoveryCases: Array<[string, ReturnType<typeof classifyCenterServerAuthError>]> = [
  ["Refresh token is invalid or expired.", "relogin"],
  ["Invalid Refresh Token", "relogin"],
  ["refresh_token_not_found", "relogin"],
  ["Device credentials are invalid.", "relogin"],
  [CENTER_SERVER_REAUTH_MESSAGE, "relogin"],
  [CENTER_SERVER_INCOMPLETE_CONFIG_MESSAGE, "relogin"],
  ["Device is not active.", "device_inactive"],
  ["Token device is not active.", "device_inactive"],
  ["Refresh token device is not active.", "device_inactive"],
  ["Token user is not active.", "account_unusable"],
  ["Refresh token subject is not active.", "account_unusable"],
  ["Connection timed out.", "network"],
  ["Request failed with HTTP 503.", "network"],
  ["SocketException: Failed host lookup", "network"],
  ["Something else", "unknown"],
  ["Unauthorized", "unknown"],
  ["not authorized", "unknown"],
  ["Auth session missing!", "network"],
  ["user session expired", "relogin"],
];

test.each(authRecoveryCases)("classifyCenterServerAuthError(%s)", (message, expected) => {
  expect(classifyCenterServerAuthError(message)).toBe(expected);
});

test("isCenterServerAuthCredentialError detects refresh token failures", () => {
  expect(isCenterServerAuthCredentialError("Refresh token is invalid or expired.")).toBe(true);
  expect(isCenterServerAuthCredentialError("Device credentials are invalid.")).toBe(true);
  expect(isCenterServerAuthCredentialError(CENTER_SERVER_REAUTH_MESSAGE)).toBe(true);
  expect(isCenterServerAuthCredentialError("Connection timed out.")).toBe(false);
  expect(isCenterServerAuthCredentialError("Unauthorized")).toBe(false);
});

test("recoveryForSessionRefreshFailure keeps session on transient failures", () => {
  expect(recoveryForSessionRefreshFailure("SocketException: Failed host lookup")).toBe("network");
  expect(recoveryForSessionRefreshFailure("Unauthorized")).toBe("network");
  expect(recoveryForSessionRefreshFailure("Something ambiguous")).toBe("network");
  expect(recoveryForSessionRefreshFailure("Refresh token is invalid or expired.")).toBe("relogin");
});

test.each(["mori", "eco"])("parseEcoConnectDeepLink parses %s://connect with url + token", (scheme) => {
  const parsed = parseEcoConnectDeepLink(
    `${scheme}://connect?url=https://abc.supabase.co&token=your.anon.key`,
  );
  expect(parsed).toEqual({ supabaseUrl: "https://abc.supabase.co", anonKey: "your.anon.key" });
});

test.each(["mori", "eco"])("parseEcoConnectDeepLink accepts %s aliases and normalizes URLs", (scheme) => {
  const parsed = parseEcoConnectDeepLink(`${scheme}://connect?supabase=https://abc.supabase.co/&anon=key123`);
  expect(parsed).toEqual({ supabaseUrl: "https://abc.supabase.co", anonKey: "key123" });
});

test("parseEcoConnectDeepLink rejects unsupported schemes and other hosts", () => {
  expect(parseEcoConnectDeepLink("https://connect?url=x&token=y")).toBeUndefined();
  expect(parseEcoConnectDeepLink("mori-evil://connect?url=x&token=y")).toBeUndefined();
  expect(parseEcoConnectDeepLink("mori://center?supabase=x&anon=y")).toBeUndefined();
  expect(parseEcoConnectDeepLink("eco://center?supabase=x&anon=y")).toBeUndefined();
  expect(parseEcoConnectDeepLink("garbage")).toBeUndefined();
});

test.each(["mori", "eco"])("isAppDeepLink routes %s links at startup and while running", (scheme) => {
  expect(isAppDeepLink(`${scheme}://connect?url=https://abc.supabase.co&token=key`)).toBe(true);
  expect(isAppDeepLink(`${scheme}://center?supabase=https://abc.supabase.co&anon=key`)).toBe(true);
});

test("isAppDeepLink rejects missing hosts, malformed URLs and unrelated schemes", () => {
  for (const url of ["mori://", "mori:connect", "mori://[", "https://connect", "mori-evil://connect", "--flag"]) {
    expect(isAppDeepLink(url)).toBe(false);
  }
});

test("new connect and pairing QR codes use mori with encoded connection details", () => {
  const connection = { supabaseUrl: "https://abc.supabase.co/", anonKey: "key+with/symbols=" };
  const center = new URL(buildCenterQrPayload(connection));
  expect(center.protocol).toBe("mori:");
  expect(center.hostname).toBe("center");
  expect(center.searchParams.get("supabase")).toBe("https://abc.supabase.co");
  expect(center.searchParams.get("anon")).toBe(connection.anonKey);
  expect(center.searchParams.has("token")).toBe(false);

  const pairing = new URL(buildPairingQrPayload({ ...connection, code: "ABCD1234", bootstrapToken: "a+b/c=" }));
  expect(pairing.protocol).toBe("mori:");
  expect(pairing.hostname).toBe("pair");
  expect(pairing.searchParams.get("code")).toBe("ABCD1234");
  expect(pairing.searchParams.get("token")).toBe("a+b/c=");
});

test("parseEcoConnectDeepLink keeps empty fields for missing/invalid params", () => {
  expect(parseEcoConnectDeepLink("eco://connect")).toEqual({ supabaseUrl: "", anonKey: "" });
  expect(parseEcoConnectDeepLink("eco://connect?url=not-a-url&token=k")).toEqual({
    supabaseUrl: "",
    anonKey: "k",
  });
});
