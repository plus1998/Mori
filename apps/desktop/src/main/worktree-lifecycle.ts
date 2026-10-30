import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createWorktreePlan } from "@eco/workspace";

export interface ApprovedPlanSnapshot {
  userPrompt: string;
  analysis: string;
  plan: string;
  planUserEdited?: boolean;
}

export interface ApprovedPlanArtifact {
  absolutePath: string;
  relativePath: string;
  contentHash: string;
}

export function approvedPlanFilePath(workspacePath: string, threadId: string): string {
  const safeThreadId = threadId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return path.join(workspacePath, ".eco", "approved-plans", `${safeThreadId}.md`);
}

export function approvedPlanRelativePath(threadId: string): string {
  const safeThreadId = threadId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `.eco/approved-plans/${safeThreadId}.md`;
}

export function formatApprovedPlanDocument(snapshot: ApprovedPlanSnapshot): string {
  const lines = [
    "# Mori approved plan",
    "",
    "## User request",
    snapshot.userPrompt.trim() || "(not captured)",
    "",
    "## Planning analysis",
    snapshot.analysis.trim() || "(no analysis captured)",
    "",
    "## Approved plan",
    snapshot.plan.trim() || "(no plan captured)",
  ];
  if (snapshot.planUserEdited) {
    lines.push("", "_User edited this plan in Mori before approval._");
  }
  return `${lines.join("\n")}\n`;
}

export function approvedPlanDocumentHash(document: string): string {
  return createHash("sha256").update(document, "utf8").digest("hex");
}

export async function writeApprovedPlanSnapshot(
  workspacePath: string,
  threadId: string,
  snapshot: ApprovedPlanSnapshot,
): Promise<ApprovedPlanArtifact> {
  const filePath = approvedPlanFilePath(workspacePath, threadId);
  const relativePath = approvedPlanRelativePath(threadId);
  const document = formatApprovedPlanDocument(snapshot);
  const contentHash = approvedPlanDocumentHash(document);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, document, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { absolutePath: filePath, relativePath, contentHash };
}

export function verifyApprovedPlanArtifact(input: {
  workspacePath: string;
  threadId: string;
  absolutePath: string;
  relativePath: string;
  contentHash: string;
}): { ok: true } | { ok: false; reason: string } {
  const expectedAbsolutePath = approvedPlanFilePath(input.workspacePath, input.threadId);
  const expectedRelativePath = approvedPlanRelativePath(input.threadId);
  if (
    path.resolve(input.absolutePath) !== path.resolve(expectedAbsolutePath) ||
    input.relativePath !== expectedRelativePath
  ) {
    return { ok: false, reason: "Approved-plan checkpoint path is not deterministic for this thread." };
  }
  try {
    const document = readFileSync(expectedAbsolutePath, "utf8");
    if (approvedPlanDocumentHash(document) !== input.contentHash) {
      return { ok: false, reason: "Approved-plan snapshot content hash does not match its checkpoint." };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Approved-plan snapshot cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function headingLineIndex(lines: readonly string[], heading: string, fromIndex = 0): number {
  const normalizedHeading = `## ${heading}`.toLowerCase();
  return lines.findIndex(
    (line, index) => index >= fromIndex && line.trim().toLowerCase() === normalizedHeading,
  );
}

/** Parse `.eco/approved-plans/<thread>.md` written by {@link formatApprovedPlanDocument}. */
export function parseApprovedPlanDocument(text: string): ApprovedPlanSnapshot | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const lines = trimmed.split(/\r?\n/);
  const userRequestIndex = headingLineIndex(lines, "User request");
  const analysisIndex = headingLineIndex(lines, "Planning analysis", userRequestIndex + 1);
  const approvedPlanIndex = headingLineIndex(lines, "Approved plan", analysisIndex + 1);
  if (userRequestIndex < 0 || analysisIndex < 0 || approvedPlanIndex < 0) {
    return undefined;
  }

  const userPrompt = lines
    .slice(userRequestIndex + 1, analysisIndex)
    .join("\n")
    .trim();
  const analysis = lines
    .slice(analysisIndex + 1, approvedPlanIndex)
    .join("\n")
    .trim();
  const planLines = lines.slice(approvedPlanIndex + 1);
  const editMarker = "_User edited this plan in Mori before approval._";
  const legacyEditMarker = "_User edited this plan in Eco before approval._";
  const lastLine = planLines.at(-1)?.trim().toLowerCase();
  const planUserEdited = lastLine === editMarker.toLowerCase() || lastLine === legacyEditMarker.toLowerCase();
  if (planUserEdited) {
    planLines.pop();
  }
  const plan = planLines.join("\n").trim();
  if (!plan) {
    return undefined;
  }
  return {
    userPrompt: userPrompt === "(not captured)" ? "" : userPrompt,
    analysis: analysis === "(no analysis captured)" ? "" : analysis,
    plan,
    ...(planUserEdited ? { planUserEdited: true } : {}),
  };
}

export async function readApprovedPlanSnapshot(
  workspacePath: string,
  threadId: string,
): Promise<ApprovedPlanSnapshot | undefined> {
  const filePath = approvedPlanFilePath(workspacePath, threadId);
  try {
    const text = await fs.readFile(filePath, "utf8");
    return parseApprovedPlanDocument(text);
  } catch {
    return undefined;
  }
}

export function resolveClaudePlanAbsolutePath(workspacePath: string, planFilePath: string): string {
  const trimmed = planFilePath.trim();
  if (!trimmed) {
    return "";
  }
  return path.isAbsolute(trimmed) ? trimmed : path.join(workspacePath, trimmed);
}

export async function claudePlanFileExists(workspacePath: string, planFilePath: string): Promise<boolean> {
  const absolute = resolveClaudePlanAbsolutePath(workspacePath, planFilePath);
  if (!absolute) {
    return false;
  }
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}

export async function readClaudePlanFile(
  workspacePath: string,
  planFilePath: string,
): Promise<string | undefined> {
  const absolute = resolveClaudePlanAbsolutePath(workspacePath, planFilePath);
  if (!absolute) {
    return undefined;
  }
  try {
    const text = await fs.readFile(absolute, "utf8");
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** @deprecated Legacy `.eco/approved-plans/` snapshots; new threads use Claude `.claude/plans/`. */
export async function approvedPlanSnapshotExists(workspacePath: string, threadId: string): Promise<boolean> {
  try {
    await fs.access(approvedPlanFilePath(workspacePath, threadId));
    return true;
  } catch {
    return false;
  }
}

export async function deleteApprovedPlanSnapshotIfNewerThan(
  workspacePath: string,
  threadId: string,
  cutoffIso: string,
): Promise<boolean> {
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) {
    return false;
  }
  const filePath = approvedPlanFilePath(workspacePath, threadId);
  try {
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs < cutoffMs) {
      return false;
    }
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Git failed because the process cwd (worktree directory) no longer exists or is invalid. */
export function isWorktreeGitCwdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /unable to read current working directory/i.test(message) ||
    /not a git repository/i.test(message) ||
    /fatal:.*does not exist/i.test(message) ||
    /failed to list untracked files/i.test(message)
  );
}

export function resolveWorktreePathHint(input: {
  threadId: string;
  workspacePath: string;
  activeWorktreePath?: string;
  pendingWorktreePath?: string;
  sdkSessionCwd?: string;
  coreSessionCwd?: string;
}): string {
  const defaultPath = createWorktreePlan(input.workspacePath, input.threadId).worktreePath;
  return (
    input.activeWorktreePath?.trim() ||
    input.pendingWorktreePath?.trim() ||
    input.sdkSessionCwd?.trim() ||
    input.coreSessionCwd?.trim() ||
    defaultPath
  );
}
