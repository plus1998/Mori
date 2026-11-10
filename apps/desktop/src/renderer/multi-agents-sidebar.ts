import type { ThreadSummary } from "../shared/ipc";
import type { MultiAgentsSnapshot } from "../shared/multi-agents";

export interface GroupedThreadRow {
  thread: ThreadSummary;
  depth: number;
  childCount: number;
  parentId?: string;
}

/** One list position per root. Linked execution conversations keep their own history. */
export function groupSidebarThreads(
  visible: ThreadSummary[],
  all: ThreadSummary[],
  groups: NonNullable<MultiAgentsSnapshot["groups"]>,
  expanded: ReadonlySet<string>,
): GroupedThreadRow[] {
  const threads = new Map(all.map((thread) => [thread.id, thread]));
  const parent = new Map<string, string>();
  for (const group of groups) {
    threads.set(group.source.id, threads.get(group.source.id) ?? group.source);
    for (const child of group.children) {
      if (child.workspacePath !== group.source.workspacePath || child.id === group.source.id) continue;
      threads.set(child.id, threads.get(child.id) ?? child);
      parent.set(child.id, group.source.id);
    }
  }
  const root = (id: string) => {
    const seen = new Set<string>();
    while (parent.has(id) && !seen.has(id)) {
      seen.add(id);
      id = parent.get(id)!;
    }
    return seen.has(id) ? undefined : id;
  };
  const rows: GroupedThreadRow[] = [],
    emitted = new Set<string>();
  const emit = (id: string, depth: number, parentId?: string) => {
    if (emitted.has(id)) return;
    const thread = threads.get(id);
    if (!thread) return;
    emitted.add(id);
    const children = [...parent]
      .filter(([childId, source]) => source === id && root(childId))
      .map(([child]) => child);
    rows.push({ thread, depth, childCount: children.length, ...(parentId ? { parentId } : {}) });
    if (expanded.has(id)) children.forEach((child) => emit(child, depth + 1, id));
  };
  for (const thread of visible) emit(root(thread.id) ?? thread.id, 0);
  return rows;
}
