import { GripHorizontal, GripVertical } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  type BrowserViewportInput,
  type BrowserViewportResizeEdge,
  resizeBrowserViewport,
} from "../shared/browser-viewport";
import { startPointerDragSession } from "./pointer-drag-session";

type ResizeStart = {
  x: number;
  y: number;
  viewport: BrowserViewportInput & { width: number; height: number };
  scale: number;
  edge: BrowserViewportResizeEdge;
  centered: { x: boolean; y: boolean };
};

/** A sibling of the scaled guest, so hit targets retain their screen size at every zoom. */
export function BrowserViewportResizeFrame({
  browserId,
  viewport,
  scale,
  centered,
  style,
}: {
  browserId: string;
  viewport: BrowserViewportInput & { width: number; height: number };
  scale: number;
  centered: { x: boolean; y: boolean };
  style: CSSProperties;
}) {
  const { t } = useTranslation();
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  const queued = useRef<BrowserViewportInput | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const applying = useRef(false);
  const active = useRef(true);
  const [dragging, setDragging] = useState<BrowserViewportResizeEdge>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      stopDrag.current?.();
      queued.current = undefined;
      if (frame.current !== undefined) {
        cancelAnimationFrame(frame.current);
        frame.current = undefined;
      }
    };
  }, []);

  async function flush() {
    if (applying.current || !active.current) return;
    applying.current = true;
    try {
      while (queued.current && active.current) {
        const next = queued.current;
        queued.current = undefined;
        if (!window.eco?.browserSetViewport) throw new Error(t("browser.viewportUnavailable"));
        await window.eco.browserSetViewport({ browserId, ...next });
      }
    } catch (caught) {
      queued.current = undefined;
      if (active.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      applying.current = false;
    }
  }

  function enqueue(input: BrowserViewportInput) {
    queued.current = input;
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      void flush();
    });
  }

  function start(event: PointerEvent<HTMLButtonElement>, edge: BrowserViewportResizeEdge) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    stopDrag.current?.();
    const origin = {
      x: event.clientX,
      y: event.clientY,
      viewport,
      scale,
      edge,
      centered,
    };
    stopDrag.current = startPointerDragSession({
      handle: event.currentTarget,
      pointerId: event.pointerId,
      onMove: point => move(origin, point),
      onEnd: point => {
        stopDrag.current = undefined;
        if (!active.current) return;
        if (point) move(origin, point);
        setDragging(undefined);
        if (frame.current !== undefined) {
          cancelAnimationFrame(frame.current);
          frame.current = undefined;
        }
        void flush();
      },
    });
    setError(undefined);
    setDragging(edge);
  }

  function move(origin: ResizeStart, event: globalThis.PointerEvent) {
    enqueue({
      ...origin.viewport,
      preset: "custom",
      ...resizeBrowserViewport(
        origin.viewport,
        { x: event.clientX - origin.x, y: event.clientY - origin.y },
        origin.scale,
        origin.edge,
        origin.centered,
      ),
    });
  }

  function keyResize(event: KeyboardEvent<HTMLButtonElement>, edge: BrowserViewportResizeEdge) {
    const amount = event.shiftKey ? 10 : 1;
    const x = event.key === "ArrowRight" ? amount : event.key === "ArrowLeft" ? -amount : 0;
    const y = event.key === "ArrowDown" ? amount : event.key === "ArrowUp" ? -amount : 0;
    if ((!x || edge === "bottom") && (!y || edge === "right")) return;
    event.preventDefault();
    enqueue({
      ...viewport,
      preset: "custom",
      ...resizeBrowserViewport(
        viewport,
        { x: (x * scale) / (centered.x ? 2 : 1), y: (y * scale) / (centered.y ? 2 : 1) },
        scale,
        edge,
        centered,
      ),
    });
  }

  return (
    <>
      {dragging
        ? createPortal(<div className={`browser-viewport-resize-shield is-${dragging}`} />, document.body)
        : null}
      <div
        className={`browser-viewport-resize-frame${dragging ? " is-dragging" : ""}`}
        style={style}
        data-browser-resizer={browserId}
      >
        {(["right", "bottom", "corner"] as const).map((edge) => (
          <button
            key={edge}
            type="button"
            className={`browser-viewport-resize-handle is-${edge}`}
            aria-label={t(`browser.viewportResize.${edge}`)}
            title={t("browser.viewportResizeHint")}
            onPointerDown={(event) => start(event, edge)}
            onKeyDown={(event) => keyResize(event, edge)}
          >
            {edge === "right" ? (
              <GripVertical size={12} />
            ) : edge === "bottom" ? (
              <GripHorizontal size={12} />
            ) : (
              <span />
            )}
          </button>
        ))}
        {error ? (
          <div className="browser-viewport-resize-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </>
  );
}
