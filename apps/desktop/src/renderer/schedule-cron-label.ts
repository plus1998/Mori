import cronstrue from "cronstrue";
import "cronstrue/locales/zh_CN";
import type { ScheduleTrigger } from "../shared/scheduling";

/** Describe the saved wall-clock rule without converting it to the viewer's timezone. */
export function scheduleCronLabel(
  trigger: Extract<ScheduleTrigger, { type: "cron" }>,
  language: string,
): string {
  const chinese = language.toLowerCase().startsWith("zh");
  const daily = trigger.expression.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  const description = chinese && daily && Number(daily[1]) < 60 && Number(daily[2]) < 24
    ? `每天${Number(daily[2])}点${Number(daily[1]) === 0 ? "整" : `${Number(daily[1])}分`}`
    : cronstrue.toString(trigger.expression, {
      locale: chinese ? "zh_CN" : "en",
      use24HourTimeFormat: true,
      verbose: Boolean(daily),
      dayOfWeekStartIndexZero: true,
      logicalAndDayFields: false,
      throwExceptionOnParseError: true,
    });
  return `${description} · ${trigger.timezone}`;
}
