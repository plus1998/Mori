import { normalizeProjectPath } from "../shared/home-project";

export const PROJECT_DRAG_MIME = "application/x-eco-project-path";

export interface OrderedProject {
  path: string;
  importedAt: string;
}

export type ProjectReorderPosition = "before" | "after";

export function buildInitialProjectOrder(projects: readonly OrderedProject[]): string[] {
  return [...projects]
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    .map((project) => project.path);
}

export function sortProjectsByOrder<T extends OrderedProject>(
  projects: readonly T[],
  orderPaths: readonly string[],
): T[] {
  const byPath = new Map(projects.map((project) => [project.path, project]));
  const ordered: T[] = [];
  const seen = new Set<string>();

  for (const path of orderPaths) {
    const project = byPath.get(path);
    if (!project || seen.has(path)) {
      continue;
    }
    ordered.push(project);
    seen.add(path);
  }

  const remaining = projects
    .filter((project) => !seen.has(project.path))
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt));

  return [...ordered, ...remaining];
}

export function ensureHomeProjectFirst<T extends OrderedProject>(
  projects: readonly T[],
  homeProjectPath: string | undefined,
): T[] {
  if (!homeProjectPath) {
    return [...projects];
  }
  const normalizedHomeProjectPath = normalizeProjectPath(homeProjectPath);
  const homeIndex = projects.findIndex(
    (project) => normalizeProjectPath(project.path) === normalizedHomeProjectPath,
  );
  if (homeIndex <= 0) {
    return [...projects];
  }
  const next = [...projects];
  const [homeProject] = next.splice(homeIndex, 1);
  if (!homeProject) {
    return [...projects];
  }
  return [homeProject, ...next];
}

export function prependProjectOrder(orderPaths: readonly string[], path: string): string[] {
  const next = orderPaths.filter((item) => item !== path);
  return [path, ...next];
}

export interface SidebarThread {
  id: string;
  createdAt: string;
  updatedAt?: string;
}

export function sortThreadsForSidebar<T extends SidebarThread>(
  threads: readonly T[],
  pinnedThreadIds: ReadonlySet<string>,
): T[] {
  return [...threads].sort((a, b) => {
    const aPinned = pinnedThreadIds.has(a.id);
    const bPinned = pinnedThreadIds.has(b.id);
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }
    const aTime = a.updatedAt ?? a.createdAt;
    const bTime = b.updatedAt ?? b.createdAt;
    return bTime.localeCompare(aTime);
  });
}

export function reorderProjectPaths(
  orderPaths: readonly string[],
  draggedPath: string,
  targetPath: string,
  position: ProjectReorderPosition,
): string[] {
  if (draggedPath === targetPath) {
    return [...orderPaths];
  }

  const withoutDragged = orderPaths.filter((path) => path !== draggedPath);
  const targetIndex = withoutDragged.indexOf(targetPath);
  if (targetIndex < 0) {
    return [...orderPaths];
  }

  const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
  return [...withoutDragged.slice(0, insertIndex), draggedPath, ...withoutDragged.slice(insertIndex)];
}
