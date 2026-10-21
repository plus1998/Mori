import { expect, test } from "bun:test";
import { CodexBackgroundTerminalService } from "../src/main/codex-background-terminals";

interface RequestCall {
  method: string;
  params: unknown;
}

function createClient(handler: (call: RequestCall) => unknown) {
  const calls: RequestCall[] = [];
  return {
    calls,
    client: {
      isInitialized: true,
      request<T = unknown>(method: string, params?: unknown): Promise<T> {
        const call = { method, params };
        calls.push(call);
        return Promise.resolve(handler(call) as T);
      },
    },
  };
}

test("lists Codex Unified Exec processes from loaded threads and maps Eco ownership", async () => {
  const { calls, client } = createClient(({ method }) => {
    if (method === "thread/loaded/list") {
      return {
        data: ["codex-main", "codex-child"],
        nextCursor: null,
      };
    }
    if (method === "thread/backgroundTerminals/list") {
      return {
        data: [
          {
            itemId: "item-bash",
            processId: "process-bash",
            command: "bun run dev",
            cwd: "/workspace/eco",
            osPid: 56282,
            cpuPercent: 1.5,
            rssKb: 208320,
          },
        ],
        nextCursor: null,
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const service = new CodexBackgroundTerminalService({
    getClient: () => client,
    resolveEcoThreadId: (codexThreadId) => (codexThreadId === "codex-child" ? "thr_parent" : "thr_main"),
  });

  const terminals = await service.list();

  expect(terminals).toEqual([
    {
      codexThreadId: "codex-child",
      threadId: "thr_parent",
      itemId: "item-bash",
      processId: "process-bash",
      workspacePath: "/workspace/eco",
      command: "bun run dev",
      osPid: 56282,
      cpuPercent: 1.5,
      rssKb: 208320,
    },
    {
      codexThreadId: "codex-main",
      threadId: "thr_main",
      itemId: "item-bash",
      processId: "process-bash",
      workspacePath: "/workspace/eco",
      command: "bun run dev",
      osPid: 56282,
      cpuPercent: 1.5,
      rssKb: 208320,
    },
  ]);
  expect(calls.map((call) => call.method)).toEqual([
    "thread/loaded/list",
    "thread/backgroundTerminals/list",
    "thread/backgroundTerminals/list",
  ]);
});

test("terminates by Codex thread and process identity", async () => {
  const { calls, client } = createClient(() => ({ terminated: true }));
  const service = new CodexBackgroundTerminalService({
    getClient: () => client,
    resolveEcoThreadId: () => "thr_main",
  });

  await expect(
    service.terminate({ codexThreadId: "codex-main", processId: "process-bash" }),
  ).resolves.toEqual({ terminated: true });
  expect(calls).toEqual([
    {
      method: "thread/backgroundTerminals/terminate",
      params: {
        threadId: "codex-main",
        processId: "process-bash",
      },
    },
  ]);
});

test("reports an unavailable app-server instead of pretending termination succeeded", async () => {
  const service = new CodexBackgroundTerminalService({
    getClient: () => undefined,
    resolveEcoThreadId: () => "thr_main",
  });

  await expect(service.terminate({ codexThreadId: "codex-main", processId: "process-bash" })).rejects.toThrow(
    "Codex app-server is not running",
  );
});
