import type { ThreadRunProjectionMainFeedEntry } from "./conversation-v2-projection-view";
import type { ThreadRunTurnFeedSection } from "./conversation-v2-turn-feed";

/** Retain mounted identity by overlapping durable members, with only the current window retained. */
function createIdentityReconciler<T extends { key: string }>(
  scope: (row: T) => string,
  members: (row: T) => string[],
) {
  let previous: Array<{ key: string; scope: string; members: Set<string> }> = [];
  let serial = 0;
  return (rows: readonly T[]): T[] => {
    const claimed = new Set<string>();
    const reserved = new Set(previous.map((row) => row.key));
    const result = rows.map((row) => {
      const ids = members(row),
        group = scope(row);
      let best: (typeof previous)[number] | undefined,
        overlap = 0;
      for (const candidate of previous) {
        if (candidate.scope !== group || claimed.has(candidate.key)) continue;
        const count = ids.reduce((total, id) => total + Number(candidate.members.has(id)), 0);
        if (count > overlap) {
          best = candidate;
          overlap = count;
        }
      }
      let key = best?.key ?? row.key;
      if (claimed.has(key) || (!best && reserved.has(key))) key = `reading:${group}:${++serial}`;
      claimed.add(key);
      return key === row.key ? row : { ...row, key };
    });
    previous = result.map((row) => ({ key: row.key, scope: scope(row), members: new Set(members(row)) }));
    return result;
  };
}

export function feedEntryMemberKeys(entry: ThreadRunProjectionMainFeedEntry): string[] {
  return entry.kind === "tool-group" ? entry.entries.map((child) => child.key) : [entry.key];
}

export function createFeedEntryIdentityReconciler() {
  return createIdentityReconciler<ThreadRunProjectionMainFeedEntry>(
    (entry) => entry.kind,
    feedEntryMemberKeys,
  );
}

export function createFeedSectionIdentityReconciler() {
  let previousFinals = new Map<string, number>();
  const reconcileVisibleEntries = createFeedEntryIdentityReconciler();
  let previousContinuation = new Map<string, boolean>();
  const reconcile = createIdentityReconciler<ThreadRunTurnFeedSection>(
    (section) => (section.kind === "turn" ? `turn:${section.attempt.attemptId}` : section.kind),
    (section) =>
      section.kind === "turn"
        ? [...section.processEntries, ...(section.finalEntry ? [section.finalEntry] : [])].flatMap(
            feedEntryMemberKeys,
          )
        : section.kind === "entry"
          ? feedEntryMemberKeys(section.entry)
          : [section.key],
  );
  return (sections: readonly ThreadRunTurnFeedSection[]): ThreadRunTurnFeedSection[] => {
    const segments = sections.flatMap((section): ThreadRunTurnFeedSection[] => {
      if (section.kind !== "turn" || section.running) return [section];
      const parts: ThreadRunTurnFeedSection[] = [];
      let pending = [...section.processEntries];
      const boundaries = pending
        .filter((entry) => previousFinals.has(entry.key))
        .sort((a, b) => previousFinals.get(a.key)! - previousFinals.get(b.key)!);
      for (const final of boundaries) {
        const cutoff = previousFinals.get(final.key)!;
        const before: ThreadRunProjectionMainFeedEntry[] = [],
          after: ThreadRunProjectionMainFeedEntry[] = [];
        for (const entry of pending) {
          if (entry.key === final.key) continue;
          if (entry.kind !== "tool-group") {
            (entry.sequence <= cutoff ? before : after).push(entry);
            continue;
          }
          const older = entry.entries.filter((child) => child.sequence <= cutoff),
            newer = entry.entries.filter((child) => child.sequence > cutoff);
          if (older.length)
            before.push({ ...entry, entries: older, at: older[0]!.at, sequence: older[0]!.sequence });
          if (newer.length)
            after.push({
              ...entry,
              key: `${entry.key}:after:${cutoff}`,
              entries: newer,
              at: newer[0]!.at,
              sequence: newer[0]!.sequence,
            });
        }
        // The old summary was shown after all the process records already loaded,
        // including tools whose observed time follows the summary's own timestamp.
        parts.push({
          ...section,
          key: `${section.key}:through:${final.key}`,
          processEntries: before,
          finalEntry: final,
          continuation: parts.length > 0 || Boolean(section.continuation),
        });
        pending = after;
      }
      if (pending.length || section.finalEntry || !parts.length)
        parts.push({
          ...section,
          processEntries: pending,
          continuation: parts.length > 0 || Boolean(section.continuation),
        });
      return parts;
    });
    const flat = segments.flatMap((section) =>
      section.kind === "turn"
        ? [...section.processEntries, ...(section.finalEntry ? [section.finalEntry] : [])]
        : section.kind === "entry"
          ? [section.entry]
          : [],
    );
    const stable = reconcileVisibleEntries(flat);
    let position = 0;
    const identified = reconcile(
      segments.map((section) => {
        if (section.kind === "entry") return { ...section, entry: stable[position++]! };
        if (section.kind !== "turn") return section;
        const processEntries = section.processEntries.map(() => stable[position++]!);
        return {
          ...section,
          processEntries,
          ...(section.finalEntry ? { finalEntry: stable[position++]! } : {}),
        };
      }),
    );
    // A newly loaded earlier segment must not take the elapsed heading away
    // from the section the user is already reading (or add a heading into it).
    const headingOwners = new Set(
      identified.flatMap((section) =>
        section.kind === "turn" && previousContinuation.get(section.key) === false
          ? [section.attempt.attemptId]
          : [],
      ),
    );
    const result = identified.map((section) => {
      if (section.kind !== "turn") return section;
      const existing = previousContinuation.get(section.key);
      const continuation =
        existing ?? (headingOwners.has(section.attempt.attemptId) || Boolean(section.continuation));
      if (!continuation) headingOwners.add(section.attempt.attemptId);
      return continuation === section.continuation ? section : { ...section, continuation };
    });
    previousContinuation = new Map(
      result.flatMap((section) =>
        section.kind === "turn" ? [[section.key, Boolean(section.continuation)] as const] : [],
      ),
    );
    previousFinals = new Map(
      result.flatMap((section) =>
        section.kind === "turn" && section.finalEntry
          ? [
              [
                section.finalEntry.key,
                Math.max(
                  section.finalEntry.sequence,
                  ...section.processEntries.flatMap((entry) =>
                    entry.kind === "tool-group"
                      ? entry.entries.map((child) => child.sequence)
                      : [entry.sequence],
                  ),
                ),
              ] as const,
            ]
          : [],
      ),
    );
    return result;
  };
}

/** Durable source entities represented by one rendered entry; tool groups can retain identity through any child. */
export function feedEntryEntityKeys(entry: ThreadRunProjectionMainFeedEntry): string[] {
  if (entry.kind === "tool-group") return entry.entries.flatMap(feedEntryEntityKeys);
  if (entry.kind !== "timeline" && entry.kind !== "agent-echo") return [];
  const message = entry.item.metadata?.conversationV2MessageId;
  const tool = entry.item.metadata?.conversationV2ToolCallId;
  return typeof message === "string" ? [`m:${message}`] : typeof tool === "string" ? [`t:${tool}`] : [];
}
