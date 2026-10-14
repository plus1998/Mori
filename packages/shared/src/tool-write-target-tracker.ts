import { readToolWriteTargetDetail } from "./tool-write-target";

/**
 * Names the target of a tool call whose arguments arrive in fragments, without re-reading
 * everything that has arrived so far.
 *
 * The reader itself is a linear scan of the text it is given, so calling it once per fragment
 * costs O(n²) over a call: a one megabyte patch in token-sized fragments spends seconds inside it
 * and delays the Feed. This tracker keeps three properties instead:
 *
 * - it looks at the first `scanLimit` characters only, so the work per look is bounded;
 * - while the arguments are shorter than that it looks after every fragment (the text is small and
 *   the answer has to be exact, "it is being written" should become "writing /tmp/x.md" the moment
 *   the path is closed), and past it only after the text has grown by `retryGrowth` — a target is
 *   named near the front of the arguments, so the rest of a long payload is never looked at again;
 * - once the text that named the target is closed it stops looking altogether.
 *
 * The window means a target named *after* `scanLimit` characters is never read: a call that writes
 * a megabyte of content before its `file_path` is announced as「正在准备写入文件」rather than by name.
 * Every producer seen so far names the file or command in its opening keys — `file_path`,
 * `command`, or the V4A marker on the patch's first line — and a bounded label beats a main
 * process that spends twenty seconds re-reading the same arguments.
 *
 * One tracker belongs to one tool call. `observe` is fed the arguments as they now stand — the
 * whole accumulated text, not the latest fragment — and may be called with a snapshot that
 * replaces an earlier one (the π adapter hands whole `partialJson` snapshots).
 */
export class ToolWriteTargetTracker {
  private toolName: string;
  private readonly scanLimit: number;
  private readonly retryGrowth: number;
  /** Length of the last text that was looked at; `-1` means nothing has been looked at yet. */
  private lookedAtLength = -1;
  private known: string | undefined;
  private isSettled = false;

  constructor(toolName: string, options: ToolWriteTargetTrackerOptions = {}) {
    this.toolName = toolName;
    this.scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
    this.retryGrowth = options.retryGrowth ?? DEFAULT_RETRY_GROWTH;
  }

  /**
   * The tool's name decides how the arguments are read, and it can arrive after the first
   * fragments (Codex names the call in `response.output_item.added`), so a new name drops what was
   * read under the old one and looks again.
   */
  setToolName(toolName: string): void {
    if (toolName === this.toolName) {
      return;
    }
    this.toolName = toolName;
    this.known = undefined;
    this.isSettled = false;
    this.lookedAtLength = -1;
  }

  /** Returns the target as it is now known, looking at `argumentsText` only if it is worth it. */
  observe(argumentsText: string): string | undefined {
    if (this.isSettled) {
      return this.known;
    }
    if (
      argumentsText.length >= this.scanLimit &&
      argumentsText.length - this.lookedAtLength < this.retryGrowth
    ) {
      return this.known;
    }
    this.lookedAtLength = argumentsText.length;
    const read = readToolWriteTargetDetail({
      toolName: this.toolName,
      argumentsText: argumentsText.slice(0, this.scanLimit),
    });
    if (read.target) {
      this.known = read.target;
    }
    if (read.final) {
      this.isSettled = true;
    }
    return this.known;
  }

  /** The target as last read, without looking at any text. */
  get target(): string | undefined {
    return this.known;
  }

  /** True once the text that named the target is closed: the answer cannot change any more. */
  get settled(): boolean {
    return this.isSettled;
  }
}

export interface ToolWriteTargetTrackerOptions {
  /** Characters of the accumulated arguments that are ever examined. */
  scanLimit?: number;
  /** How much the arguments must grow before a failed read is tried again. */
  retryGrowth?: number;
}

/** Paths and commands are named in the opening keys of the arguments, not after the payload. */
const DEFAULT_SCAN_LIMIT = 8192;
const DEFAULT_RETRY_GROWTH = 64;
