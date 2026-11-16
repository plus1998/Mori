import { useCallback, useEffect, useState } from "react";

/** Shared by the Feed and floating composer; elapsed time survives focus changes. */
export function useTurnDurationMs(startedAt: string | undefined, endedAt: string | undefined, running: boolean): number {
  const resolve = useCallback(() => {
    const startMs = Date.parse(startedAt ?? "");
    const endMs = endedAt ? Date.parse(endedAt) : Date.now();
    return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
  }, [endedAt, startedAt]);
  const [durationMs, setDurationMs] = useState(resolve);

  useEffect(() => {
    const update = () => {
      const next = resolve();
      setDurationMs((current) => (current === next ? current : next));
    };
    update();
    if (!running) return;
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [resolve, running]);

  return durationMs;
}

