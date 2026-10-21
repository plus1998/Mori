import { formatRatePerMillion } from "@eco/runtime/models-dev-pricing";
import { ArrowDown, ArrowUp, Brain, Globe, HardDrive, Image, Layers, Maximize2, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CandidateModelView, RouteCapabilityHint, RoutePricingHint } from "../shared/ipc";
import type { ManualSpecOverrideField } from "./agent-resource-manual-spec-form";
import {
  catalogCapabilityHint,
  catalogPricingHint,
  formatCatalogMappingLabel,
  listManualOverrideFields,
  manualSpecToForm,
} from "./agent-resource-manual-spec-form";

function formatTokenCount(value: number): string {
  if (value >= 1_048_576) {
    return `${(value / 1_048_576).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1024)}K`;
  }
  return String(value);
}

function chipClass(
  base: string,
  field: ManualSpecOverrideField | undefined,
  overrides: Set<ManualSpecOverrideField>,
): string {
  if (field && overrides.has(field)) {
    return `${base} model-spec-chip-manual`;
  }
  return base;
}

export function formatCandidateModelsDevLabel(candidate: CandidateModelView): string | undefined {
  if (candidate.modelsDevLabel) {
    return candidate.modelsDevLabel;
  }
  if (candidate.modelsDevMapping) {
    return `${candidate.modelsDevMapping.providerKey}/${candidate.modelsDevMapping.modelId}`;
  }
  return undefined;
}

export function candidateCapabilityHint(
  candidate: CandidateModelView | undefined,
): RouteCapabilityHint | undefined {
  if (!candidate) {
    return undefined;
  }
  const hasCapability =
    candidate.resolvedContextTokens !== undefined ||
    candidate.resolvedMaxOutputTokens !== undefined ||
    candidate.resolvedSupportsImageInput !== undefined ||
    candidate.resolvedSupportsReasoning !== undefined ||
    candidate.resolvedSupportsNativeWebSearch !== undefined ||
    candidate.resolvedSupportsRemoteCompaction !== undefined;
  if (!hasCapability) {
    return undefined;
  }
  return {
    role: "main",
    providerName: "",
    modelId: candidate.modelId,
    supportsImageInput: candidate.resolvedSupportsImageInput ?? false,
    supportsReasoning: candidate.resolvedSupportsReasoning ?? false,
    supportsNativeWebSearch: candidate.resolvedSupportsNativeWebSearch !== false,
    supportsRemoteCompaction: candidate.resolvedSupportsRemoteCompaction === true,
    capabilitiesResolved:
      candidate.resolvedSupportsImageInput !== undefined || candidate.resolvedSupportsReasoning !== undefined,
    contextLimitResolved: candidate.resolvedContextTokens !== undefined,
    ...(candidate.resolvedContextTokens !== undefined && {
      contextTokens: candidate.resolvedContextTokens,
      catalogContextTokens: candidate.resolvedContextTokens,
    }),
    ...(candidate.resolvedMaxOutputTokens !== undefined && {
      maxOutputTokens: candidate.resolvedMaxOutputTokens,
      catalogMaxOutputTokens: candidate.resolvedMaxOutputTokens,
    }),
    ...(candidate.resolvedSupportsImageInput !== undefined && {
      catalogSupportsImageInput: candidate.resolvedSupportsImageInput,
    }),
    ...(candidate.resolvedSupportsReasoning !== undefined && {
      catalogSupportsReasoning: candidate.resolvedSupportsReasoning,
    }),
    ...(candidate.modelsDevMapping && {
      modelsDevMapping: candidate.modelsDevMapping,
      resolvedModelsDevMapping: candidate.modelsDevMapping,
    }),
    ...(candidate.modelsDevLabel && {
      modelsDevLabel: candidate.modelsDevLabel,
      resolvedModelsDevLabel: candidate.modelsDevLabel,
    }),
  };
}

export function candidatePricingHint(
  candidate: CandidateModelView | undefined,
): RoutePricingHint | undefined {
  if (!candidate || candidate.resolvedInputPerM === undefined || candidate.resolvedOutputPerM === undefined) {
    return undefined;
  }
  const rates = {
    inputPerM: candidate.resolvedInputPerM,
    outputPerM: candidate.resolvedOutputPerM,
    ...(candidate.resolvedCacheReadPerM !== undefined && {
      cacheReadPerM: candidate.resolvedCacheReadPerM,
    }),
    ...(candidate.resolvedCacheWritePerM !== undefined && {
      cacheWritePerM: candidate.resolvedCacheWritePerM,
    }),
  };
  return {
    role: "main",
    providerName: "",
    modelId: candidate.modelId,
    rates,
    catalogRates: rates,
    pricingResolved: true,
    ...(candidate.modelsDevLabel && { pricingLabel: candidate.modelsDevLabel }),
  };
}

export function candidateOverrideFields(
  candidate: CandidateModelView | undefined,
): Set<ManualSpecOverrideField> | undefined {
  if (!candidate?.manualSpec) {
    return undefined;
  }
  return listManualOverrideFields(manualSpecToForm(candidate.manualSpec));
}

export function ModelSpecSummary({
  capability,
  pricing,
  overriddenFields,
  compact = false,
}: {
  capability?: RouteCapabilityHint;
  pricing?: RoutePricingHint;
  overriddenFields?: Set<ManualSpecOverrideField>;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  if (!capability && !pricing) {
    return null;
  }
  const cap = capability;
  const overrides = overriddenFields ?? new Set<ManualSpecOverrideField>();
  const hasContext = cap?.contextLimitResolved && cap.contextTokens !== undefined && cap.contextTokens > 0;
  const hasOutput = cap?.maxOutputTokens !== undefined && cap.maxOutputTokens > 0;
  const hasImage = cap?.supportsImageInput;
  const hasReasoning = cap?.supportsReasoning;
  const nativeWebSearchEnabled = cap?.supportsNativeWebSearch !== false;
  const remoteCompactionEnabled = cap?.supportsRemoteCompaction === true;
  const showNativeWebSearchChip =
    nativeWebSearchEnabled || (overrides?.has("supportsNativeWebSearch") ?? false);
  const rates = pricing?.rates;
  const hasPricing = rates && rates.inputPerM > 0 && rates.outputPerM > 0;
  const hasCache = rates && (rates.cacheReadPerM !== undefined || rates.cacheWritePerM !== undefined);

  if (
    !hasContext &&
    !hasImage &&
    !hasPricing &&
    !hasOutput &&
    !hasReasoning &&
    !showNativeWebSearchChip &&
    !remoteCompactionEnabled
  ) {
    return null;
  }

  return (
    <div className={`model-spec-summary${compact ? " model-spec-summary-compact" : ""}`}>
      {hasContext ? (
        <span
          className={chipClass("model-spec-chip model-spec-chip-capability", "contextTokens", overrides)}
          title={t("modelSpec.contextWindow")}
        >
          <Layers size={13} strokeWidth={2} />
          <span className="model-spec-chip-value">{formatTokenCount(cap!.contextTokens!)}</span>
          {!compact ? <span className="model-spec-chip-caption">{t("modelSpec.context")}</span> : null}
          {overrides.has("contextTokens") ? (
            <span className="model-spec-chip-badge">{t("modelSpec.manual")}</span>
          ) : null}
        </span>
      ) : null}
      {hasOutput ? (
        <span
          className={chipClass("model-spec-chip model-spec-chip-capability", "maxOutputTokens", overrides)}
          title={t("modelSpec.maxOutput")}
        >
          <Maximize2 size={13} strokeWidth={2} />
          <span className="model-spec-chip-value">{formatTokenCount(cap!.maxOutputTokens!)}</span>
          {!compact ? <span className="model-spec-chip-caption">{t("modelSpec.output")}</span> : null}
          {overrides.has("maxOutputTokens") ? (
            <span className="model-spec-chip-badge">{t("modelSpec.manual")}</span>
          ) : null}
        </span>
      ) : null}
      {hasImage ? (
        <span
          className={chipClass("model-spec-chip model-spec-chip-capability", "supportsImageInput", overrides)}
          title={t("modelSpec.imageInput")}
        >
          <Image size={13} strokeWidth={2} />
          {!compact ? <span className="model-spec-chip-caption">{t("modelSpec.multimodal")}</span> : null}
          {overrides.has("supportsImageInput") ? (
            <span className="model-spec-chip-badge">{t("modelSpec.manual")}</span>
          ) : null}
        </span>
      ) : null}
      {hasReasoning ? (
        <span
          className={chipClass("model-spec-chip model-spec-chip-capability", "supportsReasoning", overrides)}
          title={t("modelSpec.reasoningSupported")}
        >
          <Brain size={13} strokeWidth={2} />
          {!compact ? <span className="model-spec-chip-caption">{t("modelSpec.reasoning")}</span> : null}
          {overrides.has("supportsReasoning") ? (
            <span className="model-spec-chip-badge">{t("modelSpec.manual")}</span>
          ) : null}
        </span>
      ) : null}
      {showNativeWebSearchChip ? (
        <span
          className={chipClass(
            "model-spec-chip model-spec-chip-capability",
            "supportsNativeWebSearch",
            overrides,
          )}
          title={t("modelSpec.nativeWebSearch")}
        >
          <Globe size={13} strokeWidth={2} />
          {!compact ? (
            <span className="model-spec-chip-caption">
              {nativeWebSearchEnabled ? t("modelSpec.nativeWebSearch") : t("modelSpec.nativeWebSearchOff")}
            </span>
          ) : null}
          {overrides.has("supportsNativeWebSearch") ? (
            <span className="model-spec-chip-badge">{t("modelSpec.manual")}</span>
          ) : null}
        </span>
      ) : null}
      {remoteCompactionEnabled ? (
        <span
          className={chipClass(
            "model-spec-chip model-spec-chip-capability",
            "supportsRemoteCompaction",
            overrides,
          )}
          title={t("modelSpec.remoteCompactionHint")}
        >
          <Layers size={13} strokeWidth={2} />
          {!compact ? (
            <span className="model-spec-chip-caption">{t("modelSpec.remoteCompaction")}</span>
          ) : null}
          {overrides.has("supportsRemoteCompaction") ? (
            <span className="model-spec-chip-badge">{t("modelSpec.manual")}</span>
          ) : null}
        </span>
      ) : null}
      {hasPricing ? (
        <>
          <span
            className={chipClass(
              "model-spec-chip model-spec-chip-price model-spec-chip-price-in",
              "inputPerM",
              overrides,
            )}
            title={t("modelSpec.inputPrice")}
          >
            <ArrowUp size={13} strokeWidth={2} />
            <span className="model-spec-chip-value">{formatRatePerMillion(rates!.inputPerM)}</span>
            {overrides.has("inputPerM") ? (
              <span className="model-spec-chip-badge">{t("modelSpec.manual")}</span>
            ) : null}
          </span>
          <span
            className={chipClass(
              "model-spec-chip model-spec-chip-price model-spec-chip-price-out",
              "outputPerM",
              overrides,
            )}
            title={t("modelSpec.outputPrice")}
          >
            <ArrowDown size={13} strokeWidth={2} />
            <span className="model-spec-chip-value">{formatRatePerMillion(rates!.outputPerM)}</span>
            {overrides.has("outputPerM") ? (
              <span className="model-spec-chip-badge">{t("modelSpec.manual")}</span>
            ) : null}
          </span>
        </>
      ) : null}
      {hasCache
        ? [
            rates?.cacheReadPerM !== undefined ? (
              <span
                key="cache-read"
                className={chipClass(
                  "model-spec-chip model-spec-chip-price model-spec-chip-price-cache",
                  "cacheReadPerM",
                  overrides,
                )}
                title={t("modelSpec.cacheReadPrice")}
              >
                <HardDrive size={13} strokeWidth={2} />
                <span className="model-spec-chip-value">{formatRatePerMillion(rates!.cacheReadPerM!)}</span>
                {overrides.has("cacheReadPerM") ? (
                  <span className="model-spec-chip-badge">{t("modelSpec.manual")}</span>
                ) : null}
              </span>
            ) : null,
            rates?.cacheWritePerM !== undefined ? (
              <span
                key="cache-write"
                className={chipClass(
                  "model-spec-chip model-spec-chip-price model-spec-chip-price-cache",
                  "cacheWritePerM",
                  overrides,
                )}
                title={t("modelSpec.cacheWritePrice")}
              >
                <Save size={13} strokeWidth={2} />
                <span className="model-spec-chip-value">{formatRatePerMillion(rates!.cacheWritePerM!)}</span>
                {overrides.has("cacheWritePerM") ? (
                  <span className="model-spec-chip-badge">{t("modelSpec.manual")}</span>
                ) : null}
              </span>
            ) : null,
          ].filter(Boolean)
        : null}
    </div>
  );
}

export function ModelsDevCatalogReferencePanel({
  capability,
  pricing,
  mappingLabel,
  compact = false,
}: {
  capability?: RouteCapabilityHint;
  pricing?: RoutePricingHint;
  mappingLabel?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const catalogCapability = catalogCapabilityHint(capability);
  const catalogPricing = catalogPricingHint(pricing);
  const hasData = Boolean(catalogCapability || catalogPricing);

  return (
    <div
      className={`model-manual-spec-catalog-ref${hasData ? "" : " model-manual-spec-catalog-ref-empty"}${compact ? " model-manual-spec-catalog-ref-compact" : ""}`}
    >
      <div className="model-manual-spec-catalog-ref-header">
        <span className="model-manual-spec-catalog-ref-title">{t("modelSpec.modelsDevReference")}</span>
        {mappingLabel ? (
          <span className="model-manual-spec-catalog-ref-mapping" title={t("modelSpec.modelsDevMapping")}>
            {mappingLabel}
          </span>
        ) : null}
      </div>
      {hasData ? (
        <ModelSpecSummary
          compact
          {...(catalogCapability ? { capability: catalogCapability } : {})}
          {...(catalogPricing ? { pricing: catalogPricing } : {})}
        />
      ) : (
        <p className="model-manual-spec-catalog-ref-hint">{t("modelSpec.selectMappingHint")}</p>
      )}
    </div>
  );
}

export function CandidateModelSpecPanel({ candidate }: { candidate?: CandidateModelView }) {
  const { t } = useTranslation();
  if (!candidate) {
    return (
      <div className="candidate-model-spec-panel candidate-model-spec-panel-empty">
        <div className="candidate-model-spec-panel-header">
          <Layers size={15} strokeWidth={2} className="candidate-model-spec-panel-icon" />
          <span className="candidate-model-spec-panel-title">{t("modelSpec.title")}</span>
        </div>
        <p className="candidate-model-spec-panel-hint">{t("modelSpec.selectCandidate")}</p>
      </div>
    );
  }

  const capability = candidateCapabilityHint(candidate);
  const pricing = candidatePricingHint(candidate);
  const mappingLabel = formatCandidateModelsDevLabel(candidate);
  const overriddenFields = candidateOverrideFields(candidate);
  const hasSummary = Boolean(capability || pricing);

  return (
    <div className="candidate-model-spec-panel">
      <div className="candidate-model-spec-panel-header">
        <Layers size={15} strokeWidth={2} className="candidate-model-spec-panel-icon" />
        <span className="candidate-model-spec-panel-title">{t("modelSpec.title")}</span>
        {mappingLabel ? (
          <span className="candidate-model-spec-panel-mapping" title={t("modelSpec.modelsDevMapping")}>
            {mappingLabel}
          </span>
        ) : (
          <span className="candidate-model-spec-panel-mapping candidate-model-spec-panel-mapping-unresolved">
            {t("modelSpec.unmapped")}
          </span>
        )}
      </div>
      {!mappingLabel ? (
        <p className="candidate-model-spec-panel-hint candidate-model-spec-panel-hint-warn">
          {t("modelSpec.configureMapping")}
        </p>
      ) : null}
      {hasSummary ? (
        <ModelSpecSummary
          {...(capability ? { capability } : {})}
          {...(pricing ? { pricing } : {})}
          {...(overriddenFields ? { overriddenFields } : {})}
        />
      ) : (
        <p className="candidate-model-spec-panel-hint">{t("modelSpec.noData")}</p>
      )}
    </div>
  );
}

/** Two fixed rows mirror the compact model-card design. */
export function CandidateModelSpecTable({ candidate }: { candidate: CandidateModelView }) {
  const { t } = useTranslation();
  const overrides = candidateOverrideFields(candidate);
  const tokenValue = (value: number | undefined) =>
    value !== undefined && value > 0 ? formatTokenCount(value) : "—";
  const rateValue = (value: number | undefined) => (value !== undefined ? formatRatePerMillion(value) : "—");
  const supportValue = (value: boolean | undefined) => (value === undefined ? "—" : value ? "✓" : "×");
  type Field = { key: ManualSpecOverrideField; label: string; value: string; icon: typeof Layers };
  const capacityAndCapabilities: Field[] = [
    {
      key: "contextTokens",
      label: t("modelSpec.contextWindow"),
      value: tokenValue(candidate.resolvedContextTokens),
      icon: Layers,
    },
    {
      key: "maxOutputTokens",
      label: t("modelSpec.maxOutput"),
      value: tokenValue(candidate.resolvedMaxOutputTokens),
      icon: Maximize2,
    },
    {
      key: "supportsImageInput",
      label: t("modelSpec.multimodal"),
      value: supportValue(candidate.resolvedSupportsImageInput),
      icon: Image,
    },
    {
      key: "supportsReasoning",
      label: t("modelSpec.reasoning"),
      value: supportValue(candidate.resolvedSupportsReasoning),
      icon: Brain,
    },
    {
      key: "supportsNativeWebSearch",
      label: t("modelSpec.nativeWebSearch"),
      value: supportValue(candidate.resolvedSupportsNativeWebSearch),
      icon: Globe,
    },
    {
      key: "supportsRemoteCompaction",
      label: t("modelSpec.remoteCompaction"),
      value: supportValue(candidate.resolvedSupportsRemoteCompaction),
      icon: Layers,
    },
  ];
  const pricing: Field[] = [
    {
      key: "inputPerM",
      label: t("modelSpec.inputPrice"),
      value: rateValue(candidate.resolvedInputPerM),
      icon: ArrowUp,
    },
    {
      key: "outputPerM",
      label: t("modelSpec.outputPrice"),
      value: rateValue(candidate.resolvedOutputPerM),
      icon: ArrowDown,
    },
    {
      key: "cacheReadPerM",
      label: t("modelSpec.cacheReadPrice"),
      value: rateValue(candidate.resolvedCacheReadPerM),
      icon: HardDrive,
    },
    {
      key: "cacheWritePerM",
      label: t("modelSpec.cacheWritePrice"),
      value: rateValue(candidate.resolvedCacheWritePerM),
      icon: Save,
    },
  ];
  function renderField({ key, label, value, icon: Icon }: Field) {
    const manual = overrides?.has(key) === true;
    const description =
      value === "✓" ? t("modelSpec.supported") : value === "×" ? t("modelSpec.unsupported") : value;
    const source =
      value === "—" ? t("modelSpec.notProvided") : t(manual ? "modelSpec.manual" : "modelSpec.defaultSource");
    const tooltip = `${label}: ${description} (${source})`;
    return (
      <div className="candidate-spec-field" key={key} title={tooltip}>
        <dt className="candidate-spec-sr-only">{label}</dt>
        <dd
          className={`${value === "×" || value === "—" ? "is-muted" : ""}${manual ? " is-manual" : ""}`}
          aria-label={tooltip}
        >
          <Icon size={14} aria-hidden />
          <span>{value}</span>
        </dd>
      </div>
    );
  }
  return (
    <div className="candidate-spec-table">
      <dl className="candidate-spec-line candidate-spec-line--primary">
        {capacityAndCapabilities.map(renderField)}
      </dl>
      <dl className="candidate-spec-line candidate-spec-line--pricing">{pricing.map(renderField)}</dl>
    </div>
  );
}
