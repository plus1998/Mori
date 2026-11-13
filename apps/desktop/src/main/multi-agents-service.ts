import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ThreadPendingPlan, ThreadStartRequest, ThreadSummary } from "../shared/ipc";
import {
  type MultiAgentsConfig,
  type MultiAgentsRun,
  type MultiAgentsTask,
  type MultiAgentsTaskInput,
  validateMultiAgentsTasks,
} from "../shared/multi-agents";
import { isThreadRuntimeConfig } from "../shared/thread-runtime-config";
import { COMPOSER_REFERENCE_PATTERN, parseComposerReference, type ComposerReference } from "../shared/composer-references";
import { MultiAgentsWorkspace } from "./multi-agents-workspace";

interface Host {
  thread(id: string): ThreadSummary | undefined;
  busy(id: string): boolean;
  latestAttempt(id: string): { attemptId: string; status: string } | undefined;
  start(request: ThreadStartRequest, id: string, title: string, baseline: string): Promise<unknown>;
  resume(threadId: string, prompt: string, requestId: string): Promise<unknown>;
  cancel(threadId: string): Promise<void>;
  changed(threadId: string): void;
  validateMember(config: MultiAgentsConfig): void;
  nativeAgentKeys(threadId: string): string[];
}
const activeStatuses = new Set(["planning", "running", "awaiting_review", "paused", "interrupted"]);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class MultiAgentsService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly referenceGrants = new Map<string, Map<string, { configId: string; prompt: string }>>();
  private async exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.pending.set(id, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(id) === next) this.pending.delete(id);
    }
  }
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: Host,
    private readonly workspace = new MultiAgentsWorkspace(),
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS multi_agents_configs (id TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS multi_agents_runs (id TEXT PRIMARY KEY, value_json TEXT NOT NULL);`);
    // A process restart never silently redispatches an uncertain attempt.
    for (const run of this.runs())
      if (run.status === "running" || run.status === "planning") {
        run.status = "interrupted";
        run.message = "应用重启中断了调度，请检查成员会话后恢复。";
        for (const task of run.tasks)
          if (task.status === "running") {
            task.status = "failed";
            task.error = "应用重启，成员执行结果未确认；请检查成员会话后返工。";
          }
        this.save(run);
      }
  }
  start() {
    this.timer ??= setInterval(() => {
      void this.tick().catch((error) => console.error("[multi-agents]", error));
    }, 1500);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
    this.db.close();
  }
  configs(): MultiAgentsConfig[] {
    return this.db
      .prepare("SELECT value_json FROM multi_agents_configs ORDER BY id")
      .all()
      .map((row) => JSON.parse(row.value_json as string));
  }
  references(): ComposerReference[] {
    return this.configs().map(config => ({
      kind: "multi_agents",
      id: config.id,
      label: config.name,
      detail: `${config.mode === "sessions" ? "独立会话" : "原生子代理"} · ${
        config.mode === "sessions" ? config.members.map(member => member.name).join(", ") : config.agentKeys.join(", ")
      } · 并发 ${config.maxConcurrency}`,
    }));
  }
  resolveReference(threadId: string, configId: string, prompt: string) {
    const config = this.configs().find(value => value.id === configId);
    if (!config) throw new Error("Multi-Agents 配置已删除，请重新选择。");
    const grants = this.referenceGrants.get(threadId) ?? new Map<string, { configId: string; prompt: string }>();
    const requestId = `multi_ref_${randomUUID()}`;
    grants.set(requestId, { configId, prompt });
    this.referenceGrants.set(threadId, grants);
    return {
      type: "multi_agents", configId, requestId, name: config.name, mode: config.mode,
      maxConcurrency: config.maxConcurrency,
      members: config.mode === "sessions"
        ? config.members.map(({ id, name, responsibility, coreKind }) => ({ memberId: id, name, responsibility, harness: coreKind }))
        : config.agentKeys,
      tool: "mori_context.multi_agents_start",
      instructions: "用户明确选择此配置协作完成本条消息的任务。在 Agent 模式调用启动工具（configId, requestId），按返回指引拆分、派发、整合和验收；不需要先进入计划模式。计划模式下先形成计划，等待用户批准后执行。",
    };
  }
  disposeThread(threadId: string) {
    this.referenceGrants.delete(threadId);
  }
  private async startReferenced(threadId: string, args: Record<string, unknown>) {
    if (typeof args.configId !== "string" || typeof args.requestId !== "string")
      throw new Error("需要引用中的 configId 和 requestId。");
    const grant = this.referenceGrants.get(threadId)?.get(args.requestId);
    if (!grant || grant.configId !== args.configId)
      throw new Error("只能启动用户在当前会话明确 @ 引用的 Multi-Agents 配置。");
    const thread = this.host.thread(threadId);
    if (!thread) throw new Error("来源主会话已删除。");
    if (thread.runtimeConfig?.sessionMode !== "agent" || thread.status === "awaiting_plan")
      throw new Error("@Multi-Agents 启动需要 Agent 模式；计划模式请先批准计划。");
    // Never forward executable composer tokens to members as new user selections.
    const request = grant.prompt.replace(COMPOSER_REFERENCE_PATTERN, (_token, kind: string, encoded: string) =>
      `[${kind}: ${parseComposerReference(kind, encoded)?.label ?? kind}]`,
    );
    const run = await this.exclusive(`prepare:${threadId}`, () => this.prepareRun(
      args.requestId as string, threadId, grant.configId, undefined,
      thread.workLocation?.worktree?.worktreePath ?? thread.workspacePath, "", request,
    ));
    return {
      run,
      instructions: activeStatuses.has(run.status)
        ? this.prompt(threadId)
        : "此请求已结束，请根据返回的状态说明结果；不要重复派发任务。",
    };
  }
  runs(): MultiAgentsRun[] {
    return this.db
      .prepare("SELECT value_json FROM multi_agents_runs ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(row.value_json as string));
  }
  snapshot() {
    const runs = this.runs();
    const relations: { source: string; child: string }[] = runs.flatMap((run) =>
      run.tasks.flatMap((task) =>
        task.threadId ? [{ source: run.sourceThreadId, child: task.threadId }] : [],
      ),
    );
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='plan_execution_links'").get()) {
      for (const row of this.db
        .prepare("SELECT source_thread_id, execution_thread_id FROM plan_execution_links")
        .all())
        relations.push({ source: row.source_thread_id as string, child: row.execution_thread_id as string });
    }
    const groups = [...new Set(relations.map((value) => value.source))].flatMap((id) => {
      const source = this.host.thread(id);
      if (!source) return [];
      const children = [
        ...new Set(relations.filter((value) => value.source === id).map((value) => value.child)),
      ].flatMap((id) => {
        const thread = this.host.thread(id);
        return thread ? [thread] : [];
      });
      return children.length ? [{ source, children }] : [];
    });
    return { configs: this.configs(), runs, groups };
  }
  saveConfig(raw: MultiAgentsConfig): MultiAgentsConfig {
    if (
      !raw ||
      typeof raw.id !== "string" ||
      !raw.id.trim() ||
      typeof raw.name !== "string" ||
      !raw.name.trim()
    )
      throw new Error("配置 ID 和名称不能为空。");
    if (!["sessions", "subagents"].includes(raw.mode)) throw new Error("无效的 Multi-Agents 执行方式。");
    if (!Number.isInteger(raw.maxConcurrency) || raw.maxConcurrency < 1 || raw.maxConcurrency > 16)
      throw new Error("并发数必须为 1–16。");
    if (!Array.isArray(raw.members) || !Array.isArray(raw.agentKeys)) throw new Error("成员配置无效。");
    if (raw.mode === "sessions" && (!raw.members.length || raw.members.length > 16))
      throw new Error("请选择 1–16 个成员。");
    if (
      raw.mode === "subagents" &&
      (!raw.agentKeys.length ||
        raw.agentKeys.some((key) => typeof key !== "string" || !key.trim()) ||
        new Set(raw.agentKeys).size !== raw.agentKeys.length)
    )
      throw new Error("请选择不同的原生子代理。");
    const ids = new Set<string>();
    for (const member of raw.mode === "sessions" ? raw.members : []) {
      if (
        !member ||
        typeof member.id !== "string" ||
        !member.id ||
        ids.has(member.id) ||
        typeof member.name !== "string" ||
        !member.name.trim() ||
        typeof member.responsibility !== "string" ||
        !member.responsibility.trim()
      )
        throw new Error("成员 ID 需唯一，名称和职责不能为空。");
      ids.add(member.id);
      if (
        !["codex", "claude", "pi", "acp"].includes(member.coreKind) ||
        !isThreadRuntimeConfig(member.runtimeConfig)
      )
        throw new Error("成员 Harness 或运行配置无效。");
      const model = member.runtimeConfig.orchestrationSelection?.mainModel;
      if (member.coreKind !== "acp" && (!model?.providerId || !model.modelId))
        throw new Error(`请为 ${member.name} 选择模型。`);
      if (model?.providerId === "eco-coding-chatgpt" && !model.accountId)
        throw new Error(`请为 ${member.name} 指定账号。`);
      if (member.runtimeConfig.sessionMode !== "agent") throw new Error("成员必须使用 Agent 模式。");
      if (member.runtimeConfig.orchestrationSelection?.subagents.mode !== "none")
        throw new Error("执行成员不能再派发子代理。");
    }
    const config = structuredClone({
      ...raw,
      id: raw.id.trim(),
      name: raw.name.trim(),
      members: raw.mode === "sessions" ? raw.members : [],
      agentKeys: raw.mode === "subagents" ? raw.agentKeys : [],
    });
    this.host.validateMember(config);
    this.db
      .prepare(
        "INSERT INTO multi_agents_configs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json",
      )
      .run(config.id, JSON.stringify(config));
    return config;
  }
  deleteConfig(id: string) {
    this.db.prepare("DELETE FROM multi_agents_configs WHERE id=?").run(id);
  }
  private save(run: MultiAgentsRun) {
    this.db
      .prepare(
        "INSERT INTO multi_agents_runs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json",
      )
      .run(run.id, JSON.stringify(run));
    this.host.changed(run.sourceThreadId);
  }
  private update(run: MultiAgentsRun) {
    run.revision++;
    this.save(run);
  }
  forThread(id: string) {
    return this.runs().filter(
      (run) => run.sourceThreadId === id || run.tasks.some((task) => task.threadId === id),
    );
  }
  private source(id: string): MultiAgentsRun {
    const run = this.runs().find((value) => value.sourceThreadId === id && activeStatuses.has(value.status));
    if (!run) throw new Error("当前主会话没有进行中的 Multi-Agents 执行。");
    return run;
  }
  async prepare(
    id: string,
    sourceThreadId: string,
    configId: string,
    plan: ThreadPendingPlan,
    workspacePath: string,
    additionalMessage = "",
  ) {
    return this.exclusive(`prepare:${sourceThreadId}`, () =>
      this.prepareRun(id, sourceThreadId, configId, plan, workspacePath, additionalMessage),
    );
  }
  private async prepareRun(
    id: string,
    sourceThreadId: string,
    configId: string,
    plan: ThreadPendingPlan | undefined,
    workspacePath: string,
    additionalMessage: string,
    request?: string,
  ) {
    const existing = this.runs().find((run) => run.id === id);
    if (existing) return existing;
    if (!plan && !request?.trim()) throw new Error("Multi-Agents 缺少用户任务或已批准计划。");
    if (this.runs().some((run) => run.sourceThreadId === sourceThreadId && activeStatuses.has(run.status)))
      throw new Error("当前主会话已有 Multi-Agents 执行，请先完成或停止。");
    if (
      this.runs().some(
        (run) => activeStatuses.has(run.status) && run.tasks.some((task) => task.threadId === sourceThreadId),
      )
    )
      throw new Error("成员会话不能递归启动 Multi-Agents。");
    const config = this.configs().find((value) => value.id === configId);
    if (!config) throw new Error("Multi-Agents 配置已删除，请重新选择。");
    this.host.validateMember(config);
    if (config.mode === "subagents") {
      const thread = this.host.thread(sourceThreadId);
      if (!["claude", "codex", "pi"].includes(thread?.coreKind ?? ""))
        throw new Error("当前主会话 Harness 不支持原生子代理，请选择独立会话配置。");
      const keys = this.host.nativeAgentKeys(sourceThreadId);
      for (const key of config.agentKeys)
        if (!keys.includes(key)) throw new Error(`原生子代理「${key}」不在当前会话锁定的编排中。`);
    }
    const run: MultiAgentsRun = {
      id,
      sourceThreadId,
      config: structuredClone(config),
      ...(plan ? { plan: structuredClone(plan) } : { request: request! }),
      workspacePath,
      additionalMessage,
      status: config.mode === "subagents" ? "running" : "planning",
      tasks: [],
      revision: 0,
      notifiedRevision: 0,
      createdAt: new Date().toISOString(),
    };
    if (config.mode === "sessions") run.baselineCommit = await this.workspace.capture(workspacePath);
    this.save(run);
    return run;
  }
  private requestContext(run: MultiAgentsRun): string {
    return run.plan
      ? `<approved_plan version="${run.plan.version}" planId="${run.plan.referenceId}">\n${run.plan.plan}\n</approved_plan>`
      : `<user_request>\n${run.request}\n</user_request>`;
  }
  prompt(threadId: string): string {
    const run = this.runs().find(
      (value) => value.sourceThreadId === threadId && activeStatuses.has(value.status),
    );
    if (!run) return "";
    const members =
      run.config.mode === "sessions"
        ? run.config.members.map(({ id, name, responsibility, coreKind, runtimeConfig }) => ({
            memberId: id,
            name,
            responsibility,
            harness: coreKind,
            model: runtimeConfig.orchestrationSelection?.mainModel,
            tools: runtimeConfig.resolvedOrchestrationSnapshot?.mainAgent.tools,
            skills: runtimeConfig.skillsEnabled,
            mcp: runtimeConfig.mcpServersEnabled,
            bashReviewMode: runtimeConfig.bashReviewMode,
          }))
        : run.config.agentKeys;
    return `\n<Multi-Agents runId="${run.id}">\n用户选择了 ${run.config.name}。你负责拆分、派发、整合和最终验收。成员之间不直接通信。可用成员：${JSON.stringify(members)}\n并发上限 ${run.config.maxConcurrency}。成员池不要求人人分配任务。补充要求：${run.additionalMessage}\n${this.requestContext(run)}\n${
      run.config.mode === "sessions"
        ? "先调用 mori_context.multi_agents_submit_tasks，提交结构化任务（id, memberId, title, instructions, scope, dependsOn, acceptance）。只能指定上述 memberId，账号和 Harness 由宿主固定。宿主为每个任务创建独立会话和工作树，包含协作启动时的未提交改动；同一任务返工复用原会话。任务已启动后结束本轮等待；宿主会在结果就绪时发送后续消息，不要轮询。通过 multi_agents_status 查看状态和成员结果，按依赖顺序调用 multi_agents_integrate 将结果合入你的工作目录，冲突时先解决再继续；multi_agents_retry 给同一个成员会话返工。所有任务完成后实际检查代码和测试，再调用 multi_agents_accept 提交验收证据。模型回合结束不代表完成。"
        : `使用当前 Harness 原生子代理工具，将任务拆给选中的 ${run.config.agentKeys.join(", ")}，最多 ${run.config.maxConcurrency} 个并行。每个子代理只收到自己的任务和相关上下文，等待真实结果后统一检查代码和测试，最后调用 mori_context.multi_agents_accept 提交验收证据。原生子代理的具体进度由 Harness 子代理面板展示。`
    }\n</Multi-Agents>`;
  }
  async tool(threadId: string, name: string, args: Record<string, unknown>) {
    if (name === "multi_agents_start") return this.startReferenced(threadId, args);
    const related = this.forThread(threadId);
    if (name === "multi_agents_status" && related[0]?.sourceThreadId === threadId)
      return {
        ...related[0],
        tasks: related[0].tasks.map((task) => ({
          ...task,
          worktreePath: task.threadId
            ? this.host.thread(task.threadId)?.workLocation?.worktree?.worktreePath
            : undefined,
        })),
      };
    if (
      name === "multi_agents_accept" &&
      related[0]?.sourceThreadId === threadId &&
      related[0].status === "completed" &&
      related[0].review === args.review
    )
      return { accepted: true };
    const run = related.find((run) => activeStatuses.has(run.status));
    if (!run) throw new Error("当前会话没有进行中的 Multi-Agents 执行。");
    return this.exclusive(run.id, () => this.executeTool(threadId, name, args));
  }
  private async executeTool(threadId: string, name: string, args: Record<string, unknown>) {
    if (name === "multi_agents_report") {
      const run = this.runs().find((value) => value.tasks.some((task) => task.threadId === threadId));
      const task = run?.tasks.find((value) => value.threadId === threadId);
      if (!run || !task || task.status !== "running")
        throw new Error("只有运行中的成员能提交自己的任务结果。");
      if (typeof args.result !== "string" || !args.result.trim())
        throw new Error("结果需包含修改内容、测试结果和未解决事项。");
      const attempt = this.host.latestAttempt(threadId);
      if (!attempt || attempt.status !== "running") throw new Error("宿主尚未确认当前成员的运行尝试。");
      task.result = args.result;
      task.reported = true;
      task.reportAttemptId = attempt.attemptId;
      this.update(run);
      return { accepted: true, message: "结果已记录，宿主将在本轮实际结束后回收。" };
    }
    const run = this.source(threadId);
    if (name === "multi_agents_status") return run;
    if (["paused", "interrupted", "cancelled"].includes(run.status))
      throw new Error("调度已暂停或中断，请先在界面恢复。");
    if (name === "multi_agents_submit_tasks") {
      if (run.config.mode !== "sessions")
        throw new Error("当前配置使用原生子代理，请调用 Harness 子代理工具。");
      const tasks = args.tasks as MultiAgentsTaskInput[];
      validateMultiAgentsTasks(tasks, run.config);
      if (run.tasks.length) {
        if (
          JSON.stringify(
            run.tasks.map(({ id, memberId, title, instructions, scope, dependsOn, acceptance }) => ({
              id,
              memberId,
              title,
              instructions,
              scope,
              dependsOn,
              acceptance,
            })),
          ) === JSON.stringify(tasks)
        )
          return run;
        throw new Error("任务已提交；需要返工请调用 multi_agents_retry，不能重复创建执行。");
      }
      run.tasks = tasks.map((task) => ({ ...structuredClone(task), status: "queued", attempt: 0 }));
      run.status = "running";
      this.update(run);
      return {
        runId: run.id,
        tasks: run.tasks,
        message: "宿主开始调度；结束本轮，结果就绪后会收到后续消息。",
      };
    }
    if (name === "multi_agents_retry") {
      const task = run.tasks.find((value) => value.id === args.taskId);
      if (!task || !["failed", "blocked", "succeeded", "cancelled"].includes(task.status))
        throw new Error("该任务现在不能返工。");
      if (typeof args.instructions !== "string" || !args.instructions.trim())
        throw new Error("请提供返工指令。");
      const affected = new Set([task.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const item of run.tasks)
          if (!affected.has(item.id) && item.dependsOn.some((id) => affected.has(id))) {
            affected.add(item.id);
            grew = true;
          }
      }
      if (run.tasks.some((item) => affected.has(item.id) && item.status === "running"))
        throw new Error("下游成员仍在运行，请等待其结束后返工。");
      for (const item of run.tasks.filter((item) => affected.has(item.id))) {
        const { attempt, status, result, error, baseCommit, resultCommit, integratedCommit } = item;
        item.history = [
          ...(item.history ?? []),
          {
            attempt,
            status,
            ...(result ? { result } : {}),
            ...(error ? { error } : {}),
            ...(baseCommit ? { baseCommit } : {}),
            ...(resultCommit ? { resultCommit } : {}),
            ...(integratedCommit ? { integratedCommit } : {}),
          },
        ];
        item.instructions =
          item.id === task.id
            ? args.instructions
            : `${item.instructions}\n上游任务 ${task.id} 已返工，请基于最新依赖重新检查并修正本任务。`;
        item.status = "queued";
        item.reported = false;
        delete item.result;
        delete item.error;
        delete item.reportAttemptId;
        delete item.resultCommit;
        delete item.integrationError;
        delete item.integrationResolution;
      }
      delete run.pendingNotification;
      run.status = "running";
      this.update(run);
      return task;
    }
    if (name === "multi_agents_integrate") {
      const task = run.tasks.find((value) => value.id === args.taskId);
      if (!task || task.status !== "succeeded" || !task.baseCommit || !task.resultCommit)
        throw new Error("该任务尚无可整合结果。");
      if (task.integratedCommit === task.resultCommit) return { integrated: true };
      if (
        task.dependsOn.some((id) => {
          const dependency = run.tasks.find((value) => value.id === id)!;
          return (
            dependency.status !== "succeeded" ||
            !dependency.resultCommit ||
            dependency.integratedCommit !== dependency.resultCommit
          );
        })
      )
        throw new Error("请先整合依赖任务。");
      try {
        await this.workspace.integrate(
          run.workspacePath,
          task.integratedCommit ?? task.baseCommit,
          task.resultCommit,
        );
      } catch (error) {
        task.integrationError = message(error);
        this.update(run);
        throw new Error(
          `整合冲突：${message(error)}。请用 multi_agents_status 中的提交 / 工作树检查变更，手动解决并测试，再调用 multi_agents_resolve_integration 记录证据。`,
        );
      }
      task.integratedCommit = task.resultCommit;
      delete task.integrationError;
      this.update(run);
      return { integrated: true, message: "变更已应用到主会话工作目录，请检查并测试。" };
    }
    if (name === "multi_agents_resolve_integration") {
      const task = run.tasks.find((task) => task.id === args.taskId);
      if (!task || task.status !== "succeeded" || !task.resultCommit || !task.integrationError)
        throw new Error("该任务没有待处理的整合冲突。");
      if (typeof args.review !== "string" || !args.review.trim())
        throw new Error("请提供手动解决冲突后的实际检查和测试证据。");
      task.integrationResolution = {
        review: args.review,
        workspaceCommit: await this.workspace.capture(run.workspacePath),
      };
      task.integratedCommit = task.resultCommit;
      delete task.integrationError;
      this.update(run);
      return { integrated: true, resolution: task.integrationResolution };
    }
    if (name === "multi_agents_accept") {
      if (typeof args.review !== "string" || !args.review.trim())
        throw new Error("必须提供实际验收和测试证据。");
      if (
        run.config.mode === "sessions" &&
        (!run.tasks.length ||
          run.tasks.some(
            (task) => task.status !== "succeeded" || task.integratedCommit !== task.resultCommit,
          ))
      )
        throw new Error("仍有未完成或未整合的任务，不能标记验收完成。");
      run.status = "completed";
      run.review = args.review;
      this.update(run);
      return { accepted: true };
    }
    throw new Error("未知 Multi-Agents 工具。");
  }
  async control(id: string, action: "pause" | "resume" | "stop") {
    return this.exclusive(id, () => this.executeControl(id, action));
  }
  private async executeControl(id: string, action: "pause" | "resume" | "stop") {
    const run = this.runs().find((value) => value.id === id);
    if (!run || !activeStatuses.has(run.status)) throw new Error("执行已结束。");
    if (action === "stop") {
      run.status = "cancelled";
      this.update(run);
      const ids = [
        ...run.tasks
          .filter((task) => task.status === "running" && task.threadId)
          .map((task) => task.threadId!),
        run.sourceThreadId,
      ];
      const outcomes = await Promise.allSettled(ids.map((threadId) => this.host.cancel(threadId)));
      const failed = new Set(
        outcomes.flatMap((outcome, index) => (outcome.status === "rejected" ? [ids[index]!] : [])),
      );
      const latest = this.runs().find((value) => value.id === id)!;
      for (const task of latest.tasks)
        if (["running", "queued"].includes(task.status) && !failed.has(task.threadId ?? ""))
          task.status = "cancelled";
      if (failed.size) {
        latest.status = "interrupted";
        latest.message = `部分会话停止失败，请检查后重试：${outcomes.flatMap((outcome, index) => (outcome.status === "rejected" ? [`${ids[index]}: ${message(outcome.reason)}`] : [])).join("；")}`;
      }
      this.update(latest);
      return latest;
    }
    if (action === "pause") {
      run.status = "paused";
      this.update(run);
      return run;
    }
    if (action !== "resume") throw new Error("未知调度操作。");
    if (this.host.thread(run.sourceThreadId)?.status === "awaiting_plan")
      throw new Error("计划审批尚未完成，请停止这次执行，再从计划卡片重新批准。");
    run.status = run.tasks.length
      ? run.tasks.every((task) => !["running", "queued"].includes(task.status))
        ? "awaiting_review"
        : "running"
      : run.config.mode === "subagents"
        ? "running"
        : "planning";
    delete run.message;
    this.update(run);
    await this.host.resume(
      run.sourceThreadId,
      `Multi-Agents ${run.id} 已由用户恢复。请调用 multi_agents_status 检查状态并继续调度或验收。`,
      `${run.id}:resume:${run.revision}`,
    );
    delete run.pendingNotification;
    this.save(run);
    return run;
  }
  private taskPrompt(run: MultiAgentsRun, task: MultiAgentsTask) {
    const member = run.config.members.find((value) => value.id === task.memberId)!;
    return `你是 Multi-Agents 成员 ${member.name}，职责：${member.responsibility}。仅执行主代理派发的任务，不向其他成员派发任务，不调用主代理的管理工具。\n${this.requestContext(run)}\n用户补充要求：${run.additionalMessage}\n任务 ${task.id}：${task.title}\n${task.instructions}\n范围：${JSON.stringify(task.scope)}\n验收标准：${task.acceptance}\n依赖结果：${JSON.stringify(run.tasks.filter((value) => task.dependsOn.includes(value.id)).map((value) => ({ taskId: value.id, result: value.result })))}\n在当前隔离工作树执行。不要切换或重置分支，不要操作其他成员或主会话的目录。完成后调用 mori_context.multi_agents_report，result 包含变更、测试证据和未解决事项，然后结束本轮。宿主会回收实际运行状态，主代理统一验收。`;
  }
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const initial of this.runs()) {
        if (
          !["running", "paused", "awaiting_review"].includes(initial.status) ||
          initial.config.mode !== "sessions"
        )
          continue;
        await this.exclusive(initial.id, async () => {
          let run = this.runs().find((value) => value.id === initial.id)!;
          if (!["running", "paused", "awaiting_review"].includes(run.status)) return;
          if (!this.host.thread(run.sourceThreadId)) {
            run.status = "interrupted";
            run.message = "来源主会话已删除，调度已中断。";
            this.update(run);
            return;
          }
          for (const task of run.tasks) {
            if (task.status !== "running" || !task.threadId) continue;
            const thread = this.host.thread(task.threadId);
            if (thread?.status === "awaiting_plan") {
              const error = thread.message || "成员等待用户处理计划或审批，请打开成员会话。";
              if (task.error !== error) {
                task.error = error;
                this.update(run);
              }
              continue;
            }
            if (task.error) {
              delete task.error;
              this.update(run);
            }
            if (this.host.busy(task.threadId)) continue;
            if (thread && ["running", "queued"].includes(thread.status)) continue;
            const attempt = thread ? this.host.latestAttempt(task.threadId) : undefined;
            if (
              !thread ||
              thread.status === "failed" ||
              thread.status === "blocked" ||
              !task.reported ||
              !attempt ||
              attempt.status !== "completed" ||
              attempt.attemptId !== task.reportAttemptId
            ) {
              task.status = "failed";
              task.error =
                thread?.message || "成员未提交结果，或宿主未确认对应运行成功结束（可能已停止 / 中断）。";
            } else {
              try {
                task.resultCommit = await this.workspace.capture(
                  thread.workLocation?.worktree?.worktreePath ?? "",
                );
                task.status = "succeeded";
              } catch (error) {
                task.status = "failed";
                task.error = message(error);
              }
            }
            this.update(run);
          }
          if (run.status === "paused") return;
          for (const task of run.tasks)
            if (
              task.status === "blocked" &&
              task.error === "依赖任务未完成，需要主代理处理。" &&
              task.dependsOn.every((id) => run.tasks.find((value) => value.id === id)?.status === "succeeded")
            ) {
              task.status = "queued";
              delete task.error;
              this.update(run);
            }
          for (const task of run.tasks)
            if (
              task.status === "queued" &&
              task.dependsOn.some((id) =>
                ["failed", "blocked", "cancelled"].includes(
                  run.tasks.find((value) => value.id === id)!.status,
                ),
              )
            ) {
              task.status = "blocked";
              task.error = "依赖任务未完成，需要主代理处理。";
              this.update(run);
            }
          for (const taskId of run.tasks.map((task) => task.id)) {
            const task = run.tasks.find((value) => value.id === taskId)!;
            if (
              task.status !== "queued" ||
              run.tasks.filter((value) => value.status === "running").length >= run.config.maxConcurrency
            )
              continue;
            if (
              task.dependsOn.some(
                (id) => run.tasks.find((value) => value.id === id)?.status !== "succeeded",
              ) ||
              run.tasks.some((value) => value.memberId === task.memberId && value.status === "running")
            )
              continue;
            try {
              const member = run.config.members.find((value) => value.id === task.memberId)!;
              {
                const dependencies: MultiAgentsTask[] = [];
                const collected = new Set<string>();
                const collect = (current: MultiAgentsTask) => {
                  for (const id of current.dependsOn) {
                    if (collected.has(id)) continue;
                    const dep = run.tasks.find((value) => value.id === id)!;
                    collect(dep);
                    collected.add(id);
                    dependencies.push(dep);
                  }
                };
                collect(task);
                const baseline = await this.workspace.compose(
                  run.workspacePath,
                  run.baselineCommit!,
                  dependencies.map((dep) => ({ base: dep.baseCommit!, result: dep.resultCommit! })),
                );
                if (task.threadId && task.baseCommit && task.baseCommit !== baseline) {
                  const cwd = this.host.thread(task.threadId)?.workLocation?.worktree?.worktreePath;
                  if (!cwd) throw new Error("成员工作树已丢失，不能复用会话返工。");
                  await this.workspace.integrate(cwd, task.baseCommit, baseline);
                }
                task.baseCommit = baseline;
              }
              const existingThreadId = task.threadId;
              task.threadId ??= `thr_${randomUUID()}`;
              task.status = "running";
              task.attempt++;
              task.reported = false;
              this.update(run); // Persist identity BEFORE starting, so restart cannot duplicate it.
              if (existingThreadId)
                await this.host.resume(
                  existingThreadId,
                  this.taskPrompt(run, task),
                  `${run.id}:${task.id}:${task.attempt}`,
                );
              else {
                try {
                  await this.host.start(
                    {
                      workspacePath: this.host.thread(run.sourceThreadId)!.workspacePath,
                      coreKind: member.coreKind,
                      runtimeConfig: member.runtimeConfig,
                      prompt: this.taskPrompt(run, task),
                      developmentMode: "isolated",
                    },
                    task.threadId,
                    `${member.name} · ${task.title}`,
                    task.baseCommit,
                  );
                } catch (error) {
                  // An explicit preparation failure may happen before a conversation exists.
                  // Keep real/deleted conversations intact; only release a never-created identity.
                  if (!this.host.thread(task.threadId)) delete task.threadId;
                  throw error;
                }
              }
            } catch (error) {
              task.status = "failed";
              task.error = message(error);
              this.update(run);
            }
            // report_result may have updated durable data while a host call awaited.
            run = this.runs().find((value) => value.id === run.id)!;
          }
          if (
            run.status === "running" &&
            run.tasks.length &&
            run.tasks.every((task) => !["running", "queued"].includes(task.status))
          ) {
            run.status = "awaiting_review";
            this.update(run);
            run.pendingNotification = {
              id: `${run.id}:results:${run.revision}`,
              text: `Multi-Agents ${run.id} 的成员执行已结束，尚未验收。\n${JSON.stringify(run.tasks.map(({ id, status, result, error, threadId }) => ({ id, status, result, error, threadId })))}\n请检查结果，失败时返工；成功时整合、实际验收，再调用 multi_agents_accept。`,
            };
            this.save(run);
          }
          if (run.pendingNotification) {
            try {
              await this.host.resume(
                run.sourceThreadId,
                run.pendingNotification.text,
                run.pendingNotification.id,
              );
              delete run.pendingNotification;
              delete run.message;
              run.notifiedRevision = run.revision;
              this.save(run);
            } catch (error) {
              run.message = `结果已保存，通知主代理失败：${message(error)}`;
              this.save(run);
            }
          }
        });
      }
    } finally {
      this.ticking = false;
    }
  }
}
