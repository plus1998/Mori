import { useEffect, type Dispatch, type SetStateAction } from "react";

/** Keep search/notification selections visible without collapsing expanded pages. */
export function useRevealSelectedThread(
  selectedThreadId: string | undefined,
  threadsByProject: ReadonlyMap<string, readonly { id: string }[]>,
  visibleCounts: ReadonlyMap<string, number>,
  setVisibleCounts: Dispatch<SetStateAction<Map<string, number>>>,
  pageSize: number,
): void {
  useEffect(() => {
    if (!selectedThreadId) return;
    for (const [projectPath, threads] of threadsByProject) {
      const index = threads.findIndex((thread) => thread.id === selectedThreadId);
      if (index < 0) continue;
      const required = (Math.floor(index / pageSize) + 1) * pageSize;
      // Check before dispatch: a no-op updater still schedules work when this
      // component has pending transitions. Rebased summary mappers then create
      // another threadsByProject value, rerun this effect and starve the feed.
      if ((visibleCounts.get(projectPath) ?? pageSize) >= required) break;
      setVisibleCounts((current) => {
        if ((current.get(projectPath) ?? pageSize) >= required) return current;
        return new Map(current).set(projectPath, required);
      });
      break;
    }
  }, [selectedThreadId, threadsByProject, visibleCounts, setVisibleCounts, pageSize]);
}
