import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ThreadRunTurnFeedSection } from "../../src/renderer/conversation-v2-turn-feed";
import {
  FeedVirtualSectionWindow,
  useFeedSectionVirtualizer,
} from "../../src/renderer/feed-virtual-sections";
import "../../src/renderer/styles.css";

// Delay actual browser measurements deliberately: mounting, scroll events and
// content reflow must not change the scroll extent ahead of the virtual model.
const NativeResizeObserver = window.ResizeObserver;
let holdMeasurements = false;
const pending = new Set<() => void>();
window.ResizeObserver = class extends NativeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    super((entries, observer) => {
      const deliver = () => callback(entries, observer);
      if (holdMeasurements) pending.add(deliver);
      else deliver();
    });
  }
};

const allSections: ThreadRunTurnFeedSection[] = Array.from({ length: 60 }, (_, index) => ({
  kind: "entry",
  key: `geometry:${index}`,
  entry: {
    kind: "timeline",
    key: `timeline:${index}`,
    at: "2026-01-01T00:00:00.000Z",
    sequence: index + 1,
    item: {
      id: `geometry:${index}`,
      at: "2026-01-01T00:00:00.000Z",
      sequence: index + 1,
      eventType: "thread.user_prompt",
      text: "synthetic geometry regression",
      contentLoaded: true,
      metadata: { liveType: "thread.user_prompt" },
    },
  },
}));

function Fixture() {
  const runLogRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(100);
  const [detached, setDetached] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [short, setShort] = useState(false);
  const [count, setCount] = useState(40);
  const [tailHeight, setTailHeight] = useState(100);
  const sections = useMemo(() => allSections.slice(0, count), [count]);
  const virtual = useFeedSectionVirtualizer({
    sections,
    enabled: true,
    userDetached: detached,
    runLogRef,
    headerRef,
  });
  return (
    <main className="codex-main">
      <nav style={{ position: "fixed", top: 0, left: 0 }}>
        <button
          type="button"
          onClick={() => {
            holdMeasurements = true;
          }}
        >
          Hold measurements
        </button>
        <button
          type="button"
          onClick={() => {
            holdMeasurements = false;
            for (const deliver of pending) deliver();
            pending.clear();
          }}
        >
          Deliver measurements
        </button>
        <button type="button" onClick={() => setHeight((value) => (value === 100 ? 3600 : 100))}>
          Toggle tall content
        </button>
        <button type="button" onClick={() => setNarrow((value) => !value)}>
          Toggle width
        </button>
        <button type="button" onClick={() => setShort((value) => !value)}>
          Toggle terminal height
        </button>
        <button type="button" onClick={() => setTailHeight((value) => (value === 100 ? 1800 : 100))}>
          Toggle live content
        </button>
        <button type="button" onClick={() => setCount((value) => Math.min(value + 1, allSections.length))}>
          Append row
        </button>
        <button type="button" onClick={() => setDetached(true)}>
          Read history
        </button>
        <button type="button" onClick={() => setDetached(false)}>
          Follow end
        </button>
      </nav>
      <div
        className="activity-messages"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus the scroll container to exercise real Home/PageUp/End input.
        tabIndex={0}
        style={{
          position: "fixed",
          top: 70,
          left: 30,
          width: narrow ? 380 : 750,
          height: short ? 300 : 600,
          padding: "16px 0 80px",
          overflow: "auto",
          boxSizing: "border-box",
        }}
      >
        <div ref={runLogRef} className="run-log run-log--virtualized">
          <div ref={headerRef} className="run-log-virtual-header" style={{ height: 64 }}>
            Thread prompt
          </div>
          <FeedVirtualSectionWindow
            {...virtual}
            sections={sections}
            renderSection={(index) => (
              <div
                style={{
                  minHeight: index === count - 1 ? tailHeight : index === 34 ? height : 100,
                  padding: 12,
                  boxSizing: "border-box",
                }}
              >
                Row {index}: {"Content wraps when panels change width. ".repeat(12)}
              </div>
            )}
          />
        </div>
      </div>
      <output data-testid="model-size">{virtual.totalSize}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
