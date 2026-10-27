import {
  Check,
  ChevronLeft,
  CloudUpload,
  KeyRound,
  Loader2,
  Link2,
  LogIn,
  Plus,
  QrCode,
  RefreshCw,
  Settings2,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  CenterServerAccountAuthResult,
  CenterServerApproveVaultClaimResult,
  CenterServerConnectionStatus,
  CenterServerConnectQrResult,
  CenterServerCreatePairingResult,
  CenterServerDeviceBindingView,
  CenterServerDevicePresenceView,
  CenterServerDomainSyncState,
  CenterServerRequestVaultClaimResult,
  EcoConnectDeepLink,
  CenterServerSettingsInput,
  CenterServerSettingsSnapshot,
  CenterServerSettingsView,
  CenterServerSignInRequest,
  CenterServerSignUpRequest,
  CenterServerSubmitVaultClaimCodeResult,
  CenterServerSyncDomain,
  CenterServerSyncStatusSnapshot,
  CenterServerUnlockVaultResult,
  CenterServerVaultClaimView,
  CenterServerVaultStatus,
  CenterServerWrapVaultResult,
  HtmlHostingCapability,
} from "../shared/center-server";
import {
  CENTER_SERVER_EMAIL_NOT_CONFIRMED_MESSAGE,
  CenterServerRemoveConnectionError,
  classifyCenterServerAuthError,
  isCenterServerReloginError,
  isLocalhostCenterServerUrl,
  resolveSupabaseProjectUrl,
} from "../shared/center-server";
import { i18n } from "./i18n";
import { SupabaseDeploymentPanel } from "./SupabaseDeploymentPanel";
import type { SupabaseDeploymentConnection } from "../shared/supabase-deployment";

interface CenterServerSettingsPanelProps {
  snapshot: CenterServerSettingsSnapshot;
  busy?: boolean;
  onSave: (input: CenterServerSettingsInput) => Promise<CenterServerSettingsSnapshot>;
  onTestConnection: (input: {
    supabaseUrl: string;
    anonKey: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  onSignUp: (request: CenterServerSignUpRequest) => Promise<CenterServerAccountAuthResult>;
  onSignIn: (request: CenterServerSignInRequest) => Promise<CenterServerAccountAuthResult>;
  onCreatePairing: () => Promise<CenterServerCreatePairingResult>;
  onListBindings: () => Promise<CenterServerDeviceBindingView[]>;
  onListPresence: () => Promise<CenterServerDevicePresenceView[]>;
  onRevokeBinding: (bindingId: string) => Promise<CenterServerDeviceBindingView>;
  onConnect: () => Promise<CenterServerSettingsSnapshot>;
  onDisconnect: () => Promise<CenterServerSettingsSnapshot>;
  onRemoveConnection: (options?: { forceLocal?: boolean }) => Promise<{
    settings: CenterServerSettingsSnapshot["settings"];
    status: CenterServerSettingsSnapshot["status"];
    notice?: string;
  }>;
  onGetVaultStatus: () => Promise<CenterServerVaultStatus>;
  onGetSyncStatus: () => Promise<CenterServerSyncStatusSnapshot>;
  onUnlockVaultWithPassword: (password: string) => Promise<CenterServerUnlockVaultResult>;
  onWrapVaultWithPassword: (password: string) => Promise<CenterServerWrapVaultResult>;
  onRequestVaultClaim: () => Promise<CenterServerRequestVaultClaimResult>;
  onListPendingVaultClaims: () => Promise<CenterServerVaultClaimView[]>;
  onApproveVaultClaim: (claimId: string) => Promise<CenterServerApproveVaultClaimResult>;
  onSubmitVaultClaimCode: (code: string) => Promise<CenterServerSubmitVaultClaimCodeResult>;
  onCancelVaultClaim: () => Promise<CenterServerVaultStatus>;
  /** Supabase project imported via an eco://connect deep link, if pending. */
  ecoConnectLink?: EcoConnectDeepLink | undefined;
  /** Dismiss the deep-link confirmation dialog. */
  onEcoConnectLinkDismiss: () => void;
}

type PanelView = "list" | "edit-server" | "edit-account";
type AccountAuthMode = "signup" | "signin";
type CenterPanelTab = "sync" | "devices" | "artifacts";
type CenterSectionTab = "connection" | "deployment";

export function CenterServerSettingsPanel({
  snapshot,
  busy,
  onSave,
  onTestConnection,
  onSignUp,
  onSignIn,
  onCreatePairing,
  onListBindings,
  onListPresence,
  onRevokeBinding,
  onDisconnect,
  onRemoveConnection,
  onGetVaultStatus,
  onGetSyncStatus,
  onUnlockVaultWithPassword,
  onWrapVaultWithPassword,
  onRequestVaultClaim,
  onListPendingVaultClaims,
  onApproveVaultClaim,
  onSubmitVaultClaimCode,
  onCancelVaultClaim,
  ecoConnectLink,
  onEcoConnectLinkDismiss,
}: CenterServerSettingsPanelProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<PanelView>("list");
  const [form, setForm] = useState<CenterServerSettingsInput>(() => viewToInput(snapshot.settings));
  const [authMode, setAuthMode] = useState<AccountAuthMode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pairing, setPairing] = useState<CenterServerCreatePairingResult>();
  const [connectQr, setConnectQr] = useState<CenterServerConnectQrResult>();
  const [bindings, setBindings] = useState<CenterServerDeviceBindingView[]>([]);
  const [presence, setPresence] = useState<CenterServerDevicePresenceView[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingsError, setBindingsError] = useState<string>();
  const [revokingBindingId, setRevokingBindingId] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [ecoConnectBusy, setEcoConnectBusy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [serverReachable, setServerReachable] = useState(false);
  const [error, setError] = useState<string>();
  const [infoNotice, setInfoNotice] = useState<string>();
  const [vaultStatus, setVaultStatus] = useState<CenterServerVaultStatus>();
  const [pendingClaims, setPendingClaims] = useState<CenterServerVaultClaimView[]>([]);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultPassword, setVaultPassword] = useState("");
  const [claimCodeInput, setClaimCodeInput] = useState("");
  const [approvalCode, setApprovalCode] = useState<string>();
  const [approvalTarget, setApprovalTarget] = useState<string>();
  const [claimCodeSheetOpen, setClaimCodeSheetOpen] = useState(false);
  const [approvalSheetOpen, setApprovalSheetOpen] = useState(false);
  const [pairingSheetOpen, setPairingSheetOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<CenterServerSyncStatusSnapshot>();
  const [syncStatusLoading, setSyncStatusLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<CenterPanelTab>("sync");
  const [sectionTab, setSectionTab] = useState<CenterSectionTab>("connection");
  const onListBindingsRef = useRef(onListBindings);
  const onListPresenceRef = useRef(onListPresence);
  onListBindingsRef.current = onListBindings;
  onListPresenceRef.current = onListPresence;

  const registered = snapshot.settings.hasDeviceSecret || snapshot.settings.hasRefreshToken;
  const projectUrl = form.supabaseUrl?.trim() || form.serverUrl?.trim() || "";
  const hasUrl = projectUrl.length > 0;
  const hasAnonKeyInput = Boolean(form.anonKey?.trim()) || snapshot.settings.hasAnonKey;
  // Binding list refresh must not disable the connection switch / delete action.
  const actionBusy =
    busy || testing || pairingBusy || connectionBusy || saveBusy || authBusy || vaultBusy || ecoConnectBusy;
  const isLive = snapshot.status.state === "connected";
  const isConnecting = snapshot.status.state === "connecting";
  const needsReauth =
    registered && snapshot.status.state === "error" && isCenterServerReloginError(snapshot.status.lastError);
  const serverUrl = projectUrl || snapshot.settings.supabaseUrl || snapshot.settings.serverUrl;
  const deviceLabel = snapshot.settings.deviceName || t("settings.center.remoteService");
  const activeBindings = bindings.filter((binding) => binding.revokedAt == null);
  const hasVaultKey = vaultStatus?.hasVaultKey ?? snapshot.settings.hasVaultKey;
  const centerPanelTabs: Array<{ id: CenterPanelTab; label: string }> = [
    { id: "sync", label: t("settings.center.tab.sync") },
    { id: "devices", label: t("settings.center.tab.devices") },
    { id: "artifacts", label: t("settings.center.tab.artifacts") },
  ];

  const refreshVault = useCallback(async () => {
    if (!registered || !isLive) {
      setVaultStatus(undefined);
      setPendingClaims([]);
      return;
    }
    try {
      const [status, claims] = await Promise.all([
        onGetVaultStatus(),
        onListPendingVaultClaims().catch(() => [] as CenterServerVaultClaimView[]),
      ]);
      setVaultStatus(status);
      setPendingClaims(claims);
      if (status.approvalCode) {
        setApprovalCode(status.approvalCode);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [isLive, onGetVaultStatus, onListPendingVaultClaims, registered]);

  const refreshSyncStatus = useCallback(async () => {
    if (!registered || !isLive) {
      setSyncStatus(undefined);
      return;
    }
    setSyncStatusLoading(true);
    try {
      setSyncStatus(await onGetSyncStatus());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSyncStatusLoading(false);
    }
  }, [isLive, onGetSyncStatus, registered]);

  const refreshBindings = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (!registered || !isLive) {
        setBindings([]);
        setPresence([]);
        return;
      }
      const showLoading = options?.showLoading !== false;
      if (showLoading) {
        setBindingsLoading(true);
      }
      setBindingsError(undefined);
      try {
        const [nextBindings, nextPresence] = await Promise.all([
          onListBindingsRef.current(),
          onListPresenceRef.current(),
        ]);
        setBindings(nextBindings);
        setPresence(nextPresence);
      } catch (caught) {
        setBindingsError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (showLoading) {
          setBindingsLoading(false);
        }
      }
    },
    [isLive, registered],
  );

  useEffect(() => {
    setForm(viewToInput(snapshot.settings));
  }, [snapshot.settings]);

  useEffect(() => {
    void refreshBindings();
  }, [refreshBindings]);

  useEffect(() => {
    void refreshVault();
  }, [refreshVault]);

  useEffect(() => {
    void refreshSyncStatus();
  }, [refreshSyncStatus]);

  useEffect(() => {
    if (!registered || !isLive) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshVault();
      void refreshSyncStatus();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [isLive, registered, refreshSyncStatus, refreshVault]);

  useEffect(() => {
    if (!snapshot.status.lastPresenceChangedAt) {
      return;
    }
    void refreshBindings({ showLoading: false });
    void refreshVault();
    void refreshSyncStatus();
  }, [refreshBindings, refreshSyncStatus, refreshVault, snapshot.status.lastPresenceChangedAt]);

  useEffect(() => {
    if (!pairing || !isLive) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshBindings({ showLoading: false });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [isLive, pairing, refreshBindings]);

  async function handleTestConnection() {
    setError(undefined);
    setTesting(true);
    try {
      if (!hasUrl) {
        setServerReachable(false);
        setError(t("settings.center.serverRequired"));
        return;
      }
      if (!hasAnonKeyInput) {
        setServerReachable(false);
        setError(t("settings.center.anonKeyRequired"));
        return;
      }
      const result = await onTestConnection({
        supabaseUrl: projectUrl,
        anonKey: form.anonKey?.trim() ?? "",
      });
      if (result.ok) {
        setServerReachable(true);
      } else {
        setServerReachable(false);
        setError(result.error ?? t("settings.center.unreachable"));
      }
    } catch (caught) {
      setServerReachable(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveServer() {
    const deviceName = form.deviceName?.trim();
    if (!hasUrl) {
      setError(t("settings.center.serverRequired"));
      return;
    }
    if (!hasAnonKeyInput) {
      setError(t("settings.center.anonKeyRequired"));
      return;
    }
    if (!deviceName) {
      setError(t("settings.center.deviceRequired"));
      return;
    }
    if (!registered && !serverReachable) {
      setError(t("settings.center.testFirst"));
      return;
    }

    setError(undefined);
    setSaveBusy(true);
    try {
      await onSave({
        ...form,
        enabled: registered ? form.enabled : false,
        supabaseUrl: projectUrl,
        serverUrl: projectUrl,
        deviceName,
        anonKey: form.anonKey?.trim() ? form.anonKey.trim() : "",
      });
      if (registered) {
        setView("list");
      } else {
        setView("edit-account");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaveBusy(false);
    }
  }

  // The project this device is currently bound to (from the stored config).
  const boundProjectUrl = resolveSupabaseProjectUrl({
    supabaseUrl: snapshot.settings.supabaseUrl,
    serverUrl: snapshot.settings.serverUrl,
  });
  const sameProjectAsBound =
    Boolean(ecoConnectLink?.supabaseUrl) && boundProjectUrl === ecoConnectLink!.supabaseUrl;

  async function handleEcoConnectConfirm() {
    if (!ecoConnectLink) {
      return;
    }
    // An existing connection to a different project must be removed first.
    if (registered && boundProjectUrl && !sameProjectAsBound) {
      setError(t("settings.center.ecoConnect.alreadyConnected", { name: deviceLabel }));
      onEcoConnectLinkDismiss();
      return;
    }
    if (!ecoConnectLink.supabaseUrl) {
      setError(t("settings.center.ecoConnect.invalidUrl"));
      onEcoConnectLinkDismiss();
      return;
    }
    setError(undefined);
    setEcoConnectBusy(true);
    try {
      await onSave({
        ...form,
        enabled: registered ? form.enabled : false,
        supabaseUrl: ecoConnectLink.supabaseUrl,
        serverUrl: ecoConnectLink.supabaseUrl,
        deviceName: form.deviceName?.trim() || snapshot.settings.deviceName,
        anonKey: ecoConnectLink.anonKey,
      });
      onEcoConnectLinkDismiss();
      if (!registered) {
        // Fresh import — continue into account setup (sign up / sign in),
        // matching the manual "save server config" -> "edit-account" flow.
        setAuthMode("signup");
        setView("edit-account");
        return;
      }
      setView("list");
      setInfoNotice(
        sameProjectAsBound
          ? t("settings.center.ecoConnect.sameSuccess")
          : t("settings.center.ecoConnect.success"),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEcoConnectBusy(false);
    }
  }

  async function handleAccountAuth() {
    const deviceName = form.deviceName?.trim() || snapshot.settings.deviceName;
    if (!email.trim() || !password.trim() || !deviceName) {
      setError(t("settings.center.credentialsRequired"));
      return;
    }
    if (!projectUrl) {
      setError(t("settings.center.serverRequired"));
      return;
    }
    setError(undefined);
    setInfoNotice(undefined);
    setAuthBusy(true);
    try {
      const anonKey = form.anonKey?.trim() ?? "";
      if (authMode === "signup") {
        const result = await onSignUp({
          supabaseUrl: projectUrl,
          anonKey,
          email: email.trim(),
          password,
          deviceName,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        });
        setPassword("");
        if (result.emailConfirmationRequired) {
          setAuthMode("signin");
          setInfoNotice(t("settings.center.emailConfirmRequired"));
          return;
        }
      } else {
        await onSignIn({
          supabaseUrl: projectUrl,
          anonKey,
          email: email.trim(),
          password,
          deviceName,
        });
        setPassword("");
      }
      setView("list");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message === CENTER_SERVER_EMAIL_NOT_CONFIRMED_MESSAGE || /email\s*not\s*confirmed/i.test(message)) {
        setError(t("settings.center.emailNotConfirmed"));
      } else {
        setError(message);
      }
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleToggle(enabled: boolean) {
    setError(undefined);
    setConnectionBusy(true);
    try {
      const nextForm = { ...form, enabled };
      setForm(nextForm);
      const nextSnapshot = await onSave(nextForm);
      if (!enabled) {
        await onDisconnect();
      } else if (nextSnapshot.status.state === "error") {
        setError(nextSnapshot.status.lastError ?? t("settings.center.connectionFailed"));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setConnectionBusy(false);
    }
  }

  async function handleCreatePairing() {
    setPairingBusy(true);
    try {
      const result = await onCreatePairing();
      setPairing(result);
      setConnectQr({ qrPayload: result.qrPayload });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setPairingBusy(false);
    }
  }

  async function openPairingSheet() {
    setError(undefined);
    setPairingSheetOpen(true);
    try {
      await handleCreatePairing();
    } catch {
      // Error is shown in the page banner and the sheet stays open with retry affordance.
    }
  }

  function closePairingSheet() {
    setPairingSheetOpen(false);
  }

  async function handleUnlockVaultWithPassword() {
    setError(undefined);
    setVaultBusy(true);
    try {
      const result = await onUnlockVaultWithPassword(vaultPassword);
      setVaultStatus(result.vaultStatus);
      setVaultPassword("");
      setInfoNotice(t("settings.center.vault.unlockDone"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleWrapVaultWithPassword() {
    setError(undefined);
    setVaultBusy(true);
    try {
      const result = await onWrapVaultWithPassword(vaultPassword);
      setVaultStatus(result.vaultStatus);
      setVaultPassword("");
      setInfoNotice(t("settings.center.vault.wrapDone"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleRequestVaultClaim() {
    setError(undefined);
    setVaultBusy(true);
    try {
      await onRequestVaultClaim();
      await refreshVault();
      setClaimCodeSheetOpen(true);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (/vault_no_synced_device/i.test(message)) {
        setError(t("settings.center.vault.noSyncedDevice"));
      } else {
        setError(message);
      }
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleApproveVaultClaim(claim: CenterServerVaultClaimView) {
    setError(undefined);
    setVaultBusy(true);
    try {
      const result = await onApproveVaultClaim(claim.id);
      setApprovalCode(result.code);
      setApprovalTarget(
        t("settings.center.vault.pendingClaim", { id: shortenDeviceId(claim.requesterDeviceId) }),
      );
      setApprovalSheetOpen(true);
      await refreshVault();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleSubmitVaultClaimCode() {
    setError(undefined);
    setVaultBusy(true);
    try {
      await onSubmitVaultClaimCode(claimCodeInput);
      setClaimCodeInput("");
      setClaimCodeSheetOpen(false);
      await refreshVault();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleCancelVaultClaim() {
    setError(undefined);
    setVaultBusy(true);
    try {
      setVaultStatus(await onCancelVaultClaim());
      setClaimCodeInput("");
      setClaimCodeSheetOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleRevokeBinding(binding: CenterServerDeviceBindingView) {
    const mobile = presence.find((device) => device.id === binding.mobileDeviceId);
    const mobileLabel = mobile?.name ?? shortenDeviceId(binding.mobileDeviceId);
    const confirmed = window.confirm(t("settings.center.confirmUnbind", { name: mobileLabel }));
    if (!confirmed) {
      return;
    }
    setBindingsError(undefined);
    setRevokingBindingId(binding.id);
    try {
      await onRevokeBinding(binding.id);
      await refreshBindings();
    } catch (caught) {
      setBindingsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRevokingBindingId(undefined);
    }
  }

  function buildForceLocalConfirmMessage(error: unknown): string {
    const recovery =
      error instanceof CenterServerRemoveConnectionError
        ? error.recovery
        : classifyCenterServerAuthError(error instanceof Error ? error.message : String(error));
    const detail = error instanceof Error ? error.message : String(error);
    if (recovery === "account_unusable") {
      return t("settings.center.remove.accountUnusable", { detail });
    }
    if (recovery === "relogin") {
      return t("settings.center.remove.relogin", { detail });
    }
    return t("settings.center.remove.unreachable", { detail });
  }

  async function handleRemoveConnection(forceLocal = false) {
    if (!forceLocal) {
      const confirmed = window.confirm(t("settings.center.confirmRemove", { name: deviceLabel }));
      if (!confirmed) {
        return;
      }
    }

    setError(undefined);
    setConnectionBusy(true);
    try {
      const result = await onRemoveConnection(forceLocal ? { forceLocal: true } : undefined);
      setForm(viewToInput(result.settings));
      setPairing(undefined);
      setBindings([]);
      setPresence([]);
      setView("list");
      if (result.notice) {
        setError(result.notice);
      }
    } catch (caught) {
      const forceConfirmed = window.confirm(buildForceLocalConfirmMessage(caught));
      if (forceConfirmed) {
        await handleRemoveConnection(true);
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setConnectionBusy(false);
    }
  }

  function openSetup() {
    setError(undefined);
    setServerReachable(
      Boolean((snapshot.settings.supabaseUrl || snapshot.settings.serverUrl).trim()) &&
        snapshot.settings.hasAnonKey,
    );
    setView("edit-server");
  }

  async function handleUseDeployedProject(connection: SupabaseDeploymentConnection) {
    if (registered && boundProjectUrl !== connection.supabaseUrl) {
      throw new Error(t("settings.center.cloud.removeExisting"));
    }
    await onSave({
      ...form,
      ...connection,
      serverUrl: connection.supabaseUrl,
      enabled: registered ? form.enabled : false,
      deviceName: form.deviceName?.trim() || snapshot.settings.deviceName,
    });
    setServerReachable(true);
    setSectionTab("connection");
    if (!registered) {
      setAuthMode("signup");
      setView("edit-account");
    }
  }

  function openServerEditor() {
    setError(undefined);
    setServerReachable(true);
    setView("edit-server");
  }

  function openReauth() {
    setError(undefined);
    setAuthMode("signin");
    setView("edit-account");
  }

  const ecoConnectDialog = ecoConnectLink
    ? createPortal(
        <div className="cs-sheet-backdrop cs-sheet-backdrop--blocking" role="presentation">
          <button
            type="button"
            className="cs-sheet-scrim"
            aria-label={t("common.close")}
            disabled={actionBusy}
            onClick={() => onEcoConnectLinkDismiss()}
          />
          <div
            className="cs-sheet cs-sheet--connect"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cs-connect-title"
          >
            <div className="cs-sheet-stack">
              <span className="cs-sheet-glyph" aria-hidden>
                <Smartphone size={22} strokeWidth={1.75} />
              </span>
              <header className="cs-sheet-head">
                <h2 id="cs-connect-title" className="cs-sheet-title">
                  {t("settings.center.ecoConnect.title")}
                </h2>
                <p className="cs-sheet-subtitle">
                  {t("settings.center.ecoConnect.description", {
                    url: ecoConnectLink.supabaseUrl,
                  })}
                </p>
              </header>
              {sameProjectAsBound && registered ? (
                <p className="cs-pairing-note">{t("settings.center.ecoConnect.sameProject")}</p>
              ) : registered && boundProjectUrl ? (
                <p className="cs-error">
                  {t("settings.center.ecoConnect.alreadyConnected", { name: deviceLabel })}
                </p>
              ) : null}
              <div className="cs-sheet-actions">
                <button
                  type="button"
                  className="cs-btn"
                  disabled={actionBusy}
                  onClick={() => onEcoConnectLinkDismiss()}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="cs-btn cs-btn--accent"
                  disabled={Boolean(
                    actionBusy ||
                      !ecoConnectLink.supabaseUrl ||
                      (registered && boundProjectUrl && !sameProjectAsBound),
                  )}
                  onClick={() => void handleEcoConnectConfirm()}
                >
                  {t("settings.center.ecoConnect.confirm")}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  if (view === "edit-server") {
    return (
      <div className="cs">
        {ecoConnectDialog}
        <ServerEditor
          form={form}
          setForm={setForm}
          registered={registered}
          serverReachable={serverReachable}
          error={error}
          busy={actionBusy}
          testing={testing}
          onBack={() => setView("list")}
          onTestConnection={() => void handleTestConnection()}
          onSave={() => void handleSaveServer()}
          onServerUrlChange={() => setServerReachable(false)}
        />
      </div>
    );
  }

  if (view === "edit-account") {
    return (
      <div className="cs">
        {ecoConnectDialog}
        <AccountEditor
          serverUrl={serverUrl}
          registered={registered}
          authMode={authMode}
          setAuthMode={setAuthMode}
          email={email}
          setEmail={setEmail}
          password={password}
          setPassword={setPassword}
          displayName={displayName}
          setDisplayName={setDisplayName}
          error={error}
          infoNotice={infoNotice}
          busy={actionBusy}
          onBack={() => (registered ? setView("list") : setView("edit-server"))}
          onSubmit={() => void handleAccountAuth()}
        />
      </div>
    );
  }

  return (
    <div className="cs">
      {ecoConnectDialog}
      <header className="cs-head">
        <h1 className="cs-title">{t("settings.center.title")}</h1>
        <p className="cs-desc">{t("settings.center.description")}</p>
      </header>

      <div
        className="cs-tabs cs-section-tabs"
        role="tablist"
        aria-label={t("settings.center.sections.label")}
        onKeyDown={(event) => {
          let next: CenterSectionTab;
          if (event.key === "Home") next = "connection";
          else if (event.key === "End") next = "deployment";
          else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            next = sectionTab === "connection" ? "deployment" : "connection";
          } else return;
          event.preventDefault();
          setSectionTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`#cs-section-tab-${next}`)?.focus();
        }}
      >
        <button
          type="button"
          id="cs-section-tab-connection"
          role="tab"
          aria-selected={sectionTab === "connection"}
          aria-controls="cs-section-panel-connection"
          tabIndex={sectionTab === "connection" ? 0 : -1}
          className={sectionTab === "connection" ? "cs-tab is-active" : "cs-tab"}
          onClick={() => setSectionTab("connection")}
        >
          <Link2 size={14} aria-hidden />
          {t("settings.center.section.connection")}
        </button>
        <button
          type="button"
          id="cs-section-tab-deployment"
          role="tab"
          aria-selected={sectionTab === "deployment"}
          aria-controls="cs-section-panel-deployment"
          tabIndex={sectionTab === "deployment" ? 0 : -1}
          className={sectionTab === "deployment" ? "cs-tab is-active" : "cs-tab"}
          onClick={() => setSectionTab("deployment")}
        >
          <CloudUpload size={14} aria-hidden />
          {t("settings.center.section.deployment")}
        </button>
      </div>

      <div
        className="cs-section-panel"
        role="tabpanel"
        id="cs-section-panel-connection"
        aria-labelledby="cs-section-tab-connection"
        hidden={sectionTab !== "connection"}
      >
        {error ? <p className="cs-error">{error}</p> : null}

        {!registered ? (
          <div className="cs-empty">
            <p className="cs-empty-text">{t("settings.center.empty")}</p>
            <button type="button" className="cs-btn" disabled={actionBusy} onClick={openSetup}>
              <Plus size={15} strokeWidth={1.75} />
              {t("settings.center.add")}
            </button>
          </div>
        ) : (
          <div className="cs-card">
            <div className="cs-card-row">
              <div className="cs-service">
                <span className={`cs-dot cs-dot--${statusDotKind(snapshot.status)}`} aria-hidden />
                <div className="cs-service-copy">
                  <span className="cs-service-name">{deviceLabel}</span>
                  <span className="cs-service-url">{serverUrl}</span>
                  <StatusMeta status={snapshot.status} needsReauth={needsReauth} />
                </div>
              </div>
              <div className="cs-card-tools">
                {needsReauth ? (
                  <button
                    type="button"
                    className="cs-icon-btn is-warn"
                    onClick={openReauth}
                    aria-label={t("settings.center.relogin")}
                    title={t("settings.center.relogin")}
                    disabled={actionBusy}
                  >
                    <LogIn size={16} strokeWidth={1.75} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="cs-icon-btn"
                  onClick={openServerEditor}
                  aria-label={t("settings.center.configure")}
                  disabled={actionBusy}
                >
                  <Settings2 size={16} strokeWidth={1.75} />
                </button>
                <label
                  className="cs-switch"
                  title={form.enabled ? t("common.enabled") : t("common.disabled")}
                >
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    disabled={actionBusy || isConnecting}
                    onChange={(event) => void handleToggle(event.target.checked)}
                  />
                  <span className="cs-switch-track" aria-hidden />
                </label>
              </div>
            </div>
          </div>
        )}

        {registered ? (
          <section className="cs-block cs-block--after-card">
            <button
              type="button"
              className="cs-text-action is-muted"
              disabled={actionBusy}
              onClick={() => void handleRemoveConnection()}
            >
              <Trash2 size={14} strokeWidth={1.75} />
              {t("settings.center.delete")}
            </button>
          </section>
        ) : null}

        {registered && isLive ? (
          <div
            className="models-settings-tabs cs-panel-tabs"
            role="tablist"
            aria-label={t("settings.center.tabs.label")}
          >
            {centerPanelTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? "models-settings-tab active" : "models-settings-tab"}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : null}

        {registered && isLive && activeTab === "sync" ? (
          <div className="cs-tab-panel" role="tabpanel">
            <section className="cs-block cs-block--tab-first">
              <h2 className="cs-block-label">{t("settings.center.vault.unlockTitle")}</h2>
              <div className="cs-card cs-vault-card">
                <div className="cs-vault-status-row">
                  <div className="cs-vault-status-copy">
                    <span className="cs-vault-status-title">
                      <span
                        className={`cs-vault-status-dot cs-vault-status-dot--${
                          hasVaultKey
                            ? "ready"
                            : vaultStatus?.state === "needs_password" || vaultStatus?.hasPasswordWrap
                              ? "need-auth"
                              : vaultStatus?.state === "claim_pending" || vaultStatus?.activeClaimId
                                ? "pending"
                                : "need-auth"
                        }`}
                        aria-hidden
                      />
                      {hasVaultKey
                        ? t("settings.center.vault.statusReady")
                        : vaultStatus?.state === "needs_password" || vaultStatus?.hasPasswordWrap
                          ? t("settings.center.vault.statusNeedPassword")
                          : vaultStatus?.state === "claim_pending" || vaultStatus?.activeClaimId
                            ? t("settings.center.vault.statusWaiting")
                            : t("settings.center.vault.statusNeedPassword")}
                    </span>
                    {vaultStatus?.needsPasswordWrap ? (
                      <span className="cs-vault-status-meta">{t("settings.center.vault.needsWrapHint")}</span>
                    ) : null}
                  </div>
                  {!hasVaultKey || vaultStatus?.needsPasswordWrap ? (
                    <div className="cs-vault-password-row">
                      <input
                        type="password"
                        className="cs-input"
                        autoComplete="current-password"
                        placeholder={t("settings.center.vault.passwordPlaceholder")}
                        value={vaultPassword}
                        disabled={actionBusy || vaultBusy}
                        onChange={(event) => setVaultPassword(event.target.value)}
                      />
                      {!hasVaultKey ? (
                        <button
                          type="button"
                          className="cs-btn cs-btn--accent"
                          disabled={actionBusy || vaultBusy || !vaultPassword.trim()}
                          onClick={() => void handleUnlockVaultWithPassword()}
                        >
                          {t("settings.center.vault.unlockWithPassword")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cs-btn cs-btn--accent"
                          disabled={actionBusy || vaultBusy || !vaultPassword.trim()}
                          onClick={() => void handleWrapVaultWithPassword()}
                        >
                          {t("settings.center.vault.wrapWithPassword")}
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>

                {vaultStatus?.error ? (
                  <p className="cs-error cs-vault-inline-error">
                    {vaultStatus.error === "vault_no_synced_device" ||
                    /vault_no_synced_device/i.test(vaultStatus.error)
                      ? t("settings.center.vault.noSyncedDevice")
                      : vaultStatus.error === "settings_sync_vault_required" ||
                          /settings_sync_vault_required/i.test(vaultStatus.error)
                        ? t("settings.center.vault.vaultRequired")
                        : vaultStatus.error === "settings_sync_vault_decrypt" ||
                            /settings_sync_vault_decrypt/i.test(vaultStatus.error)
                          ? t("settings.center.vault.vaultDecryptFailed")
                          : vaultStatus.error === "vault_password_wrap_missing" ||
                              /vault_password_wrap_missing/i.test(vaultStatus.error)
                            ? t("settings.center.vault.wrapMissing")
                            : vaultStatus.error}
                  </p>
                ) : null}
              </div>
            </section>

            <section className="cs-block">
              <div className="cs-block-head">
                <h2 className="cs-block-label">{t("settings.center.syncStatus.title")}</h2>
                <button
                  type="button"
                  className="cs-text-action is-muted"
                  disabled={actionBusy || syncStatusLoading}
                  onClick={() => void refreshSyncStatus()}
                >
                  <RefreshCw
                    size={14}
                    strokeWidth={1.75}
                    className={syncStatusLoading ? "cs-spin" : undefined}
                  />
                  {t("common.refresh")}
                </button>
              </div>
              {syncStatusLoading && !syncStatus ? (
                <p className="cs-placeholder">{t("common.loading")}</p>
              ) : (
                <div className="cs-sync-status-card">
                  <ul className="cs-list cs-sync-status-list">
                    {(syncStatus?.domains ?? []).map((entry) => (
                      <li key={entry.domain} className="cs-list-item cs-sync-status-item">
                        <div className="cs-sync-status-copy">
                          <span className="cs-sync-status-label">{domainSyncLabel(entry.domain)}</span>
                          {entry.summary ? (
                            <span className="cs-sync-status-summary">
                              {formatDomainSyncSummary(entry.domain, entry.summary)}
                            </span>
                          ) : null}
                        </div>
                        <div className="cs-sync-status-state">
                          <span className={`cs-sync-status-badge is-${entry.state}`}>
                            {domainSyncStateLabel(entry.state)}
                          </span>
                          {entry.lastSyncedAt ? (
                            <span className="cs-sync-status-time">
                              {t("settings.center.syncStatus.lastSynced", {
                                time: formatLocalTime(entry.lastSyncedAt),
                              })}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="cs-vault-inline-note">{t("settings.center.syncStatus.hint")}</p>
                </div>
              )}
            </section>
          </div>
        ) : null}

        {registered && isLive && activeTab === "artifacts" ? (
          <div className="cs-tab-panel" role="tabpanel">
            <ArtifactsSettingsPanel
              {...(snapshot.htmlHosting ? { capability: snapshot.htmlHosting } : {})}
              busy={actionBusy}
              onRefresh={async () => {
                if (!window.eco?.refreshHtmlHostingCapability) return;
                setError(undefined);
                try {
                  await window.eco.refreshHtmlHostingCapability();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            />
          </div>
        ) : null}

        {registered && isLive && activeTab === "devices" ? (
          <div className="cs-tab-panel" role="tabpanel">
            <section className="cs-block cs-block--tab-first">
              <div className="cs-block-head">
                <h2 className="cs-block-label">{t("settings.center.boundPhones")}</h2>
                <div className="cs-block-head-actions">
                  <button
                    type="button"
                    className="cs-text-action is-muted"
                    disabled={actionBusy || bindingsLoading}
                    onClick={() => void refreshBindings()}
                  >
                    <RefreshCw
                      size={14}
                      strokeWidth={1.75}
                      className={bindingsLoading ? "cs-spin" : undefined}
                    />
                    {t("common.refresh")}
                  </button>
                  <button
                    type="button"
                    className="cs-btn cs-btn--ghost cs-btn--compact"
                    disabled={actionBusy || pairingBusy}
                    onClick={() => void openPairingSheet()}
                  >
                    <QrCode size={15} strokeWidth={1.75} />
                    {t("settings.center.connectPhone")}
                  </button>
                </div>
              </div>

              {bindingsError ? <p className="cs-error">{bindingsError}</p> : null}

              {bindingsLoading && activeBindings.length === 0 ? (
                <p className="cs-placeholder">{t("common.loading")}</p>
              ) : activeBindings.length === 0 ? (
                <p className="cs-placeholder">{t("settings.center.noPhones")}</p>
              ) : (
                <ul className="cs-list">
                  {activeBindings.map((binding) => {
                    const mobile = presence.find((device) => device.id === binding.mobileDeviceId);
                    const online = mobile?.online === true;
                    const mobileLabel = formatMobileLabel(mobile, binding.mobileDeviceId);
                    const mobileDetail = formatMobileDetail(mobile, binding.mobileDeviceId);
                    const revoking = revokingBindingId === binding.id;
                    return (
                      <li key={binding.id} className="cs-list-item">
                        <div className="cs-device">
                          <span className={`cs-dot cs-dot--${online ? "online" : "offline"}`} aria-hidden />
                          <div className="cs-device-copy">
                            <span className="cs-device-name">
                              <Smartphone size={14} strokeWidth={1.75} aria-hidden />
                              {mobileLabel}
                            </span>
                            {mobileDetail ? <span className="cs-device-meta">{mobileDetail}</span> : null}
                            <span className="cs-device-meta">
                              {t("settings.center.boundAt", {
                                status: online ? t("settings.center.online") : t("settings.center.offline"),
                                time: formatLocalTime(binding.createdAt),
                              })}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="cs-text-action is-muted"
                          disabled={actionBusy || revoking}
                          onClick={() => void handleRevokeBinding(binding)}
                        >
                          {revoking ? t("settings.center.revoking") : t("settings.center.revoke")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </div>

      <div
        className="cs-section-panel"
        role="tabpanel"
        id="cs-section-panel-deployment"
        aria-labelledby="cs-section-tab-deployment"
        hidden={sectionTab !== "deployment"}
      >
        <SupabaseDeploymentPanel
          projectUrl={serverUrl}
          disabled={actionBusy}
          onUseProject={handleUseDeployedProject}
        />
      </div>

      {pairingSheetOpen
        ? createPortal(
            <div className="cs-sheet-backdrop" role="presentation">
              <button
                type="button"
                className="cs-sheet-scrim"
                aria-label={t("common.close")}
                disabled={pairingBusy}
                onClick={() => {
                  if (!pairingBusy) {
                    closePairingSheet();
                  }
                }}
              />
              <div
                className="cs-sheet cs-sheet--pairing"
                role="dialog"
                aria-modal="true"
                aria-labelledby="cs-pairing-title"
              >
                <div className="cs-sheet-stack">
                  <span className="cs-sheet-glyph" aria-hidden>
                    <QrCode size={22} strokeWidth={1.75} />
                  </span>
                  <header className="cs-sheet-head">
                    <h2 id="cs-pairing-title" className="cs-sheet-title">
                      {t("settings.center.pairing")}
                    </h2>
                    <p className="cs-sheet-subtitle">{t("settings.center.scanHint")}</p>
                  </header>
                  {pairingBusy && !connectQr && !pairing ? (
                    <div className="cs-pairing cs-pairing--sheet">
                      <Loader2 size={28} strokeWidth={1.75} className="cs-spin" aria-hidden />
                      <p className="cs-pairing-note">{t("common.loading")}</p>
                    </div>
                  ) : connectQr || pairing ? (
                    <div className="cs-pairing cs-pairing--sheet">
                      {isLocalhostCenterServerUrl(
                        snapshot.settings.supabaseUrl || snapshot.settings.serverUrl,
                      ) ? (
                        <p className="cs-pairing-note">{t("settings.center.localhostWarning")}</p>
                      ) : null}
                      <div className="cs-pairing-qr">
                        <QRCodeSVG
                          value={(connectQr ?? pairing)!.qrPayload}
                          size={168}
                          level="M"
                          includeMargin={false}
                          role="img"
                          aria-label={t("settings.center.qrAriaServer")}
                        />
                      </div>
                      <p className="cs-pairing-note">{t("settings.center.scanHintPassword")}</p>
                    </div>
                  ) : (
                    <div className="cs-pairing cs-pairing--sheet">
                      <p className="cs-pairing-note">{error ?? t("settings.center.connectionFailed")}</p>
                      <button
                        type="button"
                        className="cs-btn cs-btn--accent"
                        disabled={pairingBusy}
                        onClick={() => void openPairingSheet()}
                      >
                        {t("common.retry")}
                      </button>
                    </div>
                  )}
                </div>
                <div className="cs-sheet-actions cs-sheet-actions--full">
                  <button
                    type="button"
                    className="cs-btn cs-btn--secondary"
                    disabled={pairingBusy}
                    onClick={closePairingSheet}
                  >
                    {t("common.close")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {claimCodeSheetOpen
        ? createPortal(
            <div className="cs-sheet-backdrop" role="presentation">
              <button
                type="button"
                className="cs-sheet-scrim"
                aria-label={t("common.cancel")}
                disabled={vaultBusy}
                onClick={() => {
                  if (!vaultBusy) setClaimCodeSheetOpen(false);
                }}
              />
              <div
                className="cs-sheet cs-sheet--approval"
                role="dialog"
                aria-modal="true"
                aria-labelledby="cs-claim-code-title"
              >
                <div className="cs-sheet-stack">
                  <span className="cs-sheet-glyph" aria-hidden>
                    <KeyRound size={22} strokeWidth={1.75} />
                  </span>
                  <header className="cs-sheet-head">
                    <h2 id="cs-claim-code-title" className="cs-sheet-title">
                      {t("settings.center.vault.enterCodeTitle")}
                    </h2>
                    <p className="cs-sheet-subtitle">{t("settings.center.vault.enterCodeHint")}</p>
                  </header>
                  <OtpCodeInput
                    value={claimCodeInput}
                    onChange={setClaimCodeInput}
                    onSubmit={() => void handleSubmitVaultClaimCode()}
                    disabled={vaultBusy}
                    label={t("settings.center.vault.enterCodeTitle")}
                    placeholder={t("settings.center.vault.codePlaceholder")}
                  />
                </div>
                <div className="cs-sheet-actions">
                  <button
                    type="button"
                    className="cs-btn cs-btn--secondary"
                    disabled={vaultBusy}
                    onClick={() => void handleCancelVaultClaim()}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="cs-btn cs-btn--accent"
                    disabled={vaultBusy || claimCodeInput.length < 6}
                    onClick={() => void handleSubmitVaultClaimCode()}
                  >
                    {vaultBusy ? <Loader2 size={15} className="cs-spin" /> : null}
                    {t("settings.center.vault.submitCode")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {approvalSheetOpen && approvalCode
        ? createPortal(
            <div className="cs-sheet-backdrop" role="presentation">
              <button
                type="button"
                className="cs-sheet-scrim"
                aria-label={t("common.close")}
                onClick={() => setApprovalSheetOpen(false)}
              />
              <div
                className="cs-sheet cs-sheet--approval"
                role="dialog"
                aria-modal="true"
                aria-labelledby="cs-approval-code-title"
              >
                <div className="cs-sheet-stack">
                  <span className="cs-sheet-glyph" aria-hidden>
                    <KeyRound size={22} strokeWidth={1.75} />
                  </span>
                  <header className="cs-sheet-head">
                    <h2 id="cs-approval-code-title" className="cs-sheet-title">
                      {t("settings.center.vault.showCodeTitle")}
                    </h2>
                    <p className="cs-sheet-subtitle">
                      {approvalTarget
                        ? t("settings.center.vault.approvedFor", { name: approvalTarget })
                        : t("settings.center.vault.showCodeHint")}
                    </p>
                  </header>
                  <div className="cs-code-tiles" aria-live="polite">
                    {Array.from(approvalCode).map((digit, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: digits may repeat (e.g. "111111"), positional key is intentional
                      <span key={index} className="cs-code-tile">
                        {digit}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="cs-sheet-actions cs-sheet-actions--full">
                  <button
                    type="button"
                    className="cs-btn cs-btn--accent"
                    onClick={() => setApprovalSheetOpen(false)}
                  >
                    {t("common.done")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function ServerEditor({
  form,
  setForm,
  registered,
  serverReachable,
  error,
  busy,
  testing,
  onBack,
  onTestConnection,
  onSave,
  onServerUrlChange,
}: {
  form: CenterServerSettingsInput;
  setForm: Dispatch<SetStateAction<CenterServerSettingsInput>>;
  registered: boolean;
  serverReachable: boolean;
  error: string | undefined;
  busy?: boolean;
  testing: boolean;
  onBack: () => void;
  onTestConnection: () => void;
  onSave: () => void;
  onServerUrlChange: () => void;
}) {
  const { t } = useTranslation();
  const projectUrl = form.supabaseUrl ?? form.serverUrl ?? "";
  return (
    <>
      <button type="button" className="cs-back" onClick={onBack} disabled={busy}>
        <ChevronLeft size={16} strokeWidth={1.75} />
        {t("settings.mcp.back")}
      </button>

      <header className="cs-head cs-head--editor">
        <h1 className="cs-title">
          {registered ? t("settings.center.serverConfig") : t("settings.center.add")}
        </h1>
        <p className="cs-desc">{t("settings.center.editorDescription")}</p>
      </header>

      <div className="cs-form">
        <label className="cs-field">
          <span className="cs-field-label">{t("settings.center.supabaseUrl")}</span>
          <input
            className="cs-input"
            type="text"
            value={projectUrl}
            disabled={busy}
            placeholder="https://xxxx.supabase.co"
            onChange={(event) => {
              onServerUrlChange();
              setForm((current) => ({
                ...current,
                supabaseUrl: event.target.value,
                serverUrl: event.target.value,
              }));
            }}
          />
        </label>

        <label className="cs-field">
          <span className="cs-field-label">{t("settings.center.anonKey")}</span>
          <input
            className="cs-input"
            type="password"
            value={form.anonKey ?? ""}
            disabled={busy}
            placeholder={
              registered || form.anonKey === undefined ? t("settings.center.anonKeyKeep") : "eyJhbGciOi..."
            }
            autoComplete="off"
            onChange={(event) => {
              onServerUrlChange();
              setForm((current) => ({ ...current, anonKey: event.target.value }));
            }}
          />
        </label>

        <label className="cs-field">
          <span className="cs-field-label">{t("settings.center.deviceName")}</span>
          <input
            className="cs-input"
            type="text"
            value={form.deviceName ?? ""}
            disabled={busy}
            placeholder="Mori Desktop"
            onChange={(event) => setForm((current) => ({ ...current, deviceName: event.target.value }))}
          />
        </label>

        {serverReachable && !registered ? (
          <p className="cs-success">{t("settings.center.reachable")}</p>
        ) : null}
        {error ? <p className="cs-error">{error}</p> : null}

        <div className="cs-form-actions">
          <button
            type="button"
            className="cs-btn cs-btn--ghost"
            disabled={busy || !projectUrl.trim()}
            onClick={onTestConnection}
          >
            <RefreshCw size={15} strokeWidth={1.75} className={testing ? "cs-spin" : undefined} />
            {t("settings.center.test")}
          </button>
          <button type="button" className="cs-btn" disabled={busy} onClick={onSave}>
            {busy ? (
              <>
                <Loader2 size={15} strokeWidth={1.75} className="cs-spin" aria-hidden />
                {t("settings.center.saving")}
              </>
            ) : registered ? (
              t("common.save")
            ) : (
              t("settings.center.continue")
            )}
          </button>
        </div>
      </div>
    </>
  );
}

function AccountEditor({
  serverUrl,
  registered,
  authMode,
  setAuthMode,
  email,
  setEmail,
  password,
  setPassword,
  displayName,
  setDisplayName,
  error,
  infoNotice,
  busy,
  onBack,
  onSubmit,
}: {
  serverUrl: string;
  registered: boolean;
  authMode: AccountAuthMode;
  setAuthMode: (mode: AccountAuthMode) => void;
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  displayName: string;
  setDisplayName: (value: string) => void;
  error: string | undefined;
  infoNotice: string | undefined;
  busy?: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button type="button" className="cs-back" onClick={onBack} disabled={busy}>
        <ChevronLeft size={16} strokeWidth={1.75} />
        {t("settings.mcp.back")}
      </button>

      <header className="cs-head cs-head--editor">
        <h1 className="cs-title">
          {registered ? t("settings.center.relogin") : t("settings.center.bindAccount")}
        </h1>
        <p className="cs-desc">
          <code className="cs-inline-code">{serverUrl}</code>
        </p>
      </header>

      <form
        className="cs-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {!registered ? (
          <div className="cs-tabs" role="tablist" aria-label={t("settings.center.accountActions")}>
            <button
              type="button"
              role="tab"
              aria-selected={authMode === "signup"}
              className={authMode === "signup" ? "cs-tab is-active" : "cs-tab"}
              disabled={busy}
              onClick={() => setAuthMode("signup")}
            >
              {t("settings.center.signup")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={authMode === "signin"}
              className={authMode === "signin" ? "cs-tab is-active" : "cs-tab"}
              disabled={busy}
              onClick={() => setAuthMode("signin")}
            >
              {t("settings.center.signin")}
            </button>
          </div>
        ) : null}

        {authMode === "signup" && !registered ? (
          <label className="cs-field">
            <span className="cs-field-label">{t("settings.center.displayName")}</span>
            <input
              className="cs-input"
              type="text"
              value={displayName}
              disabled={busy}
              placeholder={t("settings.center.optional")}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
        ) : null}

        <label className="cs-field">
          <span className="cs-field-label">{t("settings.center.email")}</span>
          <input
            className="cs-input"
            type="email"
            autoComplete="username"
            value={email}
            disabled={busy}
            placeholder="you@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="cs-field">
          <span className="cs-field-label">{t("settings.center.password")}</span>
          <input
            className="cs-input"
            type="password"
            autoComplete={authMode === "signup" ? "new-password" : "current-password"}
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {infoNotice ? <p className="cs-placeholder">{infoNotice}</p> : null}
        {error ? <p className="cs-error">{error}</p> : null}

        <button
          type="submit"
          className="cs-btn cs-btn--block"
          disabled={busy || !email.trim() || !password.trim()}
        >
          {busy ? (
            <>
              <Loader2 size={15} strokeWidth={1.75} className="cs-spin" aria-hidden />
              {authMode === "signup" ? t("settings.center.signingUp") : t("settings.center.signingIn")}
            </>
          ) : authMode === "signup" ? (
            t("settings.center.signupBind")
          ) : (
            t("settings.center.signinBind")
          )}
        </button>
      </form>
    </>
  );
}

function OtpCodeInput({
  value,
  onChange,
  onSubmit,
  disabled,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  label: string;
  placeholder: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cells = Array.from({ length: 6 }, (_, index) => value[index] ?? "");
  const activeIndex = value.length < 6 ? value.length : -1;
  const acceptDigits = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    if (digits !== value) {
      onChange(digits);
    }
    return digits;
  };
  return (
    <div
      className="cs-otp"
      onPointerDown={() => {
        if (!disabled) {
          inputRef.current?.focus();
        }
      }}
    >
      <input
        ref={inputRef}
        className="cs-otp-field"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={6}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => acceptDigits(event.target.value)}
        onPaste={(event) => {
          event.preventDefault();
          acceptDigits(event.clipboardData.getData("text"));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value.length >= 6) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="cs-otp-cells" aria-hidden>
        {cells.map((digit, index) => {
          const cellClass = `cs-otp-cell${digit ? " is-filled" : ""}${
            index === activeIndex ? " is-active" : ""
          }`;
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed 6-cell passcode grid, cells are positional
          return (
            <span key={index} className={cellClass}>
              {digit}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ArtifactsSettingsPanel({
  capability,
  busy,
  onRefresh,
}: {
  capability?: HtmlHostingCapability;
  busy: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const detail =
    capability?.reason === "content_type_rewritten" || capability?.renderRisk
      ? t("settings.center.artifacts.renderRisk")
      : capability?.detail?.trim() || t("settings.center.artifacts.unchecked");
  const statusKind =
    !capability || capability.reason === "unchecked"
      ? "unchecked"
      : capability.available
        ? capability.renderRisk || capability.reason === "content_type_rewritten"
          ? "available-risk"
          : "available"
        : "unavailable";
  const statusLabel =
    statusKind === "unchecked"
      ? t("settings.center.artifacts.unchecked")
      : statusKind === "available"
        ? t("settings.center.artifacts.available")
        : statusKind === "available-risk"
          ? t("settings.center.artifacts.availableWithRisk")
          : t("settings.center.artifacts.unavailable", { detail });

  return (
    <section className="cs-block cs-block--tab-first">
      <h2 className="cs-block-label">{t("settings.center.artifacts.title")}</h2>
      <p className="cs-artifacts-desc">{t("settings.center.artifacts.description")}</p>
      <div className="cs-card cs-artifacts-card">
        <div className="cs-artifacts-status-row">
          <div className="cs-artifacts-status-copy">
            <span className={`cs-artifacts-status-value is-${statusKind}`}>{statusLabel}</span>
            {capability?.checkedAt ? (
              <span className="cs-artifacts-status-meta">
                {t("settings.center.artifacts.checkedAt", {
                  time: formatLocalTime(capability.checkedAt),
                })}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="cs-btn cs-btn--ghost cs-btn--compact"
            disabled={busy || refreshing}
            onClick={() => {
              setRefreshing(true);
              void onRefresh().finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? (
              <Loader2 size={14} className="spin" aria-hidden />
            ) : (
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
            )}
            {t("settings.center.artifacts.refresh")}
          </button>
        </div>
      </div>
    </section>
  );
}

function StatusMeta({ status, needsReauth }: { status: CenterServerConnectionStatus; needsReauth: boolean }) {
  const { t } = useTranslation();
  if (needsReauth) {
    return <span className="cs-service-status is-warn">{t("settings.center.sessionExpired")}</span>;
  }
  return (
    <span className={`cs-service-status is-${status.state}`}>
      {connectionStatusLabel(status.state)}
      {status.state === "connected" && status.connectedAt ? ` · ${formatLocalTime(status.connectedAt)}` : ""}
    </span>
  );
}

function statusDotKind(status: CenterServerConnectionStatus): string {
  if (status.state === "connected") {
    return "online";
  }
  if (status.state === "connecting") {
    return "pending";
  }
  if (status.state === "error") {
    return "error";
  }
  return "offline";
}

function viewToInput(settings: CenterServerSettingsView): CenterServerSettingsInput {
  const projectUrl = settings.supabaseUrl || settings.serverUrl;
  const input: CenterServerSettingsInput = {
    enabled: settings.enabled,
    supabaseUrl: projectUrl,
    serverUrl: projectUrl,
    anonKey: "",
    deviceName: settings.deviceName,
    deviceSecret: "",
    refreshToken: "",
  };
  if (settings.deviceId) {
    input.deviceId = settings.deviceId;
  }
  return input;
}

function connectionStatusLabel(state: CenterServerConnectionStatus["state"]): string {
  switch (state) {
    case "disabled":
      return i18n.t("settings.center.status.disabled");
    case "disconnected":
      return i18n.t("settings.center.status.disconnected");
    case "connecting":
      return i18n.t("settings.center.status.connecting");
    case "connected":
      return i18n.t("settings.center.status.connected");
    case "error":
      return i18n.t("settings.center.status.error");
  }
}

function formatLocalTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return new Date(parsed).toLocaleString(i18n.resolvedLanguage);
}

function formatDomainSyncSummary(domain: CenterServerSyncDomain, summary: string): string {
  const trimmed = summary.trim();
  if (!trimmed) {
    return "";
  }

  if (domain === "providers") {
    return trimmed;
  }

  if (domain === "proxyBridge") {
    return i18n.t("settings.center.syncStatus.summary.configured");
  }

  if (domain === "asr" || domain === "imageGeneration") {
    const count = Number(trimmed);
    if (Number.isFinite(count) && count > 0) {
      return i18n.t("settings.center.syncStatus.summary.profileCount", { count });
    }
  }

  if (domain === "orchestration") {
    const count = Number(trimmed);
    if (Number.isFinite(count) && count > 0) {
      return i18n.t("settings.center.syncStatus.summary.orchestrationCount", { count });
    }
  }

  if (domain === "agentLibrary") {
    const count = Number(trimmed);
    if (Number.isFinite(count) && count > 0) {
      return i18n.t("settings.center.syncStatus.summary.agentCount", { count });
    }
  }

  if (domain === "git") {
    const segments = trimmed.split(" · ").map((part) => part.trim());
    const labels: string[] = [];
    if (segments.includes("instructions")) {
      labels.push(i18n.t("settings.center.syncStatus.summary.gitInstructions"));
    }
    const routeSegment = segments.find((part) => part !== "instructions" && /^\d+$/.test(part));
    if (routeSegment) {
      labels.push(i18n.t("settings.center.syncStatus.summary.gitRoutes", { count: Number(routeSegment) }));
    }
    if (labels.length > 0) {
      return labels.join(" · ");
    }
  }

  if (domain === "packageScriptArgs") {
    const [workspacePart, scriptPart] = trimmed.split(" · ");
    const workspaces = Number(workspacePart);
    const scripts = Number(scriptPart);
    if (Number.isFinite(workspaces) && Number.isFinite(scripts) && workspaces > 0) {
      return i18n.t("settings.center.syncStatus.summary.scriptArgs", { workspaces, scripts });
    }
  }

  if (domain === "personalization" && trimmed === "rules") {
    return i18n.t("settings.center.syncStatus.summary.personalizationRules");
  }

  return trimmed;
}

function domainSyncLabel(domain: CenterServerSyncDomain): string {
  switch (domain) {
    case "providers":
      return i18n.t("settings.center.syncStatus.domain.providers");
    case "proxyBridge":
      return i18n.t("settings.center.syncStatus.domain.proxyBridge");
    case "asr":
      return i18n.t("settings.center.syncStatus.domain.asr");
    case "imageGeneration":
      return i18n.t("settings.center.syncStatus.domain.imageGeneration");
    case "orchestration":
      return i18n.t("settings.center.syncStatus.domain.orchestration");
    case "agentLibrary":
      return i18n.t("settings.center.syncStatus.domain.agentLibrary");
    case "git":
      return i18n.t("settings.center.syncStatus.domain.git");
    case "packageScriptArgs":
      return i18n.t("settings.center.syncStatus.domain.packageScriptArgs");
    case "personalization":
      return i18n.t("settings.center.syncStatus.domain.personalization");
    case "defaultAgent":
      return i18n.t("settings.center.syncStatus.domain.defaultAgent");
    case "sshBookmarks":
      return i18n.t("settings.center.syncStatus.domain.sshBookmarks");
  }
}

function domainSyncStateLabel(state: CenterServerDomainSyncState): string {
  switch (state) {
    case "synced":
      return i18n.t("settings.center.syncStatus.state.synced");
    case "dirty":
      return i18n.t("settings.center.syncStatus.state.dirty");
    case "never_synced":
      return i18n.t("settings.center.syncStatus.state.neverSynced");
    case "cloud_empty":
      return i18n.t("settings.center.syncStatus.state.cloudEmpty");
    case "needs_vault":
      return i18n.t("settings.center.syncStatus.state.needsVault");
  }
}

function shortenDeviceId(deviceId: string): string {
  const trimmed = deviceId.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

function isGenericMobileName(name: string | undefined): boolean {
  if (!name) {
    return true;
  }
  const normalized = name.trim().toLowerCase();
  return normalized === "eco mobile" || normalized === "ecomobile";
}

function formatMobileLabel(mobile: CenterServerDevicePresenceView | undefined, deviceId: string): string {
  const model = mobile?.metadata?.model?.trim();
  if (model) {
    return model;
  }
  const name = mobile?.name?.trim();
  if (name && !isGenericMobileName(name)) {
    return name;
  }
  return shortenDeviceId(deviceId);
}

function formatMobileDetail(
  mobile: CenterServerDevicePresenceView | undefined,
  deviceId: string,
): string | undefined {
  const parts: string[] = [];
  const ipAddress = mobile?.metadata?.ipAddress?.trim();
  const platform = mobile?.metadata?.platform?.trim();
  if (ipAddress) {
    parts.push(ipAddress);
  }
  if (platform) {
    parts.push(platform);
  }
  parts.push(shortenDeviceId(deviceId));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
