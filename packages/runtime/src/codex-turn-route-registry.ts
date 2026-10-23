import type { CodexGatewayApiCompat } from "../../shared/src";

export interface CodexTurnRouteIdentity {
  /** Exact model alias sent to Codex and then to eco-gateway. */
  aliasModelId: string;
  providerId: string;
  upstreamModelId: string;
  apiCompat?: CodexGatewayApiCompat;
}

export interface CodexTurnTokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexTurnTokenUsageSnapshot {
  last: CodexTurnTokenUsageBreakdown;
  total: CodexTurnTokenUsageBreakdown;
}

export interface CodexTurnRouteRecord extends CodexTurnRouteIdentity {
  codexThreadId: string;
  turnId: string;
  /** Sum of unique model-response deltas observed for this turn. */
  appServerTokenUsage?: CodexTurnTokenUsageBreakdown;
  /** Individual requests, present only when every observed delta matches `last`. */
  appServerTokenUsageRequests?: CodexTurnTokenUsageBreakdown[];
}

export interface CodexTurnRoutePendingOwner {
  readonly codexThreadId: string;
  readonly generation: number;
}

interface MutableTurnRecord extends CodexTurnRouteRecord {
  usageRequestsIncomplete?: boolean;
  lastObservedThreadTotal?: CodexTurnTokenUsageBreakdown;
  pendingOwnerGeneration?: number;
}

interface PendingTurnRoute extends CodexTurnRouteIdentity {
  ownerGeneration: number;
}

/**
 * Correlates app-server turn notifications with the exact route selected by Eco.
 *
 * Official `turn/completed` notifications contain neither model nor usage. Usage
 * arrives separately through `thread/tokenUsage/updated`; its `last` value is a
 * single model response, so changes in the cumulative `total` are aggregated and
 * duplicate notifications are ignored.
 */
export class CodexTurnRouteRegistry {
  private readonly turns = new Map<string, MutableTurnRecord>();
  private readonly pendingRoutes = new Map<string, PendingTurnRoute>();
  private readonly latestThreadTotals = new Map<string, CodexTurnTokenUsageBreakdown>();
  private nextPendingGeneration = 1;

  get size(): number {
    return this.turns.size + this.pendingRoutes.size;
  }

  registerPending(codexThreadId: string, route: CodexTurnRouteIdentity): CodexTurnRoutePendingOwner {
    const normalizedThreadId = normalizeId(codexThreadId, "codexThreadId");
    const normalizedRoute = normalizeRoute(route);
    if (this.pendingRoutes.has(normalizedThreadId)) {
      throw new Error(`Codex turn route already has a pending owner for ${normalizedThreadId}.`);
    }
    const generation = this.nextPendingGeneration++;
    this.pendingRoutes.set(normalizedThreadId, {
      ...normalizedRoute,
      ownerGeneration: generation,
    });
    return Object.freeze({ codexThreadId: normalizedThreadId, generation });
  }

  /** Bind only the pending generation owned by the `turn/start` caller. */
  bindPending(owner: CodexTurnRoutePendingOwner, turnId: string): CodexTurnRouteRecord {
    const normalizedOwner = normalizePendingOwner(owner);
    const normalizedTurnId = normalizeId(turnId, "turnId");
    const key = turnKey(normalizedOwner.codexThreadId, normalizedTurnId);
    const existing = this.turns.get(key);
    const pending = this.pendingRoutes.get(normalizedOwner.codexThreadId);
    if (!pending || pending.ownerGeneration !== normalizedOwner.generation) {
      if (existing?.pendingOwnerGeneration === normalizedOwner.generation) {
        return snapshot(existing);
      }
      throw new Error(
        `Codex turn route pending owner is no longer active for ${normalizedOwner.codexThreadId} generation ${normalizedOwner.generation}.`,
      );
    }
    if (existing) {
      this.pendingRoutes.delete(normalizedOwner.codexThreadId);
      assertSameRoute(existing, pending);
      existing.pendingOwnerGeneration = normalizedOwner.generation;
      return snapshot(existing);
    }
    this.pendingRoutes.delete(normalizedOwner.codexThreadId);
    return this.createTurnRecord(
      normalizedOwner.codexThreadId,
      normalizedTurnId,
      pending,
      normalizedOwner.generation,
    );
  }

  clearPending(owner: CodexTurnRoutePendingOwner): boolean {
    const normalizedOwner = normalizePendingOwner(owner);
    const pending = this.pendingRoutes.get(normalizedOwner.codexThreadId);
    if (!pending || pending.ownerGeneration !== normalizedOwner.generation) {
      return false;
    }
    return this.pendingRoutes.delete(normalizedOwner.codexThreadId);
  }

  register(codexThreadId: string, turnId: string, route: CodexTurnRouteIdentity): CodexTurnRouteRecord {
    const ids = normalizeIds(codexThreadId, turnId);
    const normalizedRoute = normalizeRoute(route);
    const key = turnKey(ids.codexThreadId, ids.turnId);
    const existing = this.turns.get(key);
    if (existing) {
      assertSameRoute(existing, normalizedRoute);
      return snapshot(existing);
    }

    return this.createTurnRecord(ids.codexThreadId, ids.turnId, normalizedRoute);
  }

  observeTokenUsage(
    codexThreadId: string,
    turnId: string,
    tokenUsage: CodexTurnTokenUsageSnapshot,
  ): CodexTurnRouteRecord | undefined {
    const ids = normalizeIds(codexThreadId, turnId);
    const last = normalizeBreakdown(tokenUsage.last, "last");
    const total = normalizeBreakdown(tokenUsage.total, "total");
    const key = turnKey(ids.codexThreadId, ids.turnId);
    const record = this.turns.get(key);

    if (record) {
      const contribution = resolveUsageContribution(record.lastObservedThreadTotal, total, last);
      if (contribution) {
        record.appServerTokenUsage = record.appServerTokenUsage
          ? addBreakdowns(record.appServerTokenUsage, contribution)
          : cloneBreakdown(contribution);
        if (!breakdownsEqual(contribution, last)) {
          record.usageRequestsIncomplete = true;
          delete record.appServerTokenUsageRequests;
        } else if (!record.usageRequestsIncomplete) {
          record.appServerTokenUsageRequests ??= [];
          record.appServerTokenUsageRequests.push(cloneBreakdown(contribution));
        }
      }
      record.lastObservedThreadTotal = cloneBreakdown(total);
    } else {
      // Resume sends the historical usage replay after its JSON-RPC response.
      // A new turn may already be registered by then, so seed any same-thread
      // record that has not observed its own usage yet.
      for (const candidate of this.turns.values()) {
        if (
          candidate.codexThreadId === ids.codexThreadId &&
          candidate.appServerTokenUsage === undefined &&
          candidate.lastObservedThreadTotal === undefined
        ) {
          candidate.lastObservedThreadTotal = cloneBreakdown(total);
        }
      }
    }

    // Keep a baseline even for replay/compaction notifications that do not have
    // an Eco route registration, so the next registered turn starts cleanly.
    this.latestThreadTotals.set(ids.codexThreadId, cloneBreakdown(total));
    return record ? snapshot(record) : undefined;
  }

  peek(codexThreadId: string, turnId: string): CodexTurnRouteRecord | undefined {
    const key = turnKey(normalizeId(codexThreadId, "codexThreadId"), normalizeId(turnId, "turnId"));
    const record = this.turns.get(key);
    return record ? snapshot(record) : undefined;
  }

  consume(codexThreadId: string, turnId: string): CodexTurnRouteRecord | undefined {
    const normalizedThreadId = normalizeId(codexThreadId, "codexThreadId");
    const normalizedTurnId = normalizeId(turnId, "turnId");
    const key = turnKey(normalizedThreadId, normalizedTurnId);
    const record = this.turns.get(key);
    if (!record) {
      return undefined;
    }
    this.turns.delete(key);
    return snapshot(record);
  }

  clearTurn(codexThreadId: string, turnId: string): boolean {
    return this.turns.delete(
      turnKey(normalizeId(codexThreadId, "codexThreadId"), normalizeId(turnId, "turnId")),
    );
  }

  clearThread(codexThreadId: string): number {
    const normalizedThreadId = normalizeId(codexThreadId, "codexThreadId");
    let cleared = 0;
    for (const [key, record] of this.turns) {
      if (record.codexThreadId === normalizedThreadId) {
        this.turns.delete(key);
        cleared += 1;
      }
    }
    if (this.pendingRoutes.delete(normalizedThreadId)) {
      cleared += 1;
    }
    this.latestThreadTotals.delete(normalizedThreadId);
    return cleared;
  }

  clearAll(): void {
    this.turns.clear();
    this.pendingRoutes.clear();
    this.latestThreadTotals.clear();
  }

  private createTurnRecord(
    codexThreadId: string,
    turnId: string,
    route: CodexTurnRouteIdentity,
    pendingOwnerGeneration?: number,
  ): CodexTurnRouteRecord {
    const latestThreadTotal = this.latestThreadTotals.get(codexThreadId);
    const record: MutableTurnRecord = {
      codexThreadId,
      turnId,
      ...normalizeRoute(route),
      ...(latestThreadTotal ? { lastObservedThreadTotal: cloneBreakdown(latestThreadTotal) } : {}),
      ...(pendingOwnerGeneration !== undefined && { pendingOwnerGeneration }),
    };
    this.turns.set(turnKey(codexThreadId, turnId), record);
    return snapshot(record);
  }
}

function resolveUsageContribution(
  previousTotal: CodexTurnTokenUsageBreakdown | undefined,
  total: CodexTurnTokenUsageBreakdown,
  last: CodexTurnTokenUsageBreakdown,
): CodexTurnTokenUsageBreakdown | undefined {
  if (!previousTotal) {
    return hasUsage(last) ? last : undefined;
  }
  if (breakdownsEqual(previousTotal, total)) {
    return undefined;
  }
  if (breakdownIsMonotonic(previousTotal, total)) {
    const delta = subtractBreakdowns(total, previousTotal);
    return hasUsage(delta) ? delta : undefined;
  }
  // Codex can reset totals after compaction/replay. `last` remains the only
  // trustworthy response-local measurement across that boundary.
  return hasUsage(last) ? last : undefined;
}

function addBreakdowns(
  left: CodexTurnTokenUsageBreakdown,
  right: CodexTurnTokenUsageBreakdown,
): CodexTurnTokenUsageBreakdown {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function subtractBreakdowns(
  current: CodexTurnTokenUsageBreakdown,
  previous: CodexTurnTokenUsageBreakdown,
): CodexTurnTokenUsageBreakdown {
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
    totalTokens: current.totalTokens - previous.totalTokens,
  };
}

function breakdownIsMonotonic(
  previous: CodexTurnTokenUsageBreakdown,
  current: CodexTurnTokenUsageBreakdown,
): boolean {
  return (
    current.inputTokens >= previous.inputTokens &&
    current.cachedInputTokens >= previous.cachedInputTokens &&
    current.outputTokens >= previous.outputTokens &&
    current.reasoningOutputTokens >= previous.reasoningOutputTokens &&
    current.totalTokens >= previous.totalTokens
  );
}

function breakdownsEqual(left: CodexTurnTokenUsageBreakdown, right: CodexTurnTokenUsageBreakdown): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens &&
    left.totalTokens === right.totalTokens
  );
}

function hasUsage(usage: CodexTurnTokenUsageBreakdown): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.cachedInputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningOutputTokens > 0 ||
    usage.totalTokens > 0
  );
}

function normalizeIds(codexThreadId: string, turnId: string): { codexThreadId: string; turnId: string } {
  return {
    codexThreadId: normalizeId(codexThreadId, "codexThreadId"),
    turnId: normalizeId(turnId, "turnId"),
  };
}

function normalizePendingOwner(owner: CodexTurnRoutePendingOwner): CodexTurnRoutePendingOwner {
  const codexThreadId = normalizeId(owner.codexThreadId, "codexThreadId");
  if (!Number.isSafeInteger(owner.generation) || owner.generation <= 0) {
    throw new Error("Codex turn route pending owner generation must be a positive safe integer.");
  }
  return { codexThreadId, generation: owner.generation };
}

function normalizeId(value: string, field: "codexThreadId" | "turnId"): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Codex turn route ${field} is required.`);
  }
  return normalized;
}

function normalizeRoute(route: CodexTurnRouteIdentity): CodexTurnRouteIdentity {
  const aliasModelId = route.aliasModelId.trim();
  const providerId = route.providerId.trim();
  const upstreamModelId = route.upstreamModelId.trim();
  if (!aliasModelId || !providerId || !upstreamModelId) {
    throw new Error("Codex turn route aliasModelId, providerId, and upstreamModelId are required.");
  }
  return {
    aliasModelId,
    providerId,
    upstreamModelId,
    ...(route.apiCompat && { apiCompat: route.apiCompat }),
  };
}

function normalizeBreakdown(
  usage: CodexTurnTokenUsageBreakdown,
  field: "last" | "total",
): CodexTurnTokenUsageBreakdown {
  const normalized = cloneBreakdown(usage);
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Codex tokenUsage.${field}.${name} must be a non-negative safe integer.`);
    }
  }
  return normalized;
}

function assertSameRoute(existing: CodexTurnRouteIdentity, incoming: CodexTurnRouteIdentity): void {
  if (
    existing.aliasModelId !== incoming.aliasModelId ||
    existing.providerId !== incoming.providerId ||
    existing.upstreamModelId !== incoming.upstreamModelId ||
    existing.apiCompat !== incoming.apiCompat
  ) {
    throw new Error(
      `Codex turn route registration conflict for ${existing.aliasModelId} and ${incoming.aliasModelId}.`,
    );
  }
}

function snapshot(record: MutableTurnRecord): CodexTurnRouteRecord {
  return {
    codexThreadId: record.codexThreadId,
    turnId: record.turnId,
    aliasModelId: record.aliasModelId,
    providerId: record.providerId,
    upstreamModelId: record.upstreamModelId,
    ...(record.apiCompat && { apiCompat: record.apiCompat }),
    ...(record.appServerTokenUsage && {
      appServerTokenUsage: cloneBreakdown(record.appServerTokenUsage),
    }),
    ...(record.appServerTokenUsageRequests && {
      appServerTokenUsageRequests: record.appServerTokenUsageRequests.map(cloneBreakdown),
    }),
  };
}

function cloneBreakdown(usage: CodexTurnTokenUsageBreakdown): CodexTurnTokenUsageBreakdown {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
  };
}

function turnKey(codexThreadId: string, turnId: string): string {
  return `${codexThreadId}\u0000${turnId}`;
}
