#!/usr/bin/env node
/** Fixed self-signed macOS identity. Private material always lives outside git. */
import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const signingDirectory = () =>
  process.env.MORI_MAC_SIGNING_DIR?.trim() ||
  path.join(os.homedir(), "Library", "Application Support", "Mori", "signing", "macos");
export const publicCertificatePath = fileURLToPath(
  new URL("../packaging/macos-signing.pem", import.meta.url),
);

function run(command, args, options = {}) {
  // Do not include command arguments in errors: security arguments contain passwords.
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  } catch (error) {
    throw new Error(`${command} failed: ${error.stderr?.toString().trim() || "no diagnostic output"}`);
  }
}

export function certificateFingerprint(pem) {
  return new X509Certificate(pem).fingerprint.replaceAll(":", "");
}

export function createSigningIdentity() {
  const directory = signingDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const files = ["certificate.p12", "certificate.pem", "password.txt"];
  if (files.some((name) => fs.existsSync(path.join(directory, name)))) {
    throw new Error(
      `Signing material already exists in ${directory}; restore/reuse it, never regenerate per build.`,
    );
  }
  const temporary = fs.mkdtempSync(path.join(directory, ".create-"));
  const passwordFile = path.join(temporary, "password.txt");
  try {
    fs.writeFileSync(passwordFile, randomBytes(32).toString("base64"), { mode: 0o600 });
    run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-noenc",
      "-sha256",
      "-days",
      "7300",
      "-subj",
      "/CN=Mori Self-Signed Code Signing/O=Mori",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=critical,codeSigning",
      "-keyout",
      path.join(temporary, "private-key.pem"),
      "-out",
      path.join(temporary, "certificate.pem"),
    ]);
    // Apple's PKCS#12 importer needs the SHA1/3DES encoding, including on OpenSSL 3+.
    run("openssl", [
      "pkcs12",
      "-export",
      "-inkey",
      path.join(temporary, "private-key.pem"),
      "-in",
      path.join(temporary, "certificate.pem"),
      "-name",
      "Mori Self-Signed Code Signing",
      "-keypbe",
      "PBE-SHA1-3DES",
      "-certpbe",
      "PBE-SHA1-3DES",
      "-macalg",
      "sha1",
      "-passout",
      `file:${passwordFile}`,
      "-out",
      path.join(temporary, "certificate.p12"),
    ]);
    for (const name of files) {
      fs.copyFileSync(path.join(temporary, name), path.join(directory, name), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(directory, name), 0o600);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`Created encrypted signing identity in ${directory}`);
  console.log(
    `Public certificate SHA-1: ${certificateFingerprint(fs.readFileSync(path.join(directory, "certificate.pem")))}`,
  );
}

export function prepareSigningIdentity() {
  const directory = signingDirectory();
  const certificatePath = path.join(directory, "certificate.pem");
  const p12Path = path.join(directory, "certificate.p12");
  const passwordPath = path.join(directory, "password.txt");
  for (const file of [certificatePath, p12Path, passwordPath]) {
    if (!fs.existsSync(file))
      throw new Error(
        `Missing macOS signing material: ${file}. Restore the fixed identity; ad-hoc fallback is disabled.`,
      );
  }
  const fingerprint = certificateFingerprint(fs.readFileSync(certificatePath));
  const expected = certificateFingerprint(fs.readFileSync(publicCertificatePath));
  if (fingerprint !== expected)
    throw new Error("macOS signing certificate differs from the pinned public certificate.");
  const keychain = path.join(directory, "mori-signing.keychain-db");
  const keychainPasswordPath = path.join(directory, "keychain-password.txt");
  if (!fs.existsSync(keychainPasswordPath)) {
    fs.writeFileSync(keychainPasswordPath, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
  }
  const keychainPassword = fs.readFileSync(keychainPasswordPath, "utf8").trim();
  if (!fs.existsSync(keychain)) run("security", ["create-keychain", "-p", keychainPassword, keychain]);
  fs.chmodSync(keychain, 0o600);
  run("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
  run("security", ["set-keychain-settings", "-lut", "21600", keychain]);
  const certificates = run("security", ["find-certificate", "-a", "-Z", keychain]);
  if (!certificates.includes(fingerprint)) {
    run("security", [
      "import",
      p12Path,
      "-k",
      keychain,
      "-P",
      fs.readFileSync(passwordPath, "utf8").trim(),
      "-T",
      "/usr/bin/codesign",
      "-T",
      "/usr/bin/security",
    ]);
  }
  run("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    keychainPassword,
    keychain,
  ]);
  return { fingerprint, keychain };
}

export function importCiSigningIdentity() {
  const encoded = process.env.MORI_MAC_CERTIFICATE_P12?.trim();
  const password = process.env.MORI_MAC_CERTIFICATE_PASSWORD?.trim();
  if (!encoded || !password) {
    throw new Error(
      "Both MORI_MAC_CERTIFICATE_P12 and MORI_MAC_CERTIFICATE_PASSWORD Actions Secrets are required; ad-hoc fallback is disabled.",
    );
  }
  const directory = signingDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, value] of [
    ["certificate.p12", Buffer.from(encoded, "base64")],
    ["password.txt", password],
  ])
    fs.writeFileSync(path.join(directory, name), value, { mode: 0o600, flag: "wx" });
  const pem = run("openssl", [
    "pkcs12",
    "-in",
    path.join(directory, "certificate.p12"),
    "-passin",
    `file:${path.join(directory, "password.txt")}`,
    "-clcerts",
    "-nokeys",
  ]);
  fs.writeFileSync(path.join(directory, "certificate.pem"), pem, { mode: 0o600, flag: "wx" });
  return prepareSigningIdentity();
}

function cleanupCiSigningIdentity() {
  const directory = signingDirectory();
  const runnerTemp = process.env.RUNNER_TEMP;
  if (
    process.env.CI !== "true" ||
    !runnerTemp ||
    !directory.startsWith(`${path.resolve(runnerTemp)}${path.sep}`)
  ) {
    throw new Error("CI cleanup requires MORI_MAC_SIGNING_DIR inside RUNNER_TEMP.");
  }
  const keychain = path.join(directory, "mori-signing.keychain-db");
  if (fs.existsSync(keychain)) run("security", ["delete-keychain", keychain]);
  fs.rmSync(directory, { recursive: true, force: true });
}

function uploadSecrets() {
  const directory = signingDirectory();
  const repository = process.argv[3];
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Usage: node scripts/mac-signing.mjs upload-secrets owner/repository");
  prepareSigningIdentity();
  run("gh", ["auth", "status"]);
  for (const [name, value] of [
    ["MORI_MAC_CERTIFICATE_P12", fs.readFileSync(path.join(directory, "certificate.p12")).toString("base64")],
    ["MORI_MAC_CERTIFICATE_PASSWORD", fs.readFileSync(path.join(directory, "password.txt"), "utf8").trim()],
  ]) {
    run("gh", ["secret", "set", name, "--repo", repository], { input: value });
    console.log(`Uploaded ${name} to ${repository}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.platform !== "darwin") throw new Error("macOS signing setup requires macOS.");
  const command = process.argv[2];
  if (command === "create") createSigningIdentity();
  else if (command === "prepare") console.log(`Prepared identity ${prepareSigningIdentity().fingerprint}`);
  else if (command === "import-ci") console.log(`Imported identity ${importCiSigningIdentity().fingerprint}`);
  else if (command === "cleanup-ci") cleanupCiSigningIdentity();
  else if (command === "upload-secrets") uploadSecrets();
  else
    throw new Error(
      "Usage: mac-signing.mjs create | prepare | import-ci | cleanup-ci | upload-secrets owner/repository",
    );
}
