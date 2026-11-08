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
  return prompt;
}
