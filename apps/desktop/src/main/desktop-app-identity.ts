import path from "node:path";
import { app } from "electron";
import { DEFAULT_DEV_USER_DATA_SUFFIX, resolveDevUserDataSuffix } from "./desktop-dev-user-data-suffix";

/** Packaged desktop identity ({@link electron-builder.yml}). */
export const DESKTOP_PACKAGED_APP_ID = "com.eco.coding";

export const DESKTOP_APP_NAME = "Mori";
export const DESKTOP_DEV_APP_NAME = "Mori Dev";
const LEGACY_DEV_APP_NAME = "Eco Coding Dev";

/**
 * Unpackaged dev userData path: default Electron userData + suffix.
 * Electron scopes {@link app.requestSingleInstanceLock} to this directory.
 */
export function resolveDevUserDataPath(configuredSuffix?: string): string {
  return app.getPath("userData") + resolveDevUserDataSuffix(configuredSuffix);
}

function divertDevLogs(application: typeof app, suffix: string): void {
  if (process.platform === "darwin") {
    application.setAppLogsPath(application.getPath("logs") + suffix);
    return;
  }
  application.setAppLogsPath(path.join(application.getPath("userData") + suffix, "logs"));
}

/**
 * Keep pre-rebrand storage paths and the startup name used by Chromium's secret
 * store. Apply the user-facing name after Electron is ready, once Chromium has
 * captured its keychain identity. See electron/electron#40430.
 *
 * Must run before {@link app.requestSingleInstanceLock} and any other
 * `app.getPath("userData")` reads that should see the dev directory.
 */
export function configureDesktopIdentity(application = app): void {
  // Resolve defaults before setName: sessions, credentials and logs must continue
  // using the same locations after a display-name change.
  const userDataPath = application.getPath("userData");
  if (application.isPackaged) {
    application.setPath("userData", userDataPath);
    application.setPath("sessionData", application.getPath("sessionData"));
    application.setAppLogsPath(application.getPath("logs"));
    return;
  }

  const suffix = resolveDevUserDataSuffix(process.env.ECO_DEV_USER_DATA_SUFFIX);
  divertDevLogs(application, suffix);
  application.setPath("userData", userDataPath + suffix);
  application.setPath("sessionData", userDataPath + suffix);
  application.setName(LEGACY_DEV_APP_NAME);
}

/** Must run after ready so renaming cannot select a different safeStorage key. */
export function applyDesktopDisplayName(application = app): void {
  const displayName = application.isPackaged ? DESKTOP_APP_NAME : DESKTOP_DEV_APP_NAME;
  application.setName(displayName);
  application.setAboutPanelOptions({ applicationName: displayName });
}

export { DEFAULT_DEV_USER_DATA_SUFFIX, resolveDevUserDataSuffix };
