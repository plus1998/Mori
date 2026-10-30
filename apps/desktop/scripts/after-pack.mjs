#!/usr/bin/env node
/**
 * Post-pack hooks for unsigned local/CI builds:
 * - win32: embed icon when signAndEditExecutable is off
 * - darwin: adhoc re-sign so Gatekeeper does not report "damaged" after browser download
 */
import path from "node:path";
import { setWindowsExecutableIcon } from "./windows-exe-icon.mjs";
import { adhocSignMacApp, shouldAdhocSignMac } from "./after-pack-mac-sign.mjs";
import { ensureNodePtySpawnHelpersExecutable } from "./prepare-node-pty.mjs";
import { verifyWindowsFocusHookPackage } from "./verify-browser-focus-hook-package.mjs";

export default async function afterPack(context) {
  const platform = context.electronPlatformName;

  if (platform === "win32") {
    verifyWindowsFocusHookPackage(context.appOutDir);
    const productFilename = context.packager.appInfo.productFilename;
    const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
    const iconPath = path.join(context.packager.buildResourcesDir, "icon.ico");
    setWindowsExecutableIcon(exePath, iconPath);
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
    if (shouldAdhocSignMac(context)) adhocSignMacApp(appPath);
  }
}
