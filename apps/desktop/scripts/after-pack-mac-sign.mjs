import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prepareSigningIdentity } from "./mac-signing.mjs";

export function shouldSelfSignMac(context) {
  const identity = context.packager.platformSpecificBuildOptions?.identity;
  return identity == null || identity === "-";
}

export function selfSignMacApp(appPath) {
  const { fingerprint, keychain } = prepareSigningIdentity();
  // OCU is vendor-signed and notarized. ExtraResources is outside codesign's
  // standard nested-code locations: preserve its existing stable identity.
  const computerUseApp = path.join(
    appPath,
    "Contents",
    "Resources",
    "open-computer-use",
    "dist",
    "Open Computer Use.app",
  );
  const sign = spawnSync(
    "codesign",
    ["--force", "--deep", "--timestamp=none", "--keychain", keychain, "--sign", fingerprint, appPath],
    { stdio: "inherit" },
  );
  if (sign.error) throw sign.error;
  if (sign.status !== 0) throw new Error(`Self-signed codesign failed for ${appPath} (exit ${sign.status})`);
  const bundles = [appPath, ...(fs.existsSync(computerUseApp) ? [computerUseApp] : [])];
  for (const bundle of bundles) {
    const requirement = bundle === appPath ? ["-R", `=certificate root = H"${fingerprint}"`] : [];
    const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", ...requirement, bundle], {
      encoding: "utf8",
    });
    if (verify.error) throw verify.error;
    if (verify.status !== 0) {
      const detail = verify.stderr?.trim() || verify.stdout?.trim() || "unknown error";
      throw new Error(`Self-signed codesign verification failed for ${bundle}: ${detail}`);
    }
  }
  console.log(`Signed macOS app with fixed identity ${fingerprint}`);
}
