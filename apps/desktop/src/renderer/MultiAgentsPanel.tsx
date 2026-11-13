import type { PlanDelegationAgentOption } from "@eco/runtime/forced-plan-delegation";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FolderGit2,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  Settings2,
  Square,
  Trash2,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelRef } from "../shared/agent-orchestration";
import type { ModelSettingsSnapshot, ThreadRuntimeConfig } from "../shared/ipc";
import {
  MULTI_AGENTS_CHANGED,
  type MultiAgentsConfig,
  type MultiAgentsMember,
  type MultiAgentsRun,
  type MultiAgentsSnapshot,
} from "../shared/multi-agents";
import { ComposerMainModelPicker } from "./ComposerMainModelPicker";
import {
  SettingsButton,
  SettingsInput,
  SettingsSelect,
  SettingsTextarea,
} from "./components/SettingsControls";
import { SettingsPage, SettingsSection } from "./components/SettingsPage";
import { SettingsResourceList, SettingsResourceRow } from "./components/SettingsResourceList";
import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import { Switch } from "./components/Switch";
import "./multi-agents.css";

export function useMultiAgentsSnapshot() {
  const [snapshot, setSnapshot] = useState<MultiAgentsSnapshot>({ configs: [], runs: [] });
  const [error, setError] = useState("");
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!window.eco) return;
    const revision = ++request.current;
    try {
      const next = await window.eco.getMultiAgentsSnapshot();
      if (request.current === revision) {
        setSnapshot(next);
        setError("");
      }
    } catch (error) {
      if (request.current === revision) setError(String(error));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const dispose = window.eco?.onThreadEvent((event) => {
      if (
        event &&
        typeof event === "object" &&
        "type" in event &&
        (event.type === MULTI_AGENTS_CHANGED || event.type === "thread.plan_execution_updated")
      )
        void refresh();
    });
    const changed = () => {
      void refresh();
    };
    window.addEventListener("multi-agents-configs-changed", changed);
    return () => {
      request.current++;
      dispose?.();
      window.removeEventListener("multi-agents-configs-changed", changed);
    };
  }, [refresh]);
  return { snapshot, error, refresh };
}

function memberConfig(base: ThreadRuntimeConfig, model?: ModelRef): ThreadRuntimeConfig {
  const next = structuredClone(base);
  delete next.resolvedOrchestrationSnapshot;
  delete next.mainAgentModelOverride;
  next.sessionMode = "agent";
  next.subagentEnabled = { explore: false, architect: false, coder: false, reviewer: false, tester: false };
  next.orchestrationSelection = {
    mainPrompt: { mode: "builtin" },
    subagents: { mode: "none" },
    ...(model ? { mainModel: model } : {}),
  };
  return next;
}

const harnessLabels = { codex: "Codex", claude: "Claude Code", pi: "π", acp: "Cursor · ACP" };
const harnessIcons = { codex: "codex.ico", claude: "claude-code.ico", pi: "pi.svg", acp: "cursor.ico" };

function providerLabel(id: string, settings?: ModelSettingsSnapshot) {
  if (id === "openai") return "ChatGPT Login";
  if (id === "eco-coding-chatgpt") return "ChatGPT OAuth";
  return settings?.providers.find((provider) => provider.id === id)?.name ?? id;
}

function MemberEditor({
  member,
  onChange,
  onRemove,
  accountNames,
  settings,
}: {
  member: MultiAgentsMember;
  onChange: (member: MultiAgentsMember) => void;
  onRemove: () => void;
  accountNames: Record<string, string>;
  settings: ModelSettingsSnapshot;
}) {
  const { t } = useTranslation();
  const anchor = useRef<HTMLDivElement>(null);
  const model = member.runtimeConfig.orchestrationSelection?.mainModel;
  return (
    <section className="multi-agents-member" aria-label={t("multiAgents.memberConfiguration", { name: member.name || t("multiAgents.unnamedMember") })}>
      <header className="multi-agents-member-header">
        <img src={`./agent-icons/${harnessIcons[member.coreKind]}`} alt="" aria-hidden />
        <h3>{member.name || t("multiAgents.unnamedMember")}</h3>
        <SettingsButton
          variant="ghost"
          onClick={onRemove}
          aria-label={t("multiAgents.removeMemberName", { name: member.name })}
          title={t("multiAgents.removeMember")}
        >
          <Trash2 size={14} aria-hidden />
        </SettingsButton>
      </header>
      <SettingsGroup>
        <SettingsRow
          label={t("multiAgents.memberName")}
          stackControlOnNarrow
          control={(controlProps) => (
            <SettingsInput
              {...controlProps}
              aria-label={t("multiAgents.memberName")}
              value={member.name}
              onChange={(event) => onChange({ ...member, name: event.target.value })}
            />
          )}
        />
        <SettingsRow
          label="Harness"
          stackControlOnNarrow
          control={(controlProps) => (
            <span className="multi-agents-inline-select">
              <SettingsSelect
                {...controlProps}
                variant="inline"
                aria-label={t("multiAgents.memberHarness")}
                value={member.coreKind}
                onChange={(event) => {
                  const runtimeConfig = memberConfig(member.runtimeConfig);
                  if (event.target.value === "acp") runtimeConfig.cursorModelId = "auto";
                  onChange({
                    ...member,
                    coreKind: event.target.value as MultiAgentsMember["coreKind"],
                    runtimeConfig,
                  });
                }}
              >
                {(["codex", "claude", "pi", "acp"] as const).map((kind) => (
                  <option key={kind} value={kind}>
                    {harnessLabels[kind]}
                  </option>
                ))}
              </SettingsSelect>
              <ChevronDown size={13} aria-hidden />
            </span>
          )}
        />
        <SettingsRow
          label={t("multiAgents.modelAndAccount")}
          description={
            model
              ? `${providerLabel(model.providerId, settings)}${model.accountId ? ` · ${accountNames[model.accountId] ?? model.accountId}` : ""}`
              : t("multiAgents.modelAccountHint")
          }
          stackControlOnNarrow
          control={(controlProps) => (
            <div ref={anchor} className="multi-agents-model-field" {...controlProps}>
              {member.coreKind === "acp" ? (
                <SettingsInput
                  aria-label={t("multiAgents.cursorModel")}
                  value={member.runtimeConfig.cursorModelId ?? "auto"}
                  onChange={(event) =>
                    onChange({
                      ...member,
                      runtimeConfig: { ...member.runtimeConfig, cursorModelId: event.target.value },
                    })
                  }
                />
              ) : (
                <ComposerMainModelPicker
                  anchorRef={anchor}
                  coreKind={member.coreKind}
                  panelZIndex={1600}
                  model={model}
                  onSelect={(model) =>
                    onChange({ ...member, runtimeConfig: memberConfig(member.runtimeConfig, model) })
                  }
                />
              )}
            </div>
          )}
        />
        <SettingsRow
          label={t("multiAgents.responsibility")}
          description={t("multiAgents.responsibilityHint")}
          className="multi-agents-responsibility-row"
          control={(controlProps) => (
            <SettingsTextarea
              {...controlProps}
              aria-label={t("multiAgents.memberResponsibility")}
              rows={2}
              placeholder={t("multiAgents.responsibilityPlaceholder")}
              value={member.responsibility}
              onChange={(event) => onChange({ ...member, responsibility: event.target.value })}
            />
          )}
        />
      </SettingsGroup>
    </section>
  );
}

export function MultiAgentsSettingsPanel({
  baseConfig,
  settings,
}: {
  baseConfig: ThreadRuntimeConfig | null;
  settings: ModelSettingsSnapshot;
}) {
  const { t } = useTranslation();
  const { snapshot, error, refresh } = useMultiAgentsSnapshot();
  const [draft, setDraft] = useState<MultiAgentsConfig>();
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [accountNames, setAccountNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let disposed = false;
    void Promise.all([window.eco!.openAIAccountsList(), window.eco!.chatGptSubscriptionAccountsList()])
      .then(([login, oauth]) => {
        if (!disposed)
          setAccountNames(
            Object.fromEntries([
              ...login.map((account) => [account.id, account.name]),
              ...oauth.map((account) => [account.accountId, account.displayName]),
            ]),
          );
      })
      .catch((error) => {
        if (!disposed) setFailure(t("multiAgents.accountNamesFailed", { message: String(error) }));
      });
    return () => {
      disposed = true;
    };
  }, []);
  const agentOptions = [
    ...new Map(
      settings.subagentOrchestrations.flatMap((config) =>
        config.agents
          .filter((agent) => agent.enabled)
          .map((agent) => [agent.agentKey, agent.displayName || agent.agentKey] as const),
      ),
    ).entries(),
  ];
  const addMember = () => {
    if (!draft || !baseConfig) return;
    const member: MultiAgentsMember = {
      id: crypto.randomUUID(),
      name: `Coder${draft.members.length + 1}`,
      responsibility: "",
      coreKind: "codex",
      runtimeConfig: memberConfig(baseConfig),
    };
    setDraft({ ...draft, members: [...draft.members, member] });
  };
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailure("");
    try {
      await action();
      await refresh();
      window.dispatchEvent(new Event("multi-agents-configs-changed"));
      setDraft(undefined);
    } catch (error) {
      setFailure(String(error));
    } finally {
      setBusy(false);
    }
  };
  const newConfig = () =>
    setDraft({
      id: crypto.randomUUID(),
      name: "",
      mode: "sessions",
      members: [],
      agentKeys: [],
      maxConcurrency: 2,
    });
  return (
    <SettingsPage
      className="multi-agents-settings"
      title="Multi-Agents"
      description={t("multiAgents.intro")}
      actions={
        draft ? (
          <SettingsButton variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>
            <ArrowLeft size={14} aria-hidden />
            {t("multiAgents.configurations")}
          </SettingsButton>
        ) : undefined
      }
    >
      {(failure || error) && (
        <p role="alert" className="multi-agents-notice is-error">
          {failure || error}
        </p>
      )}
      {!draft ? (
        <SettingsSection
          title={t("multiAgents.executionConfiguration")}
          description={t("multiAgents.configurationsHint")}
          actions={
            <SettingsButton variant="primary" disabled={busy} onClick={newConfig}>
              <Plus size={15} aria-hidden />
              {t("multiAgents.newConfiguration")}
            </SettingsButton>
          }
        >
          {snapshot.configs.length > 0 ? (
            <SettingsResourceList>
              {snapshot.configs.map((config) => (
                <SettingsResourceRow
                  key={config.id}
                  name={config.name}
                  icon={<UsersRound size={20} />}
                  description={
                    config.mode === "sessions"
                      ? t("multiAgents.sessionSummary", { members: config.members.length, limit: config.maxConcurrency })
                      : t("multiAgents.nativeSummary", { members: config.agentKeys.length, limit: config.maxConcurrency })
                  }
                  metadata={
                    config.mode === "sessions"
                      ? config.members.map((member) => member.name).join("、")
                      : config.agentKeys
                          .map((key) => agentOptions.find((option) => option[0] === key)?.[1] ?? key)
                          .join("、")
                  }
                  actions={
                    <>
                      <SettingsButton disabled={busy} onClick={() => setDraft(structuredClone(config))}>
                        <Pencil size={13} aria-hidden />
                        {t("multiAgents.edit")}
                      </SettingsButton>
                      <SettingsButton
                        variant="ghost"
                        disabled={busy}
                        aria-label={t("multiAgents.deleteConfigurationName", { name: config.name })}
                        title={t("multiAgents.deleteConfiguration")}
                        onClick={() => void mutate(() => window.eco!.deleteMultiAgentsConfig(config.id))}
                      >
                        <Trash2 size={14} aria-hidden />
                      </SettingsButton>
                    </>
                  }
                />
              ))}
            </SettingsResourceList>
          ) : !error ? (
            <div className="multi-agents-empty">
              <UsersRound size={24} aria-hidden />
              <strong>{t("multiAgents.noConfigurations")}</strong>
              <p>{t("multiAgents.addMembersHint")}</p>
              <SettingsButton disabled={busy} onClick={newConfig}>
                <Plus size={14} aria-hidden />
                {t("multiAgents.newConfiguration")}
              </SettingsButton>
            </div>
          ) : null}
        </SettingsSection>
      ) : (
        <form
          className="multi-agents-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(() => window.eco!.saveMultiAgentsConfig(draft));
          }}
        >
          <fieldset disabled={busy} className="multi-agents-form-fields">
            <SettingsSection
              title={snapshot.configs.some((config) => config.id === draft.id) ? t("multiAgents.editConfiguration") : t("multiAgents.newConfiguration")}
            >
              <SettingsGroup>
                <SettingsRow
                  label={t("multiAgents.configurationName")}
                  stackControlOnNarrow
                  control={(controlProps) => (
                    <SettingsInput
                      {...controlProps}
                      autoFocus
                      required
                      aria-label={t("multiAgents.multiAgentsConfigurationName")}
                      placeholder={t("multiAgents.configurationNamePlaceholder")}
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                  )}
                />
                <SettingsRow
                  label={t("multiAgents.executionMode")}
                  description={
                    draft.mode === "sessions"
                      ? t("multiAgents.sessionsHint")
                      : t("multiAgents.nativeModeHint")
                  }
                  stackControlOnNarrow
                  control={(controlProps) => (
                    <span className="multi-agents-inline-select">
                      <SettingsSelect
                        {...controlProps}
                        variant="inline"
                        aria-label={t("multiAgents.multiAgentsExecutionMode")}
                        value={draft.mode}
                        onChange={(event) =>
                          setDraft({ ...draft, mode: event.target.value as MultiAgentsConfig["mode"] })
                        }
                      >
                        <option value="sessions">{t("multiAgents.separateSessions")}</option>
                        <option value="subagents">{t("multiAgents.nativeSubagents")}</option>
                      </SettingsSelect>
                      <ChevronDown size={13} aria-hidden />
                    </span>
                  )}
                />
                <SettingsRow
                  label={t("multiAgents.concurrencyLimit")}
                  description={t("multiAgents.concurrencyHint")}
                  control={(controlProps) => (
                    <SettingsInput
                      {...controlProps}
                      className="multi-agents-concurrency"
                      aria-label={t("multiAgents.concurrencyLimit")}
                      type="number"
                      min={1}
                      max={16}
                      value={draft.maxConcurrency}
                      onChange={(event) => setDraft({ ...draft, maxConcurrency: Number(event.target.value) })}
                    />
                  )}
                />
              </SettingsGroup>
            </SettingsSection>
            {draft.mode === "sessions" ? (
              <SettingsSection
                title={t("multiAgents.executionMembers")}
                description={t("multiAgents.membersHint")}
                actions={
                  <SettingsButton disabled={!baseConfig || draft.members.length >= 16} onClick={addMember}>
                    <Plus size={14} aria-hidden />
                    {t("multiAgents.addMember")}
                  </SettingsButton>
                }
              >
                {draft.members.length > 0 ? (
                  <div className="multi-agents-member-list">
                    {draft.members.map((member) => (
                      <MemberEditor
                        key={member.id}
                        member={member}
                        accountNames={accountNames}
                        settings={settings}
                        onChange={(next) =>
                          setDraft({
                            ...draft,
                            members: draft.members.map((value) => (value.id === member.id ? next : value)),
                          })
                        }
                        onRemove={() =>
                          setDraft({
                            ...draft,
                            members: draft.members.filter((value) => value.id !== member.id),
                          })
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <div className="multi-agents-empty is-compact">
                    <Bot size={22} aria-hidden />
                    <strong>{t("multiAgents.addTheFirstMember")}</strong>
                    <p>{t("multiAgents.firstMemberHint")}</p>
                  </div>
                )}
                {!baseConfig && (
                  <p role="status" className="multi-agents-hint">
                    {t("multiAgents.runtimeRequired")}
                  </p>
                )}
                <p className="multi-agents-hint">
                  {t("multiAgents.memberRuntimeHint")}
                </p>
                <p className="multi-agents-hint">
                  <FolderGit2 size={13} aria-hidden />
                  {t("multiAgents.worktreeHint")}
                </p>
              </SettingsSection>
            ) : (
              <SettingsSection
                title={t("multiAgents.nativeSubagents")}
                description={t("multiAgents.nativeMembersHint")}
              >
                {agentOptions.length > 0 ? (
                  <SettingsResourceList>
                    {agentOptions.map(([key, name]) => (
                      <SettingsResourceRow
                        key={key}
                        name={name}
                        description={key !== name ? key : undefined}
                        icon={<Bot size={18} />}
                        status={
                          <Switch
                            aria-label={t("multiAgents.enableSubagent", { name })}
                            checked={draft.agentKeys.includes(key)}
                            onCheckedChange={(checked) =>
                              setDraft({
                                ...draft,
                                agentKeys: checked
                                  ? [...draft.agentKeys, key]
                                  : draft.agentKeys.filter((value) => value !== key),
                              })
                            }
                          />
                        }
                      />
                    ))}
                  </SettingsResourceList>
                ) : (
                  <div className="multi-agents-empty is-compact">
                    <Bot size={22} aria-hidden />
                    <strong>{t("multiAgents.noNativeSubagentsYet")}</strong>
                    <p>{t("multiAgents.addNativeSubagentsHint")}</p>
                  </div>
                )}
              </SettingsSection>
            )}
            <footer className="multi-agents-editor-footer">
              <SettingsButton onClick={() => setDraft(undefined)}>{t("multiAgents.cancel")}</SettingsButton>
              <SettingsButton type="submit" variant="primary">
                {busy ? (
                  <LoaderCircle size={14} className="spinning" aria-hidden />
                ) : (
                  <Check size={14} aria-hidden />
                )}
                {t("multiAgents.saveConfiguration")}
              </SettingsButton>
            </footer>
          </fieldset>
        </form>
      )}
    </SettingsPage>
  );
}

export function MultiAgentsChoices({
  configs,
  agents,
  onSelect,
  onConfigure,
  disabled,
  loadError,
}: {
  configs: MultiAgentsConfig[];
  agents: readonly PlanDelegationAgentOption[];
  onSelect: (id: string) => void;
  onConfigure: () => void;
  disabled: boolean;
  loadError?: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="multi-agents-choices">
      <p>{t("multiAgents.choicesHint")}</p>
      {loadError && (
        <p role="alert" className="multi-agents-error">
          {t("multiAgents.unableToLoadConfigurations")}{loadError}
        </p>
      )}
      {configs.map((config) => {
        const unavailable =
          config.mode === "subagents" &&
          config.agentKeys.some((key) => !agents.some((agent) => agent.agentKey === key));
        return (
          <button
            key={config.id}
            type="button"
            className="plan-approval-menu-option multi-agents-choice"
            disabled={disabled || unavailable}
            title={unavailable ? t("multiAgents.missingNativeMembers") : undefined}
            onClick={() => onSelect(config.id)}
          >
            <UsersRound size={16} className="multi-agents-choice-icon" aria-hidden />
            <span>
              <strong>{config.name}</strong>
              <small>
                {config.mode === "sessions"
                  ? t("multiAgents.sessionSummary", { members: config.members.length, limit: config.maxConcurrency })
                  : t("multiAgents.nativeMembers", { members: config.agentKeys.length })}
              </small>
              {unavailable && <small>{t("multiAgents.membersUnavailableInThisSession")}</small>}
            </span>
            <ChevronRight size={14} aria-hidden />
          </button>
        );
      })}
      {!configs.length && !loadError && <p>{t("multiAgents.noMultiAgentsConfigurationsYet")}</p>}
      <button type="button" className="plan-approval-menu-option multi-agents-manage" onClick={onConfigure}>
        <Settings2 size={15} aria-hidden />
        {t("multiAgents.manageMultiAgentsConfigurations")}
      </button>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: MultiAgentsRun["status"] | MultiAgentsRun["tasks"][number]["status"];
}) {
  const { t } = useTranslation();
  return (
    <span className="multi-agents-status" data-status={status}>
      <i aria-hidden />
      {t(`multiAgents.status.${status}`)}
    </span>
  );
}

export function MultiAgentsRunPanel({
  runs,
  onNavigate,
  loadError,
}: {
  runs: MultiAgentsRun[];
  onNavigate: (id: string) => void;
  loadError?: string | undefined;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!runs.length && !loadError) return null;
  const control = async (id: string, action: "pause" | "resume" | "stop") => {
    setBusy(true);
    setError("");
    try {
      await window.eco!.controlMultiAgentsRun(id, action);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="multi-agents-runs">
      {loadError && (
        <p role="alert" className="multi-agents-notice is-error">
          {t("multiAgents.unableToLoadMultiAgentsStatus")}{loadError}
        </p>
      )}
      {error && (
        <p role="alert" className="multi-agents-notice is-error">
          {error}
        </p>
      )}
      {runs.map((run) => {
        const succeeded = run.tasks.filter((task) => task.status === "succeeded").length;
        return (
          <details
            key={run.id}
            className="multi-agents-run"
            open={run.status !== "completed" && run.status !== "cancelled"}
          >
            <summary className="multi-agents-run-summary">
              <UsersRound size={17} aria-hidden />
              <span className="multi-agents-run-heading">
                <strong>{run.config.name}</strong>
                <small>{run.plan
                  ? t("multiAgents.planVersion", { version: run.plan.version ?? 1 })
                  : t("multiAgents.agentRequest")}</small>
              </span>
              <StatusBadge status={run.status} />
              <ChevronRight size={14} className="multi-agents-run-chevron" aria-hidden />
            </summary>
            <div className="multi-agents-run-body">
              {run.tasks.length > 0 && (
                <div className="multi-agents-progress">
                  <span>
                    {t("multiAgents.taskProgress", { completed: succeeded, total: run.tasks.length })}
                  </span>
                  <div
                    role="progressbar"
                    aria-label={t("multiAgents.memberTaskProgress")}
                    aria-valuemin={0}
                    aria-valuemax={run.tasks.length}
                    aria-valuenow={succeeded}
                  >
                    <span style={{ width: `${(100 * succeeded) / run.tasks.length}%` }} />
                  </div>
                </div>
              )}
              {run.message && (
                <p role="status" className="multi-agents-run-message">
                  {run.message}
                </p>
              )}
              {run.status === "planning" && (
                <p className="multi-agents-run-message">{t("multiAgents.waitingForTasks")}</p>
              )}
              {run.config.mode === "subagents" && (
                <p className="multi-agents-run-message">
                  {t("multiAgents.nativeProgress", { members: run.config.agentKeys.join(", ") })}
                </p>
              )}
              <div className="multi-agents-tasks">
                {run.tasks.map((task) => {
                  const member = run.config.members.find((member) => member.id === task.memberId);
                  const model = member?.runtimeConfig.orchestrationSelection?.mainModel;
                  const integrated = task.integratedCommit && task.integratedCommit === task.resultCommit;
                  return (
                    <section className="multi-agents-task" key={task.id}>
                      <div className="multi-agents-task-heading">
                        {member && (
                          <img src={`./agent-icons/${harnessIcons[member.coreKind]}`} alt="" aria-hidden />
                        )}
                        <strong>{task.title}</strong>
                        <StatusBadge status={task.status} />
                        {task.threadId && (
                          <SettingsButton
                            variant="ghost"
                            className="multi-agents-open-thread"
                            title={t("multiAgents.openMemberSession")}
                            aria-label={t("multiAgents.openNamedSession", { name: member?.name ?? t("multiAgents.member") })}
                            onClick={() => onNavigate(task.threadId!)}
                          >
                            <ArrowUpRight size={15} aria-hidden />
                          </SettingsButton>
                        )}
                      </div>
                      <div className="multi-agents-task-meta">
                        <span>{member?.name}</span>
                        <span>{member && harnessLabels[member.coreKind]}</span>
                        <span>{t("multiAgents.attempt", { attempt: task.attempt })}</span>
                        {integrated && (
                          <span className="multi-agents-integrated">
                            <CircleCheck size={12} aria-hidden />
                            {task.integrationResolution ? t("multiAgents.manuallyIntegrated") : t("multiAgents.integrated")}
                          </span>
                        )}
                      </div>
                      {model && (
                        <p className="multi-agents-task-model">
                          {providerLabel(model.providerId)} · {model.modelId}
                          {model.accountId ? t("multiAgents.account", { id: model.accountId }) : ""}
                        </p>
                      )}
                      {task.dependsOn.length > 0 && (
                        <p className="multi-agents-task-model">{t("multiAgents.dependencies")}{task.dependsOn.join("、")}</p>
                      )}
                      {task.error && <p className="multi-agents-notice is-error">{task.error}</p>}
                      {task.integrationError && (
                        <p className="multi-agents-notice is-error">{t("multiAgents.integrationConflict")}{task.integrationError}</p>
                      )}
                      {task.integrationResolution && (
                        <p className="multi-agents-task-model">
                          {t("multiAgents.manualIntegration")}{task.integrationResolution.review}
                        </p>
                      )}
                      <div className="multi-agents-task-details">
                        <details>
                          <summary>
                            <ChevronRight size={12} aria-hidden />
                            {t("multiAgents.taskAndAcceptanceCriteria")}
                          </summary>
                          <div>
                            <p>{task.instructions}</p>
                            <p>{t("multiAgents.scope")}{task.scope.join("、")}</p>
                            <p>{t("multiAgents.review")}{task.acceptance}</p>
                          </div>
                        </details>
                        {Boolean(task.history?.length) && (
                          <details>
                            <summary>
                              <ChevronRight size={12} aria-hidden />
                              {t("multiAgents.previousAttempts", { total: task.history!.length })}
                            </summary>
                            <div>
                              {task.history!.map((attempt, index) => (
                                <p key={index}>
                                  {t("multiAgents.attempt", { attempt: attempt.attempt })} · {t(`multiAgents.status.${attempt.status}`)}
                                  <br />
                                  {attempt.error || attempt.result}
                                </p>
                              ))}
                            </div>
                          </details>
                        )}
                        {task.result && (
                          <details>
                            <summary>
                              <ChevronRight size={12} aria-hidden />
                              {t("multiAgents.executionResults")}
                            </summary>
                            <pre>{task.result}</pre>
                          </details>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
              {run.review && (
                <p className="multi-agents-run-review">
                  <CircleCheck size={15} aria-hidden />
                  <span>{t("multiAgents.review")}{run.review}</span>
                </p>
              )}
            </div>
            {!["completed", "cancelled"].includes(run.status) && (
              <footer className="multi-agents-run-footer">
                {["paused", "interrupted"].includes(run.status) ? (
                  <SettingsButton
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void control(run.id, "resume")}
                  >
                    <Play size={13} aria-hidden />
                    {t("multiAgents.resumeScheduling")}
                  </SettingsButton>
                ) : (
                  <SettingsButton
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void control(run.id, "pause")}
                  >
                    <Pause size={13} aria-hidden />
                    {t("multiAgents.pauseDispatch")}
                  </SettingsButton>
                )}
                <SettingsButton
                  variant="ghost"
                  className="multi-agents-stop"
                  disabled={busy}
                  onClick={() => void control(run.id, "stop")}
                >
                  <Square size={12} aria-hidden />
                  {t("multiAgents.stopAll")}
                </SettingsButton>
              </footer>
            )}
          </details>
        );
      })}
    </div>
  );
}
