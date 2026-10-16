import { ArrowLeft, Check, Globe2, Plus, Trash2, X } from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { WebChatItem, WebChatListSnapshot, WebChatListView } from "../shared/web-chat-list";
import {
  createCustomWebChatItem,
  buildWebChatProxy,
  splitWebChatProxy,
  normalizeWebChatListSnapshot,
  removeCustomWebChatItem,
  webChatHostname,
} from "../shared/web-chat-list";
import { webChatListPopoverBoxForRect } from "./web-chat-list-popover-layout";

export interface WebChatListPopoverProps {
  open: boolean;
  items: WebChatItem[];
  siteProxies?: Record<string, string> | undefined;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSelect: (item: WebChatItem) => void;
  onListChange: (view: WebChatListView) => void;
}

function customsSnapshotFromItems(items: WebChatItem[]): WebChatListSnapshot {
  return normalizeWebChatListSnapshot({
    customs: items.filter((item) => !item.builtin),
  });
}

function panelStyleFromAnchor(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  return webChatListPopoverBoxForRect(rect, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

export function WebChatListPopover({
  open,
  items,
  siteProxies,
  anchorRef,
  onClose,
  onSelect,
  onListChange,
}: WebChatListPopoverProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>(() => ({ visibility: "hidden" }));
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState(items[0]?.id ?? "");
  const proxy = siteProxies?.[selectedSiteId];
  const [proxyMode, setProxyMode] = useState<"system" | "direct" | "custom">("system");
  const [proxySaved, setProxySaved] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [formError, setFormError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [draftProxy, setDraftProxy] = useState("");
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  useEffect(() => {
    const fields = splitWebChatProxy(proxy);
    setDraftProxy(fields.address);
    setProxyUsername(fields.username);
    setProxyPassword(fields.password);
    setProxyMode(!proxy ? "system" : proxy === "direct" ? "direct" : "custom");
  }, [proxy, open, selectedSiteId, settingsOpen]);

  const updatePanelPosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) {
      return;
    }
    setPanelStyle(panelStyleFromAnchor(anchor));
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle({ visibility: "hidden" });
      setAdding(false);
      setSettingsOpen(false);
      setProxySaved(false);
      setDraftTitle("");
      setDraftUrl("");
      setFormError(undefined);
      return;
    }
    updatePanelPosition();
    const raf = window.requestAnimationFrame(() => updatePanelPosition());
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Use pointerdown capture so we do not race the opening click, and ignore
    // the same-tick activation path of the topbar toggle.
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) {
        return;
      }
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onClose, open]);

  const persist = useCallback(
    async (next: WebChatListSnapshot) => {
      if (!window.eco?.saveWebChatList) {
        throw new Error("web chat list API unavailable");
      }
      setSaving(true);
      try {
        const view = await window.eco.saveWebChatList({ ...next, proxy: "", siteProxies: next.siteProxies ?? siteProxies ?? {} });
        onListChange(view);
        return view;
      } finally {
        setSaving(false);
      }
    },
    [onListChange, siteProxies],
  );

  const handleAdd = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setFormError(undefined);
      const created = createCustomWebChatItem(
        { title: draftTitle, url: draftUrl },
        customsSnapshotFromItems(items),
      );
      if (!created.ok) {
        if (created.reason === "invalid_title") {
          setFormError(t("app.webChat.invalidTitle"));
        } else if (created.reason === "invalid_url") {
          setFormError(t("app.webChat.invalidUrl"));
        } else {
          setFormError(t("app.webChat.duplicateUrl"));
        }
        return;
      }
      try {
        await persist(created.next);
        setDraftTitle("");
        setDraftUrl("");
        setAdding(false);
      } catch (caught) {
        setFormError(caught instanceof Error ? caught.message : t("app.webChat.saveFailed"));
      }
    },
    [draftTitle, draftUrl, items, persist, t],
  );

  const handleRemove = useCallback(
    async (item: WebChatItem) => {
      if (item.builtin) {
        return;
      }
      try {
        await persist(removeCustomWebChatItem(item.id, customsSnapshotFromItems(items)));
      } catch (error) {
        setFormError(error instanceof Error ? error.message : t("app.webChat.saveFailed"));
      }
    },
    [items, persist, t],
  );

  if (!open) {
    return null;
  }

  const popover = (
    <div
      ref={panelRef}
      className="web-chat-list-popover"
      style={panelStyle}
      role="dialog"
      aria-label={t("app.webChat.listTitle")}
    >
      <div className="web-chat-list-popover-header">
        <div className="web-chat-list-header-heading">
          {settingsOpen ? (
            <button type="button" className="web-chat-list-popover-icon-btn"
              onClick={() => { setSettingsOpen(false); setFormError(undefined); }}
              aria-label={t("app.webChat.back")} title={t("app.webChat.back")}>
              <ArrowLeft size={15} aria-hidden />
            </button>
          ) : null}
          <span className="web-chat-list-popover-title">
            {settingsOpen ? t("app.webChat.siteNetworkSettings", { title: items.find((item) => item.id === selectedSiteId)?.title }) : t("app.webChat.listTitle")}
          </span>
        </div>
        <div className="web-chat-list-header-actions">
          <button type="button" className="web-chat-list-popover-icon-btn" onClick={onClose}
            aria-label={t("app.webChat.close")} title={t("app.webChat.close")}>
            <X size={15} aria-hidden />
          </button>
        </div>
      </div>
      {settingsOpen ? (
        <form className="web-chat-settings" onSubmit={(event) => {
          event.preventDefault();
          setFormError(undefined);
          setProxySaved(false);
          if (proxyMode === "custom" && !draftProxy.trim()) {
            setFormError(t("app.webChat.proxyRequired"));
            return;
          }
          let nextProxy: string;
          try {
            nextProxy = proxyMode === "system" ? "" : proxyMode === "direct" ? "direct" : buildWebChatProxy(draftProxy.trim(), proxyUsername, proxyPassword);
          } catch (error) {
            setFormError(error instanceof Error ? error.message : String(error));
            return;
          }
          void persist({ ...customsSnapshotFromItems(items), siteProxies: { ...siteProxies, [selectedSiteId]: nextProxy } })
            .then(() => setProxySaved(true))
            .catch((error) => setFormError(error instanceof Error ? error.message : String(error)));
        }}>
          <div className="web-chat-settings-note">
            <Globe2 size={16} aria-hidden />
            <div><strong>{t("app.webChat.sharedLogin")}</strong><p>{t("app.webChat.sharedLoginHint")}</p></div>
          </div>
          <fieldset className="web-chat-proxy-fieldset" disabled={saving}>
            <legend>{t("app.webChat.proxy")}</legend>
            <div className="web-chat-proxy-modes">
              {(["system", "direct", "custom"] as const).map((mode) => (
                <label key={mode} className={proxyMode === mode ? "is-selected" : ""}>
                  <input type="radio" name="web-chat-proxy-mode" value={mode} checked={proxyMode === mode}
                    onChange={() => { setProxyMode(mode); setProxySaved(false); setFormError(undefined); }} />
                  <span>{t(`app.webChat.proxyMode.${mode}`)}</span>
                </label>
              ))}
            </div>
            {proxyMode === "custom" ? (
              <>
              <label className="web-chat-list-field web-chat-proxy-address">
                <span>{t("app.webChat.proxyAddress")}</span>
                <input value={draftProxy} onChange={(event) => { setDraftProxy(event.target.value); setProxySaved(false); }}
                  placeholder="http://127.0.0.1:7890" autoComplete="off" spellCheck={false} autoFocus
                  onPaste={(event) => {
                    const pasted = event.clipboardData.getData("text").trim();
                    try {
                      const fields = splitWebChatProxy(pasted);
                      if (!fields.username && !fields.password) return;
                      event.preventDefault();
                      setDraftProxy(fields.address); setProxyUsername(fields.username); setProxyPassword(fields.password); setProxySaved(false);
                    } catch { /* Normal input validation runs on save. */ }
                  }} />
              </label>
              <div className="web-chat-proxy-credentials">
                <label className="web-chat-list-field">
                  <span>{t("app.webChat.proxyUsername")}</span>
                  <input value={proxyUsername} autoComplete="off" spellCheck={false}
                    placeholder={t("app.webChat.optional")}
                    onChange={(event) => { setProxyUsername(event.target.value); setProxySaved(false); }} />
                </label>
                <label className="web-chat-list-field">
                  <span>{t("app.webChat.proxyPassword")}</span>
                  <input type="password" value={proxyPassword} autoComplete="new-password"
                    placeholder={t("app.webChat.optional")}
                    onChange={(event) => { setProxyPassword(event.target.value); setProxySaved(false); }} />
                </label>
              </div>
              </>
            ) : null}
            <p className="web-chat-settings-hint">{t(proxyMode === "custom" ? "app.webChat.proxyCustomHint" : proxyMode === "system" ? "app.webChat.proxySystemHint" : "app.webChat.proxyDirectHint")}</p>
          </fieldset>
          {formError ? <p className="web-chat-list-form-error" role="alert">{formError}</p> : null}
          <div className="web-chat-settings-footer">
            <span className="web-chat-settings-status" role="status">
              {proxySaved ? <><Check size={13} aria-hidden />{t("app.webChat.proxySaved")}</> : null}
            </span>
            <button type="submit" className="web-chat-list-primary-btn" disabled={saving}>
              {t(saving ? "app.webChat.saving" : "app.webChat.save")}
            </button>
          </div>
        </form>
      ) : <>
      <div className="web-chat-list-popover-list" role="list">
        {items.length === 0 ? (
          <p className="web-chat-list-empty">{t("app.webChat.empty")}</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="web-chat-list-row" role="listitem">
              <button
                type="button"
                className="web-chat-list-item"
                onClick={() => {
                  onSelect(item);
                  onClose();
                }}
              >
                <span className="web-chat-list-item-title">{item.title}</span>
                <span className="web-chat-list-item-desc">{webChatHostname(item.url)}</span>
              </button>
              <div className="web-chat-list-row-actions">
              <button
                type="button"
                className="web-chat-list-popover-icon-btn web-chat-list-network"
                data-proxy-mode={!siteProxies?.[item.id] ? "system" : siteProxies[item.id] === "direct" ? "direct" : "custom"}
                onClick={() => {
                  setSelectedSiteId(item.id);
                  setSettingsOpen(true);
                  setAdding(false);
                  setFormError(undefined);
                  setProxySaved(false);
                }}
                aria-label={t("app.webChat.siteNetworkSettings", { title: item.title })}
                title={t("app.webChat.siteNetworkSummary", {
                  title: item.title,
                  mode: t(!siteProxies?.[item.id] ? "app.webChat.proxyMode.system" : siteProxies[item.id] === "direct" ? "app.webChat.proxyMode.direct" : "app.webChat.proxyMode.custom"),
                })}
              >
                <Globe2 size={14} aria-hidden />
              </button>
              {!item.builtin ? (
                <button
                  type="button"
                  className="web-chat-list-popover-icon-btn web-chat-list-remove"
                  onClick={() => void handleRemove(item)}
                  disabled={saving}
                  title={t("app.webChat.remove")}
                  aria-label={t("app.webChat.removeNamed", { title: item.title })}
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              ) : null}
              </div>
            </div>
          ))
        )}
      </div>
      {formError && !adding ? <p className="web-chat-list-form-error" role="alert">{formError}</p> : null}
      {adding ? (
        <form className="web-chat-list-add-form" onSubmit={(event) => void handleAdd(event)}>
          <label className="web-chat-list-field">
            <span>{t("app.webChat.nameLabel")}</span>
            <input
              type="text"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder={t("app.webChat.namePlaceholder")}
              autoFocus
              maxLength={80}
            />
          </label>
          <label className="web-chat-list-field">
            <span>{t("app.webChat.urlLabel")}</span>
            <input
              type="text"
              value={draftUrl}
              onChange={(event) => setDraftUrl(event.target.value)}
              placeholder={t("app.webChat.urlPlaceholder")}
              maxLength={500}
            />
          </label>
          {formError ? <p className="web-chat-list-form-error">{formError}</p> : null}
          <div className="web-chat-list-add-actions">
            <button type="button" className="web-chat-list-secondary-btn" onClick={() => setAdding(false)}>
              {t("app.webChat.cancel")}
            </button>
            <button type="submit" className="web-chat-list-primary-btn" disabled={saving}>
              {t("app.webChat.save")}
            </button>
          </div>
        </form>
      ) : (
        <div className="web-chat-list-footer">
          <button
            type="button"
            className="web-chat-list-add-btn"
            onClick={() => {
              setAdding(true);
              setFormError(undefined);
            }}
          >
            <Plus size={14} aria-hidden />
            <span>{t("app.webChat.add")}</span>
          </button>
        </div>
      )}
      </>}
    </div>
  );

  return createPortal(popover, document.body);
}
