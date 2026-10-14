import type { DiffDisplayLine } from "./diff-display-lines";
import { highlightDiffDisplayLines } from "./diff-shiki-highlight";

const canceled = new Set<number>();
const active = new Set<number>();
let queue = Promise.resolve();
self.onmessage = (
  event: MessageEvent<{
    id: number;
    cancel?: boolean;
    lines: DiffDisplayLine[];
    language: string;
    theme: "light" | "dark";
  }>,
) => {
  const request = event.data;
  if (request.cancel) {
    if (active.has(request.id)) canceled.add(request.id);
    return;
  }
  active.add(request.id);
  queue = queue.then(async () => {
    if (canceled.delete(request.id)) {
      active.delete(request.id);
      return;
    }
    try {
      const htmls = await highlightDiffDisplayLines(request.lines, request.language, request.theme);
      if (!canceled.delete(request.id)) self.postMessage({ id: request.id, htmls });
    } catch (error) {
      if (!canceled.delete(request.id))
        self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      active.delete(request.id);
    }
  });
};
