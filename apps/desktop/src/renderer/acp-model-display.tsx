import type { TFunction } from "i18next";
import type { AcpModelOption } from "../shared/acp-model-vendor";
import type { I18nKey } from "../shared/i18n-catalogs";

interface ModelTag {
  key: string;
  label: string;
  accent?: boolean;
}

const effortLabels = new Map<string, I18nKey>([
  ["off", "settings.acpModel.variant.effort.off"],
  ["none", "settings.acpModel.variant.effort.off"],
  ["minimal", "settings.acpModel.variant.effort.minimal"],
  ["low", "settings.acpModel.variant.effort.low"],
  ["medium", "settings.acpModel.variant.effort.medium"],
  ["high", "settings.acpModel.variant.effort.high"],
  ["xhigh", "settings.acpModel.variant.effort.xhigh"],
  ["max", "settings.acpModel.variant.effort.max"],
]);

export function describeAcpModel(model: AcpModelOption, t: TFunction): { label: string; tags: ModelTag[] } {
  const bracket = model.id.indexOf("[");
  if (bracket < 0 || !model.id.endsWith("]")) return { label: model.displayName, tags: [] };
  const label = model.displayName === model.id ? model.id.slice(0, bracket) : model.displayName;
  const options = new Map<string, string>();
  for (const item of model.id.slice(bracket + 1, -1).split(",")) {
    const equal = item.indexOf("=");
    if (equal < 0) continue;
    const key = item.slice(0, equal).trim();
    const value = item.slice(equal + 1).trim();
    if (key && value) options.set(key, value);
  }

  const tags: ModelTag[] = [];
  const context = options.get("context");
  if (context) {
    tags.push({ key: "context", label: t("settings.acpModel.variant.context", { size: context.toUpperCase() }) });
    options.delete("context");
  }
  for (const key of ["reasoning_effort", "effort"]) {
    const effort = options.get(key);
    const labelKey = effort && effortLabels.get(effort);
    if (labelKey) {
      tags.push({ key, label: t(labelKey) });
      options.delete(key);
    }
  }
  const fast = options.get("fast");
  if (fast === "true" || fast === "false") {
    tags.push({
      key: "fast",
      label: t(fast === "true" ? "settings.acpModel.variant.fast" : "settings.acpModel.variant.standard"),
      accent: fast === "true",
    });
    options.delete("fast");
  }
  for (const [key, value] of options) {
    tags.push({ key, label: `${key.replaceAll("_", " ")} · ${value}` });
  }
  return { label, tags };
}

export function AcpModelTags({ tags }: { tags: readonly ModelTag[] }) {
  return (
    <span className="acp-model-tags">
      {tags.map(tag => (
        <span key={tag.key} className={tag.accent ? "acp-model-tag is-fast" : "acp-model-tag"}>
          {tag.label}
        </span>
      ))}
    </span>
  );
}
