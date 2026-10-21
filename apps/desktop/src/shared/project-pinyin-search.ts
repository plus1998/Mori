/**
 * Pinyin spellings are stored next to each project so that a Chinese project
 * such as "会话存档" is found by typing "huihua". The dictionary-backed
 * generator lives in ./project-pinyin (loaded on demand); everything here is
 * plain string work that runs in the search hot path.
 */

/**
 * CJK ideographs (Unified + Extension A + Compatibility). Kana and Hangul are
 * intentionally excluded: only Chinese project names get a pinyin spelling.
 */
const CHINESE_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * One-letter queries would match the pinyin abbreviation of almost every
 * Chinese project ("h" matches "hhcd"), so pinyin matching needs at least two
 * letters. A single Chinese character still matches through the raw name.
 */
export const MIN_PINYIN_QUERY_LENGTH = 2;

export interface ProjectSearchTermEntry {
  /** Display name the spellings were generated from; a new name regenerates them. */
  name: string;
  /** Full spelling plus the per-character abbreviation, e.g. ["huihuacundang", "hhcd"]. */
  terms: string[];
}

export type ProjectSearchTermIndex = Record<string, ProjectSearchTermEntry>;

export function hasChineseCharacters(value: string): boolean {
  return CHINESE_PATTERN.test(value);
}

/**
 * Lowercase the value and drop separators and spaces, so the query "hui hua"
 * and the stored term "huihuacundang" compare on the same footing.
 */
export function normalizePinyinSearchToken(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** True when any stored pinyin spelling contains the query. */
export function matchesProjectSearchTerms(
  searchTerms: readonly string[] | undefined,
  query: string,
): boolean {
  if (!searchTerms || searchTerms.length === 0) {
    return false;
  }
  const normalizedQuery = normalizePinyinSearchToken(query);
  if (normalizedQuery.length < MIN_PINYIN_QUERY_LENGTH) {
    return false;
  }
  return searchTerms.some((term) => normalizePinyinSearchToken(term).includes(normalizedQuery));
}

export interface ProjectSearchTermPlan {
  /** Entries that still describe their project's current name. */
  kept: ProjectSearchTermIndex;
  /** Chinese-named projects whose spelling is missing or generated from an older name. */
  pending: { path: string; name: string }[];
}

/** Split the stored index into entries to keep and projects to (re)generate. */
export function planProjectSearchTermIndex(
  projects: readonly { path: string; name: string }[],
  stored: Readonly<Record<string, ProjectSearchTermEntry>>,
): ProjectSearchTermPlan {
  const kept: ProjectSearchTermIndex = {};
  const pending: { path: string; name: string }[] = [];
  for (const project of projects) {
    if (!hasChineseCharacters(project.name)) {
      continue;
    }
    const entry = stored[project.path];
    if (entry && entry.name === project.name) {
      kept[project.path] = entry;
      continue;
    }
    pending.push({ path: project.path, name: project.name });
  }
  return { kept, pending };
}

/** True when the plan changed the stored index (new, regenerated or dropped entries). */
export function projectSearchTermPlanChanged(
  plan: ProjectSearchTermPlan,
  stored: Readonly<Record<string, ProjectSearchTermEntry>>,
): boolean {
  return plan.pending.length > 0 || Object.keys(plan.kept).length !== Object.keys(stored).length;
}

let projectPinyinModule: Promise<typeof import("./project-pinyin")> | undefined;

/** Load the pinyin dictionary only when a spelling actually has to be generated. */
export function loadProjectPinyin(): Promise<typeof import("./project-pinyin")> {
  projectPinyinModule ??= import("./project-pinyin");
  return projectPinyinModule;
}
