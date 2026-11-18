export const FEED_RESTORE_READING_SECTION_EVENT = "eco:feed-restore-reading-section";

export interface FeedReadingAnchor {
  key: string;
  sectionKey: string;
  offset: number;
  sectionOffset: number;
}

export function captureFeedReadingAnchor(container: HTMLElement): FeedReadingAnchor | undefined {
  const viewport = container.getBoundingClientRect();
  const nodes = [
    ...container.querySelectorAll<HTMLElement>("[data-feed-entry-key], [data-feed-section-key]"),
  ];
  const visible = nodes.filter((node) => {
    const element = node.style.display === "contents" ? node.firstElementChild : node;
    const rect = element?.getBoundingClientRect();
    return rect && rect.height > 0 && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom;
  });
  const node = visible.find(
    (candidate) => !visible.some((child) => child !== candidate && candidate.contains(child)),
  );
  if (!node) return undefined;
  const element = node.style.display === "contents" ? node.firstElementChild! : node;
  const section = node.closest<HTMLElement>("[data-feed-section-key]");
  return {
    key: node.dataset.feedEntryKey ?? "",
    sectionKey: section?.dataset.feedSectionKey ?? "",
    sectionOffset: section ? section.getBoundingClientRect().top - viewport.top : 0,
    offset: element.getBoundingClientRect().top - viewport.top,
  };
}

export function restoreFeedReadingAnchor(container: HTMLElement, anchor: FeedReadingAnchor): boolean {
  const selector = anchor.key
    ? `[data-feed-entry-key="${CSS.escape(anchor.key)}"]`
    : `[data-feed-section-key="${CSS.escape(anchor.sectionKey)}"]`;
  const entry = container.querySelector<HTMLElement>(selector);
  // A partial turn can regroup its children when the adjacent page arrives.
  // Preserve the turn header when that specific aggregate no longer exists.
  const node =
    entry ??
    container.querySelector<HTMLElement>(`[data-feed-section-key="${CSS.escape(anchor.sectionKey)}"]`);
  const element = node?.style.display === "contents" ? node.firstElementChild : node;
  if (!element) {
    container.querySelector(".run-log")?.dispatchEvent(
      new CustomEvent(FEED_RESTORE_READING_SECTION_EVENT, {
        detail: { sectionKey: anchor.sectionKey, entryKey: anchor.key },
      }),
    );
    return false;
  }
  const delta =
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    (entry ? anchor.offset : anchor.sectionOffset);
  if (Math.abs(delta) > 0.5) container.scrollTop += delta;
  return true;
}

/** Protect only visible leaf entries, rather than all hidden children of a folded tool group. */
export function captureFeedVisibleEntityKeys(container: HTMLElement): Set<string> {
  const viewport = container.getBoundingClientRect();
  const visible = [...container.querySelectorAll<HTMLElement>("[data-feed-entity-keys]")].filter((node) => {
    const element = node.style.display === "contents" ? node.firstElementChild : node;
    const rect = element?.getBoundingClientRect();
    return rect && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  return new Set(
    visible
      .filter((node) => !visible.some((child) => child !== node && node.contains(child)))
      .flatMap((node) => {
        const keys = JSON.parse(node.dataset.feedEntityKeys!) as string[];
        // The first child owns a collapsed group's time and turn boundary. Evicting
        // it while the header is visible can move that group into another turn.
        return keys.length ? [keys[0]!] : [];
      }),
  );
}
