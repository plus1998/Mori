import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

/** Fade only overflowing labels; hovering the row reveals the end without an ellipsis. */
export function OverflowFadeText({ children, className }: { children: string; className: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [measurement, setMeasurement] = useState({ distance: 0, duration: 0 });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const measure = () => {
      const overflow = content.getBoundingClientRect().width - viewport.getBoundingClientRect().width;
      const distance = overflow > 1 ? Math.ceil(overflow) : 0;
      const duration = distance / (Number.parseFloat(getComputedStyle(content).fontSize) * 2);
      setMeasurement((previous) => previous.distance === distance && previous.duration === duration
        ? previous
        : { distance, duration });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [children]);

  const style = {
    "--overflow-text-distance": `${measurement.distance}px`,
    "--overflow-text-duration": `${measurement.duration}s`,
  } as CSSProperties;

  return (
    <span className={`overflow-fade-text ${className}`} data-overflowing={measurement.distance > 0 || undefined} style={style}>
      <span ref={viewportRef} className="overflow-fade-text-clip">
        <span ref={contentRef} className="overflow-fade-text-content">{children}</span>
      </span>
    </span>
  );
}
