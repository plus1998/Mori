import type { CodexThreadAttributionRecord, CodexThreadMap } from "./codex-thread-map";
import type { ConversationStore } from "./conversation-store";

export class ConversationStoreCodexThreadMap implements CodexThreadMap {
  private readonly attribution = new Map<string, CodexThreadAttributionRecord>();

  constructor(private readonly store: ConversationStore) {}

  getCodexThreadId(ecoThreadId: string): string | undefined {
    const session = this.store.getThreadCoreSession(ecoThreadId.trim());
    return session?.coreKind === "codex" ? session.externalSessionId : undefined;
  }

  getEcoThreadId(codexThreadId: string): string | undefined {
    return this.store.getThreadIdByCoreSession("codex", codexThreadId.trim());
  }

  setMapping(ecoThreadId: string, codexThreadId: string): void {
    const thread = this.store.getThread(ecoThreadId.trim());
    if (!thread) {
      throw new Error(`Thread not found: ${ecoThreadId}`);
    }
    this.store.saveThreadCoreSession({
      threadId: thread.id,
      coreKind: "codex",
      externalSessionId: codexThreadId,
      cwd: thread.workLocation?.mode === "isolated" && thread.workLocation.worktree
        ? thread.workLocation.worktree.worktreePath : thread.workspacePath,
    });
  }

  deleteMapping(ecoThreadId: string): void {
    this.store.deleteThreadCoreSession(ecoThreadId.trim(), "codex");
  }

  getThreadAttribution(codexThreadId: string): CodexThreadAttributionRecord | undefined {
    return this.attribution.get(codexThreadId.trim());
  }

  setThreadAttribution(codexThreadId: string, record: CodexThreadAttributionRecord): void {
    const id = codexThreadId.trim();
    const parent = record.parentThreadId.trim();
    if (!id || !parent) {
      throw new Error("Codex child attribution requires thread and parent ids.");
    }
    // Root Codex id is eco-mapped; never persist it as a child (would re-scope planner feed).
    if (this.getEcoThreadId(id) || id === parent) {
      return;
    }
    this.attribution.set(id, {
      ...record,
      parentThreadId: parent,
    });
  }
}
