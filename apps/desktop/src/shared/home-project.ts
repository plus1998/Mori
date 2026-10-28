export const HOME_PROJECT_DISPLAY_NAME = "Home";

export const HOME_PROJECT_IMPORTED_AT = "1970-01-01T00:00:00.000Z";

export function normalizeProjectPath(projectPath: string): string {
  return projectPath.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

/** Derive the default project name from the last path segment. */
export function pathToName(projectPath: string): string {
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

export interface ResolvedProjectName {
  /** The user-facing display name. */
  name: string;
  /** True when the user explicitly renamed this project. */
  custom: boolean;
}

/**
 * Resolve the display name for a project path.
 * Home projects keep their fixed display name; otherwise the custom name set by
 * the user wins, falling back to the last path segment.
 */
export function resolveProjectName(
  path: string,
  customName: string | undefined,
  homeProjectPath: string | undefined,
): ResolvedProjectName {
  if (homeProjectPath && isHomeProjectPath(path, homeProjectPath)) {
    return { name: HOME_PROJECT_DISPLAY_NAME, custom: false };
  }
  const trimmed = customName?.trim();
  if (trimmed) {
    return { name: trimmed, custom: true };
  }
  return { name: pathToName(path), custom: false };
}

export function isCustomProjectName(name: string | undefined, path: string): boolean {
  const trimmed = name?.trim();
  // Older versions persisted the slash-only basename, which could be an entire
  // Windows path. Do not mistake that generated name for a user rename.
  const legacyName = path.split("/").filter(Boolean).at(-1) ?? path;
  return Boolean(trimmed) && trimmed !== pathToName(path) && trimmed !== legacyName;
}

export function buildHomeProjectPath(homedir: string): string {
  const trimmed = normalizeProjectPath(homedir);
  return `${trimmed}/.eco/projects/home`;
}

export function isHomeProjectPath(projectPath: string, homeProjectPath: string): boolean {
  return normalizeProjectPath(projectPath) === normalizeProjectPath(homeProjectPath);
}
