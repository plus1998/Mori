import type {
  BashApprovalRequest,
  ClarificationRequest,
  ThreadPendingPlan,
  ThreadSummary,
} from "../shared/ipc";

export type SidebarAttentionKind = "question" | "plan" | "bash" | "completed";

export interface SidebarAttentionItem {
  id: string;
  threadId: string;
  title: string;
  kind: SidebarAttentionKind;
  detail?: string;
  updatedAt: string;
}

export interface BuildSidebarAttentionItemsInput {
  threads: readonly ThreadSummary[];
  unreadThreadIds: ReadonlySet<string>;
  pendingPlansByThread: Readonly<Record<string, ThreadPendingPlan>>;
  pendingBashApprovalsByThread: Readonly<Record<string, BashApprovalRequest>>;
  pendingClarificationsByThread: Readonly<Record<string, ClarificationRequest>>;
}

const KIND_PRIORITY: Record<SidebarAttentionKind, number> = {
  question: 0,
  plan: 1,
  bash: 2,
  completed: 3,
};

export function buildSidebarAttentionItems(input: BuildSidebarAttentionItemsInput): SidebarAttentionItem[] {
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread]));
  const items: SidebarAttentionItem[] = [];
  const planThreadIds = new Set<string>();

  for (const [threadId, clarification] of Object.entries(input.pendingClarificationsByThread)) {
    const thread = threadsById.get(threadId);
    const title = threadTitle(thread);
    if (!title) continue;
    const detail = clarification.questions.find((question) => question.question.trim())?.question.trim();
    items.push({
      id: `question:${threadId}:${clarification.toolUseId}`,
      threadId,
      title,
      kind: "question",
      ...(detail ? { detail } : {}),
      updatedAt: thread?.updatedAt ?? "",
    });
  }

  for (const [threadId, plan] of Object.entries(input.pendingPlansByThread)) {
    const thread = threadsById.get(threadId);
    const title = threadTitle(thread, plan.userPrompt);
    if (!title) continue;
    planThreadIds.add(threadId);
    const detail = planDetail(plan);
    items.push({
      id: `plan:${threadId}`,
      threadId,
      title,
      kind: "plan",
      ...(detail ? { detail } : {}),
      updatedAt: thread?.updatedAt ?? "",
    });
  }

  for (const thread of input.threads) {
    if (thread.status !== "awaiting_plan" || planThreadIds.has(thread.id)) continue;
    const title = threadTitle(thread);
    if (!title) continue;
    items.push({
      id: `plan:${thread.id}`,
      threadId: thread.id,
      title,
      kind: "plan",
      updatedAt: thread.updatedAt,
    });
  }

  for (const [threadId, approval] of Object.entries(input.pendingBashApprovalsByThread)) {
    const thread = threadsById.get(threadId);
    const title = threadTitle(thread);
    if (!title) continue;
    const detail = bashDetail(approval);
    items.push({
      id: `bash:${threadId}:${approval.toolUseId}`,
      threadId,
      title,
      kind: "bash",
      ...(detail ? { detail } : {}),
      updatedAt: thread?.updatedAt ?? "",
    });
  }

  for (const threadId of input.unreadThreadIds) {
    const thread = threadsById.get(threadId);
    const title = threadTitle(thread);
    if (!title) continue;
    items.push({
      id: `completed:${threadId}`,
      threadId,
      title,
      kind: "completed",
      ...(thread?.message.trim() ? { detail: thread.message.trim() } : {}),
      updatedAt: thread?.updatedAt ?? "",
    });
  }

  return items.sort((left, right) => {
    const kindDelta = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
    if (kindDelta !== 0) return kindDelta;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function threadTitle(thread: ThreadSummary | undefined, fallback = ""): string | undefined {
  const title = thread?.title.trim() || fallback.trim();
  return title || undefined;
}

function planDetail(plan: ThreadPendingPlan): string | undefined {
  const value = plan.plan.trim() || plan.analysis.trim() || plan.userPrompt.trim();
  return value || undefined;
}

function bashDetail(approval: BashApprovalRequest): string | undefined {
  const filesystemTool = approval.filesystemTool?.trim();
  const filesystemPath = approval.filesystemPath?.trim();
  if (filesystemTool && filesystemPath) {
    return `${filesystemTool} ${filesystemPath}`;
  }
  return approval.command.trim() || approval.description?.trim() || approval.reason.trim() || undefined;
}
