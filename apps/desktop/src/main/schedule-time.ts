import { CronExpressionParser } from "cron-parser";
import type { ScheduleTrigger } from "../shared/scheduling";

const timestamp = (value: string): number => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("时间必须是包含时区的 ISO 时间戳。");
  }
  return Date.parse(value);
};

export function normalizeScheduleTrigger(trigger: ScheduleTrigger): ScheduleTrigger {
  if (!trigger || typeof trigger !== "object") throw new Error("缺少定时规则。");
  if (trigger.type === "at") return { type: "at", at: new Date(timestamp(trigger.at)).toISOString() };
  if (trigger.type === "interval") {
    if (!Number.isSafeInteger(trigger.everySeconds) || trigger.everySeconds < 60) throw new Error("间隔至少为 60 秒。");
    return { type: "interval", everySeconds: trigger.everySeconds, anchorAt: new Date(timestamp(trigger.anchorAt)).toISOString() };
  }
  if (trigger.type !== "cron") throw new Error("不支持的定时规则。");
  const expression = trigger.expression?.trim();
  if (!expression || expression.split(/\s+/).length !== 5 || /(^|[\s,])H(?:\b|\()/i.test(expression)) throw new Error("Cron 必须为五个字段，且不能包含随机 H 字段。");
  if (!trigger.timezone) throw new Error("Cron 必须指定 IANA 时区。");
  new Intl.DateTimeFormat("en", { timeZone: trigger.timezone }).format();
  CronExpressionParser.parse(expression, { tz: trigger.timezone }).next();
  return { type: "cron", expression, timezone: trigger.timezone };
}

/** Strictly after `after`; interval phase never drifts with actual dispatch time. */
export function nextScheduleTime(trigger: ScheduleTrigger, after: number): string | null {
  if (trigger.type === "at") return timestamp(trigger.at) > after ? trigger.at : null;
  if (trigger.type === "interval") {
    const anchor = timestamp(trigger.anchorAt);
    const step = trigger.everySeconds * 1000;
    return new Date(anchor + Math.max(0, Math.floor((after - anchor) / step) + 1) * step).toISOString();
  }
  return CronExpressionParser.parse(trigger.expression, { currentDate: after, tz: trigger.timezone }).next().toISOString();
}

/** Coalesce missed recurring ticks into the latest occurrence, never a burst. */
export function latestScheduleTime(trigger: ScheduleTrigger, now: number, firstDue: string): string {
  if (trigger.type === "at") return trigger.at;
  if (trigger.type === "interval") {
    const anchor = timestamp(trigger.anchorAt);
    return new Date(anchor + Math.floor((now - anchor) / (trigger.everySeconds * 1000)) * trigger.everySeconds * 1000).toISOString();
  }
  const previous = CronExpressionParser.parse(trigger.expression, { currentDate: now + 1, tz: trigger.timezone }).prev().toDate().toISOString();
  return previous < firstDue ? firstDue : previous;
}

export function previewSchedule(trigger: ScheduleTrigger, now = Date.now()): string[] {
  const normalized = normalizeScheduleTrigger(trigger);
  const result: string[] = [];
  for (let cursor = now, i = 0; i < 5; i++) {
    const next = nextScheduleTime(normalized, cursor);
    if (!next) break;
    result.push(next);
    cursor = Date.parse(next);
  }
  return result;
}
