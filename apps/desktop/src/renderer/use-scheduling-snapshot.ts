import { useCallback, useEffect, useRef, useState } from "react";
import type { SchedulingSnapshot } from "../shared/scheduling";

/** One live snapshot shared by the task panel, conversation cards, and search. */
export function useSchedulingSnapshot() {
  const [snapshot, setSnapshot] = useState<SchedulingSnapshot>({ schedules: [], occurrences: [] });
  const [loading, setLoading] = useState(Boolean(window.eco));
  const [error, setError] = useState("");
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!window.eco) return;
    const revision = ++request.current;
    try {
      const next = await window.eco.listSchedules();
      if (revision === request.current) { setSnapshot(next); setError(""); }
    } catch (caught) {
      if (revision === request.current) setError(String(caught));
    } finally {
      if (revision === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const dispose = window.eco?.onSchedulesChanged(() => void refresh());
    return () => { request.current++; dispose?.(); };
  }, [refresh]);
  return { snapshot, loading, error, refresh };
}
