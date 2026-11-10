import { memo, useEffect, useRef } from "react";

const SWEEP_CLASS = "run-log-shimmer-active";
const documentCadences = new WeakMap<Document, ReturnType<typeof createDocumentCadence>>();

/** All visible labels share one observer and two timers, without React updates per sweep. */
function createDocumentCadence(document: Document) {
  const { defaultView } = document;
  if (!defaultView) throw new Error("ShimmerText requires a live document");
  const view = defaultView;
  const motion = view.matchMedia("(prefers-reduced-motion: reduce)");
  const elements = new Map<HTMLElement, boolean>();
  let nextSweep: number | undefined;
  let sweepEnd: number | undefined;

  function stop() {
    view.clearTimeout(nextSweep);
    view.clearTimeout(sweepEnd);
    nextSweep = undefined;
    sweepEnd = undefined;
    for (const element of elements.keys()) element.classList.remove(SWEEP_CLASS);
  }

  function canPlay() {
    return !document.hidden && !motion.matches && Array.from(elements.values()).some(Boolean);
  }

  function sweep() {
    nextSweep = undefined;
    if (!canPlay()) return stop();
    for (const [element, visible] of elements) {
      if (visible) element.classList.add(SWEEP_CLASS);
    }
    sweepEnd = view.setTimeout(() => {
      sweepEnd = undefined;
      for (const element of elements.keys()) element.classList.remove(SWEEP_CLASS);
    }, 1_000);
    nextSweep = view.setTimeout(sweep, 4_000);
  }

  function reconcile() {
    for (const [element, visible] of elements) {
      if (!visible) element.classList.remove(SWEEP_CLASS);
    }
    if (!canPlay()) stop();
    else if (nextSweep === undefined) nextSweep = view.setTimeout(sweep, 600);
  }

  const observer = new view.IntersectionObserver((entries) => {
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      if (elements.has(element)) elements.set(element, entry.isIntersecting);
    }
    reconcile();
  });
  document.addEventListener("visibilitychange", reconcile);
  motion.addEventListener("change", reconcile);

  return {
    observe(element: HTMLElement) {
      elements.set(element, false);
      observer.observe(element);
      return () => {
        if (!elements.delete(element)) return;
        element.classList.remove(SWEEP_CLASS);
        observer.unobserve(element);
        if (elements.size > 0) return reconcile();
        stop();
        observer.disconnect();
        document.removeEventListener("visibilitychange", reconcile);
        motion.removeEventListener("change", reconcile);
        documentCadences.delete(document);
      };
    },
  };
}

export const ShimmerText = memo(function ShimmerText({ children }: { children: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const document = element.ownerDocument;
    let cadence = documentCadences.get(document);
    if (!cadence) {
      cadence = createDocumentCadence(document);
      documentCadences.set(document, cadence);
    }
    return cadence.observe(element);
  }, []);

  return (
    <span ref={ref} className="run-log-shimmer-text" aria-live="polite">
      {children}
      <span className="run-log-shimmer-sweep" aria-hidden="true">
        <span className="run-log-shimmer-highlight">{children}</span>
      </span>
    </span>
  );
});
