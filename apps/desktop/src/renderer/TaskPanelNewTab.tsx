import { AudioLines, FolderOpen, Globe, Palette, KeyRound, ListChecks, Terminal } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeBrowserNavigateUrl } from "../shared/browser";
import { BrowserAddressInput } from "./BrowserAddressInput";
import type { TaskPanelHomeTool } from "./task-panel-tabs";

/** A local start page. It has no browser guest until an address is submitted. */
export function TaskPanelNewTab({
  tabId,
  onOpenTool,
  onNavigate,
}: {
  tabId: string;
  onOpenTool: (tabId: string, tool: TaskPanelHomeTool) => void;
  onNavigate: (tabId: string, url: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const addressInputId = useId();
  const titleId = useId();
  const [address, setAddress] = useState("");
  const [opening, setOpening] = useState(false);

  return (
    <div className="browser-panel task-panel-new-tab" aria-label={t("browser.newTab")}>
      <div className="browser-panel-chrome">
        <form
          className="browser-panel-address-form"
          onSubmit={(event) => {
            event.preventDefault();
            const url = normalizeBrowserNavigateUrl(address);
            if (!url || opening) return;
            setOpening(true);
            void onNavigate(tabId, url).finally(() => setOpening(false));
          }}
        >
          <label className="sr-only" htmlFor={addressInputId}>
            {t("browser.address")}
          </label>
          <Globe size={14} aria-hidden className="browser-panel-address-icon" />
          <BrowserAddressInput
            id={addressInputId}
            value={address}
            onValueChange={setAddress}
            disabled={opening}
          />
        </form>
      </div>
      <div className="browser-panel-content">
        <section className="task-panel-home-actions browser-panel-tool-home" aria-labelledby={titleId}>
          <h2 id={titleId}>{t("browser.toolsTitle")}</h2>
          <button type="button" disabled={opening} onClick={() => onOpenTool(tabId, "review")}>
            <ListChecks size={17} aria-hidden />
            <span>{t("task.review")}</span>
          </button>
          <button type="button" disabled={opening} onClick={() => onOpenTool(tabId, "terminal")}>
            <Terminal size={17} aria-hidden />
            <span>{t("task.terminal")}</span>
          </button>
          <button type="button" disabled={opening} onClick={() => onOpenTool(tabId, "files")}>
            <FolderOpen size={17} aria-hidden />
            <span>{t("task.files")}</span>
          </button>
          <button type="button" disabled={opening} onClick={() => onOpenTool(tabId, "sshBookmarks")}>
            <KeyRound size={17} aria-hidden />
            <span>{t("app.sshBookmarks.title")}</span>
          </button>
          <button type="button" disabled={opening} onClick={() => onOpenTool(tabId, "imageGeneration")}>
            <Palette size={17} aria-hidden />
            <span>{t("settings.imageGeneration.title")}</span>
          </button>
          <button type="button" disabled={opening} onClick={() => onOpenTool(tabId, "speechGeneration")}>
            <AudioLines size={17} aria-hidden />
            <span>{t("settings.tts.title")}</span>
          </button>
        </section>
      </div>
    </div>
  );
}
