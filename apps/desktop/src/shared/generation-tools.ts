/** Direct tools use the current conversation, or a project scope before a conversation exists. */
export interface GenerationToolContext {
  workspacePath: string;
  threadId?: string;
}

export interface GenerationToolRequest<T> {
  context: GenerationToolContext;
  profileId: string;
  profileUpdatedAt: string;
  input: T;
}

export interface GenerationExecutionContext {
  threadId: string;
  workspacePath: string;
  generationRoot: string;
  toolUseId?: string;
}

export function generationToolScopeId(context: GenerationToolContext): string {
  return context.threadId || `generation-workspace:${context.workspacePath}`;
}
