import { useEffect, useRef, useState, type PointerEvent } from "react";

/** React capture includes the composer's portaled menus, so they remain active. */
export function useFloatingConversationFocus(enabled: boolean) {
  const [focused, setFocused] = useState(false);
  const insidePointerRef = useRef<globalThis.PointerEvent | undefined>(undefined);
  const blurFrameRef = useRef<number | undefined>(undefined);

  const cancelBlur = () => {
    if (blurFrameRef.current !== undefined) cancelAnimationFrame(blurFrameRef.current);
    blurFrameRef.current = undefined;
  };

  useEffect(() => {
    if (!enabled) return;
    const outsidePointer = (event: globalThis.PointerEvent) => {
      if (event !== insidePointerRef.current) setFocused(false);
    };
    const windowBlur = () => setFocused(false);
    document.addEventListener("pointerdown", outsidePointer);
    window.addEventListener("blur", windowBlur);
    return () => {
      cancelBlur();
      document.removeEventListener("pointerdown", outsidePointer);
      window.removeEventListener("blur", windowBlur);
    };
  }, [enabled]);

  return {
    focused,
    focusProps: {
      onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
        if (!enabled) return;
        insidePointerRef.current = event.nativeEvent;
        cancelBlur();
        setFocused(true);
      },
      onFocusCapture: () => {
        if (!enabled) return;
        cancelBlur();
        setFocused(true);
      },
      onBlurCapture: () => {
        if (!enabled) return;
        cancelBlur();
        blurFrameRef.current = requestAnimationFrame(() => {
          blurFrameRef.current = undefined;
          setFocused(false);
        });
      },
    },
  };
}
