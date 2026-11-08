/** Poll only while the resource panel can be read; resume immediately on interaction. */
export function startResourcePanelPolling(refresh: () => Promise<void>, intervalMs: number): () => void {
  let stopped = false;
  let fetching = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = Date.now();
  const active = () =>
    document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastActivity < 60_000;
  const poll = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || fetching || !active()) return;
    fetching = true;
    try {
      await refresh();
    } finally {
      fetching = false;
      if (!stopped && active()) timer = setTimeout(() => void poll(), intervalMs);
    }
  };
  const interact = () => {
    const wasActive = active();
    lastActivity = Date.now();
    if (!wasActive) void poll();
  };
  const visibility = () => {
    clearTimeout(timer);
    timer = undefined;
    if (document.visibilityState === "visible" && document.hasFocus()) {
      lastActivity = Date.now();
      void poll();
    }
  };
  const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
  for (const event of events) window.addEventListener(event, interact, { passive: true });
  window.addEventListener("focus", visibility);
  window.addEventListener("blur", visibility);
  document.addEventListener("visibilitychange", visibility);
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const event of events) window.removeEventListener(event, interact);
    window.removeEventListener("focus", visibility);
    window.removeEventListener("blur", visibility);
    document.removeEventListener("visibilitychange", visibility);
  };
}
