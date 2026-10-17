import { X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CandidateModelInput,
  CandidateModelView,
  ModelsDevMapping,
  ModelsDevModelOption,
  RouteCapabilityHint,
  RoutePricingHint,
  RuntimeRoleRouteConfig,
} from "../shared/ipc";
import {
  isRateFormValueValid,
  isTokenFormValueValid,
  type ManualSpecFormFields,
  prefillManualSpecFormFromCandidate,
  prefillManualSpecFormFromHints,
  tryFormToManualSpec,
} from "./agent-resource-manual-spec-form";
import { ModelCascadeSelect } from "./ModelCascadeSelect";
import { ModelManualSpecPanel } from "./ModelManualSpecPanel";

export interface CandidateModelEditorHandle {
  hasPendingEdits: () => boolean;
  savePendingEdits: () => Promise<void>;
}

interface CandidateModelEditorProps {
  providerId: string;
  candidate: CandidateModelView;
  modelsDevOptions: readonly ModelsDevModelOption[];
  modelsDevLoading: boolean;
  busy?: boolean | undefined;
  onClose: () => void;
  onSaved: (candidateId: string) => void;
  onError: (message: string) => void;
}

async function lookupCandidateRouteHints(
  providerId: string,
  modelId: string,
  mapping?: ModelsDevMapping,
): Promise<{ capability?: RouteCapabilityHint; pricing?: RoutePricingHint }> {
  const route: RuntimeRoleRouteConfig = {
    role: "planner",
    providerId,
    modelId,
    ...(mapping ? { modelsDevMapping: mapping } : {}),
  };
  const [capabilities, pricing] = await Promise.all([
    window.eco!.getRouteCapabilities([route]),
    window.eco!.getRoutePricing([route]),
  ]);
  return {
    ...(capabilities[0] ? { capability: capabilities[0] } : {}),
    ...(pricing[0] ? { pricing: pricing[0] } : {}),
  };
}

/**
 * 候选模型编辑区。
 *
 * 服务商配置表单在编辑候选模型时让位（CSS 收起、DOM 保留以不丢表单状态），
 * 这块区域接管左侧空间；候选模型列表保持原位可点击切换。
 */
export const CandidateModelEditor = forwardRef<CandidateModelEditorHandle, CandidateModelEditorProps>(
  function CandidateModelEditor(
    { providerId, candidate, modelsDevOptions, modelsDevLoading, busy, onClose, onSaved, onError },
    ref,
  ) {
    const { t } = useTranslation();
    const [modelId, setModelId] = useState(candidate.modelId);
    const [displayName, setDisplayName] = useState(candidate.displayName ?? "");
    const [mapping, setMapping] = useState<ModelsDevMapping | undefined>(candidate.modelsDevMapping);
    const [form, setForm] = useState<ManualSpecFormFields>(() =>
      prefillManualSpecFormFromCandidate(candidate),
    );
    const [autoCapability, setAutoCapability] = useState<RouteCapabilityHint | undefined>(undefined);
    const [autoPricing, setAutoPricing] = useState<RoutePricingHint | undefined>(undefined);
    const [saving, setSaving] = useState(false);
    const candidateRef = useRef(candidate);
    candidateRef.current = candidate;

    const cascadeOptions = useMemo(
      () =>
        modelsDevOptions.map((option) => ({
          key: `${option.providerKey}::${option.modelId}`,
          providerId: option.providerKey,
          providerName: option.providerKey,
          modelId: option.modelId,
          label: option.displayName,
          description: option.modelId,
        })),
      [modelsDevOptions],
    );

    const loadHints = useCallback(
      async (
        targetCandidateId: string,
        targetModelId: string,
        nextMapping?: ModelsDevMapping,
        replaceForm = false,
      ) => {
        try {
          const hints = await lookupCandidateRouteHints(providerId, targetModelId, nextMapping);
          if (candidateRef.current.id !== targetCandidateId) {
            return;
          }
          setAutoCapability(hints.capability);
          setAutoPricing(hints.pricing);
          if (replaceForm) {
            setForm((current) => ({
              ...prefillManualSpecFormFromHints(hints.capability, hints.pricing),
              supportsNativeWebSearch: current.supportsNativeWebSearch,
              supportsRemoteCompaction: current.supportsRemoteCompaction,
            }));
          }
        } catch (error) {
          console.error("Failed to resolve candidate model hints:", error);
        }
      },
      [providerId],
    );

    const loadHintsRef = useRef(loadHints);
    loadHintsRef.current = loadHints;

    // 外层用 key={candidate.id} 挂载，切换编辑对象会重新挂载；这里只拉一次 catalog 参考值。
    useEffect(() => {
      const target = candidateRef.current;
      void loadHintsRef.current(target.id, target.modelId, target.modelsDevMapping, !target.manualSpec);
    }, []);

    const handleMappingChange = async (next: ModelsDevMapping | undefined) => {
      setMapping(next);
      await loadHints(candidate.id, modelId.trim() || candidate.modelId, next, true);
    };

    const modelIdMissing = !modelId.trim();
    const hasInvalidField =
      !isTokenFormValueValid(form.contextTokens) ||
      !isTokenFormValueValid(form.maxOutputTokens) ||
      !isRateFormValueValid(form.inputPerM) ||
      !isRateFormValueValid(form.outputPerM) ||
      !isRateFormValueValid(form.cacheReadPerM) ||
      !isRateFormValueValid(form.cacheWritePerM) ||
      !isRateFormValueValid(form.priceMultiplier);

    const persist = useCallback(async () => {
      if (modelIdMissing) {
        throw new Error(t("modelSpec.modelIdRequired"));
      }
      if (hasInvalidField) {
        throw new Error(t("modelSpec.validation.positiveNumber", { field: t("modelSpec.pricingPerM") }));
      }
      const input: CandidateModelInput = {
        id: candidate.id,
        providerId,
        modelId: modelId.trim(),
        sortOrder: candidate.sortOrder,
      };
      const trimmedDisplayName = displayName.trim();
      if (trimmedDisplayName) input.displayName = trimmedDisplayName;
      if (mapping) input.modelsDevMapping = mapping;
      const manualSpec = tryFormToManualSpec(form);
      if (manualSpec) input.manualSpec = manualSpec;
      await window.eco!.saveCandidateModel(input);
      onSaved(candidate.id);
    }, [
      candidate.id,
      candidate.sortOrder,
      displayName,
      form,
      hasInvalidField,
      mapping,
      modelId,
      modelIdMissing,
      onSaved,
      providerId,
      t,
    ]);

    const handleSave = useCallback(async () => {
      setSaving(true);
      try {
        await persist();
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
    }, [onError, persist]);

    useImperativeHandle(
      ref,
      () => ({
        hasPendingEdits: () => true,
        savePendingEdits: async () => {
          await persist();
        },
      }),
      [persist],
    );

    // ⌘/Ctrl + S 保存，Esc 取消（只在弹窗内部生效，且优先于弹窗自身的 Esc 关闭）
    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest(".settings-modal-provider-editor")) {
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          event.stopPropagation();
          void handleSave();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      };
      document.addEventListener("keydown", onKeyDown, true);
      return () => document.removeEventListener("keydown", onKeyDown, true);
    }, [handleSave, onClose]);

    const autoResolvedMapping = autoCapability?.resolvedModelsDevMapping;
    const autoResolvedLabel = autoCapability?.resolvedModelsDevLabel;
    const hasManualMapping = Boolean(mapping);
    const manualLabel = mapping
      ? (cascadeOptions.find(
          (option) => option.providerId === mapping.providerKey && option.modelId === mapping.modelId,
        )?.label ?? `${mapping.providerKey}/${mapping.modelId}`)
      : undefined;
    const autoMatchSummary =
      autoResolvedLabel ??
      (autoResolvedMapping ? `${autoResolvedMapping.providerKey}/${autoResolvedMapping.modelId}` : undefined);
    const autoMatchedKey = autoResolvedMapping
      ? `${autoResolvedMapping.providerKey}::${autoResolvedMapping.modelId}`
      : undefined;

    return (
      <section className="candidate-editor" aria-label={t("candidateModels.editTitle")}>
        <header className="candidate-editor-header">
          <div className="candidate-editor-heading">
            <span className="candidate-editor-eyebrow">{t("candidateModels.editTitle")}</span>
            <span className="candidate-editor-model-id" title={candidate.modelId}>
              {candidate.modelId}
            </span>
          </div>
          <button
            type="button"
            className="mcp-icon-button"
            onClick={onClose}
            aria-label={t("candidateModels.cancelEdit")}
            title={t("candidateModels.cancelEdit")}
          >
            <X size={15} />
          </button>
        </header>

        <div className="candidate-editor-body">
          <section className="candidate-editor-section">
            <h4 className="candidate-editor-section-title">{t("candidateModels.sectionIdentity")}</h4>
            <div className="candidate-editor-grid candidate-editor-grid--2">
              <label className={`candidate-editor-field${modelIdMissing ? " is-invalid" : ""}`}>
                <span className="candidate-editor-field-label">
                  Model ID
                  <span className="candidate-editor-required" aria-hidden>
                    *
                  </span>
                </span>
                <input
                  className="candidate-editor-input is-mono"
                  value={modelId}
                  disabled={busy}
                  onChange={(event) => setModelId(event.target.value)}
                />
                <span className="candidate-editor-caption">
                  {modelIdMissing ? t("modelSpec.modelIdRequired") : t("candidateModels.upstreamModelIdHint")}
                </span>
              </label>
              <label className="candidate-editor-field">
                <span className="candidate-editor-field-label">{t("candidateModels.displayName")}</span>
                <input
                  className="candidate-editor-input"
                  value={displayName}
                  placeholder={modelId.trim() || candidate.modelId}
                  disabled={busy}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <span className="candidate-editor-caption">{t("candidateModels.displayNameHint")}</span>
              </label>
            </div>
          </section>

          <section className="candidate-editor-section">
            <h4 className="candidate-editor-section-title">{t("modelSpec.modelsDevMapping")}</h4>
            <ModelCascadeSelect
              value={
                mapping
                  ? {
                      key: `${mapping.providerKey}::${mapping.modelId}`,
                      providerId: mapping.providerKey,
                      modelId: mapping.modelId,
                    }
                  : undefined
              }
              secondaryValue={
                autoResolvedMapping
                  ? {
                      key: `${autoResolvedMapping.providerKey}::${autoResolvedMapping.modelId}`,
                      providerId: autoResolvedMapping.providerKey,
                      modelId: autoResolvedMapping.modelId,
                    }
                  : undefined
              }
              options={cascadeOptions}
              loading={modelsDevLoading}
              disabled={busy}
              clearable
              clearLabel={
                autoMatchSummary
                  ? `${t("modelsDevSelect.auto")}${t("modelsDevSelect.currentMatch", { model: autoMatchSummary })}`
                  : `${t("modelsDevSelect.auto")}${t("modelsDevSelect.inferFromId")}`
              }
              placeholder={t("modelsDevSelect.placeholder")}
              renderExtra={
                autoMatchedKey && !hasManualMapping
                  ? (option) =>
                      option.key === autoMatchedKey ? (
                        <span className="model-cascade-model-extra">
                          {t("modelsDevSelect.autoMatchedSuffix")}
                        </span>
                      ) : null
                  : undefined
              }
              footer={
                manualLabel ? (
                  <p className="model-cascade-hint">
                    {t("modelsDevSelect.manualMapping", { model: manualLabel })}
                  </p>
                ) : autoMatchSummary ? (
                  <p className="model-cascade-hint">
                    {t("modelsDevSelect.autoMatch", { model: autoMatchSummary })}
                  </p>
                ) : (
                  <p className="model-cascade-hint is-unresolved">{t("modelsDevSelect.unresolved")}</p>
                )
              }
              onChange={(selection) =>
                void handleMappingChange(
                  selection ? { providerKey: selection.providerId, modelId: selection.modelId } : undefined,
                )
              }
            />
          </section>

          <ModelManualSpecPanel
            variant="editor"
            value={form}
            {...(autoCapability ? { autoCapability } : {})}
            {...(autoPricing ? { autoPricing } : {})}
            {...(mapping ? { mapping } : {})}
            {...(busy !== undefined ? { disabled: busy } : {})}
            onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          />
        </div>

        <footer className="candidate-editor-footer">
          <span className="candidate-editor-hint">{t("modelSpec.shortcutHint")}</span>
          <div className="candidate-editor-actions">
            <button type="button" className="settings-secondary-button" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="mcp-save-button candidate-editor-save"
              disabled={busy || saving || modelIdMissing}
              onClick={() => void handleSave()}
            >
              {t("common.save")}
            </button>
          </div>
        </footer>
      </section>
    );
  },
);
