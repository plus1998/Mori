import { useTranslation } from "react-i18next";
import { ScheduleDurationField } from "./ScheduleDurationField";
import type { ScheduleTimingForm } from "./schedule-form";

export function ScheduleTimingFields({ form, onChange }: {
  form: ScheduleTimingForm;
  onChange(update: Partial<ScheduleTimingForm>): void;
}) {
  const { t } = useTranslation();
  return <>
    <label>{t("scheduling.trigger")}<select value={form.triggerType} onChange={event => onChange({ triggerType: event.target.value as ScheduleTimingForm["triggerType"] })}>
      <option value="at">{t("scheduling.at")}</option><option value="interval">{t("scheduling.interval")}</option><option value="cron">Cron</option>
    </select></label>
    {form.triggerType === "cron" ? <div className="scheduling-fields">
      <label>{t("scheduling.cron")}<input required value={form.cron} onChange={event => onChange({ cron: event.target.value })}/></label>
      <label>{t("scheduling.timezone")}<input required value={form.timezone} onChange={event => onChange({ timezone: event.target.value })}/></label>
    </div> : <div className="scheduling-fields">
      <label>{t(form.triggerType === "at" ? "scheduling.time" : "scheduling.firstTime")}<input type="datetime-local" step={1} required value={form.at} onChange={event => onChange({ at: event.target.value })}/></label>
      {form.triggerType === "interval" && <ScheduleDurationField label={t("scheduling.repeatInterval")} value={form.interval} minSeconds={60} onChange={interval => onChange({ interval })}/>}
    </div>}
    <ScheduleDurationField label={t("scheduling.taskCatchUp")} value={form.catchUp} minSeconds={0} maxSeconds={86400} onChange={catchUp => onChange({ catchUp })}/>
  </>;
}
