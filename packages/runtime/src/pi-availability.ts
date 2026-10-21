export interface PiCoreAvailability {
  available: boolean;
  version?: string;
  reason?: string;
}

/**
 * The PI release Eco is built against. Eco drives the official MCP extension and
 * the codemode sandbox, including 1.3's native cancellation and worker lifecycle.
 */
export const PI_MINIMUM_VERSION = "1.3.0";

/** Exports the driver calls directly; a missing one means a pre-1.0.3 install. */
const PI_REQUIRED_EXPORTS = ["createAgentSession", "createMcpExtension", "createCodemodeExtension"] as const;

let cached: PiCoreAvailability | undefined;

/** Reset in-process probe cache (tests only). */
export function resetPiCoreAvailabilityCache(): void {
  cached = undefined;
}

/**
 * Probe whether `@earendil-works/pi-coding-agent` can be loaded.
 * Failures are explicit — never silent-fallback to another Core.
 *
 * The probe checks the exports Eco actually calls, not just that the package
 * resolves. A stale install sitting earlier on the resolution path (an old
 * hoisted link shadowing the pinned one) loads fine and then breaks deep inside
 * session setup, so the missing export is reported here with the version that
 * was really loaded.
 */
export async function probePiCoreAvailability(): Promise<PiCoreAvailability> {
  if (cached) {
    return cached;
  }
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    const version =
      typeof (mod as { VERSION?: string }).VERSION === "string"
        ? (mod as { VERSION: string }).VERSION
        : undefined;
    const missing = PI_REQUIRED_EXPORTS.filter(
      (name) => typeof (mod as unknown as Record<string, unknown>)[name] !== "function",
    );
    if (missing.length > 0) {
      cached = {
        available: false,
        reason:
          `PI coding-agent ${version ?? "(unknown version)"} is missing ${missing.join(", ")}. ` +
          `Eco requires the official MCP and codemode extensions from PI ${PI_MINIMUM_VERSION}.`,
      };
      return cached;
    }
    cached = {
      available: true,
      ...(version && { version }),
    };
    return cached;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cached = {
      available: false,
      reason: `PI Harness 不可用：无法加载 @earendil-works/pi-coding-agent（${message}）。`,
    };
    return cached;
  }
}

export function isPiCoreAvailableSync(): boolean {
  return cached?.available === true;
}
