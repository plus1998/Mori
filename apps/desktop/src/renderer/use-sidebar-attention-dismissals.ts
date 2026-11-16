import { useCallback, useRef, useState } from "react";
import {
  dismissSidebarAttentionItems,
  readSidebarAttentionDismissals,
  revealSidebarAttentionItem,
  type SidebarAttentionDismissals,
  saveSidebarAttentionDismissals,
} from "./sidebar-attention-dismissals";
import type { SidebarAttentionItem } from "./sidebar-attention-items";

function readInitialState(): { dismissed: SidebarAttentionDismissals; error: boolean } {
  if (typeof window === "undefined") return { dismissed: {}, error: false };
  try {
    return { dismissed: readSidebarAttentionDismissals(window.localStorage), error: false };
  } catch (error) {
    console.error("[eco] failed to read ignored notifications", error);
    return { dismissed: {}, error: true };
  }
}

export function useSidebarAttentionDismissals() {
  const [state, setState] = useState(readInitialState);
  const currentRef = useRef(state.dismissed);
  const commit = useCallback((next: SidebarAttentionDismissals) => {
    if (next === currentRef.current) return true;
    try {
      saveSidebarAttentionDismissals(window.localStorage, next);
      currentRef.current = next;
      setState({ dismissed: next, error: false });
      return true;
    } catch (error) {
      console.error("[eco] failed to save ignored notifications", error);
      setState({ dismissed: currentRef.current, error: true });
      return false;
    }
  }, []);
  const dismiss = useCallback(
    (items: readonly SidebarAttentionItem[]) => {
      commit(dismissSidebarAttentionItems(currentRef.current, items));
    },
    [commit],
  );
  const reveal = useCallback(
    (id: string) => {
      const next = revealSidebarAttentionItem(currentRef.current, id);
      if (!commit(next)) {
        // A storage error must never conceal a new approval. Keep the error visible.
        currentRef.current = next;
        setState({ dismissed: next, error: true });
      }
    },
    [commit],
  );
  return { dismissed: state.dismissed, error: state.error, dismiss, reveal };
}
