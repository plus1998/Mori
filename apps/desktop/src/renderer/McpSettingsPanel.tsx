import type { TFunction } from "i18next";
import {
  Braces,
  Check,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  Copy,
  ListChecks,
  LoaderCircle,
  Plus,
  Radar,
  RotateCcw,
  Settings2,
  Trash2,
  TriangleAlert,
  WandSparkles,
} from "lucide-react";
import {
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  McpServerCheckResult,
  McpServerConfigInput,
  McpServerConfigView,
  McpTransport,
} from "../shared/ipc";
import {
  mcpServerToInput,
  parseMcpArgsList,
  parseMcpEnvEntries,
  serializeMcpArgsList,
  serializeMcpEnvEntries,
} from "../shared/mcp";
import {
  type McpJsonIssue,
  type McpJsonIssueCode,
  type McpJsonParseResult,
  parseMcpJson,
  prettifyMcpJson,
  serializeMcpServersJson,
} from "../shared/mcp-json";

interface McpSettingsPanelProps {
  servers: McpServerConfigView[];
  busy?: boolean | undefined;
  onSave: (input: McpServerConfigInput) => Promise<void>;
  onDelete: (serverId: string) => Promise<void>;
  onCheck: (input: McpServerConfigInput) => Promise<McpServerCheckResult>;
}

const emptyForm: McpServerConfigInput = {
  name: "",
  transport: "stdio",
  enabled: true,
  command: "",
  argsJson: "[]",
  envJson: "{}",
  url: "",
  headersJson: "{}",
  allowedTools: "",
};

type McpPanelView = "list" | "edit";

type McpEditorMode = "form" | "json";

type McpCheckState =
  | { status: "checking" }
  | { status: "ok"; result: McpServerCheckResult }
  | { status: "error"; result: McpServerCheckResult };

const editorCheckKey = "__editor__";

const EDITOR_JSON_PLACEHOLDER = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}`;

const IMPORT_JSON_PLACEHOLDER = `{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "docs": { "type": "http", "url": "https://example.com/mcp" }
  }
}`;

export function McpSettingsPanel({ servers, busy, onSave, onDelete, onCheck }: McpSettingsPanelProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<McpPanelView>("list");
  const [form, setForm] = useState<McpServerConfigInput>(emptyForm);
  const [args, setArgs] = useState<string[]>([]);
  const [envEntries, setEnvEntries] = useState<Array<{ key: string; value: string }>>([]);
  const [error, setError] = useState<string>();
  const [checkStates, setCheckStates] = useState<Record<string, McpCheckState>>({});
  const [mode, setMode] = useState<McpEditorMode>("form");
  const [jsonText, setJsonText] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (view !== "edit") {
      return;
    }
    setArgs(parseMcpArgsList(form.argsJson ?? "[]"));
    setEnvEntries(parseMcpEnvEntries(form.envJson ?? "{}"));
  }, [view, form.id, form.argsJson, form.envJson]);

  const jsonParse = useMemo(
    () => parseMcpJson(jsonText, { singleServer: true, fallbackName: form.name }),
    [jsonText, form.name],
  );

  function openCreate() {
    setError(undefined);
    setMode("form");
    setJsonText("");
    setForm({ ...emptyForm, enabled: true });
    setView("edit");
  }

  function openEdit(server: McpServerConfigView) {
    setError(undefined);
    setMode("form");
    setJsonText("");
    setForm(mcpServerToInput(server));
    setView("edit");
  }

  function closeEditor() {
    setError(undefined);
    setMode("form");
    setJsonText("");
    setForm(emptyForm);
    setView("list");
  }

  async function handleToggle(server: McpServerConfigView) {
    setError(undefined);
    try {
      await onSave({ ...mcpServerToInput(server), enabled: !server.enabled });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleSave() {
    setError(undefined);
    const resolved = resolveEditorPayload();
    if ("error" in resolved) {
      setError(resolved.error);
      return;
    }
    const payload = resolved.payload;
    const name = payload.name.trim();
    const taken = servers.some(
      (server) => server.id !== payload.id && server.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) {
      setError(t("settings.mcp.nameTaken", { name }));
      return;
    }
    try {
      await onSave(payload);
      closeEditor();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleDelete() {
    if (!form.id) {
      return;
    }
    setError(undefined);
    try {
      await onDelete(form.id);
      closeEditor();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function buildCurrentFormPayload(): McpServerConfigInput {
    return {
      ...form,
      argsJson: serializeMcpArgsList(args),
      envJson: serializeMcpEnvEntries(envEntries),
    };
  }

  /**
   * The two editors are views of one draft, so switching directions has to keep them in
   * step: form → JSON regenerates the blob, JSON → form only lands when it parses cleanly.
   */
  function switchMode(next: McpEditorMode) {
    if (next === mode) {
      return;
    }
    if (next === "json") {
      setError(undefined);
      const draft = buildCurrentFormPayload();
      const blankDraft = !draft.name.trim() && !draft.command?.trim() && !draft.url?.trim();
      // A blank new server is better served by the placeholder example than by an
      // `{"mcpServers": {"server": {"command": ""}}}` skeleton that is already invalid.
      setJsonText(blankDraft ? "" : serializeMcpServersJson([draft]));
      setMode("json");
      return;
    }
    const input = jsonParse.servers[0];
    if (jsonText.trim() === "") {
      // Nothing was typed: keep the draft the form already holds instead of failing on it.
      setError(undefined);
      setMode("form");
      return;
    }
    if (!jsonParse.ok || !input) {
      setError(describeParseFailure(jsonParse, t));
      return;
    }
    const nextForm: McpServerConfigInput = { ...input };
    if (form.resetToolApprovals) nextForm.resetToolApprovals = true;
    if (form.id) {
      nextForm.id = form.id;
    }
    setError(undefined);
    setForm(nextForm);
    setMode("form");
  }

  function resolveEditorPayload(): { payload: McpServerConfigInput } | { error: string } {
    if (mode === "form") {
      return { payload: buildCurrentFormPayload() };
    }
    const input = jsonParse.servers[0];
    if (!jsonParse.ok || !input) {
      return { error: describeParseFailure(jsonParse, t) };
    }
    const payload: McpServerConfigInput = { ...input };
    if (form.resetToolApprovals) payload.resetToolApprovals = true;
    if (form.id) {
      payload.id = form.id;
    }
    return { payload };
  }

  function handleEditorCheck() {
    const resolved = resolveEditorPayload();
    if ("error" in resolved) {
      setError(resolved.error);
      return;
    }
    void handleCheck(editorCheckKey, resolved.payload);
  }

  function handleFormatJson() {
    const pretty = prettifyMcpJson(jsonText);
    if (pretty) {
      setJsonText(pretty);
    }
  }

  async function handleImport(inputs: McpServerConfigInput[]) {
    for (const input of inputs) {
      const existing = servers.find(
        (server) => server.name.toLowerCase() === input.name.trim().toLowerCase(),
      );
      const payload: McpServerConfigInput = { ...input };
      if (existing) {
        payload.id = existing.id;
      }
      await onSave(payload);
    }
  }

  async function handleCheck(key: string, input: McpServerConfigInput) {
    setError(undefined);
    setCheckStates((current) => ({ ...current, [key]: { status: "checking" } }));
    try {
      const result = await onCheck(input);
      setCheckStates((current) => ({
        ...current,
        [key]: { status: result.ok ? "ok" : "error", result },
      }));
    } catch (caught) {
      const result: McpServerCheckResult = {
        ok: false,
        serverName: input.name.trim() || t("settings.mcp.unnamed"),
        transport: input.transport,
        checkedAt: new Date().toISOString(),
        durationMs: 0,
        message: caught instanceof Error ? caught.message : String(caught),
        capabilities: [],
      };
      setCheckStates((current) => ({ ...current, [key]: { status: "error", result } }));
    }
  }

  if (view === "edit") {
    return (
      <McpServerEditor
        form={form}
        rememberedTools={servers.find((server) => server.id === form.id)?.rememberedTools ?? []}
        setForm={setForm}
        args={args}
        setArgs={setArgs}
        envEntries={envEntries}
        setEnvEntries={setEnvEntries}
        error={error}
        busy={busy}
        onBack={closeEditor}
        onSave={handleSave}
        onDelete={handleDelete}
        onCheck={handleEditorCheck}
        checkState={checkStates[editorCheckKey]}
        mode={mode}
        onModeChange={switchMode}
        jsonText={jsonText}
        onJsonTextChange={setJsonText}
        jsonParse={jsonParse}
        onFormatJson={handleFormatJson}
        onRegenerateJson={() => setJsonText(serializeMcpServersJson([buildCurrentFormPayload()]))}
      />
    );
  }

  return (
    <>
      <header className="mcp-page-header">
        <h1>{t("settings.mcp.title")}</h1>
        <p className="mcp-page-desc">
          {t("settings.mcp.description")}{" "}
          <a
            href="https://code.claude.com/docs/en/agent-sdk/mcp"
            target="_blank"
            rel="noreferrer"
            className="mcp-learn-more"
          >
            {t("settings.mcp.learnMore")}
          </a>
        </p>
      </header>

      {error && <p className="settings-form-error mcp-list-error">{error}</p>}

      <section className="mcp-list-section settings-list-scroll-section">
        <div className="mcp-list-toolbar">
          <span className="mcp-list-toolbar-label">{t("settings.mcp.servers")}</span>
          <div className="mcp-list-toolbar-actions">
            <button
              type="button"
              className="mcp-add-button"
              onClick={() => setImportOpen(true)}
              disabled={busy}
            >
              <ClipboardPaste size={16} />
              {t("settings.mcp.import")}
            </button>
            <button type="button" className="mcp-add-button" onClick={openCreate} disabled={busy}>
              <Plus size={16} />
              {t("settings.mcp.add")}
            </button>
          </div>
        </div>

        {servers.length === 0 ? (
          <p className="mcp-list-empty">{t("settings.mcp.empty")}</p>
        ) : (
          <ul className="mcp-server-list">
            {servers.map((server) => (
              <li key={server.id} className="mcp-server-row">
                <div className="mcp-server-summary">
                  <span className="mcp-server-name">{server.name}</span>
                  <span className="mcp-server-meta">
                    {server.transport}
                    <McpCheckStatus state={checkStates[server.id]} />
                  </span>
                </div>
                <div className="mcp-server-actions">
                  <button
                    type="button"
                    className="mcp-icon-button"
                    onClick={() => void handleCheck(server.id, mcpServerToInput(server))}
                    aria-label={t("settings.mcp.checkAria", { name: server.name })}
                    title={t("settings.mcp.check")}
                    disabled={busy || checkStates[server.id]?.status === "checking"}
                  >
                    {checkStates[server.id]?.status === "checking" ? (
                      <LoaderCircle size={18} className="mcp-spin" />
                    ) : (
                      <Radar size={18} />
                    )}
                  </button>
                  <button
                    type="button"
                    className="mcp-icon-button"
                    onClick={() => openEdit(server)}
                    aria-label={t("settings.mcp.configureAria", { name: server.name })}
                    disabled={busy}
                  >
                    <Settings2 size={18} />
                  </button>
                  <label
                    className="mcp-toggle"
                    title={server.enabled ? t("settings.mcp.enabled") : t("settings.mcp.disabled")}
                  >
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      disabled={busy}
                      onChange={() => void handleToggle(server)}
                    />
                    <span className="mcp-toggle-track" aria-hidden />
                  </label>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {importOpen && (
        <McpJsonImportDialog
          servers={servers}
          busy={busy}
          onClose={() => setImportOpen(false)}
          onImport={handleImport}
        />
      )}
    </>
  );
}

function McpServerEditor({
  form,
  rememberedTools,
  setForm,
  args,
  setArgs,
  envEntries,
  setEnvEntries,
  error,
  busy,
  onBack,
  onSave,
  onDelete,
  onCheck,
  checkState,
  mode,
  onModeChange,
  jsonText,
  onJsonTextChange,
  jsonParse,
  onFormatJson,
  onRegenerateJson,
}: {
  form: McpServerConfigInput;
  rememberedTools: string[];
  setForm: Dispatch<SetStateAction<McpServerConfigInput>>;
  args: string[];
  setArgs: Dispatch<SetStateAction<string[]>>;
  envEntries: Array<{ key: string; value: string }>;
  setEnvEntries: Dispatch<SetStateAction<Array<{ key: string; value: string }>>>;
  error?: string | undefined;
  busy?: boolean | undefined;
  onBack: () => void;
  onSave: () => void;
  onDelete: () => void;
  onCheck: () => void;
  checkState?: McpCheckState | undefined;
  mode: McpEditorMode;
  onModeChange: (mode: McpEditorMode) => void;
  jsonText: string;
  onJsonTextChange: (value: string) => void;
  jsonParse: McpJsonParseResult;
  onFormatJson: () => void;
  onRegenerateJson: () => void;
}) {
  const { t } = useTranslation();
  const isEditing = Boolean(form.id);
  const titleName = form.name.trim() || t("settings.mcp.newServer");

  return (
    <>
      <header className="mcp-editor-header">
        <button type="button" className="mcp-back-button" onClick={onBack} disabled={busy}>
          <ChevronLeft size={18} />
          {t("settings.mcp.back")}
        </button>
        {isEditing && (
          <button
            type="button"
            className="mcp-uninstall-button"
            onClick={() => void onDelete()}
            disabled={busy}
          >
            <Trash2 size={16} />
            {t("settings.mcp.uninstall")}
          </button>
        )}
      </header>

      <div className="mcp-editor-title-block">
        <h1>{isEditing ? t("settings.mcp.updateTitle", { name: titleName }) : t("settings.mcp.addTitle")}</h1>
        {isEditing && mode === "form" && <p className="mcp-editor-hint">{t("settings.mcp.switchHint")}</p>}
      </div>

      <div className="mcp-mode-toggle" role="group" aria-label={t("settings.mcp.modeAria")}>
        <button
          type="button"
          className={mode === "form" ? "mcp-mode-btn is-active" : "mcp-mode-btn"}
          onClick={() => onModeChange("form")}
          disabled={busy}
        >
          <ListChecks size={14} />
          {t("settings.mcp.modeForm")}
        </button>
        <button
          type="button"
          className={mode === "json" ? "mcp-mode-btn is-active" : "mcp-mode-btn"}
          onClick={() => onModeChange("json")}
          disabled={busy}
        >
          <Braces size={14} />
          {t("settings.mcp.modeJson")}
        </button>
      </div>

      <div className={mode === "json" ? "mcp-editor-form is-json" : "mcp-editor-form"}>
        {mode === "form" && !isEditing && (
          <label className="mcp-field">
            <span className="mcp-field-label">{t("settings.mcp.name")}</span>
            <input
              className="mcp-field-input"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="github"
            />
          </label>
        )}

        {mode === "form" && !isEditing && (
          <label className="mcp-field">
            <span className="mcp-field-label">{t("settings.mcp.transport")}</span>
            <select
              className="mcp-field-input"
              value={form.transport}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  transport: event.target.value as McpTransport,
                }))
              }
            >
              <option value="stdio">{t("settings.mcp.localProcess")}</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </label>
        )}

        {mode === "json" ? (
          <McpJsonField
            value={jsonText}
            onChange={onJsonTextChange}
            parse={jsonParse}
            placeholder={EDITOR_JSON_PLACEHOLDER}
            onFormat={onFormatJson}
            onRegenerate={onRegenerateJson}
            minLines={14}
          />
        ) : form.transport === "stdio" ? (
          <>
            <label className="mcp-field">
              <span className="mcp-field-label">{t("settings.mcp.command")}</span>
              <input
                className="mcp-field-input"
                value={form.command ?? ""}
                onChange={(event) => setForm((current) => ({ ...current, command: event.target.value }))}
                placeholder="/usr/local/bin/npx"
              />
            </label>

            <div className="mcp-field">
              <span className="mcp-field-label">{t("settings.mcp.arguments")}</span>
              <ul className="mcp-kv-rows">
                {args.map((arg, index) => (
                  <li key={`arg-${index}`} className="mcp-kv-row">
                    <input
                      className="mcp-field-input"
                      value={arg}
                      onChange={(event) =>
                        setArgs((current) =>
                          current.map((entry, entryIndex) =>
                            entryIndex === index ? event.target.value : entry,
                          ),
                        )
                      }
                      placeholder={t("settings.mcp.argumentValue")}
                    />
                    <button
                      type="button"
                      className="mcp-row-delete"
                      onClick={() => setArgs((current) => current.filter((_, i) => i !== index))}
                      aria-label={t("settings.mcp.deleteArgument")}
                    >
                      <Trash2 size={16} />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mcp-inline-add"
                onClick={() => setArgs((current) => [...current, ""])}
              >
                <Plus size={16} />
                {t("settings.mcp.addArgument")}
              </button>
            </div>

            <div className="mcp-field">
              <span className="mcp-field-label">{t("settings.mcp.environment")}</span>
              <ul className="mcp-kv-rows">
                {envEntries.map((entry, index) => (
                  <li key={`env-${index}`} className="mcp-kv-row mcp-env-row">
                    <input
                      className="mcp-field-input mcp-env-key"
                      value={entry.key}
                      onChange={(event) =>
                        setEnvEntries((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, key: event.target.value } : item,
                          ),
                        )
                      }
                      placeholder="KEY"
                    />
                    <input
                      className="mcp-field-input"
                      value={entry.value}
                      onChange={(event) =>
                        setEnvEntries((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, value: event.target.value } : item,
                          ),
                        )
                      }
                      placeholder="value"
                    />
                    <button
                      type="button"
                      className="mcp-row-delete"
                      onClick={() => setEnvEntries((current) => current.filter((_, i) => i !== index))}
                      aria-label={t("settings.mcp.deleteEnvironment")}
                    >
                      <Trash2 size={16} />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mcp-inline-add"
                onClick={() => setEnvEntries((current) => [...current, { key: "", value: "" }])}
              >
                <Plus size={16} />
                {t("settings.mcp.addEnvironment")}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="mcp-field">
              <span className="mcp-field-label">URL</span>
              <input
                className="mcp-field-input"
                value={form.url ?? ""}
                onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
                placeholder="https://api.example.com/mcp"
              />
            </label>
            <label className="mcp-field">
              <span className="mcp-field-label">{t("settings.mcp.headers")}</span>
              <textarea
                className="mcp-field-input mcp-field-textarea"
                value={form.headersJson ?? "{}"}
                onChange={(event) => setForm((current) => ({ ...current, headersJson: event.target.value }))}
                rows={4}
              />
            </label>
          </>
        )}

        {rememberedTools.length > 0 && (
          <div className="mcp-field">
            <span className="mcp-field-label">{t("settings.mcp.rememberedTools")}</span>
            <p>
              {form.resetToolApprovals
                ? t("settings.mcp.resetToolApprovalsPending")
                : rememberedTools.join(" · ")}
            </p>
            <button
              type="button"
              className="mcp-secondary-button"
              disabled={busy || form.resetToolApprovals}
              onClick={() => setForm((current) => ({ ...current, resetToolApprovals: true }))}
            >
              {t("settings.mcp.resetToolApprovals")}
            </button>
          </div>
        )}

        {mode === "form" && (
          <details className="mcp-advanced">
            <summary>{t("settings.mcp.advanced")}</summary>
            <label className="mcp-field">
              <span className="mcp-field-label">{t("settings.mcp.allowedTools")}</span>
              <input
                className="mcp-field-input"
                value={form.allowedTools ?? ""}
                onChange={(event) => setForm((current) => ({ ...current, allowedTools: event.target.value }))}
                placeholder="mcp__github__*"
              />
            </label>
          </details>
        )}

        {error && <p className="settings-form-error">{error}</p>}

        {checkState && <McpCheckCard state={checkState} />}

        <div className="mcp-editor-actions">
          <button
            type="button"
            className="mcp-secondary-button"
            onClick={() => void onCheck()}
            disabled={busy || checkState?.status === "checking"}
          >
            {checkState?.status === "checking" ? (
              <LoaderCircle size={16} className="mcp-spin" />
            ) : (
              <Radar size={16} />
            )}
            {t("settings.mcp.check")}
          </button>
          <button
            type="button"
            className="mcp-save-button"
            onClick={() => void onSave()}
            disabled={busy || (mode === "json" && !jsonParse.ok)}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </>
  );
}

function McpCheckStatus({ state }: { state?: McpCheckState | undefined }) {
  const { t } = useTranslation();
  if (!state) {
    return null;
  }
  if (state.status === "checking") {
    return (
      <span className="mcp-check-status is-checking">
        <LoaderCircle size={13} className="mcp-spin" />
        {t("settings.mcp.checking")}
      </span>
    );
  }
  const result = state.result;
  return (
    <span
      className={result.ok ? "mcp-check-status is-ok" : "mcp-check-status is-error"}
      title={result.details || result.message}
    >
      {result.ok ? <CircleCheck size={13} /> : <CircleAlert size={13} />}
      {formatCheckSummary(result, t)}
    </span>
  );
}

function McpCheckCard({ state }: { state: McpCheckState }) {
  const { t } = useTranslation();
  if (state.status === "checking") {
    return (
      <div className="mcp-check-card is-checking">
        <LoaderCircle size={16} className="mcp-spin" />
        <span>{t("settings.mcp.handshaking")}</span>
      </div>
    );
  }
  const result = state.result;
  return (
    <div className={result.ok ? "mcp-check-card is-ok" : "mcp-check-card is-error"}>
      <div className="mcp-check-card-heading">
        {result.ok ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
        <span>{result.message}</span>
      </div>
      <div className="mcp-check-card-meta">
        <span>{result.transport}</span>
        <span>{result.durationMs}ms</span>
        {result.protocolVersion && (
          <span>{t("settings.mcp.protocol", { version: result.protocolVersion })}</span>
        )}
        {result.serverInfo?.name && <span>{result.serverInfo.name}</span>}
      </div>
      {result.toolNames && result.toolNames.length > 0 && (
        <p className="mcp-check-card-detail">
          {t("settings.mcp.tools", { tools: result.toolNames.join(", ") })}
        </p>
      )}
      {!result.ok && result.details && <p className="mcp-check-card-detail">{result.details}</p>}
    </div>
  );
}

function formatCheckSummary(result: McpServerCheckResult, t: TFunction): string {
  if (!result.ok) {
    return t("settings.mcp.failed", { message: result.message });
  }
  if (typeof result.toolsCount === "number") {
    return t("settings.mcp.passedWithTools", {
      count: result.toolsCount,
      duration: result.durationMs,
    });
  }
  return t("settings.mcp.passed", { duration: result.durationMs });
}

/**
 * Raw-JSON editor for one MCP server, or for a whole pasted `mcpServers` blob. It keeps a
 * line-number gutter aligned with the textarea and reports parse problems as they are typed,
 * so a paste from vendor docs can be checked before anything is saved.
 */
export function McpJsonField({
  value,
  onChange,
  parse,
  placeholder,
  onFormat,
  onRegenerate,
  minLines = 10,
}: {
  value: string;
  onChange: (next: string) => void;
  parse: McpJsonParseResult;
  placeholder: string;
  onFormat: () => void;
  onRegenerate?: () => void;
  minLines?: number;
}) {
  const { t } = useTranslation();
  const gutterRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const lineCount = Math.max(value.split("\n").length, minLines);
  const errorLine = parse.errors[0]?.line;
  const isBlank = value.trim() === "";
  const hasError = !isBlank && parse.errors.length > 0;
  const firstError = parse.errors[0];
  const firstWarning = parse.warnings[0];

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab") {
      return;
    }
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
    window.requestAnimationFrame(() => target.setSelectionRange(start + 2, start + 2));
  }

  return (
    <div className="mcp-json-field">
      <div className="mcp-json-toolbar">
        <span className="mcp-json-hint">{t("settings.mcp.json.hint")}</span>
        <div className="mcp-json-actions">
          {onRegenerate && (
            <button type="button" className="mcp-json-action" onClick={onRegenerate}>
              <RotateCcw size={13} />
              {t("settings.mcp.json.regenerate")}
            </button>
          )}
          <button type="button" className="mcp-json-action" onClick={onFormat}>
            <WandSparkles size={13} />
            {t("settings.mcp.json.format")}
          </button>
          <button type="button" className="mcp-json-action" onClick={() => void copyAll()}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {t(copied ? "settings.mcp.json.copied" : "settings.mcp.json.copy")}
          </button>
        </div>
      </div>

      <div className={hasError ? "mcp-json-editor has-error" : "mcp-json-editor"}>
        <div className="mcp-json-gutter" ref={gutterRef} aria-hidden>
          {Array.from({ length: lineCount }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: line numbers are positional by definition
            <span key={`ln-${index + 1}`} className={errorLine === index + 1 ? "is-error" : undefined}>
              {index + 1}
            </span>
          ))}
        </div>
        <textarea
          className="mcp-json-input"
          value={value}
          rows={lineCount}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          wrap="off"
          placeholder={placeholder}
          aria-label={t("settings.mcp.json.aria")}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            if (gutterRef.current) {
              gutterRef.current.scrollTop = event.currentTarget.scrollTop;
            }
          }}
          onKeyDown={handleKeyDown}
        />
      </div>

      <div className="mcp-json-status">
        {isBlank ? null : firstError ? (
          <p className="mcp-json-message is-error" title={firstError.detail}>
            <CircleAlert size={13} />
            <span>
              {describeIssue(firstError, t)}
              {describeMore(parse.errors.length - 1, t)}
            </span>
          </p>
        ) : parse.servers.length > 0 ? (
          <p className="mcp-json-message is-ok">
            <CircleCheck size={13} />
            <span>{describeParsedServers(parse.servers, t)}</span>
          </p>
        ) : null}
        {isBlank || firstError || !firstWarning ? null : (
          <p className="mcp-json-message is-warn">
            <TriangleAlert size={13} />
            <span>
              {describeIssue(firstWarning, t)}
              {describeMore(parse.warnings.length - 1, t)}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

export function McpJsonImportDialog({
  servers,
  busy,
  onClose,
  onImport,
  initialJson = "",
}: {
  servers: readonly McpServerConfigView[];
  busy?: boolean | undefined;
  onClose: () => void;
  onImport: (inputs: McpServerConfigInput[]) => Promise<void>;
  /** Test-only: pre-fill the editor so the preview list can be asserted. */
  initialJson?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialJson);
  const [error, setError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const parse = useMemo(() => parseMcpJson(text), [text]);
  const known = new Set(servers.map((server) => server.name.toLowerCase()));
  const canImport = parse.ok && parse.servers.length > 0 && !importing && !busy;

  async function submit() {
    if (!canImport) {
      return;
    }
    setError(undefined);
    setImporting(true);
    try {
      await onImport(parse.servers);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="settings-modal-backdrop">
      <button
        type="button"
        className="settings-modal-backdrop-close"
        onClick={onClose}
        aria-label={t("common.close")}
        title={t("common.close")}
        disabled={importing}
      />
      <div
        className="settings-modal mcp-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-import-title"
      >
        <header className="settings-modal-header">
          <h2 id="mcp-import-title" className="settings-modal-title">
            {t("settings.mcp.importTitle")}
          </h2>
        </header>

        <div className="settings-modal-body mcp-import-body">
          <p className="mcp-import-desc">{t("settings.mcp.importDesc")}</p>
          <McpJsonField
            value={text}
            onChange={setText}
            parse={parse}
            placeholder={IMPORT_JSON_PLACEHOLDER}
            onFormat={() => {
              const pretty = prettifyMcpJson(text);
              if (pretty) {
                setText(pretty);
              }
            }}
            minLines={12}
          />

          {parse.servers.length > 0 && (
            <ul className="mcp-import-preview">
              {parse.servers.map((input) => (
                <li key={input.name} className="mcp-import-row">
                  <div className="mcp-import-row-main">
                    <span className="mcp-import-name">{input.name}</span>
                    <span className="mcp-import-summary">{describeInputSummary(input)}</span>
                  </div>
                  <span
                    className={
                      known.has(input.name.toLowerCase()) ? "mcp-import-badge is-update" : "mcp-import-badge"
                    }
                  >
                    {t(
                      known.has(input.name.toLowerCase())
                        ? "settings.mcp.importUpdate"
                        : "settings.mcp.importCreate",
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="settings-form-error">{error}</p>}
        </div>

        <footer className="settings-modal-footer">
          <div className="settings-modal-footer-actions">
            <button type="button" className="settings-modal-cancel" onClick={onClose} disabled={importing}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="settings-modal-confirm mcp-import-confirm"
              onClick={() => void submit()}
              disabled={!canImport}
            >
              {importing ? <LoaderCircle size={14} className="mcp-spin" /> : <ClipboardPaste size={14} />}
              {t("settings.mcp.importAction", { count: parse.servers.length })}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

const ISSUE_KEYS: Record<McpJsonIssueCode, string> = {
  empty: "settings.mcp.json.error.empty",
  syntax: "settings.mcp.json.error.syntax",
  notObject: "settings.mcp.json.error.notObject",
  noServers: "settings.mcp.json.error.noServers",
  tooMany: "settings.mcp.json.error.tooMany",
  missingName: "settings.mcp.json.error.missingName",
  duplicateName: "settings.mcp.json.error.duplicateName",
  nameInvalid: "settings.mcp.json.error.nameInvalid",
  entryNotObject: "settings.mcp.json.error.entryNotObject",
  missingCommand: "settings.mcp.json.error.missingCommand",
  missingUrl: "settings.mcp.json.error.missingUrl",
  invalidArgs: "settings.mcp.json.error.invalidArgs",
  invalidEnv: "settings.mcp.json.error.invalidEnv",
  invalidHeaders: "settings.mcp.json.error.invalidHeaders",
  invalidAllowedTools: "settings.mcp.json.error.invalidAllowedTools",
  invalidTransport: "settings.mcp.json.error.invalidTransport",
  unknownField: "settings.mcp.json.warn.unknownField",
  ignoredTopLevel: "settings.mcp.json.warn.ignoredTopLevel",
};

function describeIssue(issue: McpJsonIssue, t: TFunction): string {
  const label = t(ISSUE_KEYS[issue.code], issue.params ?? {});
  const parts: string[] = [];
  if (issue.serverName) {
    parts.push(issue.serverName);
  }
  parts.push(label);
  if (issue.line) {
    parts.push(t("settings.mcp.json.position", { line: issue.line }));
  }
  return parts.join(" · ");
}

/** Collapse the remaining problems into one suffix so the status line stays a single line. */
function describeMore(extra: number, t: TFunction): string {
  return extra > 0 ? t("settings.mcp.json.moreIssues", { count: extra }) : "";
}

function describeParseFailure(parse: McpJsonParseResult, t: TFunction): string {
  const first = parse.errors[0];
  return first ? describeIssue(first, t) : t("settings.mcp.json.error.unknown");
}

function describeParsedServers(servers: readonly McpServerConfigInput[], t: TFunction): string {
  const first = servers[0];
  if (servers.length === 1 && first) {
    return t("settings.mcp.json.validOne", { name: first.name, transport: first.transport });
  }
  return t("settings.mcp.json.validMany", { count: servers.length });
}

function describeInputSummary(input: McpServerConfigInput): string {
  if (input.transport === "stdio") {
    const args = parseMcpArgsList(input.argsJson ?? "[]");
    return [input.command ?? "", ...args].filter(Boolean).join(" ");
  }
  return input.url ?? "";
}
