import { ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CodexCatalogModelView, CodexModelCatalogStatusView } from "../../shared/ipc";

const EXPANDED_STORAGE_KEY = "eco.codexModelCatalog.expanded";

function readExpandedPreference(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function formatFetchedAt(fetchedAt: number | undefined): string {
  if (!fetchedAt) {
    return "尚未获取";
  }
  return new Date(fetchedAt).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Keep the footer readable: the full URL stays in the tooltip, the label shows the catalog path. */
function formatSourceLabel(sourceUrl: string | undefined): string {
  if (!sourceUrl) {
    return "";
  }
  try {
    const segments = new URL(sourceUrl).pathname.split("/").filter(Boolean);
    return segments.slice(-3).join("/");
  } catch {
    return sourceUrl;
  }
}

function formatContextWindow(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens)) {
    return "";
  }
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * Codex 账号 model list. The upstream source is the codex-rs models-manager
 * catalog, so new OpenAI models appear without shipping a new client build.
 *
 * The card sits above the account list and stays a single summary row until
 * expanded, so a long account list can never push it out of view.
 */
export function CodexModelCatalogSection() {
  const [models, setModels] = useState<CodexCatalogModelView[]>([]);
  const [status, setStatus] = useState<CodexModelCatalogStatusView | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(readExpandedPreference);
  const [modelIdDraft, setModelIdDraft] = useState("");
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

  const applySnapshot = useCallback(
    (snapshot: { models: CodexCatalogModelView[]; status: CodexModelCatalogStatusView }) => {
      setModels(snapshot.models);
      setStatus(snapshot.status);
    },
    [],
  );

  const load = useCallback(async () => {
    const eco = window.eco;
    if (!eco?.getCodexModelCatalog) {
      return;
    }
    setLoading(true);
    try {
      applySnapshot(await eco.getCodexModelCatalog());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(EXPANDED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Preference is cosmetic; a blocked storage API must not break the picker.
      }
      return next;
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    const eco = window.eco;
    if (!eco?.refreshCodexModelCatalog) {
      return;
    }
    setRefreshing(true);
    try {
      applySnapshot(await eco.refreshCodexModelCatalog());
      setError("");
    } catch (caught) {
      setError(`刷新失败：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setRefreshing(false);
    }
  }, [applySnapshot]);

  const handleAdd = useCallback(async () => {
    const eco = window.eco;
    const modelId = modelIdDraft.trim();
    if (!eco?.addCodexModelCatalogModel || !modelId) {
      return;
    }
    try {
      const displayName = displayNameDraft.trim();
      applySnapshot(
        await eco.addCodexModelCatalogModel({
          modelId,
          ...(displayName ? { displayName } : {}),
        }),
      );
      setModelIdDraft("");
      setDisplayNameDraft("");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [modelIdDraft, displayNameDraft, applySnapshot]);

  const handleRemove = useCallback(
    async (modelId: string) => {
      const eco = window.eco;
      if (!eco?.removeCodexModelCatalogModel) {
        return;
      }
      setRemovingId(modelId);
      try {
        applySnapshot(await eco.removeCodexModelCatalogModel(modelId));
        setError("");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setRemovingId(null);
      }
    },
    [applySnapshot],
  );

  const summary = loading
    ? "正在读取模型目录…"
    : `${models.length} 个可用 · 上次刷新 ${formatFetchedAt(status?.fetchedAt)}`;

  return (
    <section className={expanded ? "codex-catalog-card is-expanded" : "codex-catalog-card"}>
      <div className="codex-catalog-bar">
        <button
          type="button"
          className="codex-catalog-summary"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <ChevronRight
            size={14}
            className={expanded ? "codex-catalog-chevron is-open" : "codex-catalog-chevron"}
          />
          <strong>Codex 模型列表</strong>
          <span className="codex-catalog-summary-meta">{summary}</span>
        </button>
        <div className="codex-catalog-actions">
          {status?.lastError && !error ? (
            <span className="codex-catalog-warning" title={status.lastError}>
              自动获取失败
            </span>
          ) : null}
          <button
            type="button"
            className="codex-action-secondary"
            onClick={() => void handleRefresh()}
            disabled={refreshing || loading}
          >
            <RefreshCw size={14} className={refreshing ? "mcp-spin" : undefined} />
            {refreshing ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {expanded ? (
        <>
          {error ? <div className="codex-account-sync-error">{error}</div> : null}
          {!error && status?.lastError ? (
            <div className="codex-account-sync-error">上次自动获取失败：{status.lastError}</div>
          ) : null}

          <form
            className="codex-catalog-add"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAdd();
            }}
          >
            <label className="codex-catalog-add-field">
              <span>Model ID</span>
              <input
                className="mcp-field-input"
                type="text"
                value={modelIdDraft}
                placeholder="例如 gpt-6.1-sol-preview"
                onChange={(event) => setModelIdDraft(event.target.value)}
              />
            </label>
            <label className="codex-catalog-add-field">
              <span>显示名（可选）</span>
              <input
                className="mcp-field-input"
                type="text"
                value={displayNameDraft}
                placeholder="留空则使用 Model ID"
                onChange={(event) => setDisplayNameDraft(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="settings-primary-button"
              disabled={!modelIdDraft.trim() || refreshing}
            >
              <Plus size={14} />
              手动添加
            </button>
          </form>

          {models.length === 0 ? (
            <p className="codex-catalog-empty">没有可用模型，请点击刷新或手动添加。</p>
          ) : (
            <ul className="codex-catalog-list">
              {models.map((model) => (
                <li key={`${model.origin}:${model.modelId}`} className="codex-catalog-item">
                  <div className="codex-catalog-item-main">
                    <strong title={model.modelId}>{model.displayName}</strong>
                    <span className="codex-catalog-item-id">{model.modelId}</span>
                  </div>
                  <div className="codex-catalog-item-meta">
                    {model.origin === "manual" ? (
                      <span className="codex-catalog-tag is-manual">手动</span>
                    ) : (
                      <span className="codex-catalog-tag">codex-rs</span>
                    )}
                    {model.contextWindow ? (
                      <span className="codex-catalog-meta">
                        上下文 {formatContextWindow(model.contextWindow)}
                      </span>
                    ) : null}
                    {model.reasoningEfforts.length > 0 ? (
                      <span className="codex-catalog-meta" title={model.reasoningEfforts.join(" / ")}>
                        推理 {model.reasoningEfforts.length} 档
                      </span>
                    ) : null}
                    {model.origin === "manual" ? (
                      <button
                        type="button"
                        className="mcp-icon-button"
                        aria-label={`移除 ${model.modelId}`}
                        title={`移除 ${model.modelId}`}
                        onClick={() => void handleRemove(model.modelId)}
                        disabled={removingId !== null}
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <footer className="codex-catalog-footer">
            <span className="codex-catalog-counts">
              远端 {status?.remoteCount ?? 0} 个 · 手动 {status?.manualCount ?? 0} 个
            </span>
            <span className="codex-catalog-note">隐藏模型不在此列出</span>
            <span className="codex-catalog-source" title={status?.sourceUrl}>
              {formatSourceLabel(status?.sourceUrl)}
            </span>
          </footer>
        </>
      ) : null}
    </section>
  );
}
