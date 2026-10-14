import type { ScheduleDefinition, ScheduleTrigger } from "../shared/scheduling";
import { localScheduleDate } from "./schedule-form";

export type MessageTimeUnit = "minutes" | "hours" | "days";
export interface MessageDuration { amount: string; unit: MessageTimeUnit }
export const messageTimeUnitSeconds: Record<MessageTimeUnit, number> = { minutes: 60, hours: 3600, days: 86400 };

export interface ScheduledMessageForm {
  name: string;
  prompt: string;
  enabled: boolean;
  timingMode: "delay" | "schedule" | "interval" | "cron";
  duration: MessageDuration;
  at: string;
  cron: string;
  timezone: string;
  lateness: MessageDuration;
  originalAt: string | undefined;
}

export function messageDurationFromSeconds(seconds: number): MessageDuration {
  const unit = seconds !== 0 && seconds % 86400 === 0 ? "days" : seconds % 3600 === 0 ? "hours" : "minutes";
  return { amount: String(seconds / messageTimeUnitSeconds[unit]), unit };
}

export function messageDurationWithUnit(duration: MessageDuration, unit: MessageTimeUnit): MessageDuration {
  const amount = duration.amount.trim() && Number.isFinite(Number(duration.amount))
    ? String(Number(duration.amount) * messageTimeUnitSeconds[duration.unit] / messageTimeUnitSeconds[unit])
    : duration.amount;
  return { amount, unit };
}

export function messageDurationSeconds(duration: MessageDuration): number {
  const raw = Number(duration.amount) * messageTimeUnitSeconds[duration.unit];
  const seconds = Math.round(raw);
  // Unit conversion can introduce floating point noise for saved second-level intervals.
  if (!duration.amount.trim() || !Number.isSafeInteger(seconds) || Math.abs(raw - seconds) > 0.000001 || seconds < 0) {
    throw new Error("请设置有效时长（精确到秒） / Set a valid duration in whole seconds");
  }
  return seconds;
}

export function scheduledMessageLatenessFor(form: ScheduledMessageForm): number {
  const seconds = messageDurationSeconds(form.lateness);
  if (seconds > 86400) throw new Error("补发窗口不能超过 24 小时 / The catch-up window cannot exceed 24 hours");
  return seconds;
}

export function initialScheduledMessageForm(definition?: ScheduleDefinition, now = Date.now()): ScheduledMessageForm {
  const trigger = definition?.trigger;
  return {
    name: definition && definition.name !== scheduledMessageName({ name: "", prompt: definition.prompt }) ? definition.name : "",
    prompt: definition?.prompt ?? "", enabled: definition?.enabled ?? true,
    timingMode: trigger?.type === "interval" || trigger?.type === "cron" ? trigger.type : definition ? "schedule" : "delay",
    duration: trigger?.type === "interval" ? messageDurationFromSeconds(trigger.everySeconds) : { amount: "1", unit: "hours" },
    originalAt: trigger?.type === "at" ? trigger.at : trigger?.type === "interval" ? trigger.anchorAt : undefined,
    at: localScheduleDate(trigger?.type === "at" ? trigger.at : trigger?.type === "interval" ? trigger.anchorAt : new Date(now + 3600_000).toISOString()),
    cron: trigger?.type === "cron" ? trigger.expression : "0 9 * * *",
    timezone: trigger?.type === "cron" ? trigger.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
    lateness: messageDurationFromSeconds(definition?.maxLatenessSeconds ?? 86400),
  };
}

export function scheduledMessageTriggerFor(form: ScheduledMessageForm, now = Date.now()): ScheduleTrigger {
  if (form.timingMode === "cron") return { type: "cron", expression: form.cron, timezone: form.timezone };
  let seconds = 0;
  if (form.timingMode === "delay" || form.timingMode === "interval") {
    seconds = messageDurationSeconds(form.duration);
    if (seconds < 60) throw new Error("延迟或间隔至少为 1 分钟 / The delay or interval must be at least 1 minute");
  }
  if (form.timingMode === "delay") {
    const at = now + seconds * 1000;
    if (!Number.isFinite(new Date(at).getTime())) throw new Error("延迟超出有效时间范围 / The delay exceeds the valid date range");
    return { type: "at", at: new Date(at).toISOString() };
  }
  if (!form.at || !Number.isFinite(Date.parse(form.at))) throw new Error("请选择有效时间 / Choose a valid time");
  // datetime-local displays whole seconds. Body-only edits preserve the exact saved date.
  const at = form.originalAt && form.at === localScheduleDate(form.originalAt) ? form.originalAt : new Date(form.at).toISOString();
  return form.timingMode === "interval" ? { type: "interval", everySeconds: seconds, anchorAt: at } : { type: "at", at };
}

/** A separate title is optional for messages; the first line provides their list label. */
export function scheduledMessageName(form: Pick<ScheduledMessageForm, "name" | "prompt">): string {
  return form.name.trim() || form.prompt.trim().split(/\r?\n/, 1)[0]!.slice(0, 200);
}
