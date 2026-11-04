/**
 * Codex-style two-region split for streaming markdown:
 * - stable: completed top-level blocks (safe to fully render)
 * - tail: mutable remainder
 *
 * Incomplete fences / search-replace stay plain in the tail. Tables remain
 * mutable but are live-rendered: the parser handles partial rows, and keeping
 * the table mounted avoids switching between pipe text and table DOM per row.
 *
 * Incomplete prose (paragraphs, lists, headings) is not structural — callers
 * should live-render that as markdown so spacing matches settle.
 */

export interface StreamingMarkdownPartition {
  stable: string;
  tail: string;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/**
 * Partition markdown source into completed blocks vs a mutable tail.
 * When not streaming, the whole source is stable.
 */
export function partitionStreamingMarkdown(text: string, streaming: boolean): StreamingMarkdownPartition {
  if (!text) {
    return { stable: "", tail: "" };
  }
  if (!streaming) {
    return { stable: text, tail: "" };
  }

  const holdFrom = findStructuredEditHoldFrom(text);
  if (holdFrom !== null) {
    const prefix = text.slice(0, holdFrom);
    const held = text.slice(holdFrom);
    if (!prefix) {
      return { stable: "", tail: held };
    }
    const parts = partitionClosedTopLevel(prefix);
    return {
      stable: parts.stable,
      tail: parts.tail + held,
    };
  }

  return partitionClosedTopLevel(text);
}

/**
 * True when the mutable tail must stay plain (incomplete fence / edit hold).
 * Prose and tables use the live Markdown document, including incomplete rows.
 */
export function isStructuralStreamingTail(tail: string): boolean {
  if (!tail) {
    return false;
  }
  if (findStructuredEditHoldFrom(tail) !== null) {
    return true;
  }

  const lines = splitLinesWithOffsets(tail);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.content.trim() === "") {
      continue;
    }

    const fence = matchFenceOpen(line.content);
    if (fence) {
      return findClosingFence(lines, i + 1, fence.marker) === null;
    }

    // The remaining blocks, including a confirmed GFM table, stay live.
    return false;
  }

  return false;
}

function findStructuredEditHoldFrom(text: string): number | null {
  const searchReplaceOpen = text.lastIndexOf("<<<<<<< SEARCH");
  if (searchReplaceOpen >= 0) {
    const tail = text.slice(searchReplaceOpen);
    if (!tail.includes(">>>>>>> REPLACE")) {
      return searchReplaceOpen;
    }
  }

  const conflictOpen = text.lastIndexOf("<<<<<<<");
  if (conflictOpen >= 0 && !text.slice(conflictOpen).includes(">>>>>>>")) {
    return conflictOpen;
  }

  return null;
}

function partitionClosedTopLevel(text: string): StreamingMarkdownPartition {
  const mutableStart = findMutableStartIndex(text);
  if (mutableStart <= 0) {
    return { stable: "", tail: text };
  }
  if (mutableStart >= text.length) {
    return { stable: text, tail: "" };
  }
  return {
    stable: text.slice(0, mutableStart),
    tail: text.slice(mutableStart),
  };
}

/**
 * Index where the mutable (incomplete) top-level region starts.
 * Everything before is stable.
 *
 * This is a *cheap approximation* of Markdown block structure, and it is only
 * used to pick the stable/tail split. Callers that need a parse-safe seal read
 * the tokenizer's real block map instead (see `feedMarkdownBlockRanges`).
 */
function findMutableStartIndex(text: string): number {
  const lines = splitLinesWithOffsets(text);
  let i = 0;
  let completedThrough = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const lineStart = line.start;

    // Leading blanks — only commit them after a following complete block.
    if (line.content.trim() === "") {
      i += 1;
      continue;
    }

    const fence = matchFenceOpen(line.content);
    if (fence) {
      const closeAt = findClosingFence(lines, i + 1, fence.marker);
      if (closeAt === null) {
        // Incomplete fence: everything from fence open is mutable.
        return lineStart;
      }
      // Fence block complete through closing line (and its newline if present).
      completedThrough = endOfLine(lines[closeAt]!);
      i = closeAt + 1;
      continue;
    }

    if (isTableRow(line.content) || isTableSeparator(line.content)) {
      const table = scanTable(lines, i);
      if (!table.complete) {
        // Confirmed GFM table still open, or pipe rows still arriving at EOF.
        return lineStart;
      }
      // complete: either a real table, or abandoned pipe-rows (no separator).
      completedThrough = table.endExclusive;
      i = table.nextIndex;
      continue;
    }

    // Paragraph / heading / list / blockquote — consume until blank line or structural next block.
    const block = scanLooseBlock(lines, i);
    if (!block.complete) {
      return lineStart;
    }
    completedThrough = block.endExclusive;
    i = block.nextIndex;
  }

  return completedThrough;
}

function scanLooseBlock(
  lines: LineRange[],
  startIndex: number,
): { complete: boolean; endExclusive: number; nextIndex: number } {
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.content.trim() === "") {
      // Blank line ends the block; include trailing blanks that separate from the next block.
      let end = endOfLine(line);
      let j = i + 1;
      while (j < lines.length && lines[j]!.content.trim() === "") {
        end = endOfLine(lines[j]!);
        j += 1;
      }
      return { complete: true, endExclusive: end, nextIndex: j };
    }
    // Opening a fence/table ends previous loose text before that line (handled by outer loop).
    if (matchFenceOpen(line.content) || isTableRow(line.content) || isTableSeparator(line.content)) {
      return {
        complete: true,
        endExclusive: line.start,
        nextIndex: i,
      };
    }
    i += 1;
  }
  // Reached EOF without a closing blank line — still typing this block.
  return { complete: false, endExclusive: 0, nextIndex: startIndex };
}

function scanTable(
  lines: LineRange[],
  startIndex: number,
): {
  complete: boolean;
  sawSeparator: boolean;
  endExclusive: number;
  nextIndex: number;
} {
  let i = startIndex;
  let sawSeparator = false;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.content.trim() === "") {
      if (!sawSeparator) {
        // Pipe rows + blank without a separator are not a GFM table — commit them
        // so following prose is not frozen as structural plain text.
        return {
          complete: true,
          sawSeparator: false,
          endExclusive: endOfLine(line),
          nextIndex: i + 1,
        };
      }
      return {
        complete: true,
        sawSeparator: true,
        endExclusive: endOfLine(line),
        nextIndex: i + 1,
      };
    }
    if (isTableSeparator(line.content)) {
      sawSeparator = true;
      i += 1;
      continue;
    }
    if (isTableRow(line.content)) {
      i += 1;
      continue;
    }
    // Left the table on a non-table line.
    if (!sawSeparator) {
      // Malformed / decorative pipes — commit the run, continue from this line.
      return {
        complete: true,
        sawSeparator: false,
        endExclusive: line.start,
        nextIndex: i,
      };
    }
    return {
      complete: true,
      sawSeparator: true,
      endExclusive: line.start,
      nextIndex: i,
    };
  }

  // Still inside the table at EOF — whole region is mutable.
  return {
    complete: false,
    sawSeparator,
    endExclusive: 0,
    nextIndex: startIndex,
  };
}

function matchFenceOpen(line: string): { marker: string } | null {
  const m = line.match(FENCE_OPEN);
  if (!m) return null;
  return { marker: m[2]! };
}

function findClosingFence(lines: LineRange[], fromIndex: number, openMarker: string): number | null {
  const char = openMarker[0]!;
  const minLen = openMarker.length;
  for (let i = fromIndex; i < lines.length; i += 1) {
    const content = lines[i]!.content;
    const m = content.match(/^( {0,3})(`{3,}|~{3,})\s*$/);
    if (!m) continue;
    const closer = m[2]!;
    if (closer[0] === char && closer.length >= minLen) {
      return i;
    }
  }
  return null;
}

function isTableRow(line: string): boolean {
  return TABLE_ROW.test(line);
}

function isTableSeparator(line: string): boolean {
  return TABLE_SEP.test(line);
}

interface LineRange {
  start: number;
  content: string;
  /** Inclusive end index of the line content in source (before \n). */
  contentEnd: number;
  /** Whether a trailing newline follows this line in source. */
  hasNewline: boolean;
}

function splitLinesWithOffsets(text: string): LineRange[] {
  const lines: LineRange[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      lines.push({
        start,
        content: text.slice(start, i),
        contentEnd: i,
        hasNewline: true,
      });
      start = i + 1;
    }
  }
  if (start < text.length || text.length === 0 || text.endsWith("\n")) {
    // Last line without trailing newline, or empty trailing line after final \n.
    if (start <= text.length) {
      const isEmptyTrailing = start === text.length && text.endsWith("\n");
      if (!isEmptyTrailing || lines.length === 0 || start < text.length) {
        lines.push({
          start,
          content: text.slice(start),
          contentEnd: text.length,
          hasNewline: false,
        });
      } else if (isEmptyTrailing) {
        // Trailing empty line after final newline — represent it so blank-end completion works.
        lines.push({
          start,
          content: "",
          contentEnd: text.length,
          hasNewline: false,
        });
      }
    }
  }
  return lines;
}

function endOfLine(line: LineRange): number {
  return line.hasNewline ? line.contentEnd + 1 : line.contentEnd;
}
