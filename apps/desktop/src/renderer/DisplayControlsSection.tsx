import { LockKeyholeOpen, Monitor, SunDim } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DisplayControlChange, DisplayControlState } from "../shared/display-control";

function desktopApi() {
  if (!window.eco) throw new Error("Desktop API unavailable");
  return window.eco;
}

export function DisplayControlsSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<DisplayControlState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const isMac = window.eco?.platform === "darwin";

  useEffect(() => {
    if (!isMac) return;
    mounted.current = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching || busyRef.current) return;
      fetching = true;
      try {
        const next = await desktopApi().getDisplayControlState();
        if (mounted.current && !busyRef.current) setState(next);
      } catch (error) {
        if (mounted.current) setError(String(error));
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [isMac]);

  if (!isMac) return null;
  const displays = state?.displays ?? [];

  const change = async (input: DisplayControlChange) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await desktopApi().setDisplayControl(input);
      if (mounted.current) setState(next);
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section className="running-display-controls" aria-label={t("app.running.displayControls")}>
      <label className="running-display-control" title={t("app.running.preventAutoLockHint")}>
        <LockKeyholeOpen size={16} aria-hidden />
        <span>{t("app.running.preventAutoLock")}</span>
        <input
          type="checkbox"
          role="switch"
          aria-label={t("app.running.preventAutoLock")}
          aria-checked={state?.preventAutoLock ?? false}
          checked={state?.preventAutoLock ?? false}
          disabled={!state || busy}
          onChange={(event) => void change({ control: "preventAutoLock", enabled: event.target.checked })}
        />
      </label>
      <label className="running-display-control" title={t("app.running.dimScreenHint")}>
        <SunDim size={16} aria-hidden />
        <span>{t("app.running.dimScreen")}</span>
        <input
          type="checkbox"
          role="switch"
          aria-label={t("app.running.dimScreen")}
          aria-checked={state?.dimmed ?? false}
          checked={state?.dimmed ?? false}
          disabled={!state || (!state.brightnessAvailable && !state.dimmed) || busy}
          onChange={(event) => void change({ control: "dimmed", enabled: event.target.checked })}
        />
      </label>
      <details className="running-display-details">
        <summary>{t("app.running.displayDetails")}</summary>
        <div className="running-display-monitors">
          <p className="running-display-monitor-hint">{t("app.running.preventAutoLockHint")}</p>
          <p className="running-display-monitor-hint">{t("app.running.dimScreenHint")}</p>
          <p className="running-display-monitor-summary">
            {t("app.running.displayCount", { count: displays.length })}
          </p>
          <ul aria-label={t("app.running.connectedDisplays")}>
            {displays.map((display, index) => (
              <li key={display.key} title={display.error}>
                <Monitor size={12} aria-hidden />
                <span className="running-display-monitor-name">
                  {display.name
                    ? `${display.name} · ${index + 1}`
                    : t(display.internal ? "app.running.internalDisplay" : "app.running.externalDisplay", {
                        number: index + 1,
                      })}
                </span>
                <span className="running-display-monitor-status">
                  {display.method ? `${t(`app.running.displayMethod.${display.method}`)} · ` : ""}
                  {t(`app.running.displayStatus.${display.status}`)}
                </span>
              </li>
            ))}
          </ul>
          {displays.some((display) => display.method === "software") ? (
            <p className="running-display-monitor-hint">{t("app.running.softwareDimmingHint")}</p>
          ) : null}
        </div>
      </details>
      {state && !state.brightnessAvailable && !state.dimmed ? (
        <p className="running-display-monitor-hint" role="status">
          {t("app.running.brightnessUnavailable")}
        </p>
      ) : null}
      {state?.pendingRestores ? (
        <p className="running-display-monitor-hint" role="status">
          {t("app.running.pendingDisplayRestores", { count: state.pendingRestores })}
        </p>
      ) : null}
      {error || state?.error || state?.brightnessError ? (
        <p className="running-resources-error" role="alert">
          {error || state?.error || state?.brightnessError}
        </p>
      ) : null}
    </section>
  );
}
