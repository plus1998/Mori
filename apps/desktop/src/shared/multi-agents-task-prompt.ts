export interface MultiAgentsTaskPromptDisplay {
  memberName: string;
  taskId: string;
  title: string;
}

/** Recognize the complete member envelope emitted by MultiAgentsService.taskPrompt.
 * The original message remains the source for execution, copying and editing.
 */
export function parseMultiAgentsTaskPrompt(text: string): MultiAgentsTaskPromptDisplay | undefined {
  const match =
    /^你是 Multi-Agents 成员 ([^\n]+)，职责：[^\n]+。仅执行主代理派发的任务，不向其他成员派发任务，不调用主代理的管理工具。\n(?:<user_request>\n[\s\S]*?\n<\/user_request>|<approved_plan version="[^"\n]+" planId="[^"\n]+">\n[\s\S]*?\n<\/approved_plan>)\n用户补充要求：[\s\S]*?\n任务 ([a-zA-Z0-9_-]{1,80})：([^\n]+)\n[\s\S]+\n范围：(\[[^\n]*\])\n验收标准：[\s\S]+\n依赖结果：(\[[^\n]*\])\n在当前隔离工作树执行。不要切换或重置分支，不要操作其他成员或主会话的目录。完成后调用 mori_context\.multi_agents_report[,，] ?result 包含变更、测试证据和未解决事项，然后结束本轮。宿主会回收实际运行状态，主代理统一验收。$/.exec(
      text.trim().replaceAll("\r\n", "\n"),
    );
  if (!match) return undefined;
  const [, rawMemberName, taskId, rawTitle, scopeJson, dependenciesJson] = match;
  if (!rawMemberName || !taskId || !rawTitle || !scopeJson || !dependenciesJson) return undefined;
  try {
    const scope: unknown = JSON.parse(scopeJson);
    const dependencies: unknown = JSON.parse(dependenciesJson);
    if (!Array.isArray(scope) || scope.some((item) => typeof item !== "string")) return undefined;
    if (!Array.isArray(dependencies)) return undefined;
  } catch {
    return undefined;
  }
  const memberName = rawMemberName.trim();
  const title = rawTitle.trim();
  if (!memberName || !title) return undefined;
  return { memberName, taskId, title };
}
