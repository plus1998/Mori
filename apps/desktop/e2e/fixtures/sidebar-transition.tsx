import { startTransition, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useRevealSelectedThread } from "../../src/renderer/use-reveal-selected-thread";

const project = "/offline-project";
const initialThreads = Array.from({ length: 30 }, (_, index) => ({ id: `thread-${index}` }));

function SidebarTransitionFixture() {
  const [threads, setThreads] = useState(initialThreads);
  const [selected, setSelected] = useState("thread-2");
  const [visibleCounts, setVisibleCounts] = useState(new Map<string, number>());
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const byProject = useMemo(() => new Map([[project, threads]]), [threads]);
  useRevealSelectedThread(selected, byProject, visibleCounts, setVisibleCounts, 10);

  useEffect(() => {
    if (!started) return;
    // Reproduce the incident's queues: pending transition + a newer urgent
    // summary mapper. React replays the mapper while rebasing that transition.
    startTransition(() => {
      setReady(true);
      setThreads((current) => current);
    });
    setThreads((current) => current.map((thread) => ({ ...thread })));
  }, [started]);

  return <>
    <button onClick={() => setStarted(true)}>Receive event and open history</button>
    <button onClick={() => setSelected("thread-22")}>Open search result</button>
    <button onClick={() => setSelected("thread-2")}>Return to first page</button>
    <output aria-label="History">{ready ? "History ready" : "Loading history"}</output>
    <output aria-label="Visible count">{visibleCounts.get(project) ?? 10}</output>
  </>;
}

createRoot(document.getElementById("root")!).render(<SidebarTransitionFixture />);
