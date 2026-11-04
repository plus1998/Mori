import { useEffect } from "react";
import { BrowserWebviewPersistentHost } from "./BrowserWebviewPersistentHost";
import { installBrowserAgentPresenceOverlay } from "./browser-agent-presence-overlay";
import { useBrowserWebviewInstances } from "./browser-state-store";
import { browserWebviewPool } from "./browser-webview-pool";

/**
 * App-root layer: owns persistent host slots and syncs the imperative guest pool
 * with main-process {@link BrowserViewState.allGuestInstances}.
 */
export function BrowserWebviewLayer({ windowBrowserId }: { windowBrowserId?: string } = {}) {
  const instances = useBrowserWebviewInstances().filter(instance => windowBrowserId
    ? instance.windowed && instance.id === windowBrowserId
    : !instance.windowed);

  // Sync during render so release runs before React commits PersistentHost unmounts
  // (otherwise the slot div is deleted with the <webview> still inside).
  browserWebviewPool.sync(instances);

  useEffect(() => installBrowserAgentPresenceOverlay(), []);

  return (
    <>
      {instances.map((instance) => (
        <BrowserWebviewPersistentHost key={instance.id} browserId={instance.id} />
      ))}
    </>
  );
}
