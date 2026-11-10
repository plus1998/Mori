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
import type { ModelRef } from "../shared/agent-orchestration";
import type { ModelSettingsSnapshot, ThreadRuntimeConfig } from "../shared/ipc";
import {
  MULTI_AGENTS_CHANGED,
  MULTI_AGENTS_STATUS_LABELS,
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
  const anchor = useRef<HTMLDivElement>(null);
  const model = member.runtimeConfig.orchestrationSelection?.mainModel;
  return (
    <section className="multi-agents-member" aria-label={`${member.name || "未命名成员"} 配置`}>
      <header className="multi-agents-member-header">
        <img src={`./agent-icons/${harnessIcons[member.coreKind]}`} alt="" aria-hidden />
        <h3>{member.name || "未命名成员"}</h3>
        <SettingsButton
          variant="ghost"
          onClick={onRemove}
          aria-label={`移除成员 ${member.name}`}
          title="移除成员"
        >
          <Trash2 size={14} aria-hidden />
        </SettingsButton>
      </header>
      <SettingsGroup>
        <SettingsRow
          label="成员名称"
          stackControlOnNarrow
          control={(controlProps) => (
            <SettingsInput
              {...controlProps}
              aria-label="成员名称"
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
                aria-label="成员 Harness"
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
          label="模型与账号"
          description={
            model
              ? `${providerLabel(model.providerId, settings)}${model.accountId ? ` · ${accountNames[model.accountId] ?? model.accountId}` : ""}`
              : "为此成员单独选择模型和账号"
          }
          stackControlOnNarrow
          control={(controlProps) => (
            <div ref={anchor} className="multi-agents-model-field" {...controlProps}>
              {member.coreKind === "acp" ? (
                <SettingsInput
                  aria-label="Cursor 模型"
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
          label="职责"
          description="主代理根据职责拆分并分配任务"
          className="multi-agents-responsibility-row"
          control={(controlProps) => (
            <SettingsTextarea
              {...controlProps}
              aria-label="成员职责"
              rows={2}
              placeholder="例如：负责后端接口和单元测试"
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
        if (!disposed) setFailure(`读取账号名称失败：${String(error)}`);
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
      description="由当前会话的主代理拆分任务，派发给成员执行，最后统一整合与验收。"
      actions={
        draft ? (
          <SettingsButton variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>
            <ArrowLeft size={14} aria-hidden />
            配置列表
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
          title="执行配置"
          description="保存常用成员组合，在计划执行菜单中选择。"
          actions={
            <SettingsButton variant="primary" disabled={busy} onClick={newConfig}>
              <Plus size={15} aria-hidden />
              新建配置
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
                      ? `${config.members.length} 个成员 · 独立会话 · 最多 ${config.maxConcurrency} 个并行`
                      : `${config.agentKeys.length} 个原生子代理 · 最多 ${config.maxConcurrency} 个并行`
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
                        编辑
                      </SettingsButton>
                      <SettingsButton
                        variant="ghost"
                        disabled={busy}
                        aria-label={`删除配置 ${config.name}`}
                        title="删除配置"
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
              <strong>还没有执行配置</strong>
              <p>添加成员，为他们选择 Harness、模型和账号。</p>
              <SettingsButton disabled={busy} onClick={newConfig}>
                <Plus size={14} aria-hidden />
                新建配置
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
              title={snapshot.configs.some((config) => config.id === draft.id) ? "编辑配置" : "新建配置"}
            >
              <SettingsGroup>
                <SettingsRow
                  label="配置名称"
                  stackControlOnNarrow
                  control={(controlProps) => (
                    <SettingsInput
                      {...controlProps}
                      autoFocus
                      required
                      aria-label="Multi-Agents 配置名称"
                      placeholder="例如：前后端开发"
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                  )}
                />
                <SettingsRow
                  label="执行方式"
                  description={
                    draft.mode === "sessions"
                      ? "成员使用独立会话，可分别选择账号"
                      : "调用当前 Harness 的原生子代理"
                  }
                  stackControlOnNarrow
                  control={(controlProps) => (
                    <span className="multi-agents-inline-select">
                      <SettingsSelect
                        {...controlProps}
                        variant="inline"
                        aria-label="Multi-Agents 执行方式"
                        value={draft.mode}
                        onChange={(event) =>
                          setDraft({ ...draft, mode: event.target.value as MultiAgentsConfig["mode"] })
                        }
                      >
                        <option value="sessions">独立会话</option>
                        <option value="subagents">原生子代理</option>
                      </SettingsSelect>
                      <ChevronDown size={13} aria-hidden />
                    </span>
                  )}
                />
                <SettingsRow
                  label="并发上限"
                  description="同时执行的任务数量"
                  control={(controlProps) => (
                    <SettingsInput
                      {...controlProps}
                      className="multi-agents-concurrency"
                      aria-label="并发上限"
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
                title="执行成员"
                description="主代理根据各成员的职责分配任务。"
                actions={
                  <SettingsButton disabled={!baseConfig || draft.members.length >= 16} onClick={addMember}>
                    <Plus size={14} aria-hidden />
                    添加成员
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
                    <strong>添加第一个执行成员</strong>
                    <p>每个成员可使用不同的 Harness、模型和账号。</p>
                  </div>
                )}
                {!baseConfig && (
                  <p role="status" className="multi-agents-hint">
                    请先在输入框选择有效运行配置，再添加成员。
                  </p>
                )}
                <p className="multi-agents-hint">
                  工具、MCP、Skills 和审批方式沿用添加成员时的运行配置。成员只接收主代理派发的任务。
                </p>
                <p className="multi-agents-hint">
                  <FolderGit2 size={13} aria-hidden />
                  每个任务使用独立会话和工作树，返工沿用原会话。需要在 Git 仓库根目录执行。
                </p>
              </SettingsSection>
            ) : (
              <SettingsSection
                title="原生子代理"
                description="执行时使用主会话已启用的子代理，账号由 Harness 继承。"
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
                            aria-label={`启用子代理 ${name}`}
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
                    <strong>还没有原生子代理</strong>
                    <p>请先在编排组件中添加子代理。</p>
                  </div>
                )}
              </SettingsSection>
            )}
            <footer className="multi-agents-editor-footer">
              <SettingsButton onClick={() => setDraft(undefined)}>取消</SettingsButton>
              <SettingsButton type="submit" variant="primary">
                {busy ? (
                  <LoaderCircle size={14} className="spinning" aria-hidden />
                ) : (
                  <Check size={14} aria-hidden />
                )}
                保存配置
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
  return (
    <div className="multi-agents-choices">
      <p>主代理拆分任务并统一验收</p>
      {loadError && (
        <p role="alert" className="multi-agents-error">
          读取配置失败：{loadError}
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
            title={unavailable ? "当前会话的编排缺少选中的原生子代理" : undefined}
            onClick={() => onSelect(config.id)}
          >
            <UsersRound size={16} className="multi-agents-choice-icon" aria-hidden />
            <span>
              <strong>{config.name}</strong>
              <small>
                {config.mode === "sessions"
                  ? `${config.members.length} 个执行成员 · 独立会话 · 并发 ${config.maxConcurrency}`
                  : `${config.agentKeys.length} 个原生子代理`}
              </small>
              {unavailable && <small>当前会话缺少成员</small>}
            </span>
            <ChevronRight size={14} aria-hidden />
          </button>
        );
      })}
      {!configs.length && !loadError && <p>还没有 Multi-Agents 配置。</p>}
      <button type="button" className="plan-approval-menu-option multi-agents-manage" onClick={onConfigure}>
        <Settings2 size={15} aria-hidden />
        管理 Multi-Agents 配置
      </button>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: MultiAgentsRun["status"] | MultiAgentsRun["tasks"][number]["status"];
}) {
  return (
    <span className="multi-agents-status" data-status={status}>
      <i aria-hidden />
      {MULTI_AGENTS_STATUS_LABELS[status]}
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
          读取 Multi-Agents 状态失败：{loadError}
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
                <small>Multi-Agents · 计划 v{run.plan.version ?? 1}</small>
              </span>
              <StatusBadge status={run.status} />
              <ChevronRight size={14} className="multi-agents-run-chevron" aria-hidden />
            </summary>
            <div className="multi-agents-run-body">
              {run.tasks.length > 0 && (
                <div className="multi-agents-progress">
                  <span>
                    {succeeded} / {run.tasks.length} 个任务执行完成
                  </span>
                  <div
                    role="progressbar"
                    aria-label="成员任务执行进度"
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
                <p className="multi-agents-run-message">等待主代理拆分任务，所选成员是可用成员池。</p>
              )}
              {run.config.mode === "subagents" && (
                <p className="multi-agents-run-message">
                  原生子代理：{run.config.agentKeys.join("、")}。详细进度见 Harness 子代理面板。
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
                            title="打开成员会话"
                            aria-label={`打开 ${member?.name ?? "成员"} 会话`}
                            onClick={() => onNavigate(task.threadId!)}
                          >
                            <ArrowUpRight size={15} aria-hidden />
                          </SettingsButton>
                        )}
                      </div>
                      <div className="multi-agents-task-meta">
                        <span>{member?.name}</span>
                        <span>{member && harnessLabels[member.coreKind]}</span>
                        <span>第 {task.attempt} 次执行</span>
                        {integrated && (
                          <span className="multi-agents-integrated">
                            <CircleCheck size={12} aria-hidden />
                            {task.integrationResolution ? "已人工整合" : "已整合"}
                          </span>
                        )}
                      </div>
                      {model && (
                        <p className="multi-agents-task-model">
                          {providerLabel(model.providerId)} · {model.modelId}
                          {model.accountId ? ` · 账号 ${model.accountId}` : ""}
                        </p>
                      )}
                      {task.dependsOn.length > 0 && (
                        <p className="multi-agents-task-model">依赖：{task.dependsOn.join("、")}</p>
                      )}
                      {task.error && <p className="multi-agents-notice is-error">{task.error}</p>}
                      {task.integrationError && (
                        <p className="multi-agents-notice is-error">整合冲突：{task.integrationError}</p>
                      )}
                      {task.integrationResolution && (
                        <p className="multi-agents-task-model">
                          人工整合：{task.integrationResolution.review}
                        </p>
                      )}
                      <div className="multi-agents-task-details">
                        <details>
                          <summary>
                            <ChevronRight size={12} aria-hidden />
                            任务与验收标准
                          </summary>
                          <div>
                            <p>{task.instructions}</p>
                            <p>范围：{task.scope.join("、")}</p>
                            <p>验收：{task.acceptance}</p>
                          </div>
                        </details>
                        {Boolean(task.history?.length) && (
                          <details>
                            <summary>
                              <ChevronRight size={12} aria-hidden />
                              此前执行记录（{task.history!.length}）
                            </summary>
                            <div>
                              {task.history!.map((attempt, index) => (
                                <p key={index}>
                                  第 {attempt.attempt} 次 · {MULTI_AGENTS_STATUS_LABELS[attempt.status]}
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
                              执行结果
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
                  <span>验收：{run.review}</span>
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
                    恢复调度
                  </SettingsButton>
                ) : (
                  <SettingsButton
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void control(run.id, "pause")}
                  >
                    <Pause size={13} aria-hidden />
                    暂停派发
                  </SettingsButton>
                )}
                <SettingsButton
                  variant="ghost"
                  className="multi-agents-stop"
                  disabled={busy}
                  onClick={() => void control(run.id, "stop")}
                >
                  <Square size={12} aria-hidden />
                  停止全部
                </SettingsButton>
              </footer>
            )}
          </details>
        );
      })}
    </div>
  );
}
