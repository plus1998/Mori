import { useId } from "react";
import { useTranslation } from "react-i18next";
import { messageDurationWithUnit, messageTimeUnitSeconds, type MessageDuration, type MessageTimeUnit } from "./scheduled-message-form";

/** Amount + unit pair (minutes / hours / days) so 600 minutes reads as 10 hours. */
export function ScheduleDurationField({ label, value, minSeconds, maxSeconds, suffix, onChange }: {
  label: string;
  value: MessageDuration;
  minSeconds: number;
  maxSeconds?: number | undefined;
  suffix?: string | undefined;
  onChange(value: MessageDuration): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const unitSeconds = messageTimeUnitSeconds[value.unit];
  return <div className="scheduled-message-duration-field">
    <label htmlFor={id}>{label}</label>
    <div className="scheduled-message-duration">
      <input id={id} type="number" min={minSeconds / unitSeconds} max={maxSeconds === undefined ? undefined : maxSeconds / unitSeconds} step="any" required value={value.amount} onChange={event => onChange({ ...value, amount: event.target.value })}/>
      <select aria-label={t("scheduling.durationUnit", { label })} value={value.unit} onChange={event => onChange(messageDurationWithUnit(value, event.target.value as MessageTimeUnit))}>
        <option value="minutes">{t("scheduling.minutes")}</option><option value="hours">{t("scheduling.hours")}</option><option value="days">{t("scheduling.days")}</option>
      </select>{suffix && <span>{suffix}</span>}
    </div>
  </div>;
}
