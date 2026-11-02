import { useEffect, useRef, useState } from "react";
import type { ThreadSummary, WorktreeStatusResult } from "../shared/ipc";
import type { ThreadDevelopmentMode, ThreadWorkLocation } from "../shared/thread-worktree";

interface Props {
  thread?: ThreadSummary;
  mode: ThreadDevelopmentMode;
  busy: boolean;
  onModeChange: (mode: ThreadDevelopmentMode) => void;
  onLocationChange: (threadId: string, location: ThreadWorkLocation) => void;
}

export function ThreadWorktreeControl({ thread, mode, busy, onModeChange, onLocationChange }: Props) {
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
    if (!threadId || !recordId || operationRef.current) return;
    operationRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      const api = window.eco;
      if (!api) throw new Error("桌面 API 不可用。");
      const request = {
        threadId,
        worktreeId: recordId,
        ...(action === "confirm" && confirming
          ? { expectedBranchCommit: confirming.branchCommit, expectedTargetCommit: confirming.targetCommit }
          : {}),
      };
      const next =
        action === "refresh"
          ? await api.getWorktreeStatus(threadId)
          : action === "confirm"
            ? await api.confirmWorktreeMerged(request)
            : action === "cleanup"
              ? await api.cleanupWorktree(request)
              : await api.selectThreadWorkLocation({ ...request, choice: action });
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

  if (!thread)
    return (
      <div className="thread-worktree-control thread-worktree-new">
        <label>
          工作位置{" "}
          <select
            aria-label="开发方式"
            value={mode}
            disabled={busy}
            onChange={(event) => onModeChange(event.target.value as ThreadDevelopmentMode)}
          >
            <option value="direct">直接开发</option>
            <option value="isolated">隔离开发</option>
          </select>
        </label>
        {mode === "isolated" ? (
          <p>从当前分支 HEAD 创建独立工作树与分支。项目中未提交的改动不会带入；依赖由 Agent 按需安装。</p>
        ) : null}
      </div>
    );

  const location = status?.location ?? thread.workLocation;
  const record = location?.worktree;
  if (!record) return null;
  const choosing = location.mode === "needs_choice";
  const locked = pending || busy || ["running", "queued", "awaiting_plan"].includes(thread.status);
  const label =
    location.mode === "direct"
      ? "直接开发 · 在项目目录继续"
      : record.state === "removed"
        ? "工作树已清理"
        : record.state === "missing"
          ? "工作树已丢失"
          : record.state === "error"
            ? "工作树创建失败"
            : status?.error
              ? "工作树核验失败"
              : status?.merged === "git"
                ? "已并入 · Git 核验"
                : status?.merged === "confirmed"
                  ? "已并入 · 用户确认"
                  : "隔离开发 · 未并入";
  return (
    <section className="thread-worktree-control" aria-label="对话工作树">
      <div className="thread-worktree-heading">
        <strong>{label}</strong>
        <button type="button" disabled={pending} onClick={() => void act("refresh")}>
          刷新状态
        </button>
      </div>
      <p>
        <code>{location.mode === "direct" ? thread.workspacePath : record.worktreePath}</code>
      </p>
      <details>
        <summary>
          <code>{record.branchName}</code>
          <span> → {record.targetBranch || "待核验"}</span>
        </summary>
        <p>
          创建时提交：<code>{record.baseCommit || "尚未创建"}</code>
        </p>
        {location.mode === "direct" ? (
          <p>
            当前目录：<code>{thread.workspacePath}</code>
          </p>
        ) : null}
      </details>
      {status?.blockingReasons?.length && record.state !== "removed" && location.mode !== "direct" ? (
        <ul>
          {status.blockingReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {record.error && !status?.blockingReasons?.includes(record.error) ? (
        <p role="status">上次操作失败：{record.error}</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {choosing ? (
        <div className="thread-worktree-actions">
          <p>聊天记录已保留。发送前请选择后续工作位置。</p>
          <button type="button" disabled={locked || status?.exists} onClick={() => void act("project")}>
            在项目目录继续
          </button>
          <button type="button" disabled={locked || status?.exists} onClick={() => void act("new_worktree")}>
            新建隔离工作树
          </button>
          {status?.canReattach ? (
            <button type="button" disabled={locked} onClick={() => void act("reattach")}>
              从旧分支重新挂载
            </button>
          ) : null}
        </div>
      ) : null}
      {location.mode !== "direct" && record.state !== "removed" ? (
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
          <button type="button" disabled={locked || !status?.canClean} onClick={() => void act("cleanup")}>
            清理工作树与分支
          </button>
          {confirming ? (
            <fieldset aria-label="确认合并结果">
              <p>
                请先确认 Agent 已把当前分支的全部提交并入 {record.targetBranch}
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
    </section>
  );
}
