import type { MoriAvatarSettings } from "../shared/mori-avatar";

let snapshot: { avatar: MoriAvatarSettings | null; error: string } = { avatar: null, error: "" };
const listeners = new Set<() => void>();
let disconnect: (() => void) | undefined;
let loading = false;
let requested = false;

function publish(next: typeof snapshot) {
  // Assistant activity also emits changes; only portrait changes should render navigation again.
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

async function refresh() {
  requested = true;
  if (loading) return;
  loading = true;
  try {
    do {
      requested = false;
      if (!window.eco) throw new Error("桌面连接尚未就绪。");
      const next = await window.eco.moriAssistantSnapshot();
      publish({ avatar: next.settings.avatar, error: "" });
    } while (requested && listeners.size);
  } catch (error) {
    publish({ ...snapshot, error: error instanceof Error ? error.message : String(error) });
  } finally {
    loading = false;
  }
}

const requestRefresh = () => { void refresh(); };

export function subscribeMoriAvatar(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    disconnect = window.eco?.onMoriAssistantChanged(requestRefresh);
    window.addEventListener("focus", requestRefresh);
    requestRefresh();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      disconnect?.();
      disconnect = undefined;
      window.removeEventListener("focus", requestRefresh);
    }
  };
}

export const getMoriAvatarSnapshot = () => snapshot;
