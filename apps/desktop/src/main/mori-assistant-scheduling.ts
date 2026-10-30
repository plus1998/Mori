import { z } from "zod";
import { IPC_CHANNELS, type ThreadSummary } from "../shared/ipc";
import type { ScheduleDefinition, ScheduleExecutionProfile, SchedulingSnapshot } from "../shared/scheduling";
import type { AssistantTool } from "./mori-assistant-runtime";
import { moriScheduledActionSchema } from "../shared/mori-scheduled-action";

const id = z.string().trim().min(1);
const trigger = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("at"), at: id }),
  z.strictObject({ type: z.literal("interval"), everySeconds: z.number().int().min(60), anchorAt: id }),
  z.strictObject({ type: z.literal("cron"), expression: id, timezone: id }),
]);
const executionFields = {
  projectPath: id.optional(),
  sourceThreadId: id.optional(),
  coreKind: z.enum(["claude", "codex", "pi", "acp"]).optional(),
  providerId: id.optional(),
  modelId: id.optional(),
  mainAgentConfigId: id.optional(),
  cursorModelId: id.optional(),
};
const schemas = {
  mori_list_schedules: z.strictObject({
    projectPath: id.optional(),
    enabled: z.boolean().optional(),
    kind: z.enum(["scheduled_task", "session_message", "assistant_action"]).optional(),
    search: z.string().max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  mori_read_schedule: z.strictObject({
    id,
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(16000).optional(),
  }),
  mori_create_schedule: z.strictObject({
    requestId: id.max(160),
    name: id.max(200),
    prompt: id.max(100000),
    trigger,
    kind: z.enum(["scheduled_task", "session_message"]).optional(),
    threadId: id.optional(),
    maxLatenessSeconds: z.number().int().min(0).max(86400).optional(),
    ...executionFields,
  }),
  mori_update_schedule: z.strictObject({
    id,
    expectedRevision: z.number().int().min(1),
    name: id.max(200).optional(),
    prompt: id.max(100000).optional(),
    trigger: trigger.optional(),
    enabled: z.boolean().optional(),
    maxLatenessSeconds: z.number().int().min(0).max(86400).optional(),
    ...executionFields,
  }),
  mori_delete_schedule: z.strictObject({ id, expectedRevision: z.number().int().min(1) }),
  mori_preview_schedule: z.strictObject({ trigger }),
  mori_retry_schedule_notification: z.strictObject({ occurrenceId: id }),
  mori_create_assistant_schedule: z.strictObject({
    requestId: id.max(140),
    name: id.max(200),
    prompt: id.max(100000),
    action: moriScheduledActionSchema,
    delaySeconds: z.number().int().min(1).max(31536000).optional(),
    at: id.optional(),
    channel: z.enum(["desktop", "wechat"]).optional(),
    maxLatenessSeconds: z.number().int().min(0).max(86400).optional(),
  }),
};
type SchedulingToolName = keyof typeof schemas;
type ExecutionFields = z.infer<typeof schemas.mori_update_schedule>;
const descriptions: Record<SchedulingToolName, string> = {
  mori_retry_schedule_notification: "仅重发失败或状态不确定的定时操作通知，不重新执行任务。occurrenceId 从 mori_read_schedule 的近期执行记录读取。状态不确定时重发可能产生重复通知，应向用户说明。",
  mori_create_assistant_schedule:
    "按用户要求安排 Mori 自身的一次性提醒、检查任务或延时执行。多久后用 delaySeconds，指定时间用含时区的 at，两者必须选一个。action.type=reminder 直接提醒，不调用模型；check_task 必须给明确 taskThreadId，届时只读检查一次；execute 保存完整执行要求，可固定 projectPath 或 agentThreadId。自动绑定当前 Mori 会话，通知默认沿用请求渠道，可明确选 desktop/wechat。固定提醒默认允许迟到 5 分钟，其余默认 1 小时；应用退出或休眠不能保证准时。使用稳定 requestId 重试，只有成功返回才能说已安排。已有定时安排继续用 list/read/update/delete 管理。",
  mori_list_schedules:
    "查看全局定时任务和定时消息，包含设置页面或其他会话创建的项目。可按项目、启停状态、类型和名称/指令关键词筛选、分页。返回最新 revision、规则、下次运行时间和指令预览；完整配置与近期执行记录用 mori_read_schedule。",
  mori_read_schedule:
    "读取指定定时项目的最新 revision、完整运行配置，以及全局最近 200 次执行中该项目最多 10 条记录。指令长文按 offset/limit 分页。修改、删除前先读取；附图仅返回元数据，不读取图片原文。",
  mori_create_schedule:
    "按用户要求创建定时项目。默认 scheduled_task，每次运行新建独立工作会话，须明确 projectPath，或用 sourceThreadId 继承工作会话的项目及运行配置；否则使用桌面默认 Harness/Agent 配置，可明确指定模型。session_message 则须明确目标工作会话 threadId，沿用该会话配置。支持含时区 ISO 时间、至少 60 秒的固定间隔、带 IANA 时区的五字段 cron。requestId 使用唯一值，重试同一配置复用原值以避免重复创建。",
  mori_update_schedule:
    "按用户要求部分修改定时项目的名称、指令、规则、启停状态和补跑窗口；独立任务还可改项目、Harness、模型或从工作会话重新取得运行配置。必须提供最新 expectedRevision，冲突时重新读取。未指定字段保留原值；定时消息不能改目标会话或运行配置；已批准的定时计划保留原有内容限制。",
  mori_delete_schedule:
    "按用户要求删除指定定时项目，必须提供最新 expectedRevision。删除会取消尚未派发的执行，已经运行的工作会话继续执行；需要停止它时另用 mori_cancel_task。",
  mori_preview_schedule:
    "验证定时规则并预览接下来最多五次触发的 ISO 时间，不创建任务。用于核对时区、一次性日期、固定间隔和 cron。",
};
export const MORI_SCHEDULING_TOOLS: AssistantTool[] = Object.entries(schemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as SchedulingToolName],
  inputSchema: z.toJSONSchema(schema),
}));
export function isMoriSchedulingTool(name: string): boolean {
  return MORI_SCHEDULING_TOOLS.some((tool) => tool.name === name);
}
export const MORI_SCHEDULING_INSTRUCTIONS =
  "定时管理使用 mori_scheduling MCP 工具。用户说多久后提醒、多久后看看某任务、多久后帮我做事时，用 mori_create_assistant_schedule 创建 Mori 定时操作，分别选择 reminder、check_task、execute；不要改成即时执行或独立 Agent 定时任务。检查必须绑定准确任务 ID，只检查一次；执行要求保存完整，明确项目或指定 Agent 时一并保存。通知默认沿用请求渠道。仅按用户要求创建或变更；修改和删除前读取最新 revision。普通 Agent 定时任务继续用 mori_create_schedule。创建成功只表示已安排；告知准确触发时间、通知渠道及应用运行且电脑唤醒的条件，不得承诺唤醒休眠电脑。";

interface SchedulingAccess {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  defaultProfile(): ScheduleExecutionProfile;
  projectPath(value: string): string;
  workThread(id: string): ThreadSummary | undefined;
  assistantContext?(): { threadId: string; channel: "desktop" | "wechat"; messageId?: string };
}

export class MoriAssistantScheduling {
  constructor(private readonly access: SchedulingAccess) {}

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (name === "mori_retry_schedule_notification") {
      const input = schemas.mori_retry_schedule_notification.parse(args);
      await this.access.invoke(IPC_CHANNELS.schedulingRetryNotification, [input.occurrenceId]);
      return { notificationRetried: true, executionRepeated: false };
    }
    if (name === "mori_create_assistant_schedule") {
      const input = schemas.mori_create_assistant_schedule.parse(args);
      if ((input.delaySeconds === undefined) === (input.at === undefined)) throw new Error("delaySeconds 和 at 必须且只能提供一个。");
      const context = this.access.assistantContext?.();
      if (!context) throw new Error("缺少当前 Mori 会话，无法安排提醒。");
      if (input.action.type === "check_task") this.requireThread(input.action.taskThreadId);
      if (input.action.type === "execute") {
        if (input.action.projectPath) input.action.projectPath = this.access.projectPath(input.action.projectPath);
        if (input.action.agentThreadId) {
          const target = this.requireThread(input.action.agentThreadId);
          if (input.action.projectPath && input.action.projectPath !== target.workspacePath) throw new Error("指定 Agent 与项目不一致。");
        }
      }
      signal.throwIfAborted();
      const schedule = await this.access.invoke(IPC_CHANNELS.schedulingCreate, [{
        kind: "assistant_action", requestId: `mori-assistant:${context.threadId}:${input.requestId}`,
        name: input.name, prompt: input.prompt, threadId: context.threadId, action: input.action,
        notification: { channel: input.channel ?? context.channel, ...(context.messageId ? { messageId: context.messageId } : {}) },
        trigger: { type: "at", at: input.at ?? new Date(Date.now() + input.delaySeconds! * 1000).toISOString() },
        ...(input.delaySeconds !== undefined ? { delaySeconds: input.delaySeconds } : {}),
        maxLatenessSeconds: input.maxLatenessSeconds ?? (input.action.type === "reminder" ? 300 : 3600),
      }]) as ScheduleDefinition;
      return { schedule: summary(schedule), scheduled: true, requiresRunningApp: true, wakesSleepingComputer: false };
    }
    if (name === "mori_preview_schedule") {
      const input = schemas.mori_preview_schedule.parse(args);
      return { nextRuns: await this.access.invoke(IPC_CHANNELS.schedulingPreview, [input.trigger]) };
    }
    if (name === "mori_create_schedule") {
      const input = schemas.mori_create_schedule.parse(args);
      const common = {
        requestId: `mori-assistant:${input.requestId}`,
        name: input.name,
        prompt: input.prompt,
        trigger: input.trigger,
        ...(input.maxLatenessSeconds !== undefined ? { maxLatenessSeconds: input.maxLatenessSeconds } : {}),
      };
      let target: object;
      if (input.kind === "session_message") {
        if (hasExecutionFields(input)) throw new Error("定时消息沿用目标会话，不能指定项目或运行配置。");
        if (!input.threadId) throw new Error("定时消息必须提供目标工作会话 threadId。");
        this.requireThread(input.threadId);
        target = { kind: "session_message", threadId: input.threadId };
      } else {
        if (input.threadId) throw new Error("独立任务请用 sourceThreadId 继承配置，不能指定 threadId。");
        const source = input.sourceThreadId ? this.requireThread(input.sourceThreadId) : undefined;
        const projectPath = input.projectPath ?? source?.workspacePath;
        if (!projectPath) throw new Error("独立定时任务必须明确 projectPath 或 sourceThreadId。");
        target = {
          kind: "scheduled_task",
          workspacePath: this.access.projectPath(projectPath),
          executionProfile: this.profile(input, source ? this.threadProfile(source) : undefined),
        };
      }
      signal.throwIfAborted();
      const result = (await this.access.invoke(IPC_CHANNELS.schedulingCreate, [
        { ...common, ...target },
      ])) as ScheduleDefinition;
      return { schedule: summary(result), scheduled: true };
    }
    if (!isMoriSchedulingTool(name)) throw new Error("未知的 Mori 定时管理工具。");
    // Validate before reading the global snapshot, including all nested trigger fields.
    args = schemas[name as SchedulingToolName].parse(args);
    const snapshot = (await this.access.invoke(IPC_CHANNELS.schedulingList, [])) as SchedulingSnapshot;
    signal.throwIfAborted();
    if (name === "mori_list_schedules") {
      const input = schemas.mori_list_schedules.parse(args);
      const projectPath = input.projectPath ? this.access.projectPath(input.projectPath) : undefined;
      const search = input.search?.trim().toLocaleLowerCase();
      const matching = snapshot.schedules.filter(
        (item) =>
          (input.enabled === undefined || item.enabled === input.enabled) &&
          (input.kind === undefined || item.kind === input.kind) &&
          (!projectPath || this.scheduleProject(item) === projectPath) &&
          (!search || `${item.name}\n${item.prompt}`.toLocaleLowerCase().includes(search)),
      );
      const offset = input.offset ?? 0;
      const end = Math.min(matching.length, offset + (input.limit ?? 20));
      return {
        items: matching.slice(offset, end).map((item) => summary(item)),
        total: matching.length,
        nextOffset: end < matching.length ? end : null,
      };
    }
    const current = snapshot.schedules.find((item) => item.id === args.id);
    if (!current) throw new Error("定时项目不存在或已删除。");
    if (name === "mori_read_schedule") {
      const input = schemas.mori_read_schedule.parse(args);
      const characters = Array.from(current.prompt);
      const offset = input.offset ?? 0;
      const end = Math.min(characters.length, offset + (input.limit ?? 8000));
      const { attachments, creationSignature: _signature, ...definition } = current;
      return {
        schedule: {
          ...definition,
          prompt: characters.slice(offset, end).join(""),
          ...(attachments
            ? {
                attachments: attachments.map((image) => ({
                  mediaType: image.mediaType,
                  byteLength: image.byteLength,
                })),
              }
            : {}),
          totalCharacters: characters.length,
          nextOffset: end < characters.length ? end : null,
        },
        recentOccurrences: snapshot.occurrences
          .filter((item) => item.scheduleId === current.id)
          .slice(0, 10)
          .map(({ definition: _definition, ...run }) => ({ ...run,
            ...(run.assistant ? { assistant: { ...run.assistant, result: run.assistant.result?.slice(0, 1000), resultTruncated: (run.assistant.result?.length ?? 0) > 1000 } } : {}),
          })),
        occurrenceHistoryWindow: { globalLimit: 200, perScheduleLimit: 10 },
      };
    }
    if (current.revision !== args.expectedRevision)
      throw new Error("定时项目已被修改，请重新读取最新 revision 后再操作。");
    if (name === "mori_delete_schedule") {
      signal.throwIfAborted();
      await this.access.invoke(IPC_CHANNELS.schedulingDelete, [current.id, args.expectedRevision]);
      return { id: current.id, deleted: true, runningOccurrencesContinue: true };
    }
    const input = schemas.mori_update_schedule.parse(args);
    const {
      projectPath,
      sourceThreadId,
      coreKind,
      providerId,
      modelId,
      mainAgentConfigId,
      cursorModelId,
      ...changes
    } = input;
    if (Object.keys(changes).length === 2 && !hasExecutionFields(input))
      throw new Error("至少提供一个需要修改的字段。");
    const executionChanged = [
      sourceThreadId,
      coreKind,
      providerId,
      modelId,
      mainAgentConfigId,
      cursorModelId,
    ].some((value) => value !== undefined);
    if (current.kind !== "scheduled_task" && hasExecutionFields(input))
      throw new Error("定时消息不能修改项目或运行配置。");
    const source = sourceThreadId ? this.requireThread(sourceThreadId) : undefined;
    if (executionChanged && !source && !current.executionProfile)
      throw new Error("任务缺少原运行配置，请指定完整的来源工作会话。");
    const updated = {
      ...changes,
      ...(projectPath !== undefined || source
        ? { workspacePath: this.access.projectPath(projectPath ?? this.requireProject(source)) }
        : {}),
      ...(executionChanged
        ? {
            executionProfile: this.profile(
              input,
              source ? this.threadProfile(source) : current.executionProfile,
            ),
          }
        : {}),
    };
    signal.throwIfAborted();
    const result = (await this.access.invoke(IPC_CHANNELS.schedulingUpdate, [updated])) as ScheduleDefinition;
    return { schedule: summary(result), updated: true };
  }

  private requireThread(id: string): ThreadSummary {
    const thread = this.access.workThread(id);
    if (!thread) throw new Error("目标工作会话不存在，或目标是 Mori 助手自身。");
    return thread;
  }
  private requireProject(thread: ThreadSummary | undefined): string {
    if (!thread) throw new Error("任务缺少明确的项目。");
    return thread.workspacePath;
  }
  private scheduleProject(item: ScheduleDefinition): string | undefined {
    return item.kind === "scheduled_task"
      ? item.workspacePath
      : item.threadId
        ? this.access.workThread(item.threadId)?.workspacePath
        : undefined;
  }
  private threadProfile(thread: ThreadSummary): ScheduleExecutionProfile {
    if (!thread.coreKind || !thread.runtimeConfig) throw new Error("来源工作会话缺少 Harness 或运行配置。");
    return { coreKind: thread.coreKind, runtimeConfig: thread.runtimeConfig };
  }
  private profile(
    input: Partial<ExecutionFields>,
    base?: ScheduleExecutionProfile,
  ): ScheduleExecutionProfile {
    const profile = structuredClone(base ?? this.access.defaultProfile());
    if (input.coreKind) profile.coreKind = input.coreKind;
    const config = profile.runtimeConfig;
    if (input.mainAgentConfigId) {
      if (!config.orchestrationSelection)
        throw new Error("请先配置默认工作 Agent 组合或指定完整的来源工作会话。");
      config.orchestrationSelection.mainAgentConfigId = input.mainAgentConfigId;
      delete config.resolvedOrchestrationSnapshot;
      delete config.mainAgentModelOverride;
    }
    if ((input.providerId === undefined) !== (input.modelId === undefined))
      throw new Error("指定模型时必须同时提供 providerId 和 modelId。");
    if (profile.coreKind === "acp") {
      if (input.modelId || input.mainAgentConfigId)
        throw new Error("Cursor 任务使用 cursorModelId，不能指定 Provider 模型或主代理配置。");
      if (input.cursorModelId) config.cursorModelId = input.cursorModelId;
    } else {
      if (input.cursorModelId) throw new Error("cursorModelId 仅用于 Cursor (acp) 任务。");
      if (input.providerId && input.modelId)
        config.mainAgentModelOverride = { providerId: input.providerId, modelId: input.modelId };
    }
    return profile;
  }
}

function hasExecutionFields(input: Partial<ExecutionFields>): boolean {
  return Object.keys(executionFields).some((key) => input[key as keyof typeof executionFields] !== undefined);
}
function summary(item: ScheduleDefinition, promptLimit = 500) {
  const characters = Array.from(item.prompt);
  return {
    id: item.id,
    revision: item.revision,
    kind: item.kind,
    name: item.name,
    enabled: item.enabled,
    trigger: item.trigger,
    nextRunAt: item.nextRunAt,
    maxLatenessSeconds: item.maxLatenessSeconds,
    prompt: characters.slice(0, promptLimit).join(""),
    promptTruncated: characters.length > promptLimit,
    workspacePath: item.workspacePath,
    threadId: item.threadId,
    source: item.source,
    coreKind: item.executionProfile?.coreKind,
    imageCount: item.attachments?.length ?? 0,
    action: item.action,
    notification: item.notification,
    error: item.error,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
