import type { CodexAppServerClient } from "@eco/runtime/codex-app-server-client";
import { steerCodexTurn } from "@eco/runtime/codex-turn-steer";

export type CodexMidTurnPortPhase = "accepting" | "closing" | "closed";

export type CodexMidTurnPushResult =
  | { ok: true; turnId: string }
  | { ok: false; reason: string; retriable: boolean; deliveryUnknown: boolean };

export type CodexMidTurnPortHandle = {
  client: Pick<CodexAppServerClient, "request">;
  codexThreadId: string;
  turnId: string;
};

type PortEntry = {
  phase: CodexMidTurnPortPhase;
  handle: CodexMidTurnPortHandle;
  inflight: Set<Promise<unknown>>;
  pendingConsumption: Map<string, CodexMidTurnConsumption>;
};

type CodexMidTurnConsumption = {
  onConsumed: (observedAt: string) => void;
  onUnconfirmed: () => void;
};

/**
 * Main-process registry for live Codex turn mid-turn inject via `turn/steer`.
 * One accepting port per Eco thread (main regular turn only).
 */
export class CodexMidTurnPortRegistry {
  private readonly ports = new Map<string, PortEntry>();

  open(threadId: string, handle: CodexMidTurnPortHandle): void {
    const id = threadId.trim();
    if (!id) {
      return;
    }
    this.ports.set(id, {
      phase: "accepting",
      handle: {
        client: handle.client,
        codexThreadId: handle.codexThreadId.trim(),
        turnId: handle.turnId.trim(),
      },
      inflight: new Set(),
      pendingConsumption: new Map(),
    });
  }

  getPhase(threadId: string): CodexMidTurnPortPhase | undefined {
    return this.ports.get(threadId.trim())?.phase;
  }

  isAccepting(threadId: string): boolean {
    return this.getPhase(threadId) === "accepting";
  }

  acceptingTurnId(threadId: string): string | undefined {
    const port = this.ports.get(threadId.trim());
    if (port?.phase === "accepting") return port.handle.turnId;
  }

  confirmUserMessage(threadId: string, turnId: string, clientUserMessageId: string, observedAt: string): void {
    const port = this.ports.get(threadId.trim());
    if (!port || port.handle.turnId !== turnId) return;
    const pending = port.pendingConsumption.get(clientUserMessageId);
    if (!pending) return;
    port.pendingConsumption.delete(clientUserMessageId);
    pending.onConsumed(observedAt);
  }

  async closeIngress(threadId: string, turnId?: string): Promise<void> {
    const port = this.ports.get(threadId.trim());
    if (!port || port.phase === "closed" || (turnId && port.handle.turnId !== turnId)) {
      return;
    }
    port.phase = "closing";
    if (port.inflight.size === 0) {
      return;
    }
    await Promise.allSettled([...port.inflight]);
  }

  close(threadId: string, turnId?: string): void {
    const id = threadId.trim();
    const port = this.ports.get(id);
    if (!port || (turnId && port.handle.turnId !== turnId)) {
      return;
    }
    port.phase = "closed";
    this.ports.delete(id);
    for (const pending of port.pendingConsumption.values()) pending.onUnconfirmed();
    port.pendingConsumption.clear();
  }

  async tryPushUserText(
    threadId: string,
    text: string,
    options?: { clientUserMessageId?: string; expectedTurnId?: string; consumption?: CodexMidTurnConsumption },
  ): Promise<CodexMidTurnPushResult> {
    const port = this.ports.get(threadId.trim());
    if (!port || port.phase !== "accepting" ||
        (options?.expectedTurnId && port.handle.turnId !== options.expectedTurnId)) {
      return {
        ok: false,
        reason: "No live Codex turn is accepting mid-turn input.",
        retriable: true,
        deliveryUnknown: false,
      };
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return {
        ok: false,
        reason: "Mid-turn steer requires non-empty text.",
        retriable: false,
        deliveryUnknown: false,
      };
    }
    const { client, codexThreadId, turnId } = port.handle;
    const clientUserMessageId = options?.clientUserMessageId?.trim();
    if (clientUserMessageId && options?.consumption) {
      port.pendingConsumption.set(clientUserMessageId, options.consumption);
    }
    const work = steerCodexTurn(client, {
      threadId: codexThreadId,
      turnId,
      input: [{ type: "text", text: trimmed }],
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    }).then(
      (result) => ({ ok: true as const, turnId: result.turnId }),
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        const deliveryUnknown =
          error instanceof Error && "deliveryUnknown" in error && error.deliveryUnknown === true;
        return {
          ok: false as const,
          reason,
          retriable: !deliveryUnknown && !/requires threadId|empty|non-empty/i.test(reason),
          deliveryUnknown,
        };
      },
    );
    port.inflight.add(work);
    try {
      const result = await work;
      // An uncertain RPC can still be followed by the authoritative user item.
      if (!result.ok && !result.deliveryUnknown && clientUserMessageId) {
        port.pendingConsumption.delete(clientUserMessageId);
      }
      return result;
    } finally {
      port.inflight.delete(work);
    }
  }
}
