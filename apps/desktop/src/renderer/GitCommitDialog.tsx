import { shortcutMatches } from "./keyboard-shortcuts";
import {
  Check,
  ChevronDown,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  Plus,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  findCommitModelOptionForCandidateId,
  resolveInitialCommitModelOption,
} from "../shared/commit-model-options";
import type { CommitModelOptionView, GitWorkingTreeStatus } from "../shared/ipc";
import { ModelCascadeSelect } from "./ModelCascadeSelect";
import { createCommitModelPricingExtra, mapCommitModelOptions } from "./model-cascade-options";
import {
  beginWorkspaceGitAction,
  clearWorkspaceGitAction,
  planWorkspaceGitActionSettlement,
  setWorkspaceGitActionPhase,
  useWorkspaceGitAction,
} from "./workspace-git-action-store";

export type CommitDialogAction = "commit" | "commit-push" | "push";

interface GitCommitDialogProps {
  open: boolean;
  workspacePath: string;
  mainAgentConfigId?: string;
  defaultCandidateModelId?: string;
  gitStatus?: GitWorkingTreeStatus;
  busy?: boolean;
  disabled?: boolean;
  onCheckoutBranch?: (branch: string) => void | Promise<void>;
  onCreateBranch?: (branch: string) => void | Promise<void>;
  onClose: () => void;
  onSaveModelPreference: (candidateModelId: string) => void | Promise<void>;
  onBeforeAction?: () => void | Promise<void>;
  onSuccess: () => void | Promise<void>;
  onPushSuccess?: () => void | Promise<void>;
}

export function GitCommitDialog({
  open,
  workspacePath,
  mainAgentConfigId,
  defaultCandidateModelId,
  gitStatus,
  busy,
  disabled,
  onCheckoutBranch,
  onCreateBranch,
  onClose,
  onSaveModelPreference,
  onBeforeAction,
  onSuccess,
  onPushSuccess,
}: GitCommitDialogProps) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [modelOptions, setModelOptions] = useState<CommitModelOptionView[]>([]);
  const [selectedCandidateModelId, setSelectedCandidateModelId] = useState<string | undefined>();
  const [modelOptionsLoading, setModelOptionsLoading] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchCreateMode, setBranchCreateMode] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState<string | undefined>();
  const [activeAction, setActiveAction] = useState<CommitDialogAction | null>(null);
  const [error, setError] = useState<string | undefined>();
  const workspaceAction = useWorkspaceGitAction(workspacePath);
  const actionPhase = workspaceAction?.phase ?? null;
  const generatingMessage = actionPhase === "generating";
  const submitting = activeAction !== null || actionPhase === "committing" || actionPhase === "pushing";
  const operationIdRef = useRef<number | null>(null);

  const selectedOption = useMemo(
    () => findCommitModelOptionForCandidateId(modelOptions, selectedCandidateModelId),
    [modelOptions, selectedCandidateModelId],
  );

  const modelLabel =
    selectedOption?.modelLabel ??
    (modelOptionsLoading ? t("git.commit.loadingModels") : t("git.commit.noModel"));

  const commitModelCascadeOptions = useMemo(() => mapCommitModelOptions(modelOptions), [modelOptions]);
  const commitModelPricingExtra = useMemo(() => createCommitModelPricingExtra(modelOptions), [modelOptions]);

  useEffect(() => {
    if (!open || !window.eco) {
      setBranchMenuOpen(false);
      setBranchCreateMode(false);
      setNewBranchName("");
      setBranchError(undefined);
      // Closing or unbinding the dialog must not cancel the workspace operation,
      // but local dialog chrome should not leak into the next project.
      if (!open) {
        setActiveAction(null);
      }
      return;
    }
    setMessage("");
    setIncludeUnstaged(true);
    setError(undefined);
    setActiveAction(null);
    setBranchMenuOpen(false);
    setBranchCreateMode(false);
    setNewBranchName("");
    setBranchError(undefined);
    setModelOptionsLoading(true);
    void window.eco
      .listGitCommitModelOptions(mainAgentConfigId ? { mainAgentConfigId } : {})
      .then((result) => {
        setModelOptions(result.options);
        const matched = resolveInitialCommitModelOption(
          result.options,
          result.savedCandidateModelId,
          defaultCandidateModelId,
        );
        setSelectedCandidateModelId(matched?.candidateModelId);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
        setModelOptions([]);
        setSelectedCandidateModelId(undefined);
      })
      .finally(() => {
        setModelOptionsLoading(false);
      });
  }, [open, mainAgentConfigId, defaultCandidateModelId]);

  const handleSelectCandidateModel = useCallback(
    async (candidateModelId: string) => {
      setError(undefined);
      try {
        await onSaveModelPreference(candidateModelId);
        setSelectedCandidateModelId(candidateModelId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [onSaveModelPreference],
  );

  const closeBranchMenu = useCallback(() => {
    setBranchMenuOpen(false);
    setBranchCreateMode(false);
    setNewBranchName("");
    setBranchError(undefined);
  }, []);

  const handleSelectBranch = useCallback(
    async (branch: string) => {
      if (!onCheckoutBranch || branchBusy) {
        return;
      }
      closeBranchMenu();
      setBranchBusy(true);
      try {
        await onCheckoutBranch(branch);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBranchBusy(false);
      }
    },
    [onCheckoutBranch, branchBusy, closeBranchMenu],
  );

  const handleCreateBranch = useCallback(async () => {
    const trimmed = newBranchName.trim();
    if (!onCreateBranch || !trimmed || branchBusy) {
      return;
    }
    setBranchBusy(true);
    setBranchError(undefined);
    try {
      await onCreateBranch(trimmed);
      closeBranchMenu();
    } catch (caught) {
      setBranchError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBranchBusy(false);
    }
  }, [onCreateBranch, newBranchName, branchBusy, closeBranchMenu]);

  const handleGenerateMessage = useCallback(async () => {
    if (!window.eco || generatingMessage || submitting || busy || disabled || workspaceAction) {
      return;
    }
    if (!selectedCandidateModelId) {
      setError(t("git.commit.selectModel"));
      return;
    }
    const operationId = beginWorkspaceGitAction(workspacePath, "generating");
    if (operationId === null) {
      return;
    }
    operationIdRef.current = operationId;
    setError(undefined);
    setMessage("");
    try {
      const result = await window.eco.generateGitCommitMessage(
        {
          workspacePath,
          includeUnstaged,
          candidateModelId: selectedCandidateModelId,
          ...(mainAgentConfigId ? { mainAgentConfigId } : {}),
        },
        {
          onDelta: (text) => {
            setMessage(text);
          },
        },
      );
      setMessage(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (operationIdRef.current === operationId) {
        clearWorkspaceGitAction(workspacePath, operationId);
        operationIdRef.current = null;
      }
    }
  }, [
    generatingMessage,
    submitting,
    busy,
    disabled,
    workspaceAction,
    workspacePath,
    mainAgentConfigId,
    includeUnstaged,
    selectedCandidateModelId,
    t,
  ]);

  const runAction = useCallback(
    async (action: CommitDialogAction) => {
      if (!window.eco || activeAction || disabled || workspaceAction) {
        return;
      }

      await onBeforeAction?.();
      const operationWorkspacePath = workspacePath;
      let operationId: number | null = null;
      let committedSuccessfully = false;
      const trimmed = message.trim();
      const initialPhase = action === "push" ? "pushing" : trimmed ? "committing" : "generating";
      operationId = beginWorkspaceGitAction(operationWorkspacePath, initialPhase);
      if (operationId === null) {
        return;
      }
      operationIdRef.current = operationId;
      setActiveAction(action);
      setError(undefined);
      let actionError: string | undefined;
      try {
        try {
          if (action === "push") {
            await window.eco.pushGitChanges({
              workspacePath: operationWorkspacePath,
              ...(gitStatus?.branch && { branch: gitStatus.branch }),
            });
          } else {
            let commitMessage = trimmed;

            if (!trimmed) {
              if (!selectedCandidateModelId) {
                throw new Error(t("git.commit.selectModel"));
              }
              const generated = await window.eco.generateGitCommitMessage(
                {
                  workspacePath: operationWorkspacePath,
                  includeUnstaged,
                  candidateModelId: selectedCandidateModelId,
                  ...(mainAgentConfigId ? { mainAgentConfigId } : {}),
                },
                {
                  onDelta: (text) => {
                    setMessage(text);
                  },
                },
              );
              commitMessage = generated.message.trim();
              setMessage(generated.message);
              if (!commitMessage) {
                throw new Error(t("git.commit.noGeneratedMessage"));
              }
              if (!setWorkspaceGitActionPhase(operationWorkspacePath, operationId, "committing")) {
                return;
              }
            }

            const result = await window.eco.commitGitChanges({
              workspacePath: operationWorkspacePath,
              includeUnstaged,
              message: commitMessage,
              ...(mainAgentConfigId ? { mainAgentConfigId } : {}),
            });
            committedSuccessfully = true;
            if (!trimmed && result.generated) {
              setMessage(result.message);
            }
            if (action === "commit-push") {
              if (!setWorkspaceGitActionPhase(operationWorkspacePath, operationId, "pushing")) {
                return;
              }
              await window.eco.pushGitChanges({
                workspacePath: operationWorkspacePath,
                ...(gitStatus?.branch && { branch: gitStatus.branch }),
              });
            }
          }
        } catch (caught) {
          actionError = caught instanceof Error ? caught.message : String(caught);
        }

        const settlement = planWorkspaceGitActionSettlement({
          ...(actionError !== undefined && { actionError }),
          committedSuccessfully,
        });

        if (settlement.shouldRefresh) {
          try {
            await onSuccess();
          } catch (successCaught) {
            // Prefer the original git action error when both fail; otherwise surface refresh failure.
            if (settlement.errorMessage) {
              setError(settlement.errorMessage);
            } else {
              setError(successCaught instanceof Error ? successCaught.message : String(successCaught));
            }
            return;
          }
        }

        if (settlement.errorMessage) {
          setError(settlement.errorMessage);
          return;
        }

        if (action === "push" || action === "commit-push") {
          try {
            await onPushSuccess?.();
          } catch {
            // Push already succeeded; notification side effects must not keep the dialog open.
          }
        }

        if (settlement.shouldClose) {
          onClose();
        }
      } finally {
        if (operationId !== null && operationIdRef.current === operationId) {
          clearWorkspaceGitAction(operationWorkspacePath, operationId);
          operationIdRef.current = null;
        }
        setActiveAction(null);
      }
    },
    [
      activeAction,
      disabled,
      workspaceAction,
      selectedCandidateModelId,
      message,
      workspacePath,
      mainAgentConfigId,
      includeUnstaged,
      gitStatus?.branch,
      onBeforeAction,
      onSuccess,
      onPushSuccess,
      onClose,
    ],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (shortcutMatches(event, "git-commit")) {
        event.preventDefault();
        void runAction("commit");
      }
      if (event.key === "Escape") {
        // A portaled model cascade panel owns its own Escape handling.
        const target = event.target as HTMLElement | null;
        if (target?.closest?.(".model-cascade-panel")) {
          return;
        }
        if (branchCreateMode) {
          setBranchCreateMode(false);
          setNewBranchName("");
          setBranchError(undefined);
          return;
        }
        if (branchMenuOpen) {
          closeBranchMenu();
          return;
        }
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, runAction, branchMenuOpen, branchCreateMode, closeBranchMenu]);

  if (!open) {
    return null;
  }

  const insertions = gitStatus?.insertions ?? 0;
  const deletions = gitStatus?.deletions ?? 0;
  const canPush = Boolean(gitStatus?.isGitRepository);
  const canCommit = Boolean(gitStatus?.canCommit) && !disabled;
  const canPushOnly = canPush && (gitStatus?.aheadCount ?? 0) > 0;
  const branchLabel = gitStatus?.branch ?? "detached";
  const branchPickerDisabled = submitting || busy || branchBusy || generatingMessage;
  const showBranchPicker = Boolean(
    gitStatus?.isGitRepository && gitStatus.branches.length > 0 && onCheckoutBranch,
  );
  const modelPickerDisabled =
    submitting || busy || disabled || generatingMessage || modelOptionsLoading || modelOptions.length === 0;
  const messageFieldDisabled = submitting || busy || disabled || generatingMessage;
  const showModelPicker = message.trim().length === 0;

  return createPortal(
    <div className="git-commit-dialog-backdrop" onMouseDown={onClose}>
      <div
        className="git-commit-popover"
        role="dialog"
        aria-label={t("git.commit.dialog")}
        onMouseDown={(event) => {
          event.stopPropagation();
          if (!(event.target as HTMLElement).closest(".git-commit-branch-select-wrap")) {
            closeBranchMenu();
          }
        }}
      >
        <header className="git-commit-popover-header">
          <div className="git-commit-popover-header-row">
            <div className="git-commit-popover-header-branch">
              {showBranchPicker ? (
                <div className="git-commit-branch-select-wrap">
                  <button
                    type="button"
                    className="git-commit-popover-branch git-commit-popover-branch-trigger"
                    disabled={branchPickerDisabled}
                    aria-expanded={branchMenuOpen}
                    aria-haspopup="listbox"
                    aria-label={t("git.commit.switchBranch")}
                    onClick={() => {
                      setBranchMenuOpen((current) => {
                        const next = !current;
                        if (!next) {
                          setBranchCreateMode(false);
                          setNewBranchName("");
                          setBranchError(undefined);
                        }
                        return next;
                      });
                    }}
                  >
                    <GitBranch size={15} strokeWidth={1.75} aria-hidden />
                    <span className="git-commit-popover-branch-label">{branchLabel}</span>
                    <ChevronDown
                      size={13}
                      strokeWidth={2}
                      className={
                        branchMenuOpen ? "git-commit-model-chevron is-open" : "git-commit-model-chevron"
                      }
                      aria-hidden
                    />
                  </button>
                  {branchMenuOpen ? (
                    <div
                      className="git-commit-branch-menu"
                      role="listbox"
                      aria-label={t("git.commit.commitTo")}
                    >
                      {branchCreateMode ? (
                        <div className="git-commit-branch-create">
                          <div className="git-commit-branch-menu-header">{t("git.commit.newBranch")}</div>
                          <input
                            className="git-commit-branch-create-input"
                            value={newBranchName}
                            placeholder={t("git.commit.branchPlaceholder")}
                            disabled={branchBusy}
                            autoFocus
                            onChange={(event) => {
                              setNewBranchName(event.target.value);
                              setBranchError(undefined);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void handleCreateBranch();
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                setBranchCreateMode(false);
                                setNewBranchName("");
                                setBranchError(undefined);
                              }
                            }}
                          />
                          {branchError ? (
                            <p className="git-commit-branch-create-error">{branchError}</p>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <div className="git-commit-branch-menu-header">{t("git.commit.commitTo")}</div>
                          <ul className="git-commit-branch-menu-list">
                            {gitStatus!.branches.map((branch) => {
                              const isActive = branch === gitStatus?.branch;
                              return (
                                <li key={branch}>
                                  <button
                                    type="button"
                                    role="option"
                                    aria-selected={isActive}
                                    className={isActive ? "is-active" : undefined}
                                    disabled={branchBusy}
                                    onClick={() => void handleSelectBranch(branch)}
                                  >
                                    <GitBranch size={14} strokeWidth={1.75} aria-hidden />
                                    <span className="git-commit-branch-menu-label">{branch}</span>
                                    {isActive ? <Check size={14} aria-hidden /> : null}
                                  </button>
                                </li>
                              );
                            })}
                            {onCreateBranch ? (
                              <li>
                                <button
                                  type="button"
                                  className="git-commit-branch-menu-create"
                                  disabled={branchBusy}
                                  onClick={() => {
                                    setBranchCreateMode(true);
                                    setNewBranchName("");
                                    setBranchError(undefined);
                                  }}
                                >
                                  <Plus size={14} strokeWidth={2} aria-hidden />
                                  <span className="git-commit-branch-menu-label">
                                    {t("git.commit.newBranch")}
                                  </span>
                                </button>
                              </li>
                            ) : null}
                          </ul>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="git-commit-popover-branch">
                  <GitBranch size={15} strokeWidth={1.75} aria-hidden />
                  <span>{branchLabel}</span>
                  <ChevronDown size={13} strokeWidth={2} aria-hidden />
                </div>
              )}
            </div>

            <div className="git-commit-popover-stats" aria-label={t("git.commit.changedLines")}>
              <span className="git-commit-stat-add">+{insertions}</span>
              <span className="git-commit-stat-del">-{deletions}</span>
            </div>
          </div>

          {showModelPicker ? (
            <div className="git-commit-popover-header-model">
              <ModelCascadeSelect
                value={
                  selectedOption
                    ? {
                        key: selectedOption.candidateModelId,
                        providerId: selectedOption.providerId,
                        modelId: selectedOption.modelId,
                      }
                    : undefined
                }
                options={commitModelCascadeOptions}
                loading={modelOptionsLoading}
                disabled={modelPickerDisabled}
                placeholder={modelLabel}
                hint={t("git.commit.generationModel")}
                renderExtra={commitModelPricingExtra}
                panelZIndex={11500}
                onChange={(selection) => {
                  if (selection) {
                    void handleSelectCandidateModel(selection.key ?? selection.modelId);
                  }
                }}
              />
            </div>
          ) : null}
        </header>

        <div className="git-commit-popover-body">
          <div className="git-commit-popover-message-wrap">
            <textarea
              className="git-commit-popover-message"
              value={message}
              placeholder={t("git.commit.messagePlaceholder")}
              rows={3}
              disabled={messageFieldDisabled}
              onChange={(event) => {
                const next = event.target.value;
                setMessage(next);
              }}
              autoFocus
            />
            <button
              type="button"
              className="git-commit-popover-message-generate"
              aria-label={t("git.commit.generate")}
              title={t("git.commit.generate")}
              disabled={messageFieldDisabled || !canCommit}
              onClick={() => void handleGenerateMessage()}
            >
              {generatingMessage ? (
                <Loader2 size={16} className="spinning" aria-hidden />
              ) : (
                <Sparkles size={16} strokeWidth={1.75} aria-hidden />
              )}
            </button>
          </div>

          <label className="git-commit-popover-checkbox">
            <input
              type="checkbox"
              checked={includeUnstaged}
              disabled={messageFieldDisabled}
              onChange={(event) => setIncludeUnstaged(event.target.checked)}
            />
            <span>{t("git.commit.includeUnstaged")}</span>
          </label>

          {error ? <p className="git-commit-popover-error">{error}</p> : null}
        </div>

        <ul className="git-commit-popover-actions">
          <li>
            <button
              type="button"
              className="git-commit-popover-action"
              disabled={!canCommit || submitting || busy || generatingMessage}
              onClick={() => void runAction("commit")}
            >
              <GitCommitHorizontal size={16} strokeWidth={1.75} aria-hidden />
              <span>
                {activeAction === "commit" && actionPhase === "committing"
                  ? t("git.commit.committing")
                  : t("git.commit.commit")}
              </span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className="git-commit-popover-action"
              disabled={!canCommit || submitting || busy || generatingMessage}
              onClick={() => void runAction("commit-push")}
            >
              <GitMerge size={16} strokeWidth={1.75} aria-hidden />
              <span>
                {activeAction === "commit-push"
                  ? actionPhase === "pushing"
                    ? t("git.commit.pushing")
                    : t("git.commit.committing")
                  : t("git.commit.commitPush")}
              </span>
            </button>
          </li>
          {canPushOnly ? (
            <li>
              <button
                type="button"
                className="git-commit-popover-action"
                disabled={submitting || busy || generatingMessage}
                onClick={() => void runAction("push")}
              >
                <GitCommitHorizontal size={16} strokeWidth={1.75} aria-hidden />
                <span>
                  {activeAction === "push" && actionPhase === "pushing"
                    ? t("git.commit.pushing")
                    : t("git.commit.pushOnly")}
                </span>
              </button>
            </li>
          ) : null}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
