import type { ScheduleTrigger } from "../shared/scheduling";
import { messageDurationSeconds, type MessageDuration } from "./scheduled-message-form";
import { messageDurationFromSeconds } from "./scheduled-message-form";

export interface ScheduleTimingForm {
  triggerType: ScheduleTrigger["type"];
  at: string;
  interval: MessageDuration;
  cron: string;
  timezone: string;
  catchUp: MessageDuration;
}

export function localScheduleDate(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

export function scheduleTriggerFor(form: ScheduleTimingForm): ScheduleTrigger {
  if (form.triggerType === "cron") return { type: "cron", expression: form.cron, timezone: form.timezone };
  if (!form.at || !Number.isFinite(Date.parse(form.at))) throw new Error("请选择有效时间 / Choose a valid time");
  const at = new Date(form.at).toISOString();
  return form.triggerType === "at" ? { type: "at", at } : { type: "interval", everySeconds: messageDurationSeconds(form.interval), anchorAt: at };
}

export function scheduleCatchUpSeconds(form: ScheduleTimingForm): number {
  return messageDurationSeconds(form.catchUp);
}

/** Largest whole unit that fits, so a 36000-second interval reads as 10 hours. */
export function scheduleIntervalLabel(seconds: number): { key: string; options: Record<string, number> } {
  if (seconds > 0 && seconds % 86_400 === 0) return { key: "scheduling.everyDays", options: { days: seconds / 86_400 } };
  if (seconds % 3_600 === 0) return { key: "scheduling.everyHours", options: { hours: seconds / 3_600 } };
  return { key: "scheduling.everyMinutes", options: { minutes: Math.round(seconds / 60) } };
}

/** Saved interval as an amount + unit pair for the form field. */
export const scheduleIntervalDuration = messageDurationFromSeconds;
