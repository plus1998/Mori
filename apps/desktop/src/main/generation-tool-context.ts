import fs from "node:fs/promises";
import path from "node:path";
import { type GenerationExecutionContext, generationToolScopeId } from "../shared/generation-tools";

/** Resolve only real conversations or explicit local project directories, never a caller-supplied output root. */
export async function resolveGenerationToolContext(
  value: unknown,
  resolveThread: (id: string) => { workspacePath: string; generationRoot: string } | undefined,
): Promise<GenerationExecutionContext> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("生成工具上下文无效。");
  const context = value as Record<string, unknown>;
  if (typeof context.workspacePath !== "string" || !path.isAbsolute(context.workspacePath)) {
    throw new Error("请先选择本地项目。");
  }
  const workspacePath = path.resolve(context.workspacePath);
  if (context.threadId !== undefined) {
    if (typeof context.threadId !== "string" || !context.threadId) throw new Error("生成工具会话无效。");
    const thread = resolveThread(context.threadId);
    if (!thread) throw new Error("生成工具会话已不存在，请重新打开工具。");
    if (path.resolve(thread.workspacePath) !== workspacePath)
      throw new Error("生成工具会话与当前项目不匹配。");
    return { threadId: context.threadId, workspacePath, generationRoot: thread.generationRoot };
  }
  if (!(await fs.stat(workspacePath)).isDirectory()) throw new Error("生成工具项目目录无效。");
  return { threadId: generationToolScopeId({ workspacePath }), workspacePath, generationRoot: workspacePath };
}
