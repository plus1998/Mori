import { Activity, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CandidateModelView, UpstreamModelOption } from "../shared/ipc";
import { CandidateModelSpecTable } from "./ModelSpecSummary";

interface CandidateModelPanelProps {
  providerId: string;
  models: UpstreamModelOption[];
  modelsLoading: boolean;
  busy: boolean | undefined;
  testingModelKey?: string | null | undefined;
  /** 编辑区保存后递增，让列表重新拉取最新 spec */
  refreshToken?: number | undefined;
  /** 编辑区里打开的候选模型；列表只负责标出它，表单本身在弹窗另一侧 */
  editingCandidateId?: string | null | undefined;
  onRefreshModels: () => void;
  onTestModel?: ((modelId: string) => void) | undefined;
  onEditCandidate?: ((candidate: CandidateModelView) => void) | undefined;
  /** 候选模型被删除时通知外层（编辑区正在编辑它时要关掉） */
  onCandidateDeleted?: ((candidateId: string) => void) | undefined;
  /** Fired after candidate models are successfully imported (bulk add). */
  onCandidatesAdded?: ((candidates: CandidateModelView[]) => void) | undefined;
}

export function CandidateModelPanel({
  providerId,
  models,
  modelsLoading,
  busy,
  testingModelKey,
  refreshToken,
  editingCandidateId,
  onRefreshModels,
  onTestModel,
  onEditCandidate,
  onCandidateDeleted,
  onCandidatesAdded,
}: CandidateModelPanelProps) {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<CandidateModelView[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"list" | "manual">("list");

  const loadCandidates = useCallback(async () => {
    if (!providerId) return;
    setLoading(true);
    try {
      const result = await window.eco!.listCandidateModels(providerId);
      setCandidates(result);
    } catch {
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    loadCandidates();
  }, [loadCandidates, refreshToken]);

  const handleAddModels = async (selectedModelIds: string[]) => {
    if (!providerId || selectedModelIds.length === 0) return;
    try {
      const imported = await window.eco!.bulkImportCandidateModels(providerId, selectedModelIds);
      await loadCandidates();
      setPickerOpen(false);
      if (imported.length > 0) {
        onCandidatesAdded?.(imported);
      }
    } catch (error) {
      console.error("Failed to import candidate models:", error);
      setPickerOpen(false);
    }
  };

  const handleManualAdd = async (modelId: string, displayName?: string) => {
    if (!providerId || !modelId.trim()) return;
    try {
      await window.eco!.saveCandidateModel({
        providerId,
        modelId: modelId.trim(),
        ...(displayName ? { displayName: displayName.trim() } : {}),
      });
      await loadCandidates();
      setPickerOpen(false);
    } catch (error) {
      console.error("Failed to add candidate model:", error);
    }
  };

  const handleDelete = async (candidate: CandidateModelView) => {
    try {
      await window.eco!.deleteCandidateModel(candidate.id);
      await loadCandidates();
      onCandidateDeleted?.(candidate.id);
    } catch (error) {
      console.error("Failed to delete candidate model:", error);
    }
  };

  const alreadyAddedModelIds = new Set(candidates.map((c) => c.modelId));
  const availableModels = useMemo(
    () => models.filter((m) => !alreadyAddedModelIds.has(m.id)),
    [models, candidates],
  );

  return (
    <aside className="candidate-panel">
      <div className="candidate-panel-header">
        <div className="candidate-panel-title-row">
          <span className="candidate-panel-title">{t("settings.models.candidateModels")}</span>
          {candidates.length > 0 ? (
            <span className="candidate-panel-count" aria-hidden="true">
              {candidates.length}
            </span>
          ) : null}
        </div>
        <div className="candidate-panel-header-actions">
          <button
            type="button"
            className="mcp-icon-button candidate-panel-icon-btn"
            disabled={busy || loading}
            onClick={loadCandidates}
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
          >
            <RefreshCw size={14} className={loading ? "model-refresh-spin" : undefined} />
          </button>
          <button
            type="button"
            className="mcp-icon-button candidate-panel-icon-btn"
            disabled={busy || modelsLoading}
            onClick={() => setPickerOpen(true)}
            title={t("candidateModels.add")}
            aria-label={t("candidateModels.add")}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="candidate-panel-body">
        {candidates.length === 0 ? (
          <p className="candidate-models-empty">{t("candidateModels.empty")}</p>
        ) : (
          <div className="candidate-models-list">
            {candidates.map((candidate) => (
              <div
                key={candidate.id}
                className={`candidate-model-card${editingCandidateId === candidate.id ? " is-editing" : ""}`}
              >
                <div className="candidate-model-summary">
                  <div className="candidate-model-summary-header">
                    <div className="candidate-model-summary-main">
                      <span
                        className="candidate-model-display-name"
                        title={candidate.displayName || candidate.modelsDevLabel || candidate.modelId}
                      >
                        {candidate.displayName || candidate.modelsDevLabel || candidate.modelId}
                      </span>
                      <span className="candidate-model-id" title={candidate.modelId}>
                        {candidate.modelId}
                      </span>
                    </div>
                    <div className="candidate-model-actions">
                      {onTestModel ? (
                        <button
                          type="button"
                          className="mcp-icon-button"
                          title={t("settings.models.testConnectivity", { name: candidate.modelId })}
                          aria-label={t("settings.models.testConnectivity", { name: candidate.modelId })}
                          disabled={busy || Boolean(testingModelKey)}
                          onClick={() => onTestModel(candidate.modelId)}
                        >
                          {testingModelKey === `${providerId}::${candidate.modelId}` ? (
                            <RefreshCw size={14} className="model-refresh-spin" />
                          ) : (
                            <Activity size={14} />
                          )}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="mcp-icon-button candidate-model-edit-btn"
                        title={t("common.edit")}
                        aria-label={t("common.edit")}
                        disabled={busy}
                        onClick={() => onEditCandidate?.(candidate)}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="mcp-icon-button candidate-model-delete"
                        title={t("common.delete")}
                        aria-label={t("common.delete")}
                        disabled={busy}
                        onClick={() => void handleDelete(candidate)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <CandidateModelSpecTable candidate={candidate} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {pickerOpen && (
        <CandidateModelPickerModal
          models={availableModels}
          loading={modelsLoading}
          tab={pickerTab}
          onTabChange={setPickerTab}
          onClose={() => {
            setPickerOpen(false);
            setPickerTab("list");
          }}
          onConfirm={handleAddModels}
          onManualAdd={handleManualAdd}
          onRefreshModels={onRefreshModels}
        />
      )}
    </aside>
  );
}

interface CandidateModelPickerModalProps {
  models: UpstreamModelOption[];
  loading: boolean;
  tab: "list" | "manual";
  onTabChange: (tab: "list" | "manual") => void;
  onClose: () => void;
  onConfirm: (selectedModelIds: string[]) => void;
  onManualAdd: (modelId: string, displayName?: string) => void;
  onRefreshModels: () => void;
}

function CandidateModelPickerModal({
  models,
  loading,
  tab,
  onTabChange,
  onClose,
  onConfirm,
  onManualAdd,
  onRefreshModels,
}: CandidateModelPickerModalProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [manualModelId, setManualModelId] = useState("");
  const [manualDisplayName, setManualDisplayName] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleManualSubmit = () => {
    const id = manualModelId.trim();
    if (!id) return;
    onManualAdd(id, manualDisplayName.trim() || undefined);
  };

  const filteredModels = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return models;
    }
    return models.filter((model) => {
      const label = (model.displayName || model.id).toLowerCase();
      return label.includes(query) || model.id.toLowerCase().includes(query);
    });
  }, [models, searchQuery]);

  const toggleSelection = (modelId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (searchQuery.trim()) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const model of filteredModels) {
          next.add(model.id);
        }
        return next;
      });
      return;
    }
    setSelected(new Set(models.map((m) => m.id)));
  };

  const clearSelection = () => {
    setSelected(new Set());
  };

  return (
    <div className="settings-modal-backdrop candidate-picker-backdrop">
      <div
        className="settings-modal candidate-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="candidate-picker-title"
      >
        <header className="settings-modal-header">
          <h2 id="candidate-picker-title" className="settings-modal-title">
            {t("candidateModels.pickerTitle")}
          </h2>
          <button type="button" className="mcp-icon-button" onClick={onClose} aria-label={t("common.close")}>
            <X size={18} />
          </button>
        </header>
        <div className="candidate-picker-body">
          <div className="candidate-picker-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={`candidate-picker-tab${tab === "list" ? " is-active" : ""}`}
              onClick={() => onTabChange("list")}
            >
              {t("candidateModels.tabList")}
            </button>
            <button
              type="button"
              role="tab"
              className={`candidate-picker-tab${tab === "manual" ? " is-active" : ""}`}
              onClick={() => onTabChange("manual")}
            >
              {t("candidateModels.tabManual")}
            </button>
          </div>

          {tab === "manual" ? (
            <div className="candidate-picker-manual-form">
              <label className="candidate-picker-manual-field">
                <span className="candidate-picker-manual-label">Model ID</span>
                <input
                  className="mcp-field-input"
                  value={manualModelId}
                  placeholder={t("candidateModels.manualModelIdPlaceholder")}
                  autoFocus
                  onChange={(e) => setManualModelId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleManualSubmit()}
                />
              </label>
              <label className="candidate-picker-manual-field">
                <span className="candidate-picker-manual-label">{t("candidateModels.displayName")}</span>
                <input
                  className="mcp-field-input"
                  value={manualDisplayName}
                  placeholder={t("candidateModels.manualDisplayNamePlaceholder")}
                  onChange={(e) => setManualDisplayName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleManualSubmit()}
                />
              </label>
            </div>
          ) : (
            <>
              <div className="candidate-picker-toolbar">
                <button type="button" className="settings-secondary-button" onClick={selectAll}>
                  {t("candidateModels.selectAll")}
                </button>
                <button type="button" className="settings-secondary-button" onClick={clearSelection}>
                  {t("candidateModels.clearSelection")}
                </button>
                <button
                  type="button"
                  className="settings-secondary-button"
                  disabled={loading}
                  onClick={onRefreshModels}
                >
                  <RefreshCw size={14} className={loading ? "model-refresh-spin" : undefined} />
                  {t("candidateModels.refreshList")}
                </button>
                <span className="candidate-picker-count">
                  {t("candidateModels.selectedCount", {
                    selected: selected.size,
                    total: models.length,
                  })}
                </span>
              </div>
              <label className="candidate-picker-search">
                <Search size={14} aria-hidden />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={searchQuery}
                  placeholder={t("candidateModels.searchPlaceholder")}
                  aria-label={t("candidateModels.searchPlaceholder")}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                {searchQuery ? (
                  <button
                    type="button"
                    className="candidate-picker-search-clear"
                    aria-label={t("common.close")}
                    onClick={() => {
                      setSearchQuery("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    <X size={12} aria-hidden />
                  </button>
                ) : null}
              </label>
              {loading && models.length === 0 ? (
                <p className="candidate-picker-loading">{t("candidateModels.loading")}</p>
              ) : models.length === 0 ? (
                <p className="candidate-picker-empty">{t("candidateModels.noneAvailable")}</p>
              ) : filteredModels.length === 0 ? (
                <p className="candidate-picker-empty">{t("modelCascade.noMatch")}</p>
              ) : (
                <div className="candidate-picker-list">
                  {filteredModels.map((model) => (
                    <label key={model.id} className="candidate-picker-item">
                      <input
                        type="checkbox"
                        checked={selected.has(model.id)}
                        onChange={() => toggleSelection(model.id)}
                      />
                      <span className="candidate-picker-item-label">{model.displayName || model.id}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <footer className="settings-modal-footer settings-modal-footer-split">
          <span />
          <div className="settings-modal-footer-actions">
            <button type="button" className="settings-modal-cancel" onClick={onClose}>
              {t("common.cancel")}
            </button>
            {tab === "list" ? (
              <button
                type="button"
                className="mcp-save-button"
                disabled={selected.size === 0}
                onClick={() => onConfirm([...selected])}
              >
                {t("candidateModels.addCount", {
                  count: selected.size > 0 ? `(${selected.size})` : "",
                })}
              </button>
            ) : (
              <button
                type="button"
                className="mcp-save-button"
                disabled={!manualModelId.trim()}
                onClick={handleManualSubmit}
              >
                {t("candidateModels.manualAdd")}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
