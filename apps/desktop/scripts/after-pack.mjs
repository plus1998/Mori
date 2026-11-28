#!/usr/bin/env node
/**
 * Post-pack hooks for local/CI builds without commercial signing:
 * - win32: embed the icon and application name when signAndEditExecutable is off
 * - darwin: use the pinned self-signed identity for stable application identity
 */
import path from "node:path";
import { selfSignMacApp, shouldSelfSignMac } from "./after-pack-mac-sign.mjs";
import { ensureNodePtySpawnHelpersExecutable } from "./prepare-node-pty.mjs";
import { verifyWindowsFocusHookPackage } from "./verify-browser-focus-hook-package.mjs";
import { setWindowsExecutableResources } from "./windows-exe-resources.mjs";

export default async function afterPack(context) {
  const platform = context.electronPlatformName;

  if (platform === "win32") {
    verifyWindowsFocusHookPackage(context.appOutDir);
    const { productFilename, productName } = context.packager.appInfo;
    const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
    const iconPath = path.join(context.packager.buildResourcesDir, "icon.ico");
    setWindowsExecutableResources(exePath, iconPath, productName);
    return;
  }

  if (platform === "darwin") {
    const productFilename = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${productFilename}.app`);
    // CI installs with --ignore-scripts, so fix the shipped helper before signing too.
    ensureNodePtySpawnHelpersExecutable(
      path.join(appPath, "Contents", "Resources", "app.asar.unpacked", "node_modules", "node-pty"),
      platform,
    );
    if (shouldSelfSignMac(context)) selfSignMacApp(appPath);
  }
}
