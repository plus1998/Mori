import { Download, FolderOpen, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserDownload, BrowserDownloadActionRequest } from "../shared/browser-downloads";
import { formatIpcInvokeError } from "./AppMessage";
import "./browser-downloads.css";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BrowserDownloadsPanel({ browserId, files }: { browserId: string; files: BrowserDownload[] }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();

  async function act(fileId: string, action: BrowserDownloadActionRequest["action"]) {
    setBusy(fileId);
    setError(undefined);
    setSaved(undefined);
    try {
      if (!window.eco) throw new Error(t("browser.downloads.unavailable"));
      const result = await window.eco.browserDownloadAction({ browserId, fileId, action });
      if (action === "save" && !result.cancelled) setSaved(fileId);
    } catch (error) {
      setError(formatIpcInvokeError(error));
    } finally {
      setBusy(undefined);
    }
  }

  return <section className="browser-downloads" aria-label={t("browser.downloads.title")}>
    <p className="browser-downloads-hint">{t("browser.downloads.temporary")}</p>
    {files.length === 0 ? <p>{t("browser.downloads.empty")}</p> : <ul>
      {[...files].reverse().map(file => <li key={file.id}>
        <div className="browser-downloads-file">
          <span className="browser-downloads-name" title={file.name}>{file.name}</span>
          <span className="browser-downloads-state">
            {t(`browser.downloads.${file.state}`)} · {formatSize(file.receivedBytes)}
            {file.totalBytes > 0 && file.state === "pending" ? ` / ${formatSize(file.totalBytes)}` : ""}
            {saved === file.id ? ` · ${t("browser.downloads.saved")}` : ""}
          </span>
          {file.state === "pending" ? <progress aria-label={t("browser.downloads.progress", { name: file.name })}
            {...(file.totalBytes > 0 ? { max: file.totalBytes, value: file.receivedBytes } : {})} /> : null}
          {file.error ? <span className="browser-downloads-error">{file.error}</span> : null}
        </div>
        {file.state === "completed" ? <>
          <button type="button" className="browser-panel-icon-btn" disabled={Boolean(busy)}
            aria-label={t("browser.downloads.save", { name: file.name })} title={t("browser.downloads.save", { name: file.name })}
            onClick={() => void act(file.id, "save")}><Download size={14} /></button>
          <button type="button" className="browser-panel-icon-btn" disabled={Boolean(busy)}
            aria-label={t("browser.downloads.reveal", { name: file.name })} title={t("browser.downloads.reveal", { name: file.name })}
            onClick={() => void act(file.id, "reveal")}><FolderOpen size={14} /></button>
        </> : file.state === "pending" ? <button type="button" className="browser-panel-icon-btn" disabled={Boolean(busy)}
          aria-label={t("browser.downloads.cancel", { name: file.name })} title={t("browser.downloads.cancel", { name: file.name })}
          onClick={() => void act(file.id, "cancel")}><X size={14} /></button> : null}
      </li>)}
    </ul>}
    {error ? <p className="browser-downloads-error" role="alert">{error}</p> : null}
  </section>;
}
