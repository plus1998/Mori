import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  API_COMPAT_THEME,
  normalizeUpstreamApiCompat,
  toggleUpstreamApiCompat,
  UPSTREAM_API_COMPAT_OPTIONS,
  type UpstreamApiCompat,
} from "../shared/api-compat";

const API_COMPAT_ICONS: Record<UpstreamApiCompat, string> = {
  system_one: "./provider-icons/system-one.png",
  anthropic: "./provider-icons/claude.ico",
  openai_responses: "./provider-icons/openai.svg",
  openai_chat_completions: "./provider-icons/openai.svg",
};

interface ApiCompatToggleProps {
  /** Runtime may still carry legacy `openai`; normalized before render. */
  value: UpstreamApiCompat | string | undefined;
  onChange: (value: UpstreamApiCompat) => void;
  /** When set, limits cycling to supported endpoint surfaces (e.g. provider presets). */
  getNextCompat?: ((current: UpstreamApiCompat) => UpstreamApiCompat) | undefined;
  disabled?: boolean | undefined;
}

function apiCompatOption(value: UpstreamApiCompat | string | undefined) {
  const normalized = normalizeUpstreamApiCompat(value);
  return UPSTREAM_API_COMPAT_OPTIONS.find((option) => option.value === normalized);
}

export function ApiCompatToggle({ value, onChange, getNextCompat, disabled }: ApiCompatToggleProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });

  const normalizedValue = normalizeUpstreamApiCompat(value);
  const nextValue = getNextCompat
    ? getNextCompat(normalizedValue)
    : toggleUpstreamApiCompat(normalizedValue);
  const currentOption = apiCompatOption(normalizedValue);
  const nextOption = apiCompatOption(nextValue);
  const currentLabel = currentOption?.label ?? normalizedValue;
  const nextLabel = nextOption?.label ?? nextValue;
  const shortLabel = API_COMPAT_THEME[normalizedValue]?.label ?? normalizedValue;

  const updateTooltipPosition = useCallback(() => {
    const el = wrapRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    setTooltipPos({
      top: rect.bottom + 8,
      left: rect.left + rect.width / 2,
    });
  }, []);

  const showTooltip = useCallback(() => {
    updateTooltipPosition();
    setHovered(true);
  }, [updateTooltipPosition]);

  const hideTooltip = useCallback(() => {
    setHovered(false);
  }, []);

  const tooltip =
    hovered &&
    createPortal(
      <span
        className="api-compat-toggle-tooltip"
        role="tooltip"
        style={{
          position: "fixed",
          top: tooltipPos.top,
          left: tooltipPos.left,
          transform: "translateX(-50%)",
        }}
      >
        <span className="api-compat-toggle-tooltip-line">
          <strong>当前：</strong>
          {currentLabel}
        </span>
        {currentOption?.hint ? (
          <span className="api-compat-toggle-tooltip-line api-compat-toggle-tooltip-hint">
            {currentOption.hint}
          </span>
        ) : null}
        <span className="api-compat-toggle-tooltip-line api-compat-toggle-tooltip-action">
          点击切换为 {nextLabel}
        </span>
      </span>,
      document.body,
    );

    return (
    <>
      <span
        ref={wrapRef}
        className="api-compat-toggle-wrap"
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        <button
          type="button"
          className={`api-compat-tag api-compat-tag--${normalizedValue.replace(/_/g, "-")}`}
          disabled={disabled}
          aria-label={`当前是 ${currentLabel}，点击切换为 ${nextLabel}`}
          onClick={() => onChange(nextValue)}
        >
          <img
            className="api-compat-tag-icon"
            src={API_COMPAT_ICONS[normalizedValue]}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
          />
          <span className="api-compat-tag-label">{shortLabel}</span>
        </button>
      </span>
      {tooltip}
    </>
  );
}
