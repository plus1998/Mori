import type { CoreKind } from "@eco/runtime";
import type { ThreadSummary } from "../shared/ipc";

export function requireThreadCore(
  thread: Pick<ThreadSummary, "id" | "coreKind">,
  expectedCore: CoreKind,
  operation: string,
): void {
  if (!thread.coreKind) {
    throw new Error(
      `CORE_MIGRATION_UNKNOWN: Thread ${thread.id} has no reliable Harness ownership; cannot ${operation}.`,
    );
  }
  if (thread.coreKind !== expectedCore) {
    throw new Error(
      `CORE_ROUTE_MISMATCH: Thread ${thread.id} belongs to ${thread.coreKind}, not ${expectedCore}; cannot ${operation}.`,
    );
  }
}
