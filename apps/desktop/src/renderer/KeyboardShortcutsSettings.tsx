import { useTranslation } from "react-i18next";
import { Keyboard, Pencil, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  acceleratorFromEvent,
  defaultShortcutBindings,
  formatAccelerator,
  SHORTCUT_DEFINITIONS,
  type ShortcutDefinition,
  validateShortcutBindings,
} from "../shared/keyboard-shortcuts";
import { saveKeyboardShortcuts, useKeyboardShortcuts } from "./keyboard-shortcuts";
import "./keyboard-shortcuts.css";

export function KeyboardShortcutsSettings() {
  const { t } = useTranslation();
  const { bindings, loaded, error: loadError } = useKeyboardShortcuts();
  const platform = window.eco?.platform ?? "darwin";
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ definition: ShortcutDefinition; index: number; value: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editError, setEditError] = useState("");
  const [ready, setReady] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const definitions = SHORTCUT_DEFINITIONS.filter(
    (d) =>
      (!d.platforms || d.platforms.includes(platform)) &&
      `${d.label} ${d.description} ${(bindings[d.id] ?? []).map((k) => formatAccelerator(k, platform)).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );

  const isEditing = Boolean(editing);
  const captureReady = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!isEditing && !resetConfirm) return;
    let active = true;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setReady(false);
    captureReady.current = false;
    if (isEditing) {
      void window.eco
        ?.setKeyboardShortcutRecording(true)
        .then(() => {
          if (active) {
            captureReady.current = true;
            setReady(true);
            dialog.current?.focus();
          }
        })
        .catch((e) => {
          if (active) setEditError(e instanceof Error ? e.message : String(e));
        });
    } else {
      dialog.current?.focus();
    }
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (busyRef.current) return;
      if (event.key === "Escape") {
        setEditing(undefined);
        setResetConfirm(false);
        return;
      }
      if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled)");
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) last?.focus();
        else if (!event.shiftKey && document.activeElement === last) first?.focus();
        else if (document.activeElement === dialog.current) first?.focus();
        else if (controls) {
          const index = Array.from(controls).indexOf(document.activeElement as HTMLElement);
          controls[index + (event.shiftKey ? -1 : 1)]?.focus();
        }
        return;
      }
      if (
        event.target instanceof HTMLButtonElement &&
        ["Enter", " "].includes(event.key) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.target.click();
        return;
      }
      if (!isEditing || !captureReady.current) return;
      try {
        const value = acceleratorFromEvent(event);
        if (value) {
          setEditing((current) => current && { ...current, value });
          setEditError("");
        }
      } catch (e) {
        setEditError(e instanceof Error ? e.message : String(e));
      }
    };
    // The input owns every keystroke while recording; other chat shortcuts cannot run.
    document.addEventListener("keydown", capture, true);
    const blur = () => {
      setEditing(undefined);
      setResetConfirm(false);
    };
    window.addEventListener("blur", blur);
    return () => {
      active = false;
      document.removeEventListener("keydown", capture, true);
      window.removeEventListener("blur", blur);
      if (isEditing)
        void window.eco?.setKeyboardShortcutRecording(false).catch((e) => setError(String(e)));
      returnFocus.current?.focus();
    };
  }, [isEditing, resetConfirm]);

  async function persist(next: typeof bindings): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      validateShortcutBindings(next, platform);
      await saveKeyboardShortcuts(next);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function commitEdit() {
    if (!editing?.value || !ready) return;
    const keys = [...(bindings[editing.definition.id] ?? [])];
    keys[editing.index] = editing.value;
    const next = { ...bindings, [editing.definition.id]: keys };
    try {
      validateShortcutBindings(next, platform);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
      return;
    }
    setBusy(true);
    try {
      await saveKeyboardShortcuts(next);
      setEditing(undefined);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section keyboard-settings" aria-labelledby="keyboard-shortcuts-title">
      <div className="keyboard-settings-heading">
        <h1 id="keyboard-shortcuts-title">{t("moriUi.keyboardShortcutsSettings.title")}</h1>
        <button
          type="button"
          className="keyboard-reset"
          disabled={busy || !loaded}
          onClick={() => setResetConfirm(true)}
        >
          <RotateCcw size={13} />
          {t("moriUi.keyboardShortcutsSettings.resetAll")}
        </button>
      </div>
      <label className="keyboard-search">
        <Search size={17} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("moriUi.keyboardShortcutsSettings.search")}
          aria-label={t("moriUi.keyboardShortcutsSettings.search")}
        />
        <Keyboard size={16} />
      </label>
      <p className="keyboard-settings-note">
        {t("moriUi.keyboardShortcutsSettings.hint")}
      </p>
      {error || loadError ? (
        <p role="alert" className="keyboard-error">
          {error || loadError}
        </p>
      ) : !loaded ? (
        <p role="status" className="keyboard-settings-note">
          {t("moriUi.keyboardShortcutsSettings.loading")}
        </p>
      ) : null}
      <div className="keyboard-list">
        {definitions.map((definition) => {
          const keys = bindings[definition.id] ?? [];
          return (
            <div className="keyboard-row" key={definition.id}>
              <div className="keyboard-row-copy">
                <strong>
                  {definition.label}
                  {definition.scope === "global" ? <span>{t("moriUi.keyboardShortcutsSettings.global")}</span> : null}
                </strong>
                <small>{definition.description}</small>
              </div>
              <div className="keyboard-row-bindings">
                {keys.length ? (
                  keys.map((key, index) => (
                    <div className="keyboard-binding" key={key}>
                      <button
                        type="button"
                        className="keyboard-edit"
                        aria-label={`修改${definition.label}快捷键 ${formatAccelerator(key, platform)}`}
                        disabled={busy || !loaded}
                        onClick={() => {
                          setEditError("");
                          setEditing({ definition, index, value: key });
                        }}
                      >
                        <kbd>{formatAccelerator(key, platform)}</kbd>
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="keyboard-icon"
                        title={t("moriUi.keyboardShortcutsSettings.clear")}
                        aria-label={`清除${definition.label}快捷键 ${formatAccelerator(key, platform)}`}
                        disabled={busy || !loaded}
                        onClick={() =>
                          void persist({ ...bindings, [definition.id]: keys.filter((_, i) => i !== index) })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                ) : (
                  <button
                    type="button"
                    className="keyboard-edit is-unassigned"
                    disabled={busy || !loaded}
                    aria-label={`设置${definition.label}快捷键`}
                    onClick={() => {
                      setEditError("");
                      setEditing({ definition, index: 0, value: "" });
                    }}
                  >
                    {t("moriUi.keyboardShortcutsSettings.unassigned")}
                    <Pencil size={14} />
                  </button>
                )}
              </div>
              <button
                type="button"
                className="keyboard-icon keyboard-add"
                aria-label={`添加${definition.label}快捷键`}
                title={t("moriUi.keyboardShortcutsSettings.add")}
                disabled={busy || !loaded || keys.length >= (definition.scope === "global" ? 1 : 4)}
                onClick={() => {
                  setEditError("");
                  setEditing({ definition, index: keys.length, value: "" });
                }}
              >
                <Plus size={14} />
              </button>
            </div>
          );
        })}
        {!definitions.length ? <div className="keyboard-empty">{t("moriUi.keyboardShortcutsSettings.noMatches")}</div> : null}
      </div>
      {editing || resetConfirm
        ? createPortal(
            <div className="keyboard-modal-backdrop">
              <button
                type="button"
                className="keyboard-modal-dismiss"
                tabIndex={-1}
                aria-label={t("moriUi.keyboardShortcutsSettings.cancelSettings")}
                disabled={busy}
                onClick={() => {
                  setEditing(undefined);
                  setResetConfirm(false);
                }}
              />
              <div
                className="keyboard-modal"
                ref={dialog}
                role="dialog"
                aria-modal="true"
                aria-labelledby="keyboard-modal-title"
                tabIndex={-1}
              >
                <button
                  type="button"
                  className="keyboard-modal-close keyboard-icon"
                  aria-label={t("moriUi.keyboardShortcutsSettings.close")}
                  disabled={busy || !loaded}
                  onClick={() => {
                    setEditing(undefined);
                    setResetConfirm(false);
                  }}
                >
                  <X size={17} />
                </button>
                <Keyboard size={24} className="keyboard-modal-symbol" />
                <h3 id="keyboard-modal-title">{editing ? editing.definition.label : "重置所有快捷键？"}</h3>
                {editing ? (
                  <>
                    <p>{t("moriUi.keyboardShortcutsSettings.recordHint")}</p>
                    <div className={`keyboard-recording ${ready ? "is-ready" : ""}`} aria-live="polite">
                      {editing.value ? (
                        <kbd>{formatAccelerator(editing.value, platform)}</kbd>
                      ) : ready ? (
                        "等待按键…"
                      ) : (
                        "正在准备…"
                      )}
                    </div>
                    {editError ? (
                      <p role="alert" className="keyboard-error">
                        {editError}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p>{t("moriUi.keyboardShortcutsSettings.resetHint")}</p>
                )}
                <div className="keyboard-modal-actions">
                  <button
                    type="button"
                    disabled={busy || !loaded}
                    onClick={() => {
                      setEditing(undefined);
                      setResetConfirm(false);
                    }}
                  >
                    {t("moriUi.keyboardShortcutsSettings.cancel")}
                  </button>
                  <button
                    type="button"
                    className="keyboard-primary"
                    disabled={busy || (!!editing && (!ready || !editing.value))}
                    onClick={() =>
                      editing
                        ? void commitEdit()
                        : void persist(defaultShortcutBindings(platform)).then((ok) => {
                            if (ok) setResetConfirm(false);
                          })
                    }
                  >
                    {busy ? "保存中…" : editing ? "保存快捷键" : "重置"}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
