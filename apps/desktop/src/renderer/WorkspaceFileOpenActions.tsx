import { ChevronDown, ExternalLink, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserOpenRequest } from "../shared/browser";
import { formatIpcInvokeError } from "./AppMessage";

interface AssociatedApp {
  name: string;
  bundleId: string;
  iconBase64?: string;
  isDefault?: boolean;
}

interface FileOpenApi {
  browserOpen(request: BrowserOpenRequest): Promise<unknown>;
  openFileExternally(filePath: string): Promise<unknown>;
}

interface FileOpenScope {
  workspacePath: string;
  threadId?: string;
}

function isHtmlFile(filePath: string): boolean {
  return /\.(?:html?|xhtml|shtml)$/i.test(filePath);
}

/** Both file entry points use the same default: HTML in Eco, other files in the OS. */
export async function openWorkspaceFileDefault(filePath: string, api: FileOpenApi, scope: FileOpenScope): Promise<void> {
  if (isHtmlFile(filePath)) {
    await api.browserOpen({ url: filePath, reveal: true, activate: true,
      ...(scope.threadId ? { threadId: scope.threadId } : { workspacePath: scope.workspacePath }),
    });
  } else {
    await api.openFileExternally(filePath);
  }
}

export function WorkspaceFileOpenActions({ filePath, requestId, workspacePath, threadId }: FileOpenScope & { filePath: string; requestId: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<AssociatedApp[]>([]);
  const [loadingApps, setLoadingApps] = useState(true);
  const [appsError, setAppsError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const html = isHtmlFile(filePath);
  const defaultApp = apps.find(app => app.isDefault);

  useEffect(() => {
    let active = true;
    setApps([]);
    setAppsError(undefined);
    setLoadingApps(true);
    void (async () => {
      try {
        if (!window.eco?.getAssociatedApps) throw new Error(t("fileBrowser.apiUnavailable"));
        const result = await window.eco.getAssociatedApps(filePath);
        if (active) setApps(result);
      } catch (error) {
        if (active) setAppsError(formatIpcInvokeError(error, t("fileBrowser.unknownError")));
      } finally {
        if (active) setLoadingApps(false);
      }
    })();
    return () => { active = false; };
  }, [filePath, requestId, t]);

  useEffect(() => {
    if (!open) return;
    const closeOnClickOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", closeOnClickOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closeOnClickOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function runAction(action: (api: NonNullable<Window["eco"]>) => Promise<unknown>) {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    setActionError(undefined);
    try {
      if (!window.eco) throw new Error(t("fileBrowser.apiUnavailable"));
      await action(window.eco);
    } catch (error) {
      setActionError(formatIpcInvokeError(error, t("fileBrowser.unknownError")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={menuRef} className="workspace-file-header__open-menu-container">
      <div className="workspace-file-header__open-group" aria-busy={busy}>
        <button type="button" className="workspace-file-header__action-btn workspace-file-header__open-btn"
          disabled={busy} title={t(html ? "fileViewer.openInBrowser" : "fileViewer.open")}
          onClick={() => void runAction(api => openWorkspaceFileDefault(filePath, api, { workspacePath, ...(threadId ? { threadId } : {}) }))}>
          {html ? <img src="./icon.png" alt="" className="workspace-file-header__app-icon" /> : defaultApp?.iconBase64 ? (
            <img src={defaultApp.iconBase64} alt="" className="workspace-file-header__app-icon" />
          ) : <ExternalLink size={14} aria-hidden />}
          <span>{t("fileViewer.open")}</span>
        </button>
        <button type="button" className="workspace-file-header__action-btn workspace-file-header__dropdown-btn"
          disabled={busy} aria-label={t("fileViewer.openWith")} title={t("fileViewer.openWith")}
          aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(current => !current)}>
          <ChevronDown size={13} aria-hidden />
        </button>
      </div>
      {open ? (
        <div className="workspace-file-header__open-menu-dropdown" role="menu" aria-label={t("fileViewer.openWith")}>
          {loadingApps ? <p className="workspace-file-header__menu-message" role="status">{t("fileViewer.loadingApps")}</p> : null}
          {appsError ? <p className="workspace-file-header__menu-message is-error" role="alert">{t("fileViewer.appsLoadFailed", { error: appsError })}</p> : null}
          {apps.filter(app => html || !app.isDefault).map(app => (
            <button key={app.bundleId} type="button" role="menuitem"
              onClick={() => void runAction(api => api.openFileWithApp(filePath, app.bundleId))}>
              {app.iconBase64 ? <img src={app.iconBase64} alt="" className="workspace-file-header__app-icon" /> : <ExternalLink size={14} aria-hidden />}
              <span>{app.name}</span>
            </button>
          ))}
          <button type="button" role="menuitem" onClick={() => void runAction(api => api.openContainingFolder(filePath))}>
            <FolderOpen size={14} aria-hidden />
            <span>{t("fileViewer.openContainingFolder")}</span>
          </button>
        </div>
      ) : null}
      {actionError ? <p className="workspace-file-header__action-error" role="alert">{actionError}</p> : null}
    </div>
  );
}
