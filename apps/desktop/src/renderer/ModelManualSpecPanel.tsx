import { RotateCcw } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelsDevMapping, RouteCapabilityHint, RoutePricingHint } from "../shared/ipc";
import { multiplyUnitRate } from "../shared/manual-spec-pricing";
import {
  catalogCapabilityHint,
  catalogPricingHint,
  countManualOverrides,
  emptyManualSpecForm,
  formatCatalogMappingLabel,
  formatTokenCountHint,
  isPriceMultiplierOverrideValue,
  isRateFormValueValid,
  isTokenFormValueValid,
  listManualOverrideFields,
  type ManualSpecFormFields,
  type ManualTriState,
  mergeEffectiveCapabilityHint,
  mergeEffectivePricingHint,
  parsePriceMultiplierFormValue,
  tryFormToManualSpec,
} from "./agent-resource-manual-spec-form";
import { ModelsDevCatalogReferencePanel } from "./ModelSpecSummary";

interface ModelManualSpecPanelProps {
  value: ManualSpecFormFields;
  autoCapability?: RouteCapabilityHint;
  autoPricing?: RoutePricingHint;
  mapping?: ModelsDevMapping;
  disabled?: boolean;
  /** sidebar = 候选模型侧栏，单列对齐布局；editor = 候选模型编辑区（服务商表单让位后的整块区域） */
  variant?: "default" | "sidebar" | "editor";
  onChange: (patch: Partial<ManualSpecFormFields>) => void;
}

function TriStateField({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: ManualTriState;
  disabled?: boolean;
  onChange: (value: ManualTriState) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ value: ManualTriState; label: string }> = [
    { value: "auto", label: t("modelSpec.auto") },
    { value: "yes", label: t("modelSpec.supported") },
    { value: "no", label: t("modelSpec.unsupported") },
  ];
  return (
    <div className="model-spec-field model-spec-field-tristate">
      <span className="model-spec-field-label">{label}</span>
      {hint ? <span className="model-spec-field-caption">catalog · {hint}</span> : null}
      <div className="model-spec-segmented" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`model-spec-segmented-btn${value === option.value ? " is-active" : ""}`}
            aria-pressed={value === option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumericField({
  label,
  value,
  placeholder,
  caption,
  disabled,
  inputMode = "numeric",
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  caption?: string;
  disabled?: boolean;
  inputMode?: "numeric" | "decimal";
  onChange: (value: string) => void;
}) {
  return (
    <label className="model-spec-field">
      <span className="model-spec-field-label">{label}</span>
      <input
        className="model-spec-field-input"
        type="text"
        inputMode={inputMode}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {caption ? <span className="model-spec-field-caption">{caption}</span> : null}
    </label>
  );
}

const CONTEXT_PRESETS = [131_072, 262_144, 524_288, 1_048_576];
const OUTPUT_PRESETS = [8_192, 16_384, 32_768, 65_536, 131_072, 262_144];

function formatTokenPresetLabel(value: number): string {
  if (value >= 1_048_576 && value % 1_048_576 === 0) {
    return `${value / 1_048_576}M`;
  }
  return `${value / 1024}K`;
}

function parseTokenInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  let multiplier = 1;
  let numericPart = lower;
  if (lower.endsWith("k")) {
    multiplier = 1024;
    numericPart = lower.slice(0, -1);
  } else if (lower.endsWith("m")) {
    multiplier = 1048576;
    numericPart = lower.slice(0, -1);
  }
  const parsed = Number(numericPart);
  if (!numericPart.trim() || !Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * multiplier);
}

function TokenPresetField({
  label,
  value,
  presets,
  placeholder,
  caption,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  presets: readonly number[];
  placeholder?: string;
  caption?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const presetsId = useId();
  const inputId = useId();
  return (
    <div className="model-spec-field">
      <label className="model-spec-field-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className="model-spec-field-input"
        type="text"
        inputMode="numeric"
        list={presetsId}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        onBlur={(event) => {
          const raw = event.target.value;
          const parsed = parseTokenInput(raw);
          if (parsed !== undefined && /[km]$/i.test(raw.trim())) onChange(String(parsed));
        }}
      />
      <datalist id={presetsId}>
        {presets.map((preset) => (
          <option key={preset} value={preset} label={formatTokenPresetLabel(preset)} />
        ))}
      </datalist>
      {caption ? <span className="model-spec-field-caption">{caption}</span> : null}
    </div>
  );
}

/** 候选模型编辑区：字段被覆盖时只靠 accent 边框 + reload 图标表达，不写“已覆盖”文字。 */
function EditorResetButton({
  label,
  disabled,
  onReset,
}: {
  label: string;
  disabled?: boolean | undefined;
  onReset: () => void;
}) {
  return (
    <button
      type="button"
      className="candidate-editor-reset-btn"
      disabled={disabled}
      onClick={onReset}
      title={label}
      aria-label={label}
    >
      <RotateCcw size={12} aria-hidden />
    </button>
  );
}

function EditorTokenField({
  label,
  value,
  presets,
  placeholder,
  catalogHint,
  hint,
  errorText,
  resetLabel,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  value: string;
  presets: readonly number[];
  placeholder?: string | undefined;
  catalogHint?: string | undefined;
  hint?: string | undefined;
  errorText: string;
  resetLabel: string;
  disabled?: boolean | undefined;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const overridden = value.trim() !== "";
  const invalid = !isTokenFormValueValid(value);
  return (
    <div
      className={`candidate-editor-field${overridden ? " is-overridden" : ""}${invalid ? " is-invalid" : ""}`}
    >
      <div className="candidate-editor-field-head">
        <span className="candidate-editor-field-label">{label}</span>
        {overridden ? <EditorResetButton label={resetLabel} disabled={disabled} onReset={onReset} /> : null}
      </div>
      <input
        className="candidate-editor-input is-mono"
        type="text"
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => {
          const parsed = parseTokenInput(event.target.value);
          if (parsed !== undefined && /[km]$/i.test(event.target.value.trim())) {
            onChange(String(parsed));
          }
        }}
      />
      <div className="candidate-editor-presets">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`candidate-editor-preset${value.trim() === String(preset) ? " is-on" : ""}`}
            disabled={disabled}
            onClick={() => onChange(String(preset))}
          >
            {formatTokenPresetLabel(preset)}
          </button>
        ))}
      </div>
      {catalogHint || hint ? (
        <span className="candidate-editor-caption">{[catalogHint, hint].filter(Boolean).join(" · ")}</span>
      ) : null}
      {invalid ? <span className="candidate-editor-error">{errorText}</span> : null}
    </div>
  );
}

function EditorPriceField({
  label,
  value,
  placeholder,
  errorText,
  resetLabel,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  value: string;
  placeholder?: string | undefined;
  errorText: string;
  resetLabel: string;
  disabled?: boolean | undefined;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const overridden = value.trim() !== "";
  const invalid = !isRateFormValueValid(value);
  return (
    <div
      className={`candidate-editor-field${overridden ? " is-overridden" : ""}${invalid ? " is-invalid" : ""}`}
    >
      <div className="candidate-editor-field-head">
        <span className="candidate-editor-field-label">{label}</span>
        {overridden ? <EditorResetButton label={resetLabel} disabled={disabled} onReset={onReset} /> : null}
      </div>
      <div className="candidate-editor-input-wrap">
        <span className="candidate-editor-input-prefix" aria-hidden>
          $
        </span>
        <input
          className="candidate-editor-input is-mono has-prefix"
          type="text"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {invalid ? <span className="candidate-editor-error">{errorText}</span> : null}
    </div>
  );
}

function EditorSegmented({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: ManualTriState;
  disabled?: boolean | undefined;
  onChange: (value: ManualTriState) => void;
}) {
  const { t } = useTranslation();
  const options: ManualTriState[] = ["auto", "yes", "no"];
  const labels: Record<ManualTriState, string> = {
    auto: t("modelSpec.auto"),
    yes: t("modelSpec.supported"),
    no: t("modelSpec.unsupported"),
  };
  return (
    <div className="candidate-editor-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`candidate-editor-seg-btn${value === option ? " is-active" : ""}`}
          aria-pressed={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

function EditorCapabilityRow({
  title,
  catalogHint,
  overridden,
  resetLabel,
  disabled,
  onReset,
  children,
}: {
  title: string;
  catalogHint?: string | undefined;
  overridden: boolean;
  resetLabel: string;
  disabled?: boolean | undefined;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`candidate-editor-cap-row${overridden ? " is-overridden" : ""}`}>
      <div className="candidate-editor-cap-left">
        <span className="candidate-editor-cap-title">{title}</span>
        {catalogHint ? <span className="candidate-editor-caption">{catalogHint}</span> : null}
      </div>
      <div className="candidate-editor-cap-right">
        {overridden ? <EditorResetButton label={resetLabel} disabled={disabled} onReset={onReset} /> : null}
        {children}
      </div>
    </div>
  );
}

export function ModelManualSpecPanel({
  value,
  autoCapability,
  autoPricing,
  mapping,
  disabled,
  variant = "default",
  onChange,
}: ModelManualSpecPanelProps) {
  const { t } = useTranslation();
  const nativeWebSearchLabelId = useId();
  const remoteCompactionLabelId = useId();
  const isSidebar = variant === "sidebar";
  const overrideCount = countManualOverrides(value);
  const [expanded, setExpanded] = useState(() => isSidebar || overrideCount > 0);

  const catalogCapability = catalogCapabilityHint(autoCapability);
  const catalogPricing = catalogPricingHint(autoPricing);

  const autoContextHint = formatTokenCountHint(catalogCapability?.contextTokens);
  const autoOutputHint = formatTokenCountHint(catalogCapability?.maxOutputTokens);
  const autoImageHint =
    catalogCapability?.supportsImageInput === true
      ? t("modelSpec.supported")
      : catalogCapability?.supportsImageInput === false
        ? t("modelSpec.unsupported")
        : undefined;
  const autoReasoningHint =
    catalogCapability?.supportsReasoning === true
      ? t("modelSpec.supported")
      : catalogCapability?.supportsReasoning === false
        ? t("modelSpec.unsupported")
        : undefined;

  const title =
    overrideCount > 0
      ? t("modelSpec.manualOverridesCount", { count: overrideCount })
      : t("modelSpec.manualOverrides");

  const multiplier = parsePriceMultiplierFormValue(value.priceMultiplier);
  const catalogRates = catalogPricing?.rates;
  const effectiveInputPerM = multiplyUnitRate(catalogRates?.inputPerM, multiplier);
  const effectiveOutputPerM = multiplyUnitRate(catalogRates?.outputPerM, multiplier);
  const effectiveCacheReadPerM = multiplyUnitRate(catalogRates?.cacheReadPerM, multiplier);
  const effectiveCacheWritePerM = multiplyUnitRate(catalogRates?.cacheWritePerM, multiplier);
  const catalogMappingLabel = formatCatalogMappingLabel(autoCapability, autoPricing, mapping);
  const multiplierCaption =
    catalogRates?.inputPerM !== undefined && catalogRates.outputPerM !== undefined
      ? t("modelSpec.multiplierCaption", {
          catalogInput: catalogRates.inputPerM,
          catalogOutput: catalogRates.outputPerM,
          effectiveInput: formatRateHint(effectiveInputPerM),
          effectiveOutput: formatRateHint(effectiveOutputPerM),
        })
      : undefined;

  const body = (
    <div className="model-manual-spec-body">
      <ModelsDevCatalogReferencePanel
        compact
        {...(autoCapability ? { capability: autoCapability } : {})}
        {...(autoPricing ? { pricing: autoPricing } : {})}
        {...(catalogMappingLabel ? { mappingLabel: catalogMappingLabel } : {})}
      />

      <section className="model-spec-form-section">
        <h4 className="model-spec-form-section-title">{t("modelSpec.contextAndOutput")}</h4>
        <div className="model-spec-form-grid">
          <TokenPresetField
            label={t("modelSpec.contextLimit")}
            value={value.contextTokens}
            presets={CONTEXT_PRESETS}
            placeholder={autoContextHint ?? "tokens"}
            {...(autoContextHint ? { caption: t("modelSpec.catalogHint", { hint: autoContextHint }) } : {})}
            {...(disabled !== undefined ? { disabled } : {})}
            onChange={(contextTokens) => onChange({ contextTokens })}
          />
          <TokenPresetField
            label={t("modelSpec.maxOutput")}
            value={value.maxOutputTokens}
            presets={OUTPUT_PRESETS}
            placeholder={autoOutputHint ?? "tokens"}
            {...(autoOutputHint ? { caption: t("modelSpec.catalogHint", { hint: autoOutputHint }) } : {})}
            {...(disabled !== undefined ? { disabled } : {})}
            onChange={(maxOutputTokens) => onChange({ maxOutputTokens })}
          />
        </div>
      </section>

      <section className="model-spec-form-section">
        <h4 className="model-spec-form-section-title">{t("modelSpec.capabilities")}</h4>
        <div className="model-spec-form-grid model-spec-form-grid--stack">
          <TriStateField
            label={t("modelSpec.multimodal")}
            {...(autoImageHint ? { hint: autoImageHint } : {})}
            value={value.supportsImageInput}
            {...(disabled !== undefined ? { disabled } : {})}
            onChange={(supportsImageInput) => onChange({ supportsImageInput })}
          />
          <TriStateField
            label={t("modelSpec.reasoning")}
            {...(autoReasoningHint ? { hint: autoReasoningHint } : {})}
            value={value.supportsReasoning}
            {...(disabled !== undefined ? { disabled } : {})}
            onChange={(supportsReasoning) => onChange({ supportsReasoning })}
          />
          <label className="model-spec-field model-spec-field-checkbox">
            <span className="model-spec-field-label" id={nativeWebSearchLabelId}>
              {t("modelSpec.nativeWebSearch")}
            </span>
            <span
              className="mcp-toggle mcp-toggle-sm"
              title={
                value.supportsNativeWebSearch
                  ? t("modelSpec.nativeWebSearch")
                  : t("modelSpec.nativeWebSearchOff")
              }
            >
              <input
                type="checkbox"
                checked={value.supportsNativeWebSearch}
                disabled={disabled}
                aria-labelledby={nativeWebSearchLabelId}
                onChange={(event) => onChange({ supportsNativeWebSearch: event.target.checked })}
              />
              <span className="mcp-toggle-track" aria-hidden />
            </span>
          </label>
          <label
            className="model-spec-field model-spec-field-checkbox"
            title={t("modelSpec.remoteCompactionHint")}
          >
            <span className="model-spec-field-label" id={remoteCompactionLabelId}>
              {t("modelSpec.remoteCompaction")}
            </span>
            <span className="mcp-toggle mcp-toggle-sm">
              <input
                type="checkbox"
                checked={value.supportsRemoteCompaction}
                disabled={disabled}
                aria-labelledby={remoteCompactionLabelId}
                onChange={(event) => onChange({ supportsRemoteCompaction: event.target.checked })}
              />
              <span className="mcp-toggle-track" aria-hidden />
            </span>
          </label>
        </div>
      </section>

      <section className="model-spec-form-section">
        <h4 className="model-spec-form-section-title">{t("modelSpec.pricing")}</h4>
        <div className="model-spec-form-grid model-spec-form-grid--pricing">
          <NumericField
            label={t("modelSpec.input")}
            value={value.inputPerM}
            placeholder={formatRatePlaceholder(
              catalogRates?.inputPerM,
              effectiveInputPerM,
              t("modelSpec.input"),
            )}
            {...(disabled !== undefined ? { disabled } : {})}
            inputMode="decimal"
            onChange={(inputPerM) => onChange({ inputPerM })}
          />
          <NumericField
            label={t("modelSpec.output")}
            value={value.outputPerM}
            placeholder={formatRatePlaceholder(
              catalogRates?.outputPerM,
              effectiveOutputPerM,
              t("modelSpec.output"),
            )}
            {...(disabled !== undefined ? { disabled } : {})}
            inputMode="decimal"
            onChange={(outputPerM) => onChange({ outputPerM })}
          />
          <NumericField
            label={t("modelSpec.cacheRead")}
            value={value.cacheReadPerM}
            placeholder={formatRatePlaceholder(
              catalogRates?.cacheReadPerM,
              effectiveCacheReadPerM,
              t("modelSpec.cacheRead"),
            )}
            {...(disabled !== undefined ? { disabled } : {})}
            inputMode="decimal"
            onChange={(cacheReadPerM) => onChange({ cacheReadPerM })}
          />
          <NumericField
            label={t("modelSpec.cacheWrite")}
            value={value.cacheWritePerM}
            placeholder={formatRatePlaceholder(
              catalogRates?.cacheWritePerM,
              effectiveCacheWritePerM,
              t("modelSpec.cacheWrite"),
            )}
            {...(disabled !== undefined ? { disabled } : {})}
            inputMode="decimal"
            onChange={(cacheWritePerM) => onChange({ cacheWritePerM })}
          />
        </div>
      </section>

      <section className="model-spec-form-section model-spec-form-section--multiplier">
        <NumericField
          label={t("modelSpec.priceMultiplier")}
          value={value.priceMultiplier}
          placeholder="x1"
          {...(multiplierCaption ? { caption: multiplierCaption } : {})}
          {...(disabled !== undefined ? { disabled } : {})}
          inputMode="decimal"
          onChange={(priceMultiplier) => onChange({ priceMultiplier })}
        />
      </section>
    </div>
  );

  const isEditor = variant === "editor";
  const editorBody = isEditor ? (
    <section className="candidate-editor-section">
      <div className="candidate-editor-section-head">
        <h4 className="candidate-editor-section-title">{t("modelSpec.manualOverrides")}</h4>
        <div className="candidate-editor-section-actions">
          {overrideCount > 0 ? (
            <span className="candidate-editor-badge">
              {t("modelSpec.overrideCount", { count: overrideCount })}
            </span>
          ) : null}
          <button
            type="button"
            className="candidate-editor-reset-all"
            disabled={Boolean(disabled) || overrideCount === 0}
            onClick={() => onChange(emptyManualSpecForm())}
          >
            {t("modelSpec.resetAllAuto")}
          </button>
        </div>
      </div>

      <h5 className="candidate-editor-subtitle">{t("modelSpec.contextAndOutput")}</h5>
      <div className="candidate-editor-grid candidate-editor-grid--2">
        <EditorTokenField
          label={t("modelSpec.contextLimit")}
          value={value.contextTokens}
          presets={CONTEXT_PRESETS}
          placeholder={autoContextHint ?? "tokens"}
          {...(autoContextHint ? { catalogHint: t("modelSpec.catalogHint", { hint: autoContextHint }) } : {})}
          hint={t("candidateModels.tokenSuffixHint")}
          errorText={t("modelSpec.tokenInvalid")}
          resetLabel={t("modelSpec.resetAuto")}
          {...(disabled !== undefined ? { disabled } : {})}
          onChange={(contextTokens) => onChange({ contextTokens })}
          onReset={() => onChange({ contextTokens: "" })}
        />
        <EditorTokenField
          label={t("modelSpec.maxOutput")}
          value={value.maxOutputTokens}
          presets={OUTPUT_PRESETS}
          placeholder={autoOutputHint ?? "tokens"}
          {...(autoOutputHint ? { catalogHint: t("modelSpec.catalogHint", { hint: autoOutputHint }) } : {})}
          errorText={t("modelSpec.tokenInvalid")}
          resetLabel={t("modelSpec.resetAuto")}
          {...(disabled !== undefined ? { disabled } : {})}
          onChange={(maxOutputTokens) => onChange({ maxOutputTokens })}
          onReset={() => onChange({ maxOutputTokens: "" })}
        />
      </div>

      <h5 className="candidate-editor-subtitle">{t("modelSpec.capabilities")}</h5>
      <div className="candidate-editor-caps">
        <EditorCapabilityRow
          title={t("modelSpec.multimodal")}
          {...(autoImageHint ? { catalogHint: t("modelSpec.catalogHint", { hint: autoImageHint }) } : {})}
          overridden={value.supportsImageInput !== "auto"}
          resetLabel={t("modelSpec.resetAuto")}
          {...(disabled !== undefined ? { disabled } : {})}
          onReset={() => onChange({ supportsImageInput: "auto" })}
        >
          <EditorSegmented
            label={t("modelSpec.multimodal")}
            value={value.supportsImageInput}
            {...(disabled !== undefined ? { disabled } : {})}
            onChange={(supportsImageInput) => onChange({ supportsImageInput })}
          />
        </EditorCapabilityRow>
        <EditorCapabilityRow
          title={t("modelSpec.reasoning")}
          {...(autoReasoningHint
            ? { catalogHint: t("modelSpec.catalogHint", { hint: autoReasoningHint }) }
            : {})}
          overridden={value.supportsReasoning !== "auto"}
          resetLabel={t("modelSpec.resetAuto")}
          {...(disabled !== undefined ? { disabled } : {})}
          onReset={() => onChange({ supportsReasoning: "auto" })}
        >
          <EditorSegmented
            label={t("modelSpec.reasoning")}
            value={value.supportsReasoning}
            {...(disabled !== undefined ? { disabled } : {})}
            onChange={(supportsReasoning) => onChange({ supportsReasoning })}
          />
        </EditorCapabilityRow>
        <EditorCapabilityRow
          title={t("modelSpec.nativeWebSearch")}
          catalogHint={
            value.supportsNativeWebSearch ? t("modelSpec.defaultSource") : t("modelSpec.nativeWebSearchOff")
          }
          overridden={!value.supportsNativeWebSearch}
          resetLabel={t("modelSpec.resetAuto")}
          {...(disabled !== undefined ? { disabled } : {})}
          onReset={() => onChange({ supportsNativeWebSearch: true })}
        >
          <label className="mcp-toggle mcp-toggle-sm">
            <input
              type="checkbox"
              checked={value.supportsNativeWebSearch}
              disabled={disabled}
              aria-label={t("modelSpec.nativeWebSearch")}
              onChange={(event) => onChange({ supportsNativeWebSearch: event.target.checked })}
            />
            <span className="mcp-toggle-track" aria-hidden />
          </label>
        </EditorCapabilityRow>
        <EditorCapabilityRow
          title={t("modelSpec.remoteCompaction")}
          catalogHint={t("modelSpec.remoteCompactionHint")}
          overridden={value.supportsRemoteCompaction}
          resetLabel={t("modelSpec.resetAuto")}
          {...(disabled !== undefined ? { disabled } : {})}
          onReset={() => onChange({ supportsRemoteCompaction: false })}
        >
          <label className="mcp-toggle mcp-toggle-sm">
            <input
              type="checkbox"
              checked={value.supportsRemoteCompaction}
              disabled={disabled}
              aria-label={t("modelSpec.remoteCompaction")}
              onChange={(event) => onChange({ supportsRemoteCompaction: event.target.checked })}
            />
            <span className="mcp-toggle-track" aria-hidden />
          </label>
        </EditorCapabilityRow>
      </div>

      <h5 className="candidate-editor-subtitle">{t("modelSpec.pricingPerM")}</h5>
      <div className="candidate-editor-grid candidate-editor-grid--4">
        <EditorPriceField
          label={t("modelSpec.input")}
          value={value.inputPerM}
          placeholder={formatRatePlaceholder(catalogRates?.inputPerM, effectiveInputPerM)}
          errorText={t("modelSpec.rateInvalid")}
          resetLabel={t("modelSpec.resetAuto")}
          {...(disabled !== undefined ? { disabled } : {})}
          onChange={(inputPerM) => onChange({ inputPerM })}
          onReset={() => onChange({ inputPerM: "" })}
        />
        <EditorPriceField
          label={t("modelSpec.output")}
          value={value.outputPerM}
          placeholder={formatRatePlaceholder(catalogRates?.outputPerM, effectiveOutputPerM)}
          errorText={t("modelSpec.rateInvalid")}
          resetLabel={t("modelSpec.resetAuto")}
          {...(disabled !== undefined ? { disabled } : {})}
          onChange={(outputPerM) => onChange({ outputPerM })}
          onReset={() => onChange({ outputPerM: "" })}
        />
        <EditorPriceField
          label={t("modelSpec.cacheRead")}
          value={value.cacheReadPerM}
          placeholder={formatRatePlaceholder(catalogRates?.cacheReadPerM, effectiveCacheReadPerM)}
          errorText={t("modelSpec.rateInvalid")}
          resetLabel={t("modelSpec.resetAuto")}
          {...(disabled !== undefined ? { disabled } : {})}
          onChange={(cacheReadPerM) => onChange({ cacheReadPerM })}
          onReset={() => onChange({ cacheReadPerM: "" })}
        />
        <EditorPriceField
          label={t("modelSpec.cacheWrite")}
          value={value.cacheWritePerM}
          placeholder={formatRatePlaceholder(catalogRates?.cacheWritePerM, effectiveCacheWritePerM)}
          errorText={t("modelSpec.rateInvalid")}
          resetLabel={t("modelSpec.resetAuto")}
          {...(disabled !== undefined ? { disabled } : {})}
          onChange={(cacheWritePerM) => onChange({ cacheWritePerM })}
          onReset={() => onChange({ cacheWritePerM: "" })}
        />
      </div>

      <div
        className={`candidate-editor-mult-banner${
          isPriceMultiplierOverrideValue(value.priceMultiplier) ? " is-overridden" : ""
        }`}
      >
        <div className="candidate-editor-mult-left">
          <div className="candidate-editor-field-head">
            <span className="candidate-editor-field-label">{t("modelSpec.priceMultiplier")}</span>
            {isPriceMultiplierOverrideValue(value.priceMultiplier) ? (
              <EditorResetButton
                label={t("modelSpec.resetAuto")}
                disabled={disabled}
                onReset={() => onChange({ priceMultiplier: "1" })}
              />
            ) : null}
          </div>
          <input
            className="candidate-editor-input is-mono candidate-editor-mult-input"
            type="text"
            inputMode="decimal"
            value={value.priceMultiplier}
            placeholder="1"
            disabled={disabled}
            onChange={(event) => onChange({ priceMultiplier: event.target.value })}
          />
          <span className="candidate-editor-mult-times" aria-hidden>
            ×
          </span>
        </div>
        <span className="candidate-editor-caption candidate-editor-mult-caption">
          {multiplierCaption ??
            t("modelSpec.multiplierCaption", {
              catalogInput: catalogRates?.inputPerM ?? "—",
              catalogOutput: catalogRates?.outputPerM ?? "—",
              effectiveInput: formatRateHint(effectiveInputPerM),
              effectiveOutput: formatRateHint(effectiveOutputPerM),
            })}
        </span>
      </div>
    </section>
  ) : null;

  if (isEditor) {
    return <div className="candidate-editor-spec">{editorBody}</div>;
  }

  if (isSidebar) {
    return (
      <div className="model-manual-spec model-manual-spec--sidebar">
        <div className="model-manual-spec-sidebar-head">
          <h3 className="model-manual-spec-sidebar-title">{t("modelSpec.manualOverrides")}</h3>
          {overrideCount > 0 ? (
            <span className="model-manual-spec-sidebar-badge">
              {t("modelSpec.overrideCount", { count: overrideCount })}
            </span>
          ) : null}
        </div>
        {body}
      </div>
    );
  }

  return (
    <div className="model-manual-spec">
      <button
        type="button"
        className="model-manual-spec-toggle"
        aria-expanded={expanded}
        disabled={disabled}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>{expanded ? "▼" : "▶"}</span>
        <span>{title}</span>
      </button>
      {expanded ? body : null}
    </div>
  );
}

function formatRatePlaceholder(catalog?: number, effective?: number, label?: string): string {
  if (effective !== undefined) {
    return `$${formatRateHint(effective)}`;
  }
  if (catalog !== undefined) {
    return `$${formatRateHint(catalog)}`;
  }
  return label ?? "—";
}

function formatRateHint(value: number | undefined): string {
  if (value === undefined) {
    return "—";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.?0+$/, "");
}

export function useEffectiveModelSpecHints(
  autoCapability: RouteCapabilityHint | undefined,
  autoPricing: RoutePricingHint | undefined,
  manualForm: ManualSpecFormFields,
) {
  return useMemo(() => {
    const overriddenFields = listManualOverrideFields(manualForm);
    const parsedManualSpec = tryFormToManualSpec(manualForm);
    return {
      capability: mergeEffectiveCapabilityHint(autoCapability, parsedManualSpec),
      pricing: mergeEffectivePricingHint(autoPricing, parsedManualSpec),
      overriddenFields,
    };
  }, [autoCapability, autoPricing, manualForm]);
}
