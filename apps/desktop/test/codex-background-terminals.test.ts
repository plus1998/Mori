import { expect, test } from "bun:test";
import { CodexBackgroundTerminalService } from "../src/main/codex-background-terminals";

interface RequestCall {
  method: string;
  params: unknown;
}

const terminalRow = {
  itemId: "item-bash",
  processId: "process-bash",
  command: "bun run dev",
  cwd: "/workspace/eco",
  osPid: 56282,
  cpuPercent: 1.5,
  rssKb: 208320,
};

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
        data: [terminalRow],
        nextCursor: null,
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const service = new CodexBackgroundTerminalService({
    getClients: () => [client],
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
  const { calls, client } = createClient(({ method }) => {
    if (method === "thread/loaded/list") return { data: ["codex-main"] };
    if (method === "thread/backgroundTerminals/list") return { data: [terminalRow] };
    return { terminated: true };
  });
  const service = new CodexBackgroundTerminalService({
    getClients: () => [client],
    resolveEcoThreadId: () => "thr_main",
  });
  await service.list();

  await expect(
    service.terminate({ codexThreadId: "codex-main", processId: "process-bash" }),
  ).resolves.toEqual({ terminated: true });
  expect(calls.slice(-1)).toEqual([
    {
      method: "thread/backgroundTerminals/terminate",
      params: {
        threadId: "codex-main",
        processId: "process-bash",
      },
    },
  ]);
});

test("does not send a termination request to a replacement after the listed owner exits", async () => {
  const owner = createClient(({ method }) => {
    if (method === "thread/loaded/list") return { data: ["codex-main"] };
    if (method === "thread/backgroundTerminals/list") return { data: [terminalRow] };
    throw new Error(`Unexpected owner method: ${method}`);
  });
  const replacement = createClient(() => ({ terminated: true }));
  let clients = [owner.client];
  const service = new CodexBackgroundTerminalService({
    getClients: () => clients,
    resolveEcoThreadId: () => "thr_main",
  });
  await service.list();
  clients = [replacement.client];

  await expect(service.terminate({ codexThreadId: "codex-main", processId: "process-bash" })).rejects.toThrow(
    "no longer available",
  );
  expect(replacement.calls).toEqual([]);
});

test("stops a listed terminal on its retiring generation even when the thread routes elsewhere", async () => {
  const old = createClient(({ method }) => {
    if (method === "thread/loaded/list") return { data: ["old-thread"], nextCursor: null };
    if (method === "thread/backgroundTerminals/list")
      return {
        data: [
          {
            itemId: "old-item",
            processId: "old-process",
            command: "bun run dev",
            cwd: "/workspace",
            osPid: null,
            cpuPercent: null,
            rssKb: null,
          },
        ],
        nextCursor: null,
      };
    if (method === "thread/backgroundTerminals/terminate") return { terminated: true };
    throw new Error(`Unexpected old method ${method}`);
  });
  const current = createClient(({ method }) => {
    if (method === "thread/loaded/list") return { data: [], nextCursor: null };
    throw new Error(`Wrong generation for ${method}`);
  });
  const service = new CodexBackgroundTerminalService({
    getClients: () => [current.client, old.client],
    resolveEcoThreadId: () => "eco-thread",
  });
  expect((await service.list()).map((terminal) => terminal.processId)).toEqual(["old-process"]);
  expect(await service.terminate({ codexThreadId: "old-thread", processId: "old-process" })).toEqual({
    terminated: true,
  });
  expect(current.calls.map((call) => call.method)).toEqual(["thread/loaded/list"]);
});

test("refuses to stop a terminal identifier reported by more than one app-server", async () => {
  const handler = ({ method }: RequestCall) => {
    if (method === "thread/loaded/list") return { data: ["codex-main"] };
    if (method === "thread/backgroundTerminals/list") return { data: [terminalRow] };
    throw new Error(`Unexpected method: ${method}`);
  };
  const first = createClient(handler);
  const second = createClient(handler);
  const service = new CodexBackgroundTerminalService({
    getClients: () => [first.client, second.client],
    resolveEcoThreadId: () => "thr_main",
  });
  await service.list();

  await expect(service.terminate({ codexThreadId: "codex-main", processId: "process-bash" }))
    .rejects.toThrow("owner is ambiguous");
});
