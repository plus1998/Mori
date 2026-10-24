import { Check, Download, FolderOpen, LoaderCircle, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserDownload, BrowserDownloadActionRequest } from "../shared/browser-downloads";
import { formatIpcInvokeError } from "./AppMessage";
import { MaterialFileIcon } from "./MaterialFileIcon";
import "./browser-downloads.css";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function BrowserDownloadsPanel({ browserId, files }: { browserId: string; files: BrowserDownload[] }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<{ fileId: string; action: BrowserDownloadActionRequest["action"] }>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<Set<string>>(() => new Set());

  async function act(fileId: string, action: BrowserDownloadActionRequest["action"]) {
    if (busy) return;
    setBusy({ fileId, action });
    setError(undefined);
    try {
      if (!window.eco) throw new Error(t("browser.downloads.unavailable"));
      const result = await window.eco.browserDownloadAction({ browserId, fileId, action });
      if (action === "save" && !result.cancelled) setSaved(current => new Set([...current, fileId]));
    } catch (error) {
      setError(formatIpcInvokeError(error));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="browser-downloads" aria-label={t("browser.downloads.title")}>
      <header className="browser-downloads-header">
        <h3>{t("browser.downloads.title")}</h3>
        <span className="browser-downloads-count">{files.length}</span>
      </header>
      {files.length === 0 ? (
        <div className="browser-downloads-empty">
          <Download size={22} strokeWidth={1.5} aria-hidden />
          <span>{t("browser.downloads.empty")}</span>
          <p>{t("browser.downloads.emptyHint")}</p>
        </div>
      ) : (
        <ul className="browser-downloads-list">
          {[...files].reverse().map(file => {
            const pending = file.state === "pending";
            const completed = file.state === "completed";
            const saving = busy?.fileId === file.id && busy.action === "save";
            const removing = busy?.fileId === file.id && busy.action === "remove";
            const percent = file.totalBytes > 0
              ? Math.min(100, Math.max(0, Math.round(file.receivedBytes / file.totalBytes * 100)))
              : undefined;
            return (
              <li key={file.id} className="browser-downloads-row" data-state={file.state} aria-busy={busy?.fileId === file.id}>
                <span className="browser-downloads-icon"><MaterialFileIcon path={file.name} size={22} /></span>
                <div className="browser-downloads-file">
                  <span className="browser-downloads-name" title={file.name}>{file.name}</span>
                  <div className="browser-downloads-meta">
                    <span className="browser-downloads-state">
                      {completed ? <Check size={11} strokeWidth={2.5} aria-hidden /> : null}
                      {t(saved.has(file.id) ? "browser.downloads.saved" : `browser.downloads.${file.state}`)}
                    </span>
                    <span className="browser-downloads-size">
                      {formatSize(file.receivedBytes)}
                      {file.totalBytes > 0 && pending ? ` / ${formatSize(file.totalBytes)}` : ""}
                    </span>
                    {pending && percent !== undefined ? <span className="browser-downloads-percent">{percent}%</span> : null}
                  </div>
                  {pending ? (
                    <progress aria-label={t("browser.downloads.progress", { name: file.name })}
                      {...(file.totalBytes > 0 ? { max: file.totalBytes, value: Math.min(file.receivedBytes, file.totalBytes) } : {})} />
                  ) : null}
                  {file.error ? <span className="browser-downloads-error">{file.error}</span> : null}
                </div>
                <div className="browser-downloads-actions">
                  {completed ? (
                    <>
                      <button type="button" className="browser-downloads-action" disabled={Boolean(busy)}
                        aria-label={t("browser.downloads.save", { name: file.name })} title={t("browser.downloads.save", { name: file.name })}
                        onClick={() => void act(file.id, "save")}>
                        {saving ? <LoaderCircle size={15} className="browser-panel-spin" /> : <Download size={15} />}
                      </button>
                      <button type="button" className="browser-downloads-action" disabled={Boolean(busy)}
                        aria-label={t("browser.downloads.reveal", { name: file.name })} title={t("browser.downloads.reveal", { name: file.name })}
                        onClick={() => void act(file.id, "reveal")}><FolderOpen size={15} /></button>
                    </>
                  ) : null}
                  {pending ? (
                    <button type="button" className="browser-downloads-action" disabled={Boolean(busy)}
                      aria-label={t("browser.downloads.cancel", { name: file.name })} title={t("browser.downloads.cancel", { name: file.name })}
                      onClick={() => void act(file.id, "cancel")}><X size={15} /></button>
                  ) : (
                    <button type="button" className="browser-downloads-action browser-downloads-action--remove" disabled={Boolean(busy)}
                      aria-label={t("browser.downloads.remove", { name: file.name })} title={t("browser.downloads.remove", { name: file.name })}
                      onClick={() => void act(file.id, "remove")}>
                      {removing ? <LoaderCircle size={15} className="browser-panel-spin" /> : <Trash2 size={15} />}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error ? <p className="browser-downloads-error browser-downloads-action-error" role="alert">{error}</p> : null}
      <p className="browser-downloads-hint">{t("browser.downloads.temporary")}</p>
    </section>
  );
}
