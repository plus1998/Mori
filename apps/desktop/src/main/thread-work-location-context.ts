import type { ThreadSummary } from "../shared/ipc";
import { type ActivityContextLine, buildAgentPromptWithContext } from "../shared/thread-continuation";

/** One prompt boundary shared by Claude, Codex, Pi and ACP. */
export function buildThreadWorkLocationPrompt(input: {
  thread: ThreadSummary;
  prompt: string;
  cwd: string;
  history: readonly ActivityContextLine[];
  hasRuntimeSession: boolean;
}): string {
  const location = input.thread.workLocation;
  let prompt = input.prompt;
  if (location?.contextResetPending && !input.hasRuntimeSession) {
    prompt = `工作位置已由用户改为：${input.cwd}。请在此目录继续；以下为保存的对话上下文。\n\n${buildAgentPromptWithContext(input.thread.prompt, prompt, input.history)}`;
  }
  if (location?.mode === "isolated" && location.worktree) {
    const record = location.worktree;
    return `当前会话使用隔离工作树：${record.worktreePath}\n项目目录：${input.thread.workspacePath}\n工作分支：${record.branchName}\n目标分支：${record.targetBranch}\n创建时提交：${record.baseCommit}\n请在所选工作树中开发，按用户任务负责提交、合并和解决冲突。依赖按项目需要安装；工作树清理由用户点击触发。\n\n${prompt}`;
  }
  return prompt;
}
