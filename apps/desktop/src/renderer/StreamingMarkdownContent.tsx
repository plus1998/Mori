import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useActivityFeedLayoutChange } from "./activity-feed-layout-context";
import { MarkdownContent } from "./MarkdownContent";
import { FEED_MARKDOWN_PLUGINS } from "./prosemirror/feed-markdown";
import { resolveStreamingDisplaySnapshot } from "./streaming-display-text";
import {
  createStreamingCaretController,
  STREAM_CARET_PULSE_MIN_UNITS,
  type StreamingCaretController,
} from "./streaming-markdown-caret";
import {
  buildStreamingMarkdownDoc,
  createStreamingMarkdownDocCache,
} from "./streaming-markdown-doc";
import { isStructuralStreamingTail, partitionStreamingMarkdown } from "./streaming-markdown-partition";
import { usePacedStreamText } from "./use-paced-stream-text";

interface StreamingMarkdownContentProps {
  text: string;
  streaming?: boolean;
  className?: string;
  onRevealStateChange?: (revealing: boolean) => void;
}

export function StreamingMarkdownContent({
  text,
  streaming = false,
  className,
  onRevealStateChange,
}: StreamingMarkdownContentProps) {
  const onLayoutChange = useActivityFeedLayoutChange();
  const snapshot = resolveStreamingDisplaySnapshot(text, streaming);
  const targetText = streaming ? snapshot.displayText : text;
  const docCacheRef = useRef(createStreamingMarkdownDocCache());
  const workMsRef = useRef(0);
  const caretRef = useRef(createStreamingCaretController());
  const caret = caretRef.current;
  const revealedLengthRef = useRef(0);
  const renderText = usePacedStreamText(targetText, streaming, { workMsRef });
  const revealing = renderText !== targetText;
  const renderAsStreaming = streaming || revealing;

  const { stable, tail } = useMemo(
    () => partitionStreamingMarkdown(renderText, renderAsStreaming),
    [renderText, renderAsStreaming],
  );
  const structuralTail = renderAsStreaming && isStructuralStreamingTail(tail);
  // Hold open fences and structured edits as plain text. Tables stay live so
  // completing each pipe row never switches the entire response's DOM shape.
  const plainTail = structuralTail ? tail : "";
  const markdownText = structuralTail ? stable : stable + tail;
  const caretVisible = renderAsStreaming && markdownText.length > 0;

  // One document for the whole response: committed blocks come from the fragment
  // cache, only the open region is re-parsed per tick.
  const docProvider = useMemo(
    () => ({
      buildDoc: () => {
        const cache = docCacheRef.current;
        const doc = buildStreamingMarkdownDoc(cache, stable, structuralTail ? "" : tail);
        // The pacer reads this to pick a tick interval: cheap builds reveal every
        // frame, and only an expensive one (a fallback full parse) slows down.
        workMsRef.current = workMsRef.current * 0.5 + cache.lastBuildMs * 0.5;
        return doc;
      },
    }),
    [stable, tail, structuralTail],
  );

  // Keep the plugin list identical while streaming and after settle: a different
  // list remounts the editor and rebuilds the whole response DOM.
  const plugins = useMemo(() => [...FEED_MARKDOWN_PLUGINS, caret.plugin], [caret]);
  const handleView = useCallback(
    (view: Parameters<StreamingCaretController["attachView"]>[0]) => caret.attachView(view),
    [caret],
  );

  useEffect(() => {
    caret.setVisible(caretVisible);
  }, [caret, caretVisible]);

  const layoutSignature = renderAsStreaming
    ? `${stable.length}:${tail.length}:${structuralTail ? "struct" : "live"}:${snapshot.pendingBlock ? "pending" : "open"}:${text.length}`
    : "";
  const wasStreamingRef = useRef(renderAsStreaming);
  const wasStructuralTailRef = useRef(structuralTail);

  useEffect(() => {
    onRevealStateChange?.(revealing);
  }, [onRevealStateChange, revealing]);

  useEffect(() => {
    // Highlight the caret when a bigger chunk lands, so large reveals read as a
    // deliberate step rather than text appearing behind the reader's eye.
    const revealed = renderText.length - revealedLengthRef.current;
    revealedLengthRef.current = renderText.length;
    if (renderAsStreaming && revealed >= STREAM_CARET_PULSE_MIN_UNITS) {
      caret.pulse();
    }
  }, [renderText, renderAsStreaming, caret]);

  useLayoutEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    const wasStructuralTail = wasStructuralTailRef.current;
    wasStreamingRef.current = renderAsStreaming;
    wasStructuralTailRef.current = structuralTail;
    if (renderAsStreaming) {
      if (!layoutSignature) {
        return;
      }
      // Plain fence tails snap to a real block in one frame — stick immediately
      // so Chromium overflow-anchor cannot walk the feed off the bottom.
      const structuralSnap = wasStructuralTail !== structuralTail;
      onLayoutChange?.(structuralSnap ? { immediate: true } : undefined);
      return;
    }
    if (wasStreaming) {
      onLayoutChange?.({ immediate: true });
    }
  }, [renderAsStreaming, layoutSignature, structuralTail, onLayoutChange]);

  // Empty after holds (e.g. incomplete SEARCH-only) → leave Feed tail as loading host.
  if (!markdownText.trim() && !plainTail) {
    return null;
  }

  // Keep the same parent chain and child position through prose, plain fences,
  // live tables and settle. Stable plugins alone cannot prevent a remount when
  // the surrounding React tree changes shape.
  return (
    <div
      className={
        className ? `markdown-content--streaming-wrap ${className}` : "markdown-content--streaming-wrap"
      }
    >
      <div className="markdown-content--streaming-body">
        <MarkdownContent
          text={markdownText}
          plugins={plugins}
          docProvider={docProvider}
          onView={handleView}
          className="markdown-content--streaming-stable"
          keepMounted
        />
        {plainTail ? (
          <div className="markdown-content markdown-content--streaming-plain">
            {plainTail}
            <span className="stream-caret" aria-hidden="true" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
