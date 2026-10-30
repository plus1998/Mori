/**
 * V4A apply_patch teaching: proactive agent-instruction prompts and patch-failure helpers.
 */

export type V4aTeachingKind =
  | "begin_extra_stars"
  | "unified_diff_no_envelope"
  | "begin_with_unified_body"
  | "missing_end"
  | "context_mismatch"
  | "invalid_hunk"
  | "other";

export const V4A_TEACHING_FOOTER =
  "Do not fall back to sed/cat/python to edit source files. Retry apply_patch with the format above.";

/** Proactive V4A grammar teaching appended to Codex agent developer instructions. */
export function buildV4aTeachingPrompt(): string {
  return [
    "Mori V4A teaching: when editing files, use apply_patch with Codex V4A patch grammar only — not git unified diff.",
    "Rules:",
    "- First line must be exactly `*** Begin Patch`; last line exactly `*** End Patch` (no extra `***`).",
    "- Use `*** Add File: path`, `*** Update File: path`, or `*** Delete File: path`.",
    "- Hunks may use optional `@@` title lines; context lines start with a space, removals with `-`, additions with `+`.",
    "- Do not use `diff --git`, `--- a/`, `+++ b/`, or git line-count hunks like `@@ -1,6 +1,7 @@` as structure.",
    V4A_TEACHING_FOOTER,
    "Minimal example:",
    V4A_MINIMAL_TEMPLATE,
  ].join("\n");
}

export function appendV4aTeachingToPrompt(base: string, enabled: boolean): string {
  if (!enabled) {
    return base.trim();
  }
  const teaching = buildV4aTeachingPrompt();
  const trimmed = base.trim();
  return trimmed ? `${trimmed}\n\n${teaching}` : teaching;
}

const V4A_MINIMAL_TEMPLATE = `*** Begin Patch
*** Update File: path/to/file.ext
@@
 context line (leading space)
-old line
+new line
*** End Patch`;

/** Helpers for classifying apply_patch verification failures (not used at runtime today). */

export function isApplyPatchVerificationFailure(output: string): boolean {
  const text = output.trim();
  return (
    /invalid (patch|hunk)/i.test(text) ||
    /failed to (find expected lines|find context|parse apply_patch)/i.test(text)
  );
}

export function extractApplyPatchInputText(toolInput: unknown): string {
  if (typeof toolInput === "string") {
    return toolInput;
  }
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return "";
  }
  const record = toolInput as Record<string, unknown>;
  for (const key of ["input", "command", "patch", "patchText"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (Array.isArray(value) && value.length >= 2 && typeof value[1] === "string") {
      return value[1];
    }
  }
  return "";
}

export function classifyV4aPatchFailure(input: string, output: string): V4aTeachingKind {
  const body = input.replace(/^\uFEFF/, "").replace(/^\n+/, "");
  const firstLine = (body.split(/\r?\n/, 1)[0] ?? "").trimEnd();
  const out = output.trim();

  if (
    firstLine === "*** Begin Patch ***" ||
    firstLine.startsWith("*** Begin Patch ***") ||
    (firstLine.startsWith("*** Begin Patch") && firstLine !== "*** Begin Patch")
  ) {
    return "begin_extra_stars";
  }

  const hasBegin = firstLine === "*** Begin Patch";
  const hasUnifiedMarkers =
    /^diff --git /m.test(body) ||
    /^--- a\//m.test(body) ||
    /^\+\+\+ b\//m.test(body) ||
    firstLine.startsWith("diff --git") ||
    firstLine.startsWith("--- a/") ||
    firstLine.startsWith("--- /");
  const hasV4aFileHeader =
    /\*\*\* Update File:/.test(body) || /\*\*\* Add File:/.test(body) || /\*\*\* Delete File:/.test(body);

  if (!hasBegin) {
    if (hasUnifiedMarkers || firstLine.startsWith("*** Update File:")) {
      return "unified_diff_no_envelope";
    }
    return "other";
  }

  if (/last line of the patch must be/i.test(out)) {
    return "missing_end";
  }

  if (hasUnifiedMarkers && !hasV4aFileHeader) {
    return "begin_with_unified_body";
  }

  if (/Failed to find (expected lines|context)/i.test(out)) {
    return "context_mismatch";
  }

  if (/invalid hunk/i.test(out)) {
    return "invalid_hunk";
  }

  if (/first line of the patch must be/i.test(out) && hasUnifiedMarkers) {
    return "begin_with_unified_body";
  }

  return "other";
}

export function buildV4aTeachingAdditionalContext(
  kind: V4aTeachingKind,
  input: string,
  output: string,
): string {
  const firstLine = (
    input
      .replace(/^\uFEFF/, "")
      .replace(/^\n+/, "")
      .split(/\r?\n/, 1)[0] ?? ""
  ).trimEnd();
  const preview = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  const errorLine = summarizeError(output);

  const lines: string[] = [
    "Mori V4A teaching: apply_patch failed. Use Codex V4A patch grammar (not git unified diff).",
    `Error: ${errorLine}`,
  ];
  if (preview) {
    lines.push(`Your input started with: ${JSON.stringify(preview)}`);
  }

  switch (kind) {
    case "begin_extra_stars":
      lines.push(
        "The first/last markers must be exactly `*** Begin Patch` and `*** End Patch` — no extra `***`.",
      );
      break;
    case "unified_diff_no_envelope":
      lines.push(
        "Do not send `diff --git`, `--- a/`, or `+++ b/`. Wrap changes in V4A:",
        V4A_MINIMAL_TEMPLATE,
      );
      break;
    case "begin_with_unified_body":
      lines.push(
        "You started with `*** Begin Patch` but the body is still git unified diff.",
        "After Begin Patch, use `*** Update File: relative/path` then hunks with `@@` (optional title only) and lines starting with space/`-`/`+`.",
        "Do not include `--- a/` / `+++ b/` / `diff --git` inside the patch.",
        V4A_MINIMAL_TEMPLATE,
      );
      break;
    case "missing_end":
      lines.push("End the patch with a final line that is exactly `*** End Patch`.");
      break;
    case "context_mismatch":
      lines.push(
        "Context lines must match the file exactly (including whitespace).",
        "Use `@@` optionally followed by a short title — do not put git counts like `@@ -1,6 +1,7 @@` as the match key.",
        "Re-read the target file, then retry with accurate context lines.",
      );
      break;
    case "invalid_hunk":
      lines.push(
        "Hunk format is invalid for V4A.",
        "Avoid context-diff headers like `*** 637,643 ****` or git line-number hunks `@@ -n,m +n,m @@` used as structure.",
        "Prefer:",
        V4A_MINIMAL_TEMPLATE,
      );
      break;
    default:
      lines.push("Retry with this exact shape:", V4A_MINIMAL_TEMPLATE);
      break;
  }

  lines.push(V4A_TEACHING_FOOTER);
  return lines.join("\n");
}

export function buildV4aTeachingHintFromFailure(input: string, output: string): string | undefined {
  if (!isApplyPatchVerificationFailure(output)) {
    return undefined;
  }
  const kind = classifyV4aPatchFailure(input, output);
  return buildV4aTeachingAdditionalContext(kind, input, output);
}

function summarizeError(output: string): string {
  const trimmed = output.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 200) {
    return trimmed;
  }
  return `${trimmed.slice(0, 197)}...`;
}
