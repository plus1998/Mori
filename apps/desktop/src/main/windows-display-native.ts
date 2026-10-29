import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { ActivityAssertion, BrightnessApi, DisplayLevels } from "./display-native";
import { WINDOWS_DISPLAY_SCRIPT } from "./windows-display-worker";

interface WindowsActivityApi {
  executionState(flags: number): number;
  sendInput(count: number, input: Buffer, size: number): number;
}

function loadWindowsActivityApi(): WindowsActivityApi {
  const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const user = koffi.load("user32.dll");
  const executionState = kernel.func("uint32_t __stdcall SetThreadExecutionState(uint32_t)");
  const sendInput = user.func("uint32_t __stdcall SendInput(uint32_t, const void *, int)");
  return { executionState, sendInput };
}

export function createWindowsActivityAssertion(
  api: WindowsActivityApi = loadWindowsActivityApi(),
  arch: string = process.arch,
): ActivityAssertion {
  // SetThreadExecutionState does not stop the screen saver. Like an idle jiggler,
  // send a relative mouse event with zero displacement: no key or cursor movement.
  // INPUT's union starts at offset 8 on 64-bit Windows and offset 4 on x86.
  const is64 = arch !== "ia32";
  const input = Buffer.alloc(is64 ? 40 : 28);
  input.writeUInt32LE(0x0001, (is64 ? 8 : 4) + 12); // MOUSEEVENTF_MOVE
  return {
    refresh() {
      // Non-continuous requests reset timers without owning thread-scoped state
      // that could interfere with Electron's separate powerSaveBlocker.
      if (!api.executionState(0x00000003)) throw new Error("SetThreadExecutionState failed.");
      if (api.sendInput(1, input, input.length) !== 1)
        throw new Error(
          "Windows rejected idle activity. The desktop may be locked or input injection restricted.",
        );
    },
    release() {},
  };
}

interface WindowsMonitor {
  key: string;
  name: string;
  internalDisplay: boolean;
  value: number;
  error: string | null;
}

export interface DisplayWorker {
  request(operation: "list" | "get" | "set", key?: string, value?: number): Promise<unknown>;
  dispose(): void;
}

export class WindowsDisplayWorker implements DisplayWorker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  private output = "";
  private stderr = "";

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const executable = path.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_DISPLAY_SCRIPT, "utf16le").toString("base64"),
      ],
      { windowsHide: true },
    );
    this.child = child;
    this.output = "";
    this.stderr = "";
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      child.kill();
      this.pending?.reject(error);
      this.pending = undefined;
    };
    child.on("error", fail);
    child.on("exit", (code) => fail(new Error(`Windows display helper exited (${code}). ${this.stderr}`)));
    child.stdin.on("error", fail);
    child.stderr.setEncoding("utf8").on("data", (data: string) => {
      this.stderr = (this.stderr + data).slice(-4000);
    });
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      if (this.child !== child) return;
      this.output += data;
      let end: number;
      while ((end = this.output.indexOf("\n")) >= 0) {
        const line = this.output.slice(0, end).trim();
        this.output = this.output.slice(end + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line) as { result?: unknown; error?: string };
          const pending = this.pending;
          this.pending = undefined;
          if (response.error) pending?.reject(new Error(response.error));
          else pending?.resolve(response.result);
        } catch {
          fail(new Error(`Invalid Windows display helper response: ${line.slice(0, 200)}`));
        }
      }
    });
    return child;
  }

  async request(operation: "list" | "get" | "set", key?: string, value?: number): Promise<unknown> {
    if (this.pending) throw new Error("A Windows display operation is already running.");
    const child = this.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
        timer = setTimeout(() => {
          this.pending = undefined;
          if (this.child === child) this.child = undefined;
          child.kill();
          reject(new Error(`Windows display ${operation} timed out. ${this.stderr}`));
        }, 15000);
        child.stdin.write(`${JSON.stringify({ operation, key, value })}\n`);
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  dispose(): void {
    this.pending?.reject(new Error("Windows display helper closed."));
    this.pending = undefined;
    const child = this.child;
    this.child = undefined;
    child?.stdin.end();
    child?.kill();
  }
}

export function createWindowsBrightnessApi(
  worker: DisplayWorker = new WindowsDisplayWorker(),
): BrightnessApi {
  let nextId = 1;
  const ids = new Map<string, number>();
  const keys = new Map<number, string>();
  const keyForId = (id: number) => {
    const key = keys.get(id);
    if (!key) throw new Error(`Unknown Windows display: ${id}`);
    return key;
  };
  return {
    async displays() {
      const monitors = (await worker.request("list")) as WindowsMonitor[];
      if (!Array.isArray(monitors)) throw new Error("Invalid Windows monitor list.");
      return monitors.map((monitor) => {
        let id = ids.get(monitor.key);
        if (id === undefined) {
          id = nextId++;
          ids.set(monitor.key, id);
          keys.set(id, monitor.key);
        }
        return { id, key: monitor.key, name: monitor.name, internal: monitor.internalDisplay };
      });
    },
    async get(id, method) {
      if (method === "software") throw new Error("Windows software dimming is not supported.");
      const monitor = (await worker.request("get", keyForId(id))) as WindowsMonitor;
      if (monitor.error) throw new Error(monitor.error);
      if (!Number.isFinite(monitor.value) || monitor.value < 0 || monitor.value > 1)
        throw new Error(`Display ${id}: invalid Windows brightness value.`);
      return { method: "backlight", value: monitor.value };
    },
    async set(id, levels: DisplayLevels) {
      if (levels.method !== "backlight") throw new Error("Windows software dimming is not supported.");
      await worker.request("set", keyForId(id), levels.value);
    },
    dispose: () => worker.dispose(),
  };
}
