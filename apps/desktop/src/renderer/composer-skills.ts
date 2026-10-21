import { COMPOSER_REFERENCE_PATTERN, parseComposerReference, type ComposerReference } from "../shared/composer-references";
import {
  parseExplicitSkillNames,
  promptIncludesSkillName,
  SKILL_NAME_TOKEN,
  type SkillInfo,
} from "../shared/skills";
import { filterUserSkills, type SkillFuzzyMatch } from "./skill-fuzzy";
import {
  FILE_ATTACHMENT_TOKEN_PATTERN,
  fileAttachmentToken,
  parseFileAttachmentPath,
} from "./workspace-file-reference";

export { parseExplicitSkillNames, promptIncludesSkillName, fileAttachmentToken };

export type PromptSegment =
  | { type: "text"; value: string }
  | { type: "skill"; name: string }
  | { type: "file"; path: string }
  | { type: "reference"; reference: ComposerReference };

export type SlashQuery = { start: number; query: string };

export function skillToken(name: string): string {
  return `$${name}`;
}

/** Display label for kebab-case skill ids (Codex-style: vue-router → Vue Router). */
export function formatSkillDisplayName(tokenName: string, skill?: SkillInfo): string {
  const raw = skill?.name ?? tokenName;
  if (!/[-_]/.test(raw)) {
    return raw;
  }
  return raw
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function buildSkillMap(skills: readonly SkillInfo[]): Map<string, SkillInfo> {
  return new Map(skills.map((skill) => [skill.name, skill]));
}

export function parsePromptSegments(text: string): PromptSegment[] {
  if (!text) {
    return [];
  }
  type Hit = { index: number; length: number; segment: Exclude<PromptSegment, { type: "text" }> };
  const hits: Hit[] = [];
  for (const match of text.matchAll(SKILL_NAME_TOKEN)) {
    if (match.index === undefined) {
      continue;
    }
    hits.push({
      index: match.index,
      length: match[0].length,
      segment: { type: "skill", name: match[1]! },
    });
  }
  for (const match of text.matchAll(FILE_ATTACHMENT_TOKEN_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    const path = parseFileAttachmentPath(match[1] ?? "");
    if (!path) {
      continue;
    }
    hits.push({
      index: match.index,
      length: match[0].length,
      segment: { type: "file", path },
    });
  }
  for (const match of text.matchAll(COMPOSER_REFERENCE_PATTERN)) {
    const reference = parseComposerReference(match[1]!, match[2]!);
    if (reference && match.index !== undefined) hits.push({ index: match.index, length: match[0].length, segment: { type: "reference", reference } });
  }
  hits.sort((left, right) => left.index - right.index || left.length - right.length);

  const segments: PromptSegment[] = [];
  let lastIndex = 0;
  for (const hit of hits) {
    if (hit.index < lastIndex) {
      continue;
    }
    if (hit.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, hit.index) });
    }
    segments.push(hit.segment);
    lastIndex = hit.index + hit.length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }
  return segments;
}

export function promptHasSkillTokens(text: string): boolean {
  return parseExplicitSkillNames(text).length > 0;
}

export function parseSlashQuery(text: string, cursor: number): SlashQuery | null {
  const clamped = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, clamped);
  const match = before.match(/(?:^|\s)(\/[^\s/]*)$/);
  if (!match?.[1]) {
    return null;
  }
  const token = match[1];
  return { start: before.length - token.length, query: token.slice(1) };
}

export function applySlashSkillSelection(
  text: string,
  selection: { start: number; end: number },
  skillName: string,
): { next: string; cursor: number } {
  const replacement = `${skillToken(skillName)} `;
  const next = `${text.slice(0, selection.start)}${replacement}${text.slice(selection.end)}`;
  return { next, cursor: selection.start + replacement.length };
}

export function filterSkillsForSlash(
  query: string,
  skills: readonly SkillInfo[],
  referenced: ReadonlySet<string>,
): SkillFuzzyMatch[] {
  const available = skills.filter((skill) => !referenced.has(skill.name));
  return filterUserSkills(query, available);
}
