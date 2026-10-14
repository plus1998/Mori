import type { DiffDisplayLine } from "./diff-display-lines";

type Task = {
  id: number;
  key: string;
  resolve: (htmls: (string | null)[]) => void;
  reject: (error: Error) => void;
  consumers: number;
};
let worker: Worker | undefined;
let nextId = 0;
const tasks = new Map<number, Task>();
const pending = new Map<string, { task: Task; promise: Promise<(string | null)[]> }>();
const results = new Map<string, (string | null)[]>();
let resultBytes = 0;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./diff-highlight.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<{ id: number; htmls?: (string | null)[]; error?: string }>) => {
    const task = tasks.get(event.data.id);
    if (!task) return;
    tasks.delete(task.id);
    pending.delete(task.key);
    if (event.data.error || !event.data.htmls) {
      task.reject(new Error(event.data.error || "Diff highlighter returned no result"));
      return;
    }
    const htmls = event.data.htmls;
    results.set(task.key, htmls);
    resultBytes += task.key.length * 2 + htmls.reduce((sum, html) => sum + (html?.length ?? 0) * 2, 0);
    while (results.size > 8 || resultBytes > 16 * 1024 * 1024) {
      const oldest = results.entries().next().value;
      if (oldest === undefined) break;
      resultBytes -= oldest[0].length * 2 + oldest[1].reduce((sum, html) => sum + (html?.length ?? 0) * 2, 0);
      results.delete(oldest[0]);
    }
    task.resolve(htmls);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "Diff highlighter worker failed");
    for (const task of tasks.values()) task.reject(error);
    tasks.clear();
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

/** Tokenization and grammar loading stay off the renderer thread. */
export async function highlightDiffInWorker(
  lines: DiffDisplayLine[],
  language: string,
  theme: "light" | "dark",
  signal: AbortSignal,
): Promise<(string | null)[]> {
  signal.throwIfAborted();
  if (lines.length === 0 || language === "plaintext") return lines.map(() => null);
  const key = JSON.stringify([language, theme, lines.map((line) => [line.kind, line.text])]);
  const cached = results.get(key);
  if (cached) return cached;
  let shared = pending.get(key);
  if (!shared) {
    const currentWorker = getWorker();
    let task!: Task;
    const promise = new Promise<(string | null)[]>((resolve, reject) => {
      task = { id: ++nextId, key, resolve, reject, consumers: 0 };
      tasks.set(task.id, task);
      currentWorker.postMessage({ id: task.id, lines, language, theme });
    });
    shared = { task, promise };
    pending.set(key, shared);
  }
  const { task, promise } = shared;
  task.consumers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", abort);
      task.consumers--;
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      if (task.consumers === 0 && tasks.has(task.id)) {
        worker?.postMessage({ id: task.id, cancel: true });
        tasks.delete(task.id);
        pending.delete(key);
        task.reject(new DOMException("Diff highlighting canceled", "AbortError"));
      }
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (htmls) => {
        if (finish()) resolve(htmls);
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
