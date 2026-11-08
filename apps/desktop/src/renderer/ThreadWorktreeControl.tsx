import { ChevronRight, Folder, GitMerge, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadSummary, WorktreeStatusResult } from "../shared/ipc";
import type {
  ThreadDevelopmentMode,
  ThreadWorkLocation,
  ThreadWorktreeRecord,
} from "../shared/thread-worktree";
import { SwitchIndicator } from "./components/Switch";

interface Props {
  thread?: ThreadSummary;
  selectedWorktree?: ThreadWorktreeRecord;
  selectionError?: string;
  workspacePath?: string | undefined;
  mode: ThreadDevelopmentMode;
  busy: boolean;
  onModeChange: (mode: ThreadDevelopmentMode) => void;
  onLocationChange: (threadId: string, location: ThreadWorkLocation) => void;
}

// The worktree mark uses an outgoing path and a second arrow, distinct from a Git branch.
function WorktreeIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12h5a3 3 0 0 0 2.12-.88L21 2M15 2h6v6M15 16l6 6M15 22h6v-6" />
    </svg>
  );
}

export function ThreadWorktreeControl({
  thread,
  selectedWorktree,
  selectionError,
  workspacePath,
  mode,
  busy,
  onModeChange,
  onLocationChange,
}: Props) {
  const { t } = useTranslation();
  const panelId = useId();
  const [status, setStatus] = useState<WorktreeStatusResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<{ branchCommit: string; targetCommit: string }>();
  const onChangeRef = useRef(onLocationChange);
  onChangeRef.current = onLocationChange;
  const operationRef = useRef(false);
  const threadId = thread?.id;
  const activeThreadRef = useRef(threadId);
  activeThreadRef.current = threadId;
  const recordId = thread?.workLocation?.worktree?.id;

  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
    setConfirming(undefined);
    if (!threadId || !recordId) return;
    let disposed = false;
    let reading = false;
    const refresh = async () => {
      if (reading || operationRef.current) return;
      reading = true;
      try {
        const api = window.eco;
        if (!api) throw new Error(t("worktreeControl.apiUnavailable"));
        const next = await api.getWorktreeStatus(threadId);
        if (!disposed) {
          setStatus(next);
          setError(undefined);
          if (next.location) onChangeRef.current(threadId, next.location);
        }
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [threadId, recordId, t]);

  async function act(action: "refresh" | "confirm" | "cleanup" | "project" | "new_worktree" | "reattach") {
    if (!threadId || operationRef.current) return;
    operationRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      const api = window.eco;
      if (!api) throw new Error(t("worktreeControl.apiUnavailable"));
      let next: WorktreeStatusResult;
      if (action === "refresh") next = await api.getWorktreeStatus(threadId);
      else if (action === "confirm" || action === "cleanup") {
        if (!recordId) throw new Error(t("worktreeControl.missingRecord"));
        const request = {
          threadId,
          worktreeId: recordId,
          ...(action === "confirm" && confirming
            ? { expectedBranchCommit: confirming.branchCommit, expectedTargetCommit: confirming.targetCommit }
            : {}),
        };
        next =
          action === "confirm"
            ? await api.confirmWorktreeMerged(request)
            : await api.cleanupWorktree(request);
      } else
        next = await api.selectThreadWorkLocation({
          threadId,
          choice: action,
          ...(recordId ? { worktreeId: recordId } : {}),
        });
      if (activeThreadRef.current === threadId) {
        setStatus(next);
        setConfirming(undefined);
      }
      if (next.location) onChangeRef.current(threadId, next.location);
    } catch (caught) {
      if (activeThreadRef.current === threadId)
        setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      operationRef.current = false;
      setPending(false);
    }
  }

  const location =
    status?.location ??
    thread?.workLocation ??
    (selectedWorktree ? { mode: "isolated" as const, worktree: selectedWorktree } : undefined);
  const record = location?.worktree;
  const choosing = location?.mode === "needs_choice";
  const isolated = thread || selectedWorktree ? location?.mode === "isolated" : mode === "isolated";
  const locked =
    pending || busy || Boolean(thread && ["running", "queued", "awaiting_plan"].includes(thread.status));
  const path = thread?.workspacePath ?? workspacePath;
  const workingPath = record && location?.mode !== "direct" ? record.worktreePath : path;
  const failure = selectionError || error || status?.error || record?.error;
  const needsAttention = Boolean(
    choosing || failure || record?.state === "missing" || record?.state === "error",
  );
  const creating = record?.state === "creating" || (!thread && !selectedWorktree && isolated && busy);
  const label = choosing
    ? t("worktreeControl.selectLocation")
    : location?.mode === "direct"
      ? t("worktreeControl.projectDirectory")
      : record?.state === "removed"
        ? t("worktreeControl.removed")
        : record?.state === "missing"
          ? t("worktreeControl.missing")
          : record?.state === "error"
            ? t("worktreeControl.creationFailed")
            : failure
              ? t("worktreeControl.checkRequired")
              : creating
                ? t("worktreeControl.creating")
                : isolated
                  ? record
                    ? selectedWorktree
                      ? t("worktreeControl.selected")
                      : t("worktreeControl.created")
                    : t("worktreeControl.create")
                  : t("worktreeControl.projectDirectory");
  const mergedLabel =
    status?.merged === "git"
      ? t("worktreeControl.gitMerged")
      : status?.merged === "confirmed"
        ? t("worktreeControl.userMerged")
        : t("worktreeControl.unmerged");

  if (!path && !record) return null;

  return (
    <section className="thread-worktree-card" aria-label={t("worktreeControl.location")}>
      {thread || selectedWorktree || creating || failure ? (
        <div className="thread-worktree-card-toolbar">
          <span
            className={`thread-worktree-location${needsAttention ? " needs-attention" : ""}`}
            role="status"
          >
            <WorktreeIcon size={14} />
            <span>{label}</span>
            {needsAttention ? <span className="thread-worktree-attention-dot" aria-hidden /> : null}
          </span>
          {thread && record ? (
            <button
              type="button"
              className="thread-worktree-refresh"
              title={t("worktreeControl.refresh")}
              aria-label={t("worktreeControl.refresh")}
              disabled={pending}
              onClick={() => void act("refresh")}
            >
              <RefreshCw size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
      {creating ? (
        <div className="thread-worktree-progress" role="status">
          <LoaderCircle size={16} className="thread-worktree-spinner" aria-hidden />
          <span>
            {record?.baseCommit ? t("worktreeControl.checkingOut") : t("worktreeControl.preparing")}
          </span>
        </div>
      ) : null}
      {!thread && !selectedWorktree ? (
        <>
          <button
            type="button"
            className="thread-worktree-row thread-worktree-toggle"
            role="switch"
            aria-label={t("worktreeControl.create")}
            aria-checked={isolated}
            aria-describedby={isolated ? `${panelId}-hint` : undefined}
            disabled={busy}
            onClick={() => onModeChange(isolated ? "direct" : "isolated")}
          >
            <WorktreeIcon size={14} />
            <span>{t("worktreeControl.create")}</span>
            <SwitchIndicator checked={isolated} tone="neutral" size="sm" />
          </button>
          {isolated ? (
            <p id={`${panelId}-hint`} className="thread-worktree-hint">
              {t("worktreeControl.createHint")}
            </p>
          ) : null}
        </>
      ) : null}
      {!thread && (selectedWorktree || selectionError) ? (
        <button
          type="button"
          className="thread-worktree-row thread-worktree-reset"
          disabled={busy}
          onClick={() => onModeChange("direct")}
        >
          {t("worktreeControl.newChatInProject")}
        </button>
      ) : null}
      {record && isolated && status?.merged ? (
        <div className="thread-worktree-row thread-worktree-metadata">
          <span className="thread-worktree-field-label">
            <GitMerge size={14} aria-hidden />
            {t("worktreeControl.mergeStatus")}
          </span>
          <span className="thread-worktree-value">{mergedLabel}</span>
        </div>
      ) : null}
      <details className="thread-worktree-details">
        <summary>
          <Folder size={14} aria-hidden />
          <span>{t("worktreeControl.details")}</span>
          <ChevronRight size={14} className="thread-worktree-disclosure" aria-hidden />
        </summary>
        <dl>
          <dt>{t("worktreeControl.directory")}</dt>
          <dd>
            <code>{workingPath}</code>
          </dd>
          {record ? (
            <>
              <dt>{t("worktreeControl.targetBranch")}</dt>
              <dd>
                <code>{record.targetBranch || t("worktreeControl.unverified")}</code>
              </dd>
              <dt>{t("worktreeControl.baseCommit")}</dt>
              <dd>
                <code>{record.baseCommit || t("worktreeControl.notCreated")}</code>
              </dd>
            </>
          ) : null}
        </dl>
      </details>
      {status?.blockingReasons?.length && record?.state !== "removed" && location?.mode !== "direct" ? (
        <details className="thread-worktree-details">
          <summary>
            <span>{t("worktreeControl.blockingReasons", { count: status.blockingReasons.length })}</span>
            <ChevronRight size={14} className="thread-worktree-disclosure" aria-hidden />
          </summary>
          <ul>
            {status.blockingReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {failure ? (
        <p className="thread-worktree-error" role="alert">
          {failure}
        </p>
      ) : null}
      {choosing ? (
        <div className="thread-worktree-actions">
          <p>{t("worktreeControl.chooseHint")}</p>
          <button type="button" disabled={locked || status?.exists} onClick={() => void act("project")}>
            {t("worktreeControl.continueInProject")}
          </button>
          <button type="button" disabled={locked || status?.exists} onClick={() => void act("new_worktree")}>
            {t("worktreeControl.createIsolated")}
          </button>
          {status?.canReattach ? (
            <button type="button" disabled={locked} onClick={() => void act("reattach")}>
              {status.exists ? t("worktreeControl.reuse") : t("worktreeControl.reattach")}
            </button>
          ) : null}
        </div>
      ) : null}
      {thread && record && location?.mode !== "direct" && record.state !== "removed" ? (
        <div className="thread-worktree-actions">
          {status?.merged === "unmerged" && status.branchExists ? (
            <button
              type="button"
              disabled={locked || !status.branchCommit || !status.targetCommit}
              onClick={() =>
                setConfirming((value) =>
                  value || !status.branchCommit || !status.targetCommit
                    ? undefined
                    : { branchCommit: status.branchCommit, targetCommit: status.targetCommit },
                )
              }
            >
              {t("worktreeControl.confirmMerged")}
            </button>
          ) : null}
          <button
            type="button"
            className="thread-worktree-cleanup"
            disabled={locked || !status?.canClean}
            onClick={() => void act("cleanup")}
          >
            <Trash2 size={13} aria-hidden />
            {t("worktreeControl.cleanup")}
          </button>
          {confirming ? (
            <fieldset aria-label={t("worktreeControl.confirmResult")}>
              <p>{t("worktreeControl.confirmHint", { branch: record.targetBranch })}</p>
              <p>
                {t("worktreeControl.confirmCommit")}
                <code>{confirming.branchCommit}</code>
              </p>
              <button type="button" disabled={locked} onClick={() => void act("confirm")}>
                {t("worktreeControl.confirmAction")}
              </button>
              <button type="button" onClick={() => setConfirming(undefined)}>
                {t("common.cancel")}
              </button>
            </fieldset>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
