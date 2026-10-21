import { expect, test } from "bun:test";
import {
  createPiMidTurnHandle,
  isPiMidTurnUnavailable,
  isPiThreadMidTurnAccepting,
  PiCodingAgentDriver,
  type PiMidTurnUnavailable,
  type PiQueuedInputDisposition,
  type PiSessionHandle,
  PiSessionRegistry,
  steerPiThreadMidTurn,
} from "../src/pi-coding-agent-driver";
import { piChildSessionKey, piParentSessionKey } from "../src/pi-subagent";

type FakeSteerableSession = {
  isStreaming: boolean;
  steer: (text: string) => Promise<PiQueuedInputDisposition | undefined>;
  getSteeringMessages: () => readonly string[];
  clearQueue: () => { steering: string[]; followUp: string[] };
};

function makeFakeSession(options: { streaming?: boolean } = {}): {
  session: FakeSteerableSession;
  steering: string[];
  cleared: Array<{ steering: string[]; followUp: string[] }>;
} {
  const steering: string[] = [];
  const cleared: Array<{ steering: string[]; followUp: string[] }> = [];
  const session: FakeSteerableSession = {
    isStreaming: options.streaming ?? true,
    // The normal PI 1.0 path queues the text and reports it as queued.
    steer: async (text) => {
      steering.push(text);
      return "queued";
    },
    getSteeringMessages: () => [...steering],
    clearQueue: () => {
      const snapshot = { steering: [...steering], followUp: [] as string[] };
      steering.length = 0;
      cleared.push(snapshot);
      return snapshot;
    },
  };
  return { session, steering, cleared };
}

function makeHandle(midTurn: Pick<PiSessionHandle, "isStreaming" | "steer">): PiSessionHandle {
  return {
    sessionId: "sess_1",
    cwd: "/tmp/pi-mid-turn",
    routeFingerprint: "fingerprint",
    bindingId: "bind_1",
    skillsFingerprint: "",
    mcpFingerprint: "",
    abort: async () => {},
    dispose: () => {},
    rebind: async () => {},
    updateSkillPaths: async () => {},
    async *prompt(): AsyncIterable<never> {},
    ...midTurn,
  };
}

test("createPiMidTurnHandle steers a live run without clearing its queue", async () => {
  const { session, steering, cleared } = makeFakeSession();
  const handle = createPiMidTurnHandle(session);

  expect(handle.isStreaming()).toBe(true);
  await handle.steer("redirect the current turn");

  expect(steering).toEqual(["redirect the current turn"]);
  expect(cleared).toEqual([]);
});

test("createPiMidTurnHandle refuses an idle session and queues nothing", async () => {
  const { session, steering, cleared } = makeFakeSession({ streaming: false });
  const handle = createPiMidTurnHandle(session);

  expect(handle.isStreaming()).toBe(false);
  let caught: unknown;
  try {
    await handle.steer("too late");
  } catch (error) {
    caught = error;
  }

  expect(isPiMidTurnUnavailable(caught)).toBe(true);
  expect((caught as PiMidTurnUnavailable).message).toContain("no active run");
  expect(steering).toEqual([]);
  expect(cleared).toEqual([]);
});

test("createPiMidTurnHandle reclaims a steer the run ended before delivering", async () => {
  const { session, steering, cleared } = makeFakeSession();
  // Simulates the narrow race: the run takes its final steering poll right after enqueue.
  session.steer = async (text) => {
    steering.push(text);
    session.isStreaming = false;
    return "queued";
  };
  const handle = createPiMidTurnHandle(session);

  let caught: unknown;
  try {
    await handle.steer("orphaned steer");
  } catch (error) {
    caught = error;
  }

  expect(isPiMidTurnUnavailable(caught)).toBe(true);
  expect((caught as PiMidTurnUnavailable).message).toContain("ended before the steering message");
  expect(cleared).toEqual([{ steering: ["orphaned steer"], followUp: [] }]);
  expect(steering).toEqual([]);
});

test("createPiMidTurnHandle treats an already-consumed steer as delivered", async () => {
  const { session, steering, cleared } = makeFakeSession();
  session.steer = async (text) => {
    steering.push(text);
    session.isStreaming = false;
    steering.length = 0;
    return "queued";
  };
  const handle = createPiMidTurnHandle(session);

  await handle.steer("consumed steer");

  expect(cleared).toEqual([]);
});

test("createPiMidTurnHandle surfaces a handled disposition as PiMidTurnUnavailable", async () => {
  const { session, steering, cleared } = makeFakeSession();
  const steered: string[] = [];
  // PI 1.0 reports "handled" when an extension input handler consumed the text:
  // nothing was queued, so reporting delivery would silently drop the message.
  session.steer = async (text) => {
    steered.push(text);
    return "handled";
  };
  const handle = createPiMidTurnHandle(session);

  let caught: unknown;
  try {
    await handle.steer("do not drop me");
  } catch (error) {
    caught = error;
  }

  expect(steered).toEqual(["do not drop me"]);
  expect(isPiMidTurnUnavailable(caught)).toBe(true);
  expect((caught as PiMidTurnUnavailable).message).toContain("consumed the steering message");
  // Nothing was queued, so there is nothing to reclaim either.
  expect(steering).toEqual([]);
  expect(cleared).toEqual([]);
});

test("createPiMidTurnHandle treats an undefined disposition as queued (older runtime)", async () => {
  const { session, steering, cleared } = makeFakeSession();
  session.steer = async (text) => {
    steering.push(text);
    return undefined;
  };
  const handle = createPiMidTurnHandle(session);

  await handle.steer("legacy runtime");

  expect(steering).toEqual(["legacy runtime"]);
  expect(cleared).toEqual([]);
});

test("createPiMidTurnHandle lets concurrent steers on a live run all land, in order", async () => {
  const { session, steering, cleared } = makeFakeSession();
  const handle = createPiMidTurnHandle(session);

  await Promise.all([handle.steer("one"), handle.steer("two"), handle.steer("three")]);

  expect(steering).toEqual(["one", "two", "three"]);
  expect(cleared).toEqual([]);
});

test("createPiMidTurnHandle never reports a concurrently reclaimed steer as delivered", async () => {
  const { session, steering, cleared } = makeFakeSession();
  const baseSteer = session.steer;
  let steerCalls = 0;
  // The run takes its final steering poll right after the first enqueue. The first call
  // must reclaim its own orphan; the second must fail closed rather than read the emptied
  // queue as proof that its own entry had been delivered.
  session.steer = async (text) => {
    steerCalls += 1;
    const disposition = await baseSteer(text);
    session.isStreaming = false;
    return disposition;
  };
  const handle = createPiMidTurnHandle(session);

  const results = await Promise.allSettled([handle.steer("first"), handle.steer("second")]);

  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  for (const result of results) {
    expect(result.status === "rejected" && isPiMidTurnUnavailable(result.reason)).toBe(true);
  }
  expect(steerCalls).toBe(1);
  expect(cleared).toEqual([{ steering: ["first"], followUp: [] }]);
  expect(steering).toEqual([]);
});

test("thread mid-turn helpers follow only the live parent session", async () => {
  const registry = new PiSessionRegistry();

  expect(isPiThreadMidTurnAccepting("thr_1", registry)).toBe(false);
  let missing: unknown;
  try {
    await steerPiThreadMidTurn("thr_1", "no session", registry);
  } catch (error) {
    missing = error;
  }
  expect(isPiMidTurnUnavailable(missing)).toBe(true);

  const idle = makeFakeSession({ streaming: false });
  registry.set(piParentSessionKey("thr_1"), makeHandle(createPiMidTurnHandle(idle.session)));
  expect(isPiThreadMidTurnAccepting("thr_1", registry)).toBe(false);
  let idleError: unknown;
  try {
    await steerPiThreadMidTurn("thr_1", "idle", registry);
  } catch (error) {
    idleError = error;
  }
  expect(isPiMidTurnUnavailable(idleError)).toBe(true);
  expect(idle.steering).toEqual([]);

  const live = makeFakeSession();
  registry.set(piParentSessionKey("thr_1"), makeHandle(createPiMidTurnHandle(live.session)));
  expect(isPiThreadMidTurnAccepting("thr_1", registry)).toBe(true);
  await steerPiThreadMidTurn("thr_1", "steer me", registry);
  expect(live.steering).toEqual(["steer me"]);
});

test("child PI sessions never answer mid-turn steering for the thread", () => {
  const registry = new PiSessionRegistry();
  const child = makeFakeSession();
  registry.set(piChildSessionKey("thr_1", "agent_1"), makeHandle(createPiMidTurnHandle(child.session)));

  expect(isPiThreadMidTurnAccepting("thr_1", registry)).toBe(false);
});

test("PiCodingAgentDriver exposes the registered parent session for mid-turn steer", async () => {
  const registry = new PiSessionRegistry();
  const steering: string[] = [];
  let streaming = false;
  let releaseRun: (() => void) | undefined;
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const agentSession = {
    get isStreaming() {
      return streaming;
    },
    steer: async (text: string) => {
      steering.push(text);
      return "queued" as const;
    },
    getSteeringMessages: () => [] as string[],
    clearQueue: () => ({ steering: [] as string[], followUp: [] as string[] }),
  };

  const driver = new PiCodingAgentDriver(
    {
      createSession: async (input) => ({
        sessionId: "sess_live",
        cwd: input.cwd,
        routeFingerprint: input.routeFingerprint,
        bindingId: input.bindingId,
        skillsFingerprint: "",
        mcpFingerprint: "",
        abort: async () => {},
        dispose: () => {},
        rebind: async () => {},
        updateSkillPaths: async () => {},
        ...createPiMidTurnHandle(agentSession),
        // biome-ignore lint/correctness/useYield: this stub only opens a streaming window; it never emits events.
        async *prompt(): AsyncIterable<never> {
          streaming = true;
          markStarted?.();
          await runGate;
          streaming = false;
        },
      }),
      resolveBridgeModel: async () => ({
        bridgeBaseUrl: "http://127.0.0.1:18765",
        bridgeModelId: "alias",
        apiKey: "k",
        agentDir: "/tmp/pi",
        apiCompat: "anthropic",
        bindingId: "cbb_live",
        providerId: "p",
      }),
    },
    registry,
  );

  const runPromise = (async () => {
    for await (const _event of driver.run({
      threadId: "thr_live",
      prompt: "start",
      workspacePath: "/w",
      worktreePath: "/w",
      routes: [
        {
          role: "main" as const,
          providerId: "p",
          modelId: "m",
          primary: { modelId: "m", contextWindow: 100_000 },
        },
      ],
      signal: new AbortController().signal,
    })) {
      // drain
    }
  })();

  await started;
  expect(isPiThreadMidTurnAccepting("thr_live", registry)).toBe(true);
  await steerPiThreadMidTurn("thr_live", "steer the live run", registry);
  expect(steering).toEqual(["steer the live run"]);

  releaseRun?.();
  await runPromise;
  expect(isPiThreadMidTurnAccepting("thr_live", registry)).toBe(false);
});
