import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "framer-motion";
import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThinkingEffort } from "../shared/ipc";
import { ComposerHoverTooltip } from "./ComposerHoverTooltip";
import { formatComposerThinkingEffortLabel } from "./ComposerModelLabel";
import { FastModeIcon } from "./FastModeIcon";
import "./composer-thinking-effort.css";

type FastPhase = "inactive" | "entering" | "active" | "exiting";
type PointerSession = {
  id: number;
  startX: number;
  startY: number;
  offset: number;
};
const POSITION_SPRING = {
  type: "spring",
  stiffness: 300,
  damping: 27,
  restDelta: 0.0001,
  restSpeed: 0.001,
} as const;
const PRESSED_SPRING = { type: "spring", stiffness: 420, damping: 38, mass: 1 } as const;
const RELEASED_SPRING = { type: "spring", stiffness: 220, damping: 26, mass: 1 } as const;
// Deterministic streaks keep render pure and avoid starting a JS loop on every pointer event.
const PARTICLES = Array.from({ length: 14 }, (_, index) => ({
  top: `${3 + ((index * 7) % 18)}px`,
  width: `${4 + (index % 4) * 3}px`,
  "--particle-delay": `${-(index * 0.137)}s`,
  "--particle-duration": `${0.5 + (index % 5) * 0.09}s`,
})) satisfies CSSProperties[];

export function ComposerThinkingEffortControl({
  efforts,
  value,
  disabled = false,
  statusLabel,
  onCommit,
  fast,
}: {
  efforts: readonly ThinkingEffort[];
  value: ThinkingEffort | undefined;
  disabled?: boolean;
  statusLabel?: string;
  onCommit(value: ThinkingEffort): void;
  fast?: { enabled: boolean; disabled: boolean; hint: string; onChange(enabled: boolean): void } | undefined;
}) {
  const { t } = useTranslation();
  const reducedMotion = Boolean(useReducedMotion());
  const lastIndex = Math.max(0, efforts.length - 1);
  const committedIndex = Math.max(0, efforts.indexOf(value ?? "low"));
  const [previewIndex, setPreviewIndex] = useState<number>();
  const preview = useRef<number | undefined>(undefined);
  const pointer = useRef<PointerSession | undefined>(undefined);
  const [pointerDown, setPointerDown] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const position = useMotionValue(lastIndex ? committedIndex / lastIndex : 0);
  const animation = useRef<{ stop(): void } | undefined>(undefined);
  const left = useTransform(position, (ratio) => `calc(${ratio * 100}% + ${13 - ratio * 26}px)`);
  const fillTransform = useTransform(
    position,
    (ratio) => `translateX(calc(${(ratio - 1) * 100}% + ${13 - ratio * 26}px))`,
  );
  const selectedIndex = previewIndex ?? committedIndex;
  const selectedEffort = efforts[selectedIndex];
  const unsupported = Boolean(value && !efforts.includes(value));
  const hasSelection = efforts.length > 0 && (!unsupported || previewIndex !== undefined);
  const inactive = disabled || efforts.length < 2;
  const isMaximum = hasSelection && selectedEffort === "max";
  const fastEnabled = Boolean(fast?.enabled);
  const previousFast = useRef(fastEnabled);
  const [fastPhase, setFastPhase] = useState<FastPhase>(fastEnabled ? "active" : "inactive");
  const label =
    statusLabel ??
    (unsupported && previewIndex === undefined
      ? t("composer.mainPicker.unsupportedThinkingEffort")
      : selectedEffort
        ? formatComposerThinkingEffortLabel(selectedEffort)
        : t("composer.mainPicker.noThinkingEfforts"));

  const moveTo = (ratio: number, immediate = false) => {
    animation.current?.stop();
    if (immediate || reducedMotion) position.set(ratio);
    else animation.current = animate(position, ratio, POSITION_SPRING);
  };
  useEffect(() => {
    if (pointer.current || preview.current !== undefined) return;
    animation.current?.stop();
    const ratio = lastIndex ? committedIndex / lastIndex : 0;
    if (reducedMotion) position.set(ratio);
    else animation.current = animate(position, ratio, POSITION_SPRING);
  }, [committedIndex, lastIndex, position, reducedMotion]);
  useEffect(() => () => animation.current?.stop(), []);
  useEffect(() => {
    const changed = previousFast.current !== fastEnabled;
    previousFast.current = fastEnabled;
    if (reducedMotion || !changed) {
      setFastPhase(fastEnabled ? "active" : "inactive");
      return;
    }
    setFastPhase(fastEnabled ? "entering" : "exiting");
    const timer = window.setTimeout(
      () => setFastPhase(fastEnabled ? "active" : "inactive"),
      fastEnabled ? 1200 : 350,
    );
    return () => window.clearTimeout(timer);
  }, [fastEnabled, reducedMotion]);

  const showPreview = (ratio: number, immediate: boolean) => {
    const index = Math.round(ratio * lastIndex);
    preview.current = index;
    setPreviewIndex(index);
    moveTo(immediate ? ratio : lastIndex ? index / lastIndex : 0, immediate);
  };
  const cancel = () => {
    pointer.current = undefined;
    preview.current = undefined;
    setPreviewIndex(undefined);
    setPointerDown(false);
    setDragging(false);
    setHovered(false);
    moveTo(lastIndex ? committedIndex / lastIndex : 0);
  };
  const commit = () => {
    const index = preview.current ?? committedIndex;
    const effort = efforts[index];
    pointer.current = undefined;
    preview.current = undefined;
    setPreviewIndex(undefined);
    setPointerDown(false);
    setDragging(false);
    setHovered(false);
    moveTo(lastIndex ? index / lastIndex : 0);
    if (effort && effort !== value) onCommit(effort);
  };
  const ratioAt = (clientX: number, offset = 0) => {
    const node = rail.current;
    const rect = node?.getBoundingClientRect();
    if (!node || !rect || rect.width <= 26) return 0;
    const inset = (13 * rect.width) / node.offsetWidth;
    return Math.max(0, Math.min(1, (clientX - rect.left - inset - offset) / (rect.width - inset * 2)));
  };
  const startPointer = (event: PointerEvent<HTMLInputElement>) => {
    if (inactive || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    animation.current?.stop();
    const rect = rail.current?.getBoundingClientRect();
    const scale = rect && rail.current ? rect.width / rail.current.offsetWidth : 1;
    const center = rect ? rect.left + 13 * scale + position.get() * (rect.width - 26 * scale) : event.clientX;
    const grabbed = hasSelection && Math.abs(event.clientX - center) <= 17 * scale;
    pointer.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offset: grabbed ? event.clientX - center : 0,
    };
    setPointerDown(true);
    setKeyboardFocused(false);
    if (!grabbed) showPreview(ratioAt(event.clientX), false);
  };
  const movePointer = (event: PointerEvent<HTMLInputElement>) => {
    const session = pointer.current;
    if (!session) {
      updateHover(event);
      return;
    }
    if (event.pointerId !== session.id) return;
    event.preventDefault();
    if ((event.clientX - session.startX) ** 2 + (event.clientY - session.startY) ** 2 < 16 && !dragging)
      return;
    setDragging(true);
    showPreview(ratioAt(event.clientX, session.offset), true);
  };
  const updateHover = (event: PointerEvent<HTMLInputElement>) => {
    if (event.pointerType === "touch") return;
    const node = rail.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const scale = rect.width / node.offsetWidth;
    const center = rect.left + 13 * scale + position.get() * (rect.width - 26 * scale);
    setHovered(Math.abs(event.clientX - center) <= 17 * scale);
  };
  return (
    <div
      className="composer-power-control"
      data-fast-mode={fastEnabled}
      data-fast-phase={fastPhase}
      data-maximum={isMaximum}
      data-disabled={inactive}
      data-reduced-motion={reducedMotion}
    >
      <div className="composer-power-heading">
        {fast ? (
          <ComposerHoverTooltip content={fast.hint}>
            <button
              className="composer-power-fast"
              type="button"
              aria-label="Fast"
              aria-pressed={fast.enabled}
              disabled={fast.disabled}
              onClick={() => fast.onChange(!fast.enabled)}
            >
              <span>
                <FastModeIcon enabled={fast.enabled} />
              </span>
            </button>
          </ComposerHoverTooltip>
        ) : (
          <span />
        )}
        <span className="composer-power-value" aria-hidden>
          {label}
        </span>
        <span />
      </div>
      <div
        ref={rail}
        className="composer-power-rail"
        data-dragging={dragging}
        data-pointer-down={pointerDown}
        data-keyboard-focused={keyboardFocused}
        data-has-selection={hasSelection}
      >
        <div className="composer-power-track" aria-hidden>
          <motion.div className="composer-power-fill" style={{ transform: fillTransform }} />
          <motion.div className="composer-power-particles" style={{ width: left }}>
            {PARTICLES.map((style) => (
              <span key={style["--particle-delay"]} style={style} />
            ))}
          </motion.div>
          <div className="composer-power-ticks">
            {efforts.map((effort, index) => (
              <span
                key={effort}
                data-filled={hasSelection && index <= selectedIndex}
                style={{
                  left: `calc(${lastIndex ? (index / lastIndex) * 100 : 0}% + ${lastIndex ? 13 - (index / lastIndex) * 26 : 13}px)`,
                }}
              />
            ))}
          </div>
        </div>
        <motion.span className="composer-power-thumb-position" aria-hidden style={{ left }}>
          <motion.span
            className="composer-power-thumb"
            initial={false}
            animate={{ scale: !reducedMotion && !inactive && (hovered || pointerDown) ? 32 / 28 : 1 }}
            transition={
              reducedMotion ? { duration: 0 } : hovered || pointerDown ? PRESSED_SPRING : RELEASED_SPRING
            }
          />
        </motion.span>
        <input
          type="range"
          dir="ltr"
          min={0}
          max={lastIndex}
          step={1}
          value={selectedIndex}
          disabled={inactive}
          aria-label={t("composer.mainPicker.thinkingEffort")}
          aria-valuetext={label}
          onPointerDown={startPointer}
          onPointerMove={movePointer}
          onPointerUp={(event) => {
            if (pointer.current?.id !== event.pointerId) return;
            commit();
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={() => {
            if (pointer.current) cancel();
          }}
          onPointerEnter={updateHover}
          onPointerLeave={() => setHovered(false)}
          onKeyDown={(event) => {
            if (
              [
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Home",
                "End",
                "PageUp",
                "PageDown",
              ].includes(event.key)
            )
              setKeyboardFocused(true);
            if (event.key === "Escape" && preview.current !== undefined) {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
          onChange={(event) => {
            const index = Number(event.currentTarget.value);
            preview.current = index;
            setPreviewIndex(index);
            moveTo(lastIndex ? index / lastIndex : 0);
          }}
          onKeyUp={(event) => {
            if (
              [
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Home",
                "End",
                "PageUp",
                "PageDown",
              ].includes(event.key)
            )
              commit();
          }}
          onFocus={(event) => setKeyboardFocused(event.currentTarget.matches(":focus-visible"))}
          onBlur={() => {
            setKeyboardFocused(false);
            if (pointer.current) cancel();
            else if (preview.current !== undefined) commit();
          }}
        />
      </div>
    </div>
  );
}
