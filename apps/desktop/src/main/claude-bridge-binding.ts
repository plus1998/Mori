import { randomBytes } from "node:crypto";
import type { ParsedUsage } from "@eco/runtime";
import type { UpstreamApiCompat } from "../shared/api-compat";
import type { PromptImageAttachment, RuntimeAgentRole, ThinkingEffort } from "../shared/ipc";
import type { ProviderConfigSecret } from "./provider-store";

export const ECO_BRIDGE_BINDING_ID_HEADER = "x-eco-bridge-binding-id";
export const ECO_BRIDGE_RUN_ATTEMPT_ID_HEADER = "x-eco-run-attempt-id";

/** Legacy shared key — must not resolve Claude bindings. */
export const LOCAL_PROXY_API_KEY = "eco-local-model-router";

export type ClaudeBridgeBindingState = "active" | "closing";

export interface ClaudeBridgeBindingRoute {
  role: RuntimeAgentRole;
  provider: ProviderConfigSecret;
  modelId: string;
  aliasModelId: string;
  apiCompat: UpstreamApiCompat;
  thinkingEffort?: ThinkingEffort;
  maxOutputTokens?: number;
  contextTokens?: number;
  supportsImageInput?: boolean;
}

export interface ClaudeBridgeBindingUsageInfo {
  role: RuntimeAgentRole;
  providerId: string;
  providerName: string;
  providerBaseUrl: string;
  modelId: string;
  apiCompat: UpstreamApiCompat;
  requestedModel?: string;
  aliasModelId?: string;
  requestId?: string;
  usage: ParsedUsage;
}

export interface ClaudeBridgeMessagesRequestResult {
  logicalRequestId?: string;
}

export type ClaudeBridgeMessagesRequestCallback = (info: {
  role: RuntimeAgentRole;
  modelId: string;
  /** Incoming HTTP headers — used for explicit request-scoped billing stamps (e.g. vision). */
  requestHeaders?: Headers;
}) => ClaudeBridgeMessagesRequestResult | void;

export function readClaudeBridgeMessagesRequestLogicalId(
  result: ClaudeBridgeMessagesRequestResult | void,
): string | undefined {
  if (!result) {
    return undefined;
  }
  const trimmed = result.logicalRequestId?.trim();
  return trimmed ? trimmed : undefined;
}

export interface ClaudeBridgeBindingCallbacks {
  onMessagesRequest?: ClaudeBridgeMessagesRequestCallback;
  onUsage?: (info: ClaudeBridgeBindingUsageInfo) => void | Promise<unknown>;
  resolveCountTokensInput?: (input: {
    role: RuntimeAgentRole;
    body: Record<string, unknown>;
  }) => number | undefined;
}

export interface ClaudeBridgeBinding {
  bindingId: string;
  credential: string;
  threadId: string;
  runAttemptId?: string;
  routes: ClaudeBridgeBindingRoute[];
  pendingImages: PromptImageAttachment[];
  imagesInjected: boolean;
  state: ClaudeBridgeBindingState;
  callbacks: ClaudeBridgeBindingCallbacks;
  /** In-flight Messages / models / count_tokens requests held by this binding. */
  inFlight: number;
  /** Outstanding usage/callback promises while closing. */
  pendingSettles: Set<Promise<unknown>>;
  /** Upstream provider request ids adopted per logical request for this binding. */
  adoptedUpstreamRequestIdsByLogical: Map<string, Set<string>>;
}

export interface CreateClaudeBridgeBindingInput {
  threadId?: string;
  runAttemptId?: string;
  routes: ClaudeBridgeBindingRoute[];
  pendingImages?: PromptImageAttachment[];
  callbacks?: ClaudeBridgeBindingCallbacks;
}

export interface ClaudeBridgeRequestMeta {
  bridgeBindingId: string;
  threadId: string;
  runAttemptId?: string;
  role?: RuntimeAgentRole;
}

/**
 * Credential → binding map. Concurrent Claude runs must never share a session.
 */
export class ClaudeBridgeBindingRegistry {
  private readonly byCredential = new Map<string, ClaudeBridgeBinding>();
  private readonly byBindingId = new Map<string, ClaudeBridgeBinding>();

  create(input: CreateClaudeBridgeBindingInput): ClaudeBridgeBinding {
    const credential = generateClaudeBridgeCredential();
    const bindingId = `cbb_${randomBytes(12).toString("hex")}`;
    const threadId = input.threadId?.trim() || "";
    const binding: ClaudeBridgeBinding = {
      bindingId,
      credential,
      threadId,
      ...(input.runAttemptId?.trim() ? { runAttemptId: input.runAttemptId.trim() } : {}),
      routes: input.routes,
      pendingImages: input.pendingImages ? [...input.pendingImages] : [],
      imagesInjected: false,
      state: "active",
      callbacks: { ...(input.callbacks ?? {}) },
      inFlight: 0,
      pendingSettles: new Set(),
      adoptedUpstreamRequestIdsByLogical: new Map(),
    };
    this.byCredential.set(credential, binding);
    this.byBindingId.set(bindingId, binding);
    return binding;
  }

  getByCredential(credential: string | undefined): ClaudeBridgeBinding | undefined {
    const key = credential?.trim();
    if (!key || key === LOCAL_PROXY_API_KEY) {
      return undefined;
    }
    return this.byCredential.get(key);
  }

  getByBindingId(bindingId: string | undefined): ClaudeBridgeBinding | undefined {
    const key = bindingId?.trim();
    if (!key) {
      return undefined;
    }
    return this.byBindingId.get(key);
  }

  /**
   * Accept requests only while active. Closing bindings reject new work.
   */
  acquire(binding: ClaudeBridgeBinding): boolean {
    if (binding.state !== "active") {
      return false;
    }
    binding.inFlight += 1;
    return true;
  }

  release(binding: ClaudeBridgeBinding): void {
    if (binding.inFlight > 0) {
      binding.inFlight -= 1;
    }
  }

  trackSettle(binding: ClaudeBridgeBinding, work: Promise<unknown>): void {
    binding.pendingSettles.add(work);
    void work
      .finally(() => {
        binding.pendingSettles.delete(work);
      })
      .catch(() => {
        // Swallow rejections from the finally-derived promise so async onUsage
        // failures cannot surface as unhandledRejection in Electron main.
      });
  }

  /**
   * Synchronously reserve a settle slot before any await (e.g. dynamic import).
   * Prevents close() from deleting the binding while usage attribution is still in-flight.
   */
  reserveUsageSettle(bindingId: string | undefined): (() => void) | undefined {
    const binding = this.getByBindingId(bindingId);
    if (!binding) {
      return undefined;
    }
    let settled = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.trackSettle(binding, gate);
    return () => {
      if (settled) {
        return;
      }
      settled = true;
      releaseGate();
    };
  }

  /**
   * Idempotent close: active → closing, refuse new requests, wait for leases + settles, delete.
   * Always removes registry entries in `finally` so a rejecting usage observer cannot leak
   * the binding in `closing` with a live credential.
   */
  async close(bindingId: string): Promise<void> {
    const binding = this.byBindingId.get(bindingId);
    if (!binding) {
      return;
    }
    if (binding.state === "active") {
      binding.state = "closing";
    }
    try {
      await waitForBindingIdle(binding);
      // One more turn of the event loop so fire-and-forget observers that just started
      // can still call reserveUsageSettle / trackSettle before we drop the binding.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await waitForBindingIdle(binding);
    } finally {
      this.byCredential.delete(binding.credential);
      this.byBindingId.delete(binding.bindingId);
    }
  }

  /** Test / diagnostics — never log raw credentials. */
  size(): number {
    return this.byBindingId.size;
  }

  clearAllForTests(): void {
    this.byCredential.clear();
    this.byBindingId.clear();
  }

  listBindingsForTests(): ClaudeBridgeBinding[] {
    return [...this.byBindingId.values()];
  }
}

export const globalClaudeBridgeBindingRegistry = new ClaudeBridgeBindingRegistry();

export function generateClaudeBridgeCredential(): string {
  // 256-bit random key; Anthropic SDK sends via ANTHROPIC_API_KEY / x-api-key.
  return `eco_cbb_${randomBytes(32).toString("hex")}`;
}

export function extractClaudeBridgeCredential(headers: Headers): string | undefined {
  const xApiKey = headers.get("x-api-key")?.trim();
  if (xApiKey) {
    return xApiKey;
  }
  const authorization = headers.get("authorization")?.trim();
  if (!authorization) {
    return undefined;
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  return bearer?.[1]?.trim() || undefined;
}

export function redactClaudeBridgeSecret(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "(none)";
  }
  if (trimmed.length <= 10) {
    return "***";
  }
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

export function unauthorizedClaudeBridgeResponse(message: string): Response {
  return Response.json(
    {
      type: "error",
      error: {
        type: "authentication_error",
        message,
      },
    },
    { status: 401 },
  );
}

async function waitForBindingIdle(binding: ClaudeBridgeBinding): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (binding.inFlight === 0 && binding.pendingSettles.size === 0) {
      return;
    }
    // Absorb observer rejections — racing the raw Promise would throw out of close()
    // before registry deletion and leave the binding stuck in `closing`.
    const settledPending = [...binding.pendingSettles].map((work) =>
      Promise.resolve(work).then(
        () => undefined,
        () => undefined,
      ),
    );
    await Promise.race([...settledPending, new Promise<void>((resolve) => setTimeout(resolve, 10))]);
  }
  // Force-drop remaining leases so close stays idempotent under hung observers.
  binding.inFlight = 0;
  binding.pendingSettles.clear();
}
