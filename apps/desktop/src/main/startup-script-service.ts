import fs from "node:fs/promises";
import type {
  BackgroundTerminalTask,
  StartupScript,
  StartupScriptSaveInput,
} from "../shared/ipc";
import { BackgroundTerminalTaskRegistry } from "./background-terminal-tasks";
import { buildStartupScriptCommandInvocation } from "./interactive-terminal-manager";
import type { StartupScriptStore } from "./startup-script-store";

export class StartupScriptService {
  private readonly startingScripts = new Set<string>();

  constructor(
    private readonly store: StartupScriptStore,
    private readonly tasks: BackgroundTerminalTaskRegistry,
  ) {}

  list(): StartupScript[] {
    return this.store.list();
  }

  save(input: StartupScriptSaveInput): StartupScript {
    if (input.id) this.assertStopped(input.id.trim());
    return this.store.save(input);
  }

  delete(id: string): { deleted: true } {
    const normalizedId = id.trim();
    this.assertStopped(normalizedId);
    this.store.delete(normalizedId);
    return { deleted: true };
  }

  async start(id: string): Promise<BackgroundTerminalTask> {
    const normalizedId = id.trim();
    const script = this.store.get(normalizedId);
    if (!script) throw new Error(`Startup script not found: ${id}`);
    this.assertStopped(script.id, true);
    this.startingScripts.add(script.id);

    try {
      if (!script.name.trim() || !script.workspacePath.trim() || !script.command.trim()) {
        throw new Error("Startup script name, working directory, and command are required.");
      }

      const directory = await fs.stat(script.workspacePath);
      if (!directory.isDirectory()) {
        throw new Error(`Startup script working directory is not a folder: ${script.workspacePath}`);
      }

      // The reservation above prevents edits, deletes, and concurrent starts
      // while filesystem validation is in flight.
      if (this.hasActiveTask(script.id)) this.throwActiveScriptError(true);
      return this.tasks.start(
        {
          workspacePath: script.workspacePath,
          command: buildStartupScriptCommandInvocation(script.command),
          label: script.name,
        },
        { startupScriptId: script.id },
      );
    } finally {
      this.startingScripts.delete(script.id);
    }
  }

  private assertStopped(id: string, starting = false): void {
    if (this.startingScripts.has(id) || this.hasActiveTask(id)) this.throwActiveScriptError(starting);
  }

  private hasActiveTask(id: string): boolean {
    return this.tasks
      .list({ startupScriptId: id })
      .some((task) => task.status === "starting" || task.status === "running");
  }

  private throwActiveScriptError(starting: boolean): never {
    throw new Error(
      starting
        ? "Startup script is already running or starting."
        : "Stop the startup script before editing or deleting it.",
    );
  }
}
