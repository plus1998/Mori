import {
  DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS,
  GLOBAL_CONTEXT_WINDOW_LIMIT_MAX,
  GLOBAL_CONTEXT_WINDOW_LIMIT_MIN,
  GLOBAL_CONTEXT_WINDOW_LIMIT_PRESETS,
  GLOBAL_CONTEXT_WINDOW_LIMIT_STEP,
  GLOBAL_MAX_OUTPUT_TOKEN_MAX,
  GLOBAL_MAX_OUTPUT_TOKEN_MIN,
  GLOBAL_MAX_OUTPUT_TOKEN_PRESETS,
  GLOBAL_MAX_OUTPUT_TOKEN_STEP,
  type GlobalContextWindowLimit,
  type GlobalMaxOutputTokens,
} from "@eco/runtime/models-dev-limits";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const contextPresetFlags = GLOBAL_CONTEXT_WINDOW_LIMIT_PRESETS.map((value) => ({
  value,
  label: formatBinaryK(value),
}));

const maxOutputPresetFlags = GLOBAL_MAX_OUTPUT_TOKEN_PRESETS.map((value) => ({
  value,
  label: formatBinaryK(value),
}));

/** Binary-friendly label for values on the 1KiB grid (262144 -> "256K"). */
function formatBinaryK(value: number): string {
  if (value >= 1_048_576 && value % 1_048_576 === 0) {
    return `${value / 1_048_576}M`;
  }
  return `${value / 1024}K`;
}

function formatContextValue(value: number, flags: ReadonlyArray<{ value: number; label: string }>) {
  const flag = flags.find((entry) => entry.value === value);
  return flag ? flag.label : formatBinaryK(value);
}

function formatMaxOutputValue(value: number, flags: ReadonlyArray<{ value: number; label: string }>) {
  const flag = flags.find((entry) => entry.value === value);
  return flag ? flag.label : formatBinaryK(value);
}

interface TokenSliderProps {
  min: number;
  max: number;
  step: number;
  value: number;
  flags: ReadonlyArray<{ value: number; label: string }>;
  format: (value: number) => string;
  ariaLabel: string;
  disabled?: boolean;
  onCommit: (value: number) => Promise<void>;
}

function TokenSlider({
  min,
  max,
  step,
  value,
  flags,
  format,
  ariaLabel,
  disabled,
  onCommit,
}: TokenSliderProps) {
  const [previewValue, setPreviewValue] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const displayValue = previewValue ?? value;
  const latestValueRef = useRef(value);
  const pointerRef = useRef<{
    id: number;
    left: number;
    width: number;
    grabOffset: number;
    snappedValue: number | null;
  } | null>(null);
  const frameRef = useRef<number | null>(null);
  const keyboardEditingRef = useRef(false);
  const mountedRef = useRef(true);

  if (
    previewValue === null &&
    pointerRef.current === null &&
    !keyboardEditingRef.current &&
    frameRef.current === null
  ) {
    latestValueRef.current = value;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  function quantize(raw: number): number {
    return Math.min(max, Math.max(min, min + Math.round((raw - min) / step) * step));
  }

  function valueFromClientX(clientX: number): number {
    const pointer = pointerRef.current;
    if (!pointer) return latestValueRef.current;
    const x = clientX - pointer.left - pointer.grabOffset;
    const flagX = (tokens: number) => ((tokens - min) / (max - min)) * pointer.width;
    // A wider release radius prevents flicker around a preset's snap boundary.
    if (pointer.snappedValue !== null && Math.abs(x - flagX(pointer.snappedValue)) <= 9) {
      return pointer.snappedValue;
    }
    pointer.snappedValue = null;
    let nearest: number | null = null;
    let distance = 5;
    for (const flag of flags) {
      const delta = Math.abs(x - flagX(flag.value));
      if (delta <= distance) {
        nearest = flag.value;
        distance = delta;
      }
    }
    if (nearest !== null) {
      pointer.snappedValue = nearest;
      return nearest;
    }
    const ratio = pointer.width > 0 ? x / pointer.width : 0;
    return quantize(min + Math.min(1, Math.max(0, ratio)) * (max - min));
  }

  function cancelFrame() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }

  function preview(next: number) {
    latestValueRef.current = next;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setPreviewValue(latestValueRef.current);
    });
  }

  async function commit(next: number) {
    cancelFrame();
    latestValueRef.current = next;
    // Keep the released position while IPC persists it; clearing early displays the old prop.
    setPreviewValue(next);
    try {
      if (next !== value) await onCommit(next);
    } finally {
      if (mountedRef.current) setPreviewValue(null);
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled || event.button !== 0 || !event.isPrimary || pointerRef.current) {
      return;
    }
    event.preventDefault();
    const track = event.currentTarget;
    const rect = track.getBoundingClientRect();
    const handleX = rect.left + ((latestValueRef.current - min) / (max - min)) * rect.width;
    const grabbingHandle = Math.abs(event.clientX - handleX) <= 12;
    pointerRef.current = {
      id: event.pointerId,
      left: rect.left,
      width: rect.width,
      grabOffset: grabbingHandle ? event.clientX - handleX : 0,
      snappedValue: flags.some((flag) => flag.value === latestValueRef.current)
        ? latestValueRef.current
        : null,
    };
    track.focus({ preventScroll: true });
    track.setPointerCapture(event.pointerId);
    keyboardEditingRef.current = false;
    setIsDragging(true);
    if (!grabbingHandle) preview(valueFromClientX(event.clientX));
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (pointerRef.current?.id !== event.pointerId || disabled) {
      return;
    }
    preview(valueFromClientX(event.clientX));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (pointerRef.current?.id !== event.pointerId) {
      return;
    }
    const next = valueFromClientX(event.clientX);
    pointerRef.current = null;
    setIsDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    void commit(next);
  }

  function cancelPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (pointerRef.current?.id !== event.pointerId) return;
    pointerRef.current = null;
    cancelFrame();
    latestValueRef.current = value;
    setIsDragging(false);
    setPreviewValue(null);
  }

  function finishKeyboardEdit() {
    if (!keyboardEditingRef.current) return;
    keyboardEditingRef.current = false;
    void commit(latestValueRef.current);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) {
      return;
    }
    const current = latestValueRef.current;
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = current - step;
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = current + step;
    } else if (event.key === "PageDown") {
      const below = [...flags].filter((flag) => flag.value < current).sort((a, b) => b.value - a.value);
      next = below[0]?.value ?? min;
    } else if (event.key === "PageUp") {
      const above = [...flags].filter((flag) => flag.value > current).sort((a, b) => a.value - b.value);
      next = above[0]?.value ?? max;
    } else if (event.key === "Home") {
      next = min;
    } else if (event.key === "End") {
      next = max;
    } else {
      return;
    }
    event.preventDefault();
    keyboardEditingRef.current = true;
    preview(quantize(next));
  }

  const positionPct = ((displayValue - min) / (max - min)) * 100;

  return (
    <div className={isDragging ? "token-slider is-dragging" : "token-slider"}>
      <div
        className={disabled ? "token-slider-track is-disabled" : "token-slider-track"}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={displayValue}
        aria-valuetext={format(displayValue)}
        aria-disabled={disabled === true}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={cancelPointer}
        onLostPointerCapture={cancelPointer}
        onKeyDown={handleKeyDown}
        onKeyUp={finishKeyboardEdit}
        onBlur={finishKeyboardEdit}
      >
        <div
          className="token-slider-fill"
          style={{ transform: `translateY(-50%) scaleX(${positionPct / 100})` }}
        />
        {flags.map((flag) => {
          const flagPct = ((flag.value - min) / (max - min)) * 100;
          const isAtValue = displayValue === flag.value;
          return (
            <div
              key={flag.value}
              className={isAtValue ? "token-slider-flag is-active" : "token-slider-flag"}
              style={{ left: `${flagPct}%` }}
            >
              <span className="token-slider-flag-dot" aria-hidden />
              <span className="token-slider-flag-label">{flag.label}</span>
            </div>
          );
        })}
        <div className="token-slider-handle" style={{ left: `${positionPct}%` }} aria-hidden>
          <span className="token-slider-value-badge">{format(displayValue)}</span>
        </div>
      </div>
    </div>
  );
}

interface ContextWindowSettingsPanelProps {
  contextWindowLimitTokens: number;
  maxOutputLimitTokens: GlobalMaxOutputTokens;
  onChangeContextWindow: (value: GlobalContextWindowLimit) => Promise<void>;
  onChangeMaxOutput: (value: GlobalMaxOutputTokens) => Promise<void>;
}

export function ContextWindowSettingsPanel({
  contextWindowLimitTokens,
  maxOutputLimitTokens,
  onChangeContextWindow,
  onChangeMaxOutput,
}: ContextWindowSettingsPanelProps) {
  const { t } = useTranslation();
  const [savingContext, setSavingContext] = useState(false);
  const [savingMaxOutput, setSavingMaxOutput] = useState(false);

  async function selectContext(next: number) {
    if (savingContext || next === contextWindowLimitTokens) {
      return;
    }
    setSavingContext(true);
    try {
      await onChangeContextWindow(next);
    } finally {
      setSavingContext(false);
    }
  }

  async function selectMaxOutput(next: GlobalMaxOutputTokens) {
    if (savingMaxOutput || next === maxOutputLimitTokens) {
      return;
    }
    setSavingMaxOutput(true);
    try {
      await onChangeMaxOutput(next);
    } finally {
      setSavingMaxOutput(false);
    }
  }

  return (
    <div className="token-limits-page">
      <header className="token-limits-page-header">
        <h1>{t("settings.contextWindow")}</h1>
      </header>

      <section className="token-limits-card">
        <div className="token-limits-head">
          <div className="token-limits-head-text">
            <span className="token-limits-title">{t("settings.contextWindow.limit")}</span>
            <p className="token-limits-subtitle">{t("settings.contextWindow.subtitle")}</p>
          </div>
          <span className="token-limits-readout">
            {t("settings.contextWindow.tokens", {
              tokens: contextWindowLimitTokens.toLocaleString(),
            })}
          </span>
        </div>

        <TokenSlider
          min={GLOBAL_CONTEXT_WINDOW_LIMIT_MIN}
          max={GLOBAL_CONTEXT_WINDOW_LIMIT_MAX}
          step={GLOBAL_CONTEXT_WINDOW_LIMIT_STEP}
          value={contextWindowLimitTokens}
          flags={contextPresetFlags}
          format={(value) => formatContextValue(value, contextPresetFlags)}
          ariaLabel={t("settings.contextWindow.limit")}
          disabled={savingContext}
          onCommit={selectContext}
        />
      </section>

      <section className="token-limits-card">
        <div className="token-limits-head">
          <div className="token-limits-head-text">
            <span className="token-limits-title">{t("settings.maxOutput.limit")}</span>
            <p className="token-limits-subtitle">
              {t(
                maxOutputLimitTokens === "dynamic"
                  ? "settings.maxOutput.dynamicSubtitle"
                  : "settings.maxOutput.subtitle",
              )}
            </p>
          </div>
          <span className="token-limits-readout">
            {maxOutputLimitTokens === "dynamic"
              ? t("settings.maxOutput.dynamic")
              : t("settings.maxOutput.tokens", {
                  tokens: maxOutputLimitTokens.toLocaleString(),
                })}
          </span>
        </div>

        <fieldset className="token-output-mode" aria-label={t("settings.maxOutput.mode")}>
          <button
            type="button"
            aria-pressed={maxOutputLimitTokens === "dynamic"}
            disabled={savingMaxOutput}
            onClick={() => void selectMaxOutput("dynamic")}
          >
            {t("settings.maxOutput.dynamic")}
          </button>
          <button
            type="button"
            aria-pressed={maxOutputLimitTokens !== "dynamic"}
            disabled={savingMaxOutput}
            onClick={() => {
              if (maxOutputLimitTokens === "dynamic") void selectMaxOutput(DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS);
            }}
          >
            {t("settings.maxOutput.fixed")}
          </button>
        </fieldset>

        {maxOutputLimitTokens !== "dynamic" ? (
          <TokenSlider
            min={GLOBAL_MAX_OUTPUT_TOKEN_MIN}
            max={GLOBAL_MAX_OUTPUT_TOKEN_MAX}
            step={GLOBAL_MAX_OUTPUT_TOKEN_STEP}
            value={maxOutputLimitTokens}
            flags={maxOutputPresetFlags}
            format={(value) => formatMaxOutputValue(value, maxOutputPresetFlags)}
            ariaLabel={t("settings.maxOutput.limit")}
            disabled={savingMaxOutput}
            onCommit={selectMaxOutput}
          />
        ) : null}
      </section>
    </div>
  );
}
