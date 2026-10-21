/**
 * Supabase Realtime private channel topic helpers.
 *
 * Topics (must stay aligned with supabase migrations):
 *   eco:user:{uuid}  — presence
 *   eco:bind:{uuid}  — RPC room for a device binding
 *   eco:vault:{uuid} — vault claim transfer room
 */

export const ECO_REALTIME_TOPIC_PREFIX = {
  user: "eco:user:",
  bind: "eco:bind:",
  vault: "eco:vault:",
} as const;

/** A mobile bind subscription asks its desktop to discover committed bindings. */
export const ECO_REALTIME_BINDINGS_CHANGED_EVENT = "eco.bindings.changed";
export const ECO_REALTIME_BINDING_READY_EVENT = "eco.binding.ready";

export type EcoRealtimeTopicKind = keyof typeof ECO_REALTIME_TOPIC_PREFIX;

export type EcoRealtimeTopic = `eco:user:${string}` | `eco:bind:${string}` | `eco:vault:${string}`;

/** Lowercase UUID as used by Postgres realtime topic helpers (`[0-9a-f-]{36}`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeEcoUuid(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

export function isEcoUuid(value: unknown): value is string {
  return typeof value === "string" && normalizeEcoUuid(value) !== null;
}

export function buildEcoUserTopic(userId: string): `eco:user:${string}` {
  const id = requireUuid(userId, "userId");
  return `${ECO_REALTIME_TOPIC_PREFIX.user}${id}`;
}

export function buildEcoBindTopic(bindingId: string): `eco:bind:${string}` {
  const id = requireUuid(bindingId, "bindingId");
  return `${ECO_REALTIME_TOPIC_PREFIX.bind}${id}`;
}

export function buildEcoVaultTopic(claimId: string): `eco:vault:${string}` {
  const id = requireUuid(claimId, "claimId");
  return `${ECO_REALTIME_TOPIC_PREFIX.vault}${id}`;
}

export function parseEcoUserTopic(topic: string): string | null {
  return parsePrefixedTopic(topic, ECO_REALTIME_TOPIC_PREFIX.user);
}

export function parseEcoBindTopic(topic: string): string | null {
  return parsePrefixedTopic(topic, ECO_REALTIME_TOPIC_PREFIX.bind);
}

export function parseEcoVaultTopic(topic: string): string | null {
  return parsePrefixedTopic(topic, ECO_REALTIME_TOPIC_PREFIX.vault);
}

export interface ParsedEcoRealtimeTopic {
  kind: EcoRealtimeTopicKind;
  id: string;
  topic: EcoRealtimeTopic;
}

export function parseEcoRealtimeTopic(topic: string): ParsedEcoRealtimeTopic | null {
  const userId = parseEcoUserTopic(topic);
  if (userId) {
    return { kind: "user", id: userId, topic: buildEcoUserTopic(userId) };
  }
  const bindingId = parseEcoBindTopic(topic);
  if (bindingId) {
    return { kind: "bind", id: bindingId, topic: buildEcoBindTopic(bindingId) };
  }
  const claimId = parseEcoVaultTopic(topic);
  if (claimId) {
    return { kind: "vault", id: claimId, topic: buildEcoVaultTopic(claimId) };
  }
  return null;
}

function parsePrefixedTopic(topic: string, prefix: string): string | null {
  if (typeof topic !== "string" || !topic.startsWith(prefix)) {
    return null;
  }
  return normalizeEcoUuid(topic.slice(prefix.length));
}

function requireUuid(value: string, label: string): string {
  const id = normalizeEcoUuid(value);
  if (!id) {
    throw new Error(`Invalid ${label}: expected UUID`);
  }
  return id;
}
