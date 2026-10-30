import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { rootCertificates } from "node:tls";
import {
  createSigningIdentity,
  importCiSigningIdentity,
  prepareSigningIdentity,
} from "../scripts/mac-signing.mjs";

let directory: string;
let previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env };
  directory = fs.mkdtempSync("/tmp/mori-signing-test-");
  process.env.MORI_MAC_SIGNING_DIR = directory;
});
afterEach(() => {
  process.env = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test("missing credentials fail instead of changing the application's signing identity", () => {
  expect(() => prepareSigningIdentity()).toThrow("ad-hoc fallback is disabled");
});

test("CI requires both secrets before writing any signing material", () => {
  process.env.MORI_MAC_CERTIFICATE_P12 = "example";
  delete process.env.MORI_MAC_CERTIFICATE_PASSWORD;
  expect(() => importCiSigningIdentity()).toThrow("Actions Secrets are required");
  expect(fs.readdirSync(directory)).toEqual([]);
});

test("creation never replaces an existing private identity", () => {
  const p12 = path.join(directory, "certificate.p12");
  fs.writeFileSync(p12, "existing identity");
  expect(() => createSigningIdentity()).toThrow("never regenerate per build");
  expect(fs.readFileSync(p12, "utf8")).toBe("existing identity");
});

test("a different certificate is rejected before importing private keys", () => {
  const otherCertificate = rootCertificates[0];
  if (!otherCertificate) throw new Error("Node did not provide a root certificate for the mismatch test");
  fs.writeFileSync(path.join(directory, "certificate.pem"), otherCertificate);
  fs.writeFileSync(path.join(directory, "certificate.p12"), "must never be imported");
  fs.writeFileSync(path.join(directory, "password.txt"), "example");
  expect(() => prepareSigningIdentity()).toThrow("differs from the pinned public certificate");
  expect(fs.existsSync(path.join(directory, "keychain-password.txt"))).toBe(false);
});
