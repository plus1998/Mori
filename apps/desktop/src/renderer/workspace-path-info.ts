import type { WorkspacePathInfo } from "../shared/ipc";

export interface WorkspacePathInspector {
  inspectWorkspacePath(request: { path: string }): Promise<WorkspacePathInfo>;
}

// A path can appear in several mounted messages. Share only concurrent probes:
// later mounts and every open must see file-system changes, not a cached guess.
const pendingByApi = new WeakMap<WorkspacePathInspector, Map<string, Promise<WorkspacePathInfo>>>();

export function probeWorkspacePath(path: string, api: WorkspacePathInspector): Promise<WorkspacePathInfo> {
  let pending = pendingByApi.get(api);
  if (!pending) {
    pending = new Map();
    pendingByApi.set(api, pending);
  }
  const existing = pending.get(path);
  if (existing) return existing;
  const request = api.inspectWorkspacePath({ path }).finally(() => pending.delete(path));
  pending.set(path, request);
  return request;
}
