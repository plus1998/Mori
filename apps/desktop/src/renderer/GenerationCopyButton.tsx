import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyTextToClipboard } from "./clipboard";
import { SettingsButton } from "./components/SettingsControls";
import { ICON_SIZE, ICON_STROKE } from "./icon-metrics";
import { copyImageSourceToClipboard } from "./image-clipboard";
import "./generation-copy-button.css";

export function GenerationCopyButton({
  value,
  kind = "text",
  label,
}: {
  value: string;
  kind?: "text" | "image";
  label?: string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<"copied" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing content invalidates in-flight copy feedback.
  useEffect(() => {
    setState(null);
    setBusy(false);
    return () => {
      attempt.current++;
    };
  }, [value]);
  useEffect(() => {
    if (!state) return;
    const timer = window.setTimeout(() => setState(null), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);
  const Icon = state === "copied" ? Check : Copy;
  return (
    <span className="generation-copy-control">
      <SettingsButton
        type="button"
        disabled={!value || busy}
        onClick={async () => {
          const current = ++attempt.current;
          setBusy(true);
          setState(null);
          const ok = await (kind === "image"
            ? copyImageSourceToClipboard(value)
            : copyTextToClipboard(value));
          if (attempt.current !== current) return;
          setBusy(false);
          setState(ok ? "copied" : "failed");
        }}
      >
        <Icon size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{label ?? t(kind === "image" ? "lightbox.copyImage" : "imageLibrary.copyText")}</span>
      </SettingsButton>
      {state ? (
        <span className="generation-copy-result" role="status">
          {t(state === "copied" ? "imageLibrary.copied" : "imageLibrary.copyFailed")}
        </span>
      ) : null}
    </span>
  );
}
