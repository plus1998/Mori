import type { CodexBackgroundTerminal, CodexBackgroundTerminalTerminateResult } from "../shared/ipc";

interface CodexBackgroundTerminalClient {
  readonly isInitialized: boolean;
  request<T = unknown>(method: string, params?: unknown, options?: { trackActivity?: boolean }): Promise<T>;
}

interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
}

interface CodexBackgroundTerminalRow {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | bigint | null;
}

export interface CodexBackgroundTerminalServiceDeps {
  getClients(): readonly CodexBackgroundTerminalClient[];
  resolveEcoThreadId(codexThreadId: string): string | undefined;
  setClientBackgroundTerminalWork?(client: CodexBackgroundTerminalClient, hasWork: boolean): void;
}

const LOADED_THREAD_PAGE_SIZE = 100;
const BACKGROUND_TERMINAL_PAGE_SIZE = 100;

/**
 * Reads and terminates Codex Unified Exec processes through the app-server's
 * owner-side APIs. OS process inspection is intentionally not used here: only
 * the producer can prove which Codex thread owns a processId.
 */
export class CodexBackgroundTerminalService {
  // This is process ownership, which can outlive a change to the thread's runtime binding.
  private listedOwners = new Map<string, CodexBackgroundTerminalClient | null>();
  private listSequence = 0;
  private appliedListSequence = 0;

  constructor(private readonly deps: CodexBackgroundTerminalServiceDeps) {}

  async list(): Promise<CodexBackgroundTerminal[]> {
    const sequence = ++this.listSequence;
    const terminalsByKey = new Map<string, CodexBackgroundTerminal>();
    const owners = new Map<string, CodexBackgroundTerminalClient | null>();
    for (const client of new Set(this.deps.getClients())) {
      if (!client.isInitialized) continue;
      let clientHasWork = false;
      const codexThreadIds = await this.listLoadedThreadIds(client);
      for (const codexThreadId of codexThreadIds) {
        const rows = await this.listThreadTerminals(client, codexThreadId);
        clientHasWork ||= rows.length > 0;
        for (const row of rows) {
          const key = `${codexThreadId}\0${row.processId}`;
          if (owners.has(key) && owners.get(key) !== client) {
            owners.set(key, null);
            continue;
          }
          owners.set(key, client);
          terminalsByKey.set(key, {
            codexThreadId,
            threadId: this.deps.resolveEcoThreadId(codexThreadId)?.trim() || codexThreadId,
            itemId: row.itemId,
            processId: row.processId,
            workspacePath: row.cwd,
            command: row.command,
            ...(row.osPid !== null && { osPid: row.osPid }),
            ...(row.cpuPercent !== null && { cpuPercent: row.cpuPercent }),
            ...(row.rssKb !== null && { rssKb: Number(row.rssKb) }),
          });
        }
      }
      this.deps.setClientBackgroundTerminalWork?.(client, clientHasWork);
    }
    if (sequence > this.appliedListSequence) {
      this.listedOwners = owners;
      this.appliedListSequence = sequence;
    }
    return [...terminalsByKey.values()].sort(
      (left, right) =>
        left.codexThreadId.localeCompare(right.codexThreadId) ||
        left.processId.localeCompare(right.processId),
    );
  }

  async terminate(input: {
    codexThreadId: string;
    processId: string;
  }): Promise<CodexBackgroundTerminalTerminateResult> {
    const codexThreadId = input.codexThreadId.trim();
    const processId = input.processId.trim();
    if (!codexThreadId || !processId) {
      throw new Error("Codex thread id and process id are required.");
    }
    const client = this.listedOwners.get(`${codexThreadId}\0${processId}`);
    if (client === null) {
      throw new Error("Multiple Codex app-servers reported this terminal; its owner is ambiguous.");
    }
    if (!client?.isInitialized || !this.deps.getClients().includes(client)) {
      throw new Error("The Codex app-server that listed this terminal is no longer available, or the terminal has already exited.");
    }
    const result = await client.request<unknown>("thread/backgroundTerminals/terminate", {
      threadId: codexThreadId,
      processId,
    });
    if (!isRecord(result) || typeof result.terminated !== "boolean") {
      throw new Error("Codex app-server returned an invalid background terminal termination result.");
    }
    return { terminated: result.terminated };
  }

  private async listLoadedThreadIds(client: CodexBackgroundTerminalClient): Promise<string[]> {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    const threadIds = new Set<string>();
    do {
      const page: unknown = await client.request<unknown>("thread/loaded/list", {
        limit: LOADED_THREAD_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }, { trackActivity: false });
      const parsed: CursorPage<string> = parseCursorPage(page, (value) => {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error("Codex app-server returned an invalid loaded thread id.");
        }
        return value.trim();
      });
      for (const threadId of parsed.data) {
        threadIds.add(threadId);
      }
      cursor = parsed.nextCursor;
      assertFreshCursor(cursor, seenCursors);
    } while (cursor);
    return [...threadIds];
  }

  private async listThreadTerminals(
    client: CodexBackgroundTerminalClient,
    codexThreadId: string,
  ): Promise<CodexBackgroundTerminalRow[]> {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    const rows: CodexBackgroundTerminalRow[] = [];
    do {
      const page: unknown = await client.request<unknown>("thread/backgroundTerminals/list", {
        threadId: codexThreadId,
        limit: BACKGROUND_TERMINAL_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }, { trackActivity: false });
      const parsed: CursorPage<CodexBackgroundTerminalRow> = parseCursorPage(
        page,
        parseBackgroundTerminalRow,
      );
      rows.push(...parsed.data);
      cursor = parsed.nextCursor;
      assertFreshCursor(cursor, seenCursors);
    } while (cursor);
    return rows;
  }
}

function parseCursorPage<T>(value: unknown, parseItem: (item: unknown) => T): CursorPage<T> {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("Codex app-server returned an invalid paginated process list.");
  }
  const nextCursor =
    value.nextCursor === null || value.nextCursor === undefined
      ? null
      : typeof value.nextCursor === "string" && value.nextCursor.trim()
        ? value.nextCursor.trim()
        : undefined;
  if (nextCursor === undefined) {
    throw new Error("Codex app-server returned an invalid process list cursor.");
  }
  return { data: value.data.map(parseItem), nextCursor };
}

function parseBackgroundTerminalRow(value: unknown): CodexBackgroundTerminalRow {
  if (!isRecord(value)) {
    throw new Error("Codex app-server returned an invalid background terminal.");
  }
  const itemId = readRequiredString(value, "itemId");
  const processId = readRequiredString(value, "processId");
  const command = readRequiredString(value, "command");
  const cwd = readRequiredString(value, "cwd");
  const osPid = readOptionalNumber(value.osPid);
  const cpuPercent = readOptionalNumber(value.cpuPercent);
  const rssKb = typeof value.rssKb === "bigint" ? value.rssKb : readOptionalNumber(value.rssKb);
  return { itemId, processId, command, cwd, osPid, cpuPercent, rssKb };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Codex app-server background terminal is missing ${key}.`);
  }
  return value.trim();
}

function readOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Codex app-server returned an invalid background terminal metric.");
  }
  return value;
}

function assertFreshCursor(cursor: string | null, seen: Set<string>): void {
  if (!cursor) {
    return;
  }
  if (seen.has(cursor)) {
    throw new Error("Codex app-server repeated a background terminal page cursor.");
  }
  seen.add(cursor);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
