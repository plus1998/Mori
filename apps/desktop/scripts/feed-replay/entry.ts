import { createReplayApi, type ReplayCall } from "./sandbox";
import { FeedReplaySession, type ReplayPlayOptions } from "./session";
import { type FeedReplayFixture, validateReplayFixture } from "./types";

const params = new URLSearchParams(location.search);
const fixturePath = params.get("fixture");
if (!fixturePath) throw new Error("Missing replay fixture URL.");
const fixtureUrl = new URL(fixturePath, location.origin);
if (fixtureUrl.origin !== location.origin || !fixtureUrl.pathname.startsWith("/.smoke-artifacts/")) {
  throw new Error("Replay fixtures must be local dev artifacts.");
}
if (window.parent === window || !window.parent.eco)
  throw new Error("Open replay through the Eco dev CDP command.");
const response = await fetch(fixtureUrl);
if (!response.ok) throw new Error(`Could not load replay fixture: HTTP ${response.status}`);
const rawFixture: unknown = await response.json();
validateReplayFixture(rawFixture);
const fixture: FeedReplayFixture = rawFixture;

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
};
Object.defineProperty(window, "localStorage", { value: memoryStorage() });
Object.defineProperty(window, "sessionStorage", { value: memoryStorage() });
for (const attr of ["data-theme", "data-platform"]) {
  const value = window.parent.document.documentElement.getAttribute(attr);
  if (value) document.documentElement.setAttribute(attr, value);
}

// Historical timestamps advance at wall-clock rate between events. Freezing Date.now
// strands App's force-scroll deadlines when playback is paused. Performance stays real.
let virtualAt = fixture.events[0]!.at;
let clockWall = performance.now();
Date.now = () => virtualAt + performance.now() - clockWall;
const session = new FeedReplaySession(fixture, Number(params.get("seq") ?? 0), (at) => {
  virtualAt = at;
  clockWall = performance.now();
});
const frames: ReturnType<typeof geometry>[] = [];
const marks: Array<Record<string, unknown>> = [];
const errors: Array<{ seq: number; message: string; source: string }> = [];
const calls: ReplayCall[] = [];
const longTasks: Array<{ seq: number; wall: number; duration: number }> = [];
const dropped = { frames: 0, marks: 0, errors: 0, calls: 0, longTasks: 0 };
function append<T>(key: keyof typeof dropped, list: T[], value: T, max = 5000) {
  if (list.length >= max) {
    list.shift();
    dropped[key]++;
  }
  list.push(value);
}
function geometry() {
  const container = document.querySelector<HTMLElement>(".activity-messages");
  return {
    wall: performance.now(),
    recordedAt: virtualAt,
    seq: session.state.appliedSeq,
    top: container?.scrollTop,
    height: container?.scrollHeight,
    client: container?.clientHeight,
    detached: container?.classList.contains("is-reading-detached"),
    headings: [...document.querySelectorAll<HTMLElement>(".run-log-turn-toggle")].map((node) => ({
      text: node.textContent,
      expanded: node.getAttribute("aria-expanded"),
      y: node.getBoundingClientRect().y,
    })),
    rows: [...document.querySelectorAll<HTMLElement>(".run-log-virtual-row")].map((node) => ({
      index: node.dataset.index,
      y: node.getBoundingClientRect().y,
      height: node.getBoundingClientRect().height,
    })),
    tail: document.querySelector<HTMLElement>(".run-log-active-tail")?.innerText,
    text: container?.innerText.slice(-240),
    renderer: window.__ecoConversationV2RendererSnapshot?.()[fixture.conversationId],
  };
}
window.eco = createReplayApi(window.parent.eco as unknown as Record<string, unknown>, session, (call) =>
  append("calls", calls, call),
) as unknown as NonNullable<Window["eco"]>;
window.addEventListener("error", (event) =>
  append("errors", errors, { seq: session.state.appliedSeq, message: event.message, source: "error" }),
);
window.addEventListener("unhandledrejection", (event) =>
  append("errors", errors, {
    seq: session.state.appliedSeq,
    message: String(event.reason),
    source: "rejection",
  }),
);
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  append("errors", errors, {
    seq: session.state.appliedSeq,
    message: args.map(String).join(" ").slice(0, 2000),
    source: "console.error",
  });
  consoleError(...args);
};
const observer = new PerformanceObserver((list) => {
  for (const task of list.getEntries())
    append("longTasks", longTasks, {
      seq: session.state.appliedSeq,
      wall: task.startTime,
      duration: task.duration,
    });
});
observer.observe({ entryTypes: ["longtask"] });
function sample() {
  if (session.playing) append("frames", frames, geometry(), 30_000);
  requestAnimationFrame(sample);
}
requestAnimationFrame(sample);
let completion: unknown;
let measurement:
  | {
      startedAt?: number;
      samples: Array<{ wall: number; inputCleared: boolean; messageVisible: boolean }>;
      messageId: string;
    }
  | undefined;
const controller = {
  fixtureUrl: fixtureUrl.href,
  status: () => {
    const next = session.nextUser();
    return {
      conversationId: fixture.conversationId,
      seq: session.state.appliedSeq,
      lastSeq: fixture.events.length,
      playing: session.playing,
      completion,
      errors: errors.slice(-5),
      blockedCalls: calls.filter((call) => call.kind === "blocked"),
      nextUser:
        next?.effect.type === "message.create"
          ? { seq: next.seq, text: next.effect.message.body, messageId: next.effect.message.messageId }
          : undefined,
      coverage: fixture.coverage,
      geometry: geometry(),
    };
  },
  play: (options: ReplayPlayOptions) => {
    session.validatePlayOptions(options);
    completion = undefined;
    void session
      .play(options, (event, phase) =>
        append("marks", marks, { eventSeq: event.seq, eventType: event.eventType, phase, ...geometry() }),
      )
      .then((result) => {
        completion = result;
      })
      .catch((error: unknown) => {
        completion = { error: String(error) };
        append("errors", errors, { seq: session.state.appliedSeq, message: String(error), source: "play" });
      });
  },
  pause: () => session.pause(),
  trace: () => ({
    formatVersion: 1,
    conversationId: fixture.conversationId,
    coverage: fixture.coverage,
    status: controller.status(),
    frames,
    marks,
    errors,
    calls,
    longTasks,
    dropped,
  }),
  clear: () => {
    frames.length = marks.length = errors.length = calls.length = longTasks.length = 0;
    for (const key of Object.keys(dropped) as Array<keyof typeof dropped>) dropped[key] = 0;
  },
  measureNextSend: () => {
    const next = session.nextUser();
    if (!next || next.effect.type !== "message.create" || session.playing)
      throw new Error("Pause at a checkpoint with a recorded next user message.");
    measurement = { samples: [], messageId: next.effect.message.messageId };
    document.addEventListener(
      "pointerdown",
      () => {
        measurement!.startedAt = performance.now();
        const tick = () => {
          const messageVisible = [
            ...document.querySelectorAll<HTMLElement>("article.run-log-user-prompt"),
          ].some((node) => node.dataset.userMessageAnchorId === `conversation-v2:${measurement!.messageId}`);
          measurement!.samples.push({
            wall: performance.now() - measurement!.startedAt!,
            inputCleared: !document.querySelector<HTMLElement>(
              '.composer-skill-input-control[role="textbox"]',
            )?.textContent,
            messageVisible,
          });
          if (measurement!.samples.length < 90) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { once: true },
    );
  },
  sendMeasurement: () => measurement,
};
declare global {
  interface Window {
    __ECO_FEED_REPLAY__?: typeof controller;
  }
}
window.__ECO_FEED_REPLAY__ = controller;
await import("../../src/renderer/App");
