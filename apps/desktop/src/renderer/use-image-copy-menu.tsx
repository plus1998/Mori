import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ImageContextMenu, type ImageContextMenuAnchor } from "./ImageContextMenu";
import { copyImageSourceToClipboard } from "./image-clipboard";

/** Result of the last copy attempt; `null` means "no hint to show". */
export type ImageCopyState = "copied" | "failed" | null;

export interface ImageCopyMenu {
  /** Right-click handler for the element that shows the image. */
  openMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Menu element; render it inside the image surface (it portals to `<body>`). */
  menu: ReactNode;
  /** Transient result of the last copy, for an inline hint. */
  copyState: ImageCopyState;
}

/**
 * Right-click "copy image" for every image surface (viewer lightbox, workspace file preview).
 *
 * One hook keeps the three behaviours identical everywhere: the menu opens at the pointer, the
 * copy result flashes for a moment and then clears, and switching images drops both.
 */
export function useImageCopyMenu(src: string | null | undefined): ImageCopyMenu {
  const copyTimerRef = useRef<number | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<ImageContextMenuAnchor | null>(null);
  const [copyState, setCopyState] = useState<ImageCopyState>(null);

  const clearCopyTimer = useCallback(() => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, []);

  // A new image drops the menu and any leftover "已复制" hint that belonged to the old one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `src` is the reset key, not a read
  useEffect(() => {
    setMenuAnchor(null);
    setCopyState(null);
    clearCopyTimer();
  }, [src, clearCopyTimer]);

  useEffect(() => clearCopyTimer, [clearCopyTimer]);

  const openMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    setMenuAnchor({ x: event.clientX, y: event.clientY });
  }, []);

  const copyImage = useCallback(() => {
    setMenuAnchor(null);
    void copyImageSourceToClipboard(src).then((ok) => {
      clearCopyTimer();
      setCopyState(ok ? "copied" : "failed");
      copyTimerRef.current = window.setTimeout(
        () => {
          copyTimerRef.current = null;
          setCopyState(null);
        },
        ok ? 1_600 : 2_600,
      );
    });
  }, [clearCopyTimer, src]);

  return {
    openMenu,
    copyState,
    menu: menuAnchor ? (
      <ImageContextMenu anchor={menuAnchor} onCopyImage={copyImage} onClose={() => setMenuAnchor(null)} />
    ) : null,
  };
}
