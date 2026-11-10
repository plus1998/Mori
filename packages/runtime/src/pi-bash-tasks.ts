import { randomUUID } from "node:crypto";
import type { createBashToolDefinition, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface PiBashTask {
  threadId: string;
  taskId: string;
  workspacePath: string;
  label: string;
  status: "running";
  taskType: "bash";
}

interface LiveTask {
  view: PiBashTask;
  controller: AbortController;
  settled: Promise<void>;
}

/** Owns per-execution cancellation; cancelling a Bash never aborts the AgentSession. */
export class PiBashTaskRegistry {
  private readonly tasks = new Map<string, LiveTask>();

  list(): PiBashTask[] {
    return [...this.tasks.values()].map((task) => ({ ...task.view }));
  }

  async stop(threadId: string, taskId: string): Promise<{ stopped: boolean }> {
    const task = this.tasks.get(taskId);
    if (!task || task.view.threadId !== threadId) return { stopped: false };
    task.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task.settled,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("PI Bash did not exit after cancellation.")), 5_000);
        }),
      ]);
      return { stopped: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async execute<T>(
    input: { threadId: string; workspacePath: string; label: string; signal?: AbortSignal },
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    if (signal.aborted) throw new Error("PI Bash cancelled before execution.");
    const taskId = randomUUID();
    let settle!: () => void;
    this.tasks.set(taskId, {
      view: {
        threadId: input.threadId,
        taskId,
        workspacePath: input.workspacePath,
        label: input.label,
        status: "running",
        taskType: "bash",
      },
      controller,
      settled: new Promise((resolve) => {
        settle = resolve;
      }),
    });
    try {
      return await run(signal);
    } finally {
      this.tasks.delete(taskId);
      settle();
    }
  }
}

export const globalPiBashTaskRegistry = new PiBashTaskRegistry();

export function createPiBashTaskExtensionFactory(input: {
  threadId: string;
  bashTool: ReturnType<typeof createBashToolDefinition>;
  registry?: PiBashTaskRegistry;
}): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      ...input.bashTool,
      execute(toolCallId, args, signal, onUpdate, ctx) {
        return (input.registry ?? globalPiBashTaskRegistry).execute(
          {
            threadId: input.threadId,
            workspacePath: ctx.cwd,
            label: args.command,
            ...(signal && { signal }),
          },
          (toolSignal) => input.bashTool.execute(toolCallId, args, toolSignal, onUpdate, ctx),
        );
      },
    });
  };
}
