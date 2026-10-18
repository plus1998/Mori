import { pinyin } from "pinyin-pro";
import { hasChineseCharacters, normalizePinyinSearchToken } from "./project-pinyin-search";

/**
 * Derive the pinyin spellings kept with a project, so the project "会话存档" is
 * found by "huihua" (or "huihuacundang" and the abbreviation "hhcd").
 *
 * Tones and separators are dropped and latin parts are kept as they are. The
 * returned list is empty for names without Chinese characters.
 *
 * This module pulls in the pinyin dictionary, so import it dynamically
 * (see loadProjectPinyin) instead of from the renderer entry graph.
 */
export function buildProjectSearchTerms(name: string): string[] {
  const trimmed = name.trim();
  if (!hasChineseCharacters(trimmed)) {
    return [];
  }
  const syllables = pinyin(trimmed, { toneType: "none", nonZh: "consecutive", type: "array" })
    .map((token) => normalizePinyinSearchToken(token))
    .filter(Boolean);
  if (syllables.length === 0) {
    return [];
  }
  const terms = [
    normalizePinyinSearchToken(syllables.join("")),
    normalizePinyinSearchToken(syllables.map((token) => token[0] ?? "").join("")),
  ];
  return [...new Set(terms.filter((term) => term.length >= 2))];
}
