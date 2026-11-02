import { GitBranch, Laptop, LoaderCircle, RefreshCw, Settings } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ComposerAbovePanel } from "./ComposerAbovePanel";
import type { ThreadSummary, WorktreeStatusResult } from "../shared/ipc";
import type { ThreadDevelopmentMode, ThreadWorkLocation, ThreadWorktreeRecord } from "../shared/thread-worktree";

interface Props {
  thread?: ThreadSummary;
  selectedWorktree?: ThreadWorktreeRecord;
  selectionError?: string;
  workspacePath?: string | undefined;
  branch?: string | undefined;
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
  branch,
  mode,
  busy,
  onModeChange,
  onLocationChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
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
        if (!api) throw new Error("桌面 API 不可用。");
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
  }, [threadId, recordId]);

  async function act(action: "refresh" | "confirm" | "cleanup" | "project" | "new_worktree" | "reattach") {
    if (!threadId || operationRef.current) return;
    operationRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      const api = window.eco;
      if (!api) throw new Error("桌面 API 不可用。");
      let next: WorktreeStatusResult;
      if (action === "refresh") next = await api.getWorktreeStatus(threadId);
      else if (action === "confirm" || action === "cleanup") {
        if (!recordId) throw new Error("工作树缺少管理记录。");
        const request = { threadId, worktreeId: recordId,
          ...(action === "confirm" && confirming
            ? { expectedBranchCommit: confirming.branchCommit, expectedTargetCommit: confirming.targetCommit } : {}) };
        next = action === "confirm" ? await api.confirmWorktreeMerged(request) : await api.cleanupWorktree(request);
      } else next = await api.selectThreadWorkLocation({ threadId, choice: action, ...(recordId ? { worktreeId: recordId } : {}) });
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

  const location = status?.location ?? thread?.workLocation ?? (selectedWorktree ? { mode: "isolated" as const, worktree: selectedWorktree } : undefined);
  const record = location?.worktree;
  const choosing = location?.mode === "needs_choice";
  const isolated = thread || selectedWorktree ? location?.mode === "isolated" : mode === "isolated";
  const locked =
    pending || busy || Boolean(thread && ["running", "queued", "awaiting_plan"].includes(thread.status));
  const path = thread?.workspacePath ?? workspacePath;
  const workingPath = record && location?.mode !== "direct" ? record.worktreePath : path;
  const branchName = isolated && record ? (record.checkoutBranch ?? record.branchName) : branch;
  const failure = selectionError || error || status?.error || record?.error;
  const needsAttention = Boolean(
    choosing || failure || record?.state === "missing" || record?.state === "error",
  );
  const creating = record?.state === "creating" || (!thread && !selectedWorktree && isolated && busy);
  const label = choosing
    ? "选择工作位置"
    : location?.mode === "direct"
      ? "项目目录"
      : record?.state === "removed"
        ? "工作树已清理"
        : record?.state === "missing"
          ? "工作树已丢失"
          : record?.state === "error"
            ? "工作树创建失败"
            : failure
              ? "工作树需检查"
              : creating
                ? "正在创建工作树"
                : isolated
                  ? record
                    ? selectedWorktree ? "已选择工作树" : "已创建工作树"
                    : "新建工作树"
                  : "项目目录";
  const mergedLabel =
    status?.merged === "git"
      ? "已并入 · Git 核验"
      : status?.merged === "confirmed"
        ? "已并入 · 用户确认"
        : "尚未并入";

  if (!path && !record) return null;

  return (
    <div className="thread-worktree-bar" aria-label="工作位置">
      {(record && location?.mode !== "direct") || creating || failure ? (
        <span className={`thread-worktree-location${needsAttention ? " needs-attention" : ""}`} role="status">
          <WorktreeIcon size={14} />
          <span>{label}</span>
          {needsAttention ? <span className="thread-worktree-attention-dot" aria-label="需要处理" /> : null}
        </span>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        className={`thread-worktree-settings${open ? " is-active" : ""}`}
        title="配置本地环境"
        aria-label="配置本地环境"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Settings size={18} strokeWidth={1.75} aria-hidden />
      </button>
      {open ? (
        <ComposerAbovePanel
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          id={panelId}
          width={360}
          minHeight={160}
          label="配置本地环境"
          className="thread-worktree-popover"
          onClose={() => {
            if (document.activeElement?.closest(".thread-worktree-popover")) {
              triggerRef.current?.focus();
            }
            setOpen(false);
            setConfirming(undefined);
          }}
        >
          <header className="thread-worktree-popover-header">
            <span>配置本地环境</span>
            {thread && record ? (
              <button
                type="button"
                className="thread-worktree-refresh"
                title="刷新状态"
                aria-label="刷新状态"
                disabled={pending}
                onClick={() => void act("refresh")}
              >
                <RefreshCw size={14} aria-hidden />
              </button>
            ) : null}
          </header>
          {creating ? (
            <div className="thread-worktree-progress" role="status">
              <LoaderCircle size={16} className="thread-worktree-spinner" aria-hidden />
              <span>{record?.baseCommit ? "正在检出文件" : "正在准备工作空间"}</span>
            </div>
          ) : null}
          {!thread && !selectedWorktree ? (
            <>
              <button
                type="button"
                className="thread-worktree-row thread-worktree-toggle"
                role="switch"
                aria-label="新建工作树"
                aria-checked={isolated}
                aria-describedby={isolated ? `${panelId}-hint` : undefined}
                disabled={busy}
                onClick={() => onModeChange(isolated ? "direct" : "isolated")}
              >
                <WorktreeIcon size={18} />
                <span>新建工作树</span>
                <span className={`thread-worktree-switch${isolated ? " is-on" : ""}`} aria-hidden>
                  <span />
                </span>
              </button>
              {isolated ? (
                <p id={`${panelId}-hint`} className="thread-worktree-hint">
                  从当前分支创建独立目录，未提交的改动不会带入。
                </p>
              ) : null}
            </>
          ) : (
            <div className="thread-worktree-row">
              {isolated ? <WorktreeIcon size={18} /> : <Laptop size={18} aria-hidden />}
              <span>工作位置</span>
              <span className="thread-worktree-value">{label}</span>
            </div>
          )}
          {!thread && (selectedWorktree || selectionError) ? <button type="button" className="thread-worktree-row" disabled={busy} onClick={() => onModeChange("direct")}>改为在项目目录新建聊天</button> : null}
          {branchName ? (
            <div className="thread-worktree-row">
              <GitBranch size={18} aria-hidden />
              <span>分支</span>
              <span className="thread-worktree-value" title={branchName}>
                {branchName}
              </span>
            </div>
          ) : null}
          {record && isolated && status?.merged ? (
            <div className="thread-worktree-row thread-worktree-status-row">
              <span>合并状态</span>
              <span className="thread-worktree-value">{mergedLabel}</span>
            </div>
          ) : null}
          <details className="thread-worktree-details">
            <summary>位置与详情</summary>
            <dl>
              <dt>工作目录</dt>
              <dd>
                <code>{workingPath}</code>
              </dd>
              {record ? (
                <>
                  <dt>目标分支</dt>
                  <dd>
                    <code>{record.targetBranch || "待核验"}</code>
                  </dd>
                  <dt>创建时提交</dt>
                  <dd>
                    <code>{record.baseCommit || "尚未创建"}</code>
                  </dd>
                </>
              ) : null}
            </dl>
          </details>
          {status?.blockingReasons?.length && record?.state !== "removed" && location?.mode !== "direct" ? (
            <details className="thread-worktree-details">
              <summary>暂不能清理 · {status.blockingReasons.length} 项原因</summary>
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
              <p>聊天记录已保留，请选择后续工作位置。</p>
              <button type="button" disabled={locked || status?.exists} onClick={() => void act("project")}>
                在项目目录继续
              </button>
              <button
                type="button"
                disabled={locked || status?.exists}
                onClick={() => void act("new_worktree")}
              >
                新建隔离工作树
              </button>
              {status?.canReattach ? (
                <button type="button" disabled={locked} onClick={() => void act("reattach")}>
                  {status.exists ? "继续使用此工作树" : "从旧分支重新挂载"}
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
                  确认已并入…
                </button>
              ) : null}
              <button
                type="button"
                className="thread-worktree-cleanup"
                disabled={locked || !status?.canClean}
                onClick={() => void act("cleanup")}
              >
                清理工作树与分支
              </button>
              {confirming ? (
                <fieldset aria-label="确认合并结果">
                  <p>
                    请确认 Agent 已把当前分支的全部提交并入 {record.targetBranch}
                    （例如压缩合并）。新增提交后需要重新核验。
                  </p>
                  <p>
                    确认提交：<code>{confirming.branchCommit}</code>
                  </p>
                  <button type="button" disabled={locked} onClick={() => void act("confirm")}>
                    我确认当前提交已并入
                  </button>
                  <button type="button" onClick={() => setConfirming(undefined)}>
                    取消
                  </button>
                </fieldset>
              ) : null}
            </div>
          ) : null}
        </ComposerAbovePanel>
      ) : null}
    </div>
  );
}
