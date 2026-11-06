import { AGENT_ROLES, type RuntimeRoleRouteConfig } from "./ipc";

/** Stable fingerprint for comparing route profiles across provider switches. */
export function computeRouteFingerprint(routes: readonly RuntimeRoleRouteConfig[]): string {
  const byRole = new Map(routes.map((route) => [route.role, route]));
  return orderedRuntimeRouteRoles(routes)
    .map((role) => {
      const route = byRole.get(role);
      if (!route) {
        return `${role}:`;
      }
      const compat = route.apiCompat ?? "";
      const thinkingEffort = route.thinkingEffort ?? "";
      return `${role}:${route.providerId}:${route.modelId.trim()}:${compat}:${thinkingEffort}${route.accountId ? `:account=${encodeURIComponent(route.accountId)}` : ""}`;
    })
    .join("|");
}

export function routesMatchFingerprint(
  routes: readonly RuntimeRoleRouteConfig[],
  fingerprint: string | undefined | null,
): boolean {
  if (!fingerprint) {
    return false;
  }
  return computeRouteFingerprint(routes) === fingerprint;
}

function orderedRuntimeRouteRoles(routes: readonly RuntimeRoleRouteConfig[]): string[] {
  const fixed = AGENT_ROLES.filter((role) => routes.some((route) => route.role === role));
  const fixedSet = new Set<string>(AGENT_ROLES);
  const dynamic = [...new Set(routes.map((route) => route.role).filter((role) => !fixedSet.has(role)))].sort(
    (left, right) => left.localeCompare(right),
  );
  return [...fixed, ...dynamic];
}
