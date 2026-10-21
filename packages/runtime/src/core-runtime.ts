export const CORE_KINDS = ["claude", "codex", "pi", "acp"] as const;

export type CoreKind = (typeof CORE_KINDS)[number];
/** ACP agent identity under coreKind `"acp"` (MVP: Cursor via `agent acp`). */
export type AcpAgentId = "cursor";
export type CoreSessionMode = "agent" | "plan" | "ask";
export type CoreCapabilitySupport = "native" | "eco" | "unsupported";

export interface CoreDescriptor {
  kind: CoreKind;
  displayName: string;
  version: string;
}

export interface CoreCapabilities {
  sessionModes: readonly CoreSessionMode[];
  compact: CoreCapabilitySupport;
  rewindFiles: CoreCapabilitySupport;
  toolApproval: CoreCapabilitySupport;
  planApproval: CoreCapabilitySupport;
  mcp: CoreCapabilitySupport;
  skills: CoreCapabilitySupport;
  subagents: CoreCapabilitySupport;
}

export const PI_CORE_CAPABILITIES = {
  sessionModes: ["agent", "plan", "ask"],
  compact: "native",
  rewindFiles: "unsupported",
  toolApproval: "eco",
  planApproval: "eco",
  mcp: "eco",
  skills: "eco",
  subagents: "eco",
} as const satisfies CoreCapabilities;

/**
 * ACP host capabilities (Cursor adapter).
 * Plan/Ask are native Cursor modes; plan approval is Eco UI over cursor/create_plan.
 * toolApproval remains unsupported until permission cards are wired (MVP auto-allows).
 */
export const ACP_CORE_CAPABILITIES = {
  sessionModes: ["agent", "plan", "ask"],
  compact: "unsupported",
  rewindFiles: "unsupported",
  toolApproval: "unsupported",
  planApproval: "eco",
  mcp: "unsupported",
  skills: "unsupported",
  subagents: "unsupported",
} as const satisfies CoreCapabilities;

export interface CoreProbeResult {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface CoreAdapter {
  readonly descriptor: CoreDescriptor;
  probe(): Promise<CoreProbeResult>;
  getCapabilities(): Promise<CoreCapabilities>;
}

export function isCoreKind(value: unknown): value is CoreKind {
  return typeof value === "string" && (CORE_KINDS as readonly string[]).includes(value);
}

export class CoreRegistry {
  private readonly adapters = new Map<CoreKind, CoreAdapter>();

  register(adapter: CoreAdapter): void {
    const kind = adapter.descriptor.kind;
    if (this.adapters.has(kind)) {
      throw new Error(`Harness adapter is already registered: ${kind}`);
    }
    this.adapters.set(kind, adapter);
  }

  has(kind: CoreKind): boolean {
    return this.adapters.has(kind);
  }

  get(kind: CoreKind): CoreAdapter | undefined {
    return this.adapters.get(kind);
  }

  require(kind: CoreKind): CoreAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new Error(`Harness adapter is not registered: ${kind}`);
    }
    return adapter;
  }

  list(): readonly CoreAdapter[] {
    return CORE_KINDS.flatMap((kind) => {
      const adapter = this.adapters.get(kind);
      return adapter ? [adapter] : [];
    });
  }
}
