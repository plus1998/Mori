import { classifyToolWriteKind, type ToolWriteKind, ToolWriteTargetTracker } from "@eco/shared";
import type {
  GatewayCodexTurnMetadata,
  GatewayToolWriteObservation,
  GatewayToolWriteObserver,
} from "./types.js";
import { isResponsesToolOutputItem } from "./upstream/responses-stream-errors.js";

type GatewayLogFn = (message: string) => void;

type ResponsesEvent = {
  type?: unknown;
  item?: unknown;
  delta?: unknown;
  name?: unknown;
  call_id?: unknown;
  item_id?: unknown;
};

/** What is known about one call so far, and what has already been said about it. */
interface ToolWriteCall {
  name?: string;
  argumentsText: string;
  /** Reads the target out of `argumentsText` without re-reading it on every fragment. */
  target: ToolWriteTargetTracker;
  announcedName: string | undefined;
  announcedTarget: string | undefined;
  announced: boolean;
}

/**
 * Announce what the model is writing, as precisely as the stream allows.
 *
 * The Feed wants「正在写入 /tmp/x.md」rather than「正在写入工具调用」, and the arguments that
 * name the target arrive while the call is still being written. Two upstream shapes feed this:
 * the Responses passthrough (native `responses` providers) and the Anthropic→Responses
 * conversion. Both state the call at its start — `response.output_item.added` for the tool item,
 * milliseconds after the last text — and then stream the arguments, which for Codex's
 * `apply_patch` is minutes of a file that is named in the patch's first line.
 *
 * Only Codex is observed: it is the one client whose app-server reports a tool only once the
 * arguments are complete, and the only one that identifies its thread (`x-codex-turn-metadata`).
 */
export class GatewayToolWriteAnnouncer {
  private readonly calls = new Map<string, ToolWriteCall>();

  constructor(
    private readonly observer: GatewayToolWriteObserver | undefined,
    private readonly codexTurnMetadata: GatewayCodexTurnMetadata | undefined,
    private readonly onLog: GatewayLogFn,
  ) {}

  /** Call for every upstream Responses event (including converted ones). */
  observeEvent(event: ResponsesEvent): void {
    if (!this.observer || !this.codexThreadId()) {
      return;
    }
    if (event.type === "response.output_item.added") {
      this.observeCallStart(event.item);
      return;
    }
    if (
      event.type === "response.custom_tool_call_input.delta" ||
      event.type === "response.function_call_arguments.delta"
    ) {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        const itemId = readEventItemId(event);
        const callId = readString(event.call_id);
        const name = readString(event.name);
        this.pushArguments({
          text: delta,
          ...(itemId && { itemId }),
          ...(callId && { callId }),
          ...(name && { name }),
        });
      }
    }
  }

  /** `response.output_item.added`: the call exists, its arguments have not arrived. */
  private observeCallStart(item: unknown): void {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const record = item as Record<string, unknown>;
    const isToolItem =
      isResponsesToolOutputItem(record) ||
      // Provider-side items Codex reports without a tool name (`web_search_call`) still mean
      // "a call is being written" — the Feed says so rather than showing nothing.
      isProviderSideToolItemType(readString(record.type));
    if (!isToolItem) {
      return;
    }
    const name = readString(record.name);
    const itemId = readItemId(record);
    const callId = readString(record.call_id);
    const key = this.callKey(itemId ?? callId, name);
    const call = this.callFor(key);
    if (name) {
      call.name = name;
      call.target.setToolName(name);
    }
    this.announce(key, call, callId ?? itemId);
  }

  /** Argument fragments: the first one that names a target upgrades the announcement. */
  pushArguments(input: { itemId?: string; callId?: string; name?: string; text: string }): void {
    if (!this.observer || !this.codexThreadId()) {
      return;
    }
    const key = this.callKey(input.itemId ?? input.callId, input.name);
    const call = this.callFor(key);
    if (input.name && !call.name) {
      call.name = input.name;
      call.target.setToolName(input.name);
    }
    call.argumentsText += input.text;
    const target = call.target.observe(call.argumentsText);
    if (!target || target === call.announcedTarget) {
      return;
    }
    this.announce(key, call, input.callId ?? input.itemId);
  }

  private announce(key: string, call: ToolWriteCall, callId: string | undefined): void {
    const changed = !call.announced || call.name !== call.announcedName;
    const target = call.target.target;
    if (!changed && (!target || target === call.announcedTarget)) {
      return;
    }
    call.announced = true;
    call.announcedName = call.name;
    call.announcedTarget = target;
    const codexThreadId = this.codexThreadId();
    if (!codexThreadId) {
      return;
    }
    const turnId = readString(this.codexTurnMetadata?.turnId);
    observeToolWrite(
      this.observer as GatewayToolWriteObserver,
      {
        codexThreadId,
        kind: call.name ? classifyToolWriteKind(call.name) : "tool",
        observedAt: new Date().toISOString(),
        ...(call.name && { toolName: call.name }),
        ...(target && { target }),
        ...(turnId && { turnId }),
        ...(callId && { callId }),
      },
      this.onLog,
    );
  }

  private callFor(key: string): ToolWriteCall {
    const existing = this.calls.get(key);
    if (existing) {
      return existing;
    }
    const created: ToolWriteCall = {
      argumentsText: "",
      announced: false,
      announcedName: undefined,
      announcedTarget: undefined,
      target: new ToolWriteTargetTracker(""),
    };
    this.calls.set(key, created);
    return created;
  }

  /**
   * One call, one key — even though the stream names it three ways. `response.output_item.added`
   * carries the item id, the call id and the name; the argument deltas carry only the item id
   * (or, for a converted Anthropic stream, the call id). Keying on the item id first is what
   * makes the fragments land on the call the start announced.
   */
  private callKey(itemId: string | undefined, name: string | undefined): string {
    return itemId ?? name ?? "";
  }

  private codexThreadId(): string | undefined {
    return readString(this.codexTurnMetadata?.threadId);
  }
}

const PROVIDER_SIDE_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "web_search_call",
  "file_search_call",
  "computer_call",
  "code_interpreter_call",
]);

function isProviderSideToolItemType(type: string | undefined): boolean {
  return type !== undefined && PROVIDER_SIDE_TOOL_ITEM_TYPES.has(type);
}

/** The item's own id: the one field that is on both the item and its argument deltas. */
function readItemId(item: Record<string, unknown>): string | undefined {
  return readString(item.id) ?? readString(item.call_id);
}

function readEventItemId(event: ResponsesEvent): string | undefined {
  return readString(event.item_id) ?? readString(event.call_id);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Fire-and-forget: a failed observation must never disturb the proxied stream. */
function observeToolWrite(
  observer: GatewayToolWriteObserver,
  observation: GatewayToolWriteObservation,
  onLog: GatewayLogFn,
): void {
  try {
    void Promise.resolve(observer(observation)).catch((error) => {
      onLog(`tool write observer failed: ${formatError(error)}`);
    });
  } catch (error) {
    onLog(`tool write observer failed: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
