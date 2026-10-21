import 'dart:async';

import 'package:adaptive_platform_ui/adaptive_platform_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/locale/app_error_localizations.dart';
import '../../core/models/eco_types.dart';
import '../../core/network/eco_center_client.dart';
import '../../core/providers/app_providers.dart';
import '../../core/providers/app_session.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/center_server_auth.dart';
import '../../core/utils/device_display.dart';
import '../../core/widgets/adaptive_glass_action_button.dart';
import '../../core/widgets/adaptive_toolbar_icon.dart';
import '../../core/widgets/app_error_state.dart';
import '../../core/widgets/eco_android_glass.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../pairing/pairing_scan_screen.dart';
import '../projects/project_providers.dart';
import '../threads/thread_providers.dart';
import 'setup_status.dart';
import 'setup_wizard.dart';
import 'unpair_pc_dialog.dart';
import '../threads/session_content_boot_loading.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  final _serverUrlController = TextEditingController();
  final _anonKeyController = TextEditingController();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isRegister = false;
  bool _busy = false;
  bool _refreshing = false;
  bool _showManualSetup = false;
  SetupWizardStep? _wizardStep;

  /// Desktop id currently being bound after a list tap (inline row spinner).
  String? _selectingDesktopId;

  /// Set after scanning a full QR while logged out; completed automatically after login.
  PairingQrPayload? _pendingPairingQr;

  /// Set when navigating into `/threads` so [dispose] does not resume bind.
  bool _enteringSession = false;
  EcoCenterClient? _centerClient;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await ref.read(appSessionProvider.future);
    final client = ref.read(ecoCenterClientProvider);
    _centerClient = client;
    // The connect screen keeps Presence for the online indicators. The bind
    // channel is created only after the session route is mounted.
    client.disconnect();
    // Block shell ensureDesktopBindReady → connect() before Presence finishes.
    client.beginPresenceOnlyMode();
    ref.invalidate(desktopPresenceProvider);
    final creds = client.credentials;
    if (creds.hasUserSession &&
        creds.hasDeviceCredentials &&
        creds.hasProjectConfig) {
      unawaited(_startPickerPresence());
    }
    _serverUrlController.text = creds.supabaseUrl;
    _anonKeyController.text = '';
    _emailController.text = creds.userEmail ?? '';
    if (mounted) {
      final overview = ref.read(setupOverviewProvider);
      setState(() => _wizardStep ??= resolveSetupWizardStep(overview));
      _consumePendingAuthRecovery();
    }
  }

  Future<void> _startPickerPresence() async {
    final client = ref.read(ecoCenterClientProvider);
    if (!client.credentials.hasUserSession ||
        !client.credentials.hasDeviceCredentials ||
        !client.credentials.hasProjectConfig) {
      return;
    }
    try {
      await client.connectPresence();
    } catch (_) {
      // Keep the REST device list usable when Presence is temporarily down.
    }
    if (!mounted) return;
    await ref.read(desktopPresenceProvider.notifier).refresh(force: true);
  }

  void _consumePendingAuthRecovery() {
    final pending = ref.read(pendingAuthRecoveryProvider);
    if (pending == null) return;
    _applyAuthRecoveryUi(pending);
  }

  void _applyAuthRecoveryUi(CenterServerAuthRecovery recovery) {
    switch (recovery) {
      case CenterServerAuthRecovery.relogin:
      case CenterServerAuthRecovery.deviceInactive:
        setState(() {
          _showManualSetup = true;
          _wizardStep = SetupWizardStep.login;
        });
        final email = ref.read(ecoCenterClientProvider).credentials.userEmail;
        if (email != null && email.isNotEmpty) {
          _emailController.text = email;
        }
      case CenterServerAuthRecovery.accountUnusable:
        setState(() {
          _showManualSetup = true;
          _wizardStep = SetupWizardStep.server;
        });
      case CenterServerAuthRecovery.network:
      case CenterServerAuthRecovery.unknown:
        break;
    }
  }

  Future<void> _refreshStatus() async {
    setState(() => _refreshing = true);
    try {
      await refreshAppSession(ref);
      ref.invalidate(credentialsProvider);
      ref.invalidate(bindingsProvider);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  void _showSnack(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  void dispose() {
    _serverUrlController.dispose();
    _anonKeyController.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    final client = _centerClient;
    final entering = _enteringSession;
    super.dispose();
    // Popping back to MainShell: leave Presence-only and restore bind/RPC.
    if (!entering && client != null && client.isPresenceOnlyMode) {
      client.leavePresenceOnlyMode();
      unawaited(client.connect().catchError((Object _) {}));
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
    } catch (error) {
      if (mounted) _showSnack(localizedAppError(error, context.l10n));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _enterApp() {
    final selected = ref.read(setupOverviewProvider).selectedDesktopId;
    if (selected == null || selected.isEmpty) {
      _showSnack(context.l10n.setupSelectOnlinePcFirst);
      return;
    }

    unawaited(
      _run(() async {
        final client = ref.read(ecoCenterClientProvider);
        final previousDesktop =
            ref.read(selectedDesktopIdProvider) ??
            client.credentials.selectedDesktopId;

        // Persist the selected target before mounting /threads. This prevents the
        // session providers from opening a bind channel for the previous PC.
        await client.setSelectedDesktop(selected);
        if (!mounted) return;
        if (ref.read(selectedDesktopIdProvider) != selected) {
          ref.read(selectedDesktopIdProvider.notifier).state = selected;
        }
        ref.invalidate(credentialsProvider);
        ref.invalidate(bindingsProvider);
        ref.invalidate(desktopPresenceProvider);
        // Leave picker mode before connecting / navigating, otherwise
        // ensureDesktopBindReady stays blocked on Presence-only.
        _enteringSession = true;
        client.leavePresenceOnlyMode();
        if (previousDesktop != selected) {
          resetDesktopScopedProviders(ref.invalidate);
        }
        // Disconnect-old is done in setSelectedDesktop; wait for the new bind
        // before showing threads so we don't flash "Realtime not connected".
        try {
          await client.connect();
        } catch (error) {
          _enteringSession = false;
          if (!mounted) return;
          _showSnack(localizedAppError(error, context.l10n));
          return;
        }
        if (!mounted) return;
        context.go('/threads');
      }),
    );
  }

  void _goToStep(SetupWizardStep step) {
    setState(() => _wizardStep = step);
  }

  void _goNext(SetupOverview overview) {
    final current = _wizardStep ?? resolveSetupWizardStep(overview);
    final nextIndex = current.index + 1;
    if (nextIndex < SetupWizardStep.values.length) {
      _goToStep(SetupWizardStep.values[nextIndex]);
    }
  }

  void _goBack() {
    final current = _wizardStep;
    if (current == null || current.index == 0) return;
    _goToStep(SetupWizardStep.values[current.index - 1]);
  }

  void _maybeAutoAdvance(SetupOverview overview, SetupWizardStep completed) {
    if (!_showManualSetup) return;
    // Login finished -- leave the wizard for the normal PC picker.
    if (completed == SetupWizardStep.login &&
        isSetupWizardStepDone(completed, overview)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        setState(() {
          _showManualSetup = false;
          _wizardStep = null;
        });
      });
      return;
    }
    final current = _wizardStep ?? resolveSetupWizardStep(overview);
    if (current == completed && isSetupWizardStepDone(completed, overview)) {
      final nextIndex = completed.index + 1;
      if (nextIndex < SetupWizardStep.values.length) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _goToStep(SetupWizardStep.values[nextIndex]);
        });
      }
    }
  }

  Future<void> _openScanner() async {
    final payload = await Navigator.of(context).push<PairingQrPayload>(
      MaterialPageRoute(builder: (_) => const PairingScanScreen()),
    );
    if (payload == null || !mounted) return;
    await _handleScanResult(payload);
  }

  Future<void> _handleScanResult(PairingQrPayload payload) async {
    final l10n = context.l10n;
    final projectUrl = payload.projectUrl?.trim();
    if (projectUrl != null && projectUrl.isNotEmpty) {
      final client = ref.read(ecoCenterClientProvider);
      final anonFromQr = payload.anonKey?.trim();
      final currentProject = client.credentials.supabaseUrl.trim().isEmpty
          ? null
          : normalizeSupabaseProjectUrl(client.credentials.supabaseUrl);
      final sameProject =
          currentProject == normalizeSupabaseProjectUrl(projectUrl);
      final anon = (anonFromQr != null && anonFromQr.isNotEmpty)
          ? anonFromQr
          : (sameProject ? (client.credentials.anonKey?.trim() ?? '') : '');
      if (anon.isNotEmpty) {
        await client.setProjectConfig(supabaseUrl: projectUrl, anonKey: anon);
        _serverUrlController.text = client.credentials.supabaseUrl;
        ref.invalidate(credentialsProvider);
      } else {
        await client.setServerUrl(projectUrl);
        _serverUrlController.text = client.credentials.supabaseUrl;
        ref.invalidate(credentialsProvider);
      }
    }

    if (payload.canConfigureServer || payload.projectUrl != null) {
      await _run(() async {
        final client = ref.read(ecoCenterClientProvider);
        if (!client.credentials.hasUserSession) {
          _pendingPairingQr = null;
          setState(() {
            _showManualSetup = true;
            _wizardStep = SetupWizardStep.login;
          });
          if (!context.mounted) return;
          _showSnack(l10n.setupScanNeedsLogin);
          return;
        }
        // Same-account login is enough -- show the normal PC picker.
        setState(() {
          _showManualSetup = false;
          _wizardStep = null;
        });
        if (!context.mounted) return;
        _showSnack(l10n.setupScanServerConfigured);
      });
      return;
    }

    if (!context.mounted) return;
    _pendingPairingQr = null;
    setState(() {
      _showManualSetup = true;
      _wizardStep = SetupWizardStep.login;
    });
    _showSnack(l10n.setupLegacyQr);
  }

  Future<void> _completeQuickPair(PairingQrPayload payload) async {
    // Legacy path retained for older QRs that still carry bootstrap tokens.
    final l10n = context.l10n;
    final client = ref.read(ecoCenterClientProvider);
    final result = await client.quickJoinFromQr(payload);
    _pendingPairingQr = null;
    final creds = client.credentials;
    _serverUrlController.text = creds.supabaseUrl;
    _emailController.text = creds.userEmail ?? '';
    ref.read(serverReachableProvider.notifier).state = true;
    ref.invalidate(credentialsProvider);
    final selected = await _selectDesktop(
      result.desktopDeviceId,
      warmShellCaches: false,
    );
    setState(() => _showManualSetup = false);
    if (!context.mounted) return;
    if (selected.online == false) {
      _showSnack(l10n.setupSelectedDeviceOffline(selected.name));
    } else {
      _showSnack(
        result.alreadyBound
            ? l10n.setupOpenedDevice(selected.name)
            : l10n.setupBoundDevice(selected.name),
      );
      if (mounted) {
        _enteringSession = true;
        client.leavePresenceOnlyMode();
        try {
          await client.connect();
        } catch (error) {
          _enteringSession = false;
          if (!mounted) return;
          _showSnack(localizedAppError(error, l10n));
          return;
        }
        if (!mounted) return;
        context.go('/threads');
      }
    }
  }

  Future<_SelectedDesktopResult> _selectDesktop(
    String desktopId, {
    bool warmShellCaches = false,
  }) async {
    final client = ref.read(ecoCenterClientProvider);
    final previousDesktop =
        ref.read(selectedDesktopIdProvider) ??
        client.credentials.selectedDesktopId;
    final mobileId = client.credentials.deviceId;
    final bindings = ref.read(bindingsProvider).valueOrNull ?? const [];
    final knownBinding = mobileId == null || mobileId.isEmpty
        ? null
        : bindings
              .where(
                (binding) =>
                    binding.isActive &&
                    binding.desktopDeviceId == desktopId &&
                    binding.mobileDeviceId == mobileId,
              )
              .firstOrNull;

    // Persist the selection and binding only. Presence may already be active for
    // the picker, but the bind/RPC channel starts when /threads mounts.
    // Reuse a known binding id so switching already-paired PCs stays local/fast.
    await client.setSelectedDesktop(
      desktopId,
      knownBindingId: knownBinding?.id,
    );
    ref.read(selectedDesktopIdProvider.notifier).state = desktopId;
    ref.invalidate(credentialsProvider);
    ref.invalidate(bindingsProvider);
    ref.invalidate(desktopPresenceProvider);
    // While Presence-only, keep shell providers idle — switching PC on this
    // screen must not call connect() via ensureDesktopBindReady.
    // Clear shell caches before navigating so ThreadsScreen boots into its
    // loading surface instead of briefly showing the previous PC's list.
    if (previousDesktop != desktopId && !client.isPresenceOnlyMode) {
      resetDesktopScopedProviders(ref.invalidate);
    }
    // Presence refresh is best-effort and must not block entering the app.
    unawaited(ref.read(desktopPresenceProvider.notifier).refresh(force: true));
    if (warmShellCaches) {
      // Optional warm for callers that stay on /connect; entering the app
      // should navigate instead and let ThreadsScreen load.
      try {
        await Future.wait([
          ref.read(threadListProvider.future),
          ref.read(projectWorkspaceContextProvider.future),
        ]);
      } catch (_) {}
    }
    final presence = ref.read(desktopPresenceProvider).valueOrNull ?? [];
    final device = presence.where((entry) => entry.id == desktopId).firstOrNull;
    final stableOnline = ref.read(stableDesktopOnlineProvider(desktopId));
    return _SelectedDesktopResult(
      name: formatDesktopLabel(device, desktopId),
      online: device?.online ?? stableOnline,
    );
  }

  @override
  Widget build(BuildContext context) {
    final overview = ref.watch(setupOverviewProvider);
    final credentials =
        ref.watch(credentialsProvider).valueOrNull ??
        ref.read(ecoCenterClientProvider).credentials;
    final pendingRecovery = ref.watch(pendingAuthRecoveryProvider);
    final needsLogin = pendingRecovery != null || !credentials.hasUserSession;
    final forceLoginWizard =
        needsLogin &&
        (pendingRecovery == CenterServerAuthRecovery.relogin ||
            pendingRecovery == CenterServerAuthRecovery.deviceInactive ||
            pendingRecovery == CenterServerAuthRecovery.accountUnusable ||
            credentials.hasProjectConfig);
    final currentStep =
        _wizardStep ??
        (forceLoginWizard &&
                pendingRecovery != CenterServerAuthRecovery.accountUnusable
            ? SetupWizardStep.login
            : resolveSetupWizardStep(overview));
    final actionBusy = _busy || _refreshing;
    final showLoginWizard = forceLoginWizard || _showManualSetup;

    ref.listen(pendingAuthRecoveryProvider, (previous, next) {
      if (next == null) return;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _consumePendingAuthRecovery();
      });
    });

    ref.listen<SetupOverview>(setupOverviewProvider, (previous, next) {
      if (previous == null) return;
      for (final step in SetupWizardStep.values) {
        if (!isSetupWizardStepDone(step, previous) &&
            isSetupWizardStepDone(step, next)) {
          _maybeAutoAdvance(next, step);
        }
      }
    });

    ref.listen(connectionStatusProvider, (previous, next) {
      next.whenData((status) {
        if (status.state != EcoConnectionState.error) {
          return;
        }
        final recovery =
            status.authRecovery ??
            classifyCenterServerAuthError(status.lastError);
        if (!shouldStopCenterServerReconnect(recovery)) {
          return;
        }
        // Global notice + route redirect live in EcoApp; only shape local UI.
        unawaited(beginCredentialRecovery(ref, recovery));
      });
    });

    final bootstrapping = overview.isBootstrapping;

    return Scaffold(
      // Cold-start boot is a full-bleed loading surface — no title / refresh chrome.
      appBar: bootstrapping
          ? null
          : AppBar(
              title: Text(context.l10n.setupConnectPc),
              leadingWidth: 64,
              leading: Navigator.canPop(context)
                  ? Padding(
                      padding: const EdgeInsets.only(left: 12),
                      child: AdaptiveToolbarIcon(
                        icon: EcoIcons.back,
                        tooltip: context.l10n.commonBack,
                        size: sessionToolbarButtonSize,
                        onPressed: actionBusy ? null : () => context.pop(),
                      ),
                    )
                  : showLoginWizard &&
                        !overview.setupComplete &&
                        !forceLoginWizard
                  ? Padding(
                      padding: const EdgeInsets.only(left: 12),
                      child: AdaptiveToolbarIcon(
                        icon: EcoIcons.qrScan,
                        tooltip: context.l10n.commonBack,
                        size: sessionToolbarButtonSize,
                        onPressed: actionBusy
                            ? null
                            : () => setState(() => _showManualSetup = false),
                      ),
                    )
                  : null,
              actions: [
                Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child: _refreshing
                      ? _GlassRefreshSpinner()
                      : AdaptiveToolbarIcon(
                          icon: EcoIcons.refresh,
                          tooltip: context.l10n.commonRefresh,
                          onPressed: actionBusy ? null : _refreshStatus,
                          size: sessionToolbarButtonSize,
                        ),
                ),
              ],
            ),
      body: bootstrapping
          ? SessionContentBootLoading(semanticLabel: context.l10n.commonLoading)
          : showLoginWizard
          ? SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SetupWizardProgress(
                    current: currentStep,
                    overview: overview,
                    onStepTap: forceLoginWizard ? (_) {} : _goToStep,
                  ),
                  const SizedBox(height: 28),
                  _ConnectStepHeader(step: currentStep, overview: overview),
                  const SizedBox(height: 20),
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 200),
                    child: _buildStepContent(
                      key: ValueKey(currentStep),
                      step: currentStep,
                      overview: overview,
                      actionBusy: actionBusy,
                    ),
                  ),
                  const SizedBox(height: 24),
                  _WizardNavBar(
                    showBack: !forceLoginWizard && currentStep.index > 0,
                    showNext:
                        !forceLoginWizard &&
                        currentStep == SetupWizardStep.server &&
                        isSetupWizardStepDone(currentStep, overview),
                    showEnterApp: false,
                    busy: actionBusy,
                    onBack: _goBack,
                    onNext: () => _goNext(overview),
                    onEnterApp: _enterApp,
                    inline: true,
                  ),
                ],
              ),
            )
          : overview.showPcPicker
          ? _ReadyConnectionView(
              overview: overview,
              busy: actionBusy,
              selectingDesktopId: _selectingDesktopId,
              onScan: _openScanner,
              onEnterApp: _enterApp,
              onSelectPc: (desktopId, name, online) async {
                setState(() {
                  _busy = true;
                  _selectingDesktopId = desktopId;
                });
                try {
                  await _selectDesktop(desktopId, warmShellCaches: false);
                  if (!context.mounted) return;
                  if (online == true) {
                    _showSnack(context.l10n.setupSelectedDevice(name));
                  } else if (online == false) {
                    _showSnack(context.l10n.setupDeviceOfflineServerHelp(name));
                  } else {
                    _showSnack(context.l10n.setupSelectedDevice(name));
                  }
                } catch (error) {
                  if (context.mounted) {
                    _showSnack(localizedAppError(error, context.l10n));
                  }
                } finally {
                  if (context.mounted) {
                    setState(() {
                      _busy = false;
                      _selectingDesktopId = null;
                    });
                  }
                }
              },
            )
          : _ScanFirstView(
              busy: actionBusy,
              onScan: _openScanner,
              onManualSetup: () => setState(() {
                _showManualSetup = true;
                _wizardStep ??= resolveSetupWizardStep(overview);
              }),
            ),
    );
  }

  Widget _buildStepContent({
    required Key key,
    required SetupWizardStep step,
    required SetupOverview overview,
    required bool actionBusy,
  }) {
    return switch (step) {
      SetupWizardStep.server => KeyedSubtree(
        key: key,
        child: _ServerStep(
          urlController: _serverUrlController,
          anonKeyController: _anonKeyController,
          overview: overview,
          busy: actionBusy,
          onTest: () => _run(() async {
            final l10n = context.l10n;
            final client = ref.read(ecoCenterClientProvider);
            final anonInput = _anonKeyController.text.trim();
            final anon = anonInput.isNotEmpty
                ? anonInput
                : (client.credentials.anonKey?.trim() ?? '');
            if (anon.isEmpty) {
              throw EcoCenterException.app(EcoCenterErrorKind.anonKeyRequired);
            }
            final ok = await client.testConnection(
              _serverUrlController.text,
              anonKey: anon,
            );
            ref.read(serverReachableProvider.notifier).state = ok;
            if (ok) {
              await client.setProjectConfig(
                supabaseUrl: _serverUrlController.text,
                anonKey: anon,
              );
              if (!context.mounted) return;
              _anonKeyController.clear();
              ref.invalidate(credentialsProvider);
              _showSnack(l10n.setupServerReachable);
            } else {
              _showSnack(l10n.setupServerUnreachable);
            }
          }),
        ),
      ),
      SetupWizardStep.login => KeyedSubtree(
        key: key,
        child: _LoginStep(
          overview: overview,
          emailController: _emailController,
          passwordController: _passwordController,
          isRegister: _isRegister,
          busy: actionBusy,
          onToggleRegister: actionBusy
              ? null
              : (value) => setState(() => _isRegister = value),
          onSubmit: () => _run(() async {
            final l10n = context.l10n;
            final client = ref.read(ecoCenterClientProvider);
            if (_serverUrlController.text.trim().isEmpty) {
              throw Exception(l10n.setupServerRequired);
            }
            final anonInput = _anonKeyController.text.trim();
            final anon = anonInput.isNotEmpty
                ? anonInput
                : (client.credentials.anonKey?.trim() ?? '');
            if (anon.isEmpty) {
              throw EcoCenterException.app(EcoCenterErrorKind.anonKeyRequired);
            }
            await client.setProjectConfig(
              supabaseUrl: _serverUrlController.text,
              anonKey: anon,
            );
            if (_isRegister) {
              await client.register(
                email: _emailController.text,
                password: _passwordController.text,
              );
            } else {
              await client.login(
                email: _emailController.text,
                password: _passwordController.text,
              );
            }
            await client.ensureMobileDevice(syncProfile: true);
            // Start the lightweight user Presence channel for the PC picker;
            // the bind/RPC channel remains lazy until /threads is entered.
            ref.read(pendingAuthRecoveryProvider.notifier).state = null;
            ref.invalidate(credentialsProvider);
            ref.invalidate(bindingsProvider);
            ref.invalidate(desktopPresenceProvider);
            unawaited(_startPickerPresence());

            final pending = _pendingPairingQr;
            if (pending != null && pending.canQuickJoin) {
              await _completeQuickPair(pending);
              return;
            }
            // Leave the config wizard; HomeScreen shows _ReadyConnectionView.
            if (!context.mounted) return;
            setState(() {
              _showManualSetup = false;
              _wizardStep = null;
            });
            _showSnack(l10n.setupLoginSuccess);
          }),
          onReconnect: () => _run(() async {
            final l10n = context.l10n;
            await ref.read(ecoCenterClientProvider).connect();
            if (!mounted) return;
            _showSnack(l10n.setupReconnectAttempted);
          }),
        ),
      ),
    };
  }
}

class _SelectedDesktopResult {
  const _SelectedDesktopResult({required this.name, required this.online});

  final String name;
  final bool? online;
}

class _ConnectStepHeader extends StatelessWidget {
  const _ConnectStepHeader({required this.step, required this.overview});

  final SetupWizardStep step;
  final SetupOverview overview;

  @override
  Widget build(BuildContext context) {
    final done = isSetupWizardStepDone(step, overview);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          step.title(context.l10n),
          style: Theme.of(context).textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.w600,
            letterSpacing: 0,
          ),
        ),
        if (!done) ...[
          const SizedBox(height: 6),
          Text(
            step.subtitle(context.l10n),
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: ecoColors(context).textMuted,
              height: 1.4,
            ),
          ),
        ],
      ],
    );
  }
}

class _WizardNavBar extends StatelessWidget {
  const _WizardNavBar({
    required this.showBack,
    required this.showNext,
    required this.busy,
    required this.onBack,
    required this.onNext,
    this.showEnterApp = false,
    this.onEnterApp,
    this.inline = false,
  });

  final bool showBack;
  final bool showNext;
  final bool busy;
  final VoidCallback onBack;
  final VoidCallback onNext;
  final bool showEnterApp;
  final VoidCallback? onEnterApp;
  final bool inline;

  @override
  Widget build(BuildContext context) {
    if (!showBack && !showNext && !showEnterApp) {
      return const SizedBox.shrink();
    }

    final buttons = Row(
      children: [
        if (showBack)
          OutlinedButton(
            onPressed: busy ? null : onBack,
            child: Text(context.l10n.setupPrevious),
          ),
        const Spacer(),
        if (showNext)
          OutlinedButton(
            onPressed: busy ? null : onNext,
            child: Text(context.l10n.setupNext),
          ),
        if (showEnterApp && onEnterApp != null) ...[
          if (showNext) const SizedBox(width: 8),
          FilledButton(
            onPressed: busy ? null : onEnterApp,
            child: Text(context.l10n.setupEnterApp),
          ),
        ],
      ],
    );

    if (inline) {
      return buttons;
    }

    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: ecoColors(context).borderSidebar),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          child: buttons,
        ),
      ),
    );
  }
}

class _ServerStep extends ConsumerWidget {
  const _ServerStep({
    required this.urlController,
    required this.anonKeyController,
    required this.overview,
    required this.busy,
    required this.onTest,
  });

  final TextEditingController urlController;
  final TextEditingController anonKeyController;
  final SetupOverview overview;
  final bool busy;
  final VoidCallback onTest;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final serverStep = overview.steps[0];
    final hasSavedAnon =
        ref
            .watch(credentialsProvider)
            .valueOrNull
            ?.anonKey
            ?.trim()
            .isNotEmpty ==
        true;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: urlController,
          decoration: InputDecoration(
            labelText: context.l10n.setupSupabaseUrlLabel,
            hintText: context.l10n.setupSupabaseUrlHint,
            suffixIcon: serverStep.state == SetupStepState.done
                ? Icon(
                    EcoIcons.checkCircle,
                    color: ecoColors(context).statusAllowText,
                  )
                : null,
          ),
          keyboardType: TextInputType.url,
          enabled: !busy,
        ),
        const SizedBox(height: 12),
        TextField(
          controller: anonKeyController,
          decoration: InputDecoration(
            labelText: context.l10n.setupAnonKeyLabel,
            hintText: hasSavedAnon
                ? context.l10n.setupAnonKeyKeep
                : context.l10n.setupAnonKeyHint,
          ),
          obscureText: true,
          enabled: !busy,
        ),
        if (serverStep.hint != null) ...[
          const SizedBox(height: 8),
          Text(
            serverStep.hint!,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: ecoColors(context).statusDenyText,
            ),
          ),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: busy ? null : onTest,
          child: Text(
            serverStep.state == SetupStepState.done
                ? context.l10n.setupRetestConnection
                : context.l10n.setupTestConnection,
          ),
        ),
      ],
    );
  }
}

class _LoginStep extends ConsumerWidget {
  const _LoginStep({
    required this.overview,
    required this.emailController,
    required this.passwordController,
    required this.isRegister,
    required this.busy,
    required this.onToggleRegister,
    required this.onSubmit,
    required this.onReconnect,
  });

  final SetupOverview overview;
  final TextEditingController emailController;
  final TextEditingController passwordController;
  final bool isRegister;
  final bool busy;
  final ValueChanged<bool>? onToggleRegister;
  final VoidCallback onSubmit;
  final VoidCallback onReconnect;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final credentials = ref.watch(credentialsProvider).valueOrNull;
    final loggedIn = credentials?.isProvisioned ?? false;
    final wsStep = overview.steps[2];

    if (loggedIn) {
      final wsNeedsAttention = wsStep.state == SetupStepState.error;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _AccountStatusRow(
            email: credentials!.userEmail!,
            connected: wsStep.state == SetupStepState.done,
          ),
          if (wsNeedsAttention) ...[
            const SizedBox(height: 12),
            Text(
              wsStep.hint ?? context.l10n.setupConnectionError,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: ecoColors(context).statusDenyText,
              ),
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: busy ? null : onReconnect,
              child: Text(context.l10n.setupRetryConnection),
            ),
          ],
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (overview.steps[0].state != SetupStepState.done)
          _StepBlockedHint(text: context.l10n.setupCompleteServerFirst)
        else ...[
          SegmentedButton<bool>(
            segments: [
              ButtonSegment(value: false, label: Text(context.l10n.setupLogin)),
              ButtonSegment(
                value: true,
                label: Text(context.l10n.setupRegister),
              ),
            ],
            selected: {isRegister},
            onSelectionChanged: onToggleRegister == null
                ? null
                : (value) => onToggleRegister!(value.first),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: emailController,
            decoration: InputDecoration(labelText: context.l10n.setupEmail),
            keyboardType: TextInputType.emailAddress,
            enabled: !busy,
          ),
          const SizedBox(height: 12),
          TextField(
            controller: passwordController,
            decoration: InputDecoration(labelText: context.l10n.setupPassword),
            obscureText: true,
            enabled: !busy,
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: busy ? null : onSubmit,
            child: Text(
              isRegister
                  ? context.l10n.setupRegisterAndLogin
                  : context.l10n.setupLogin,
            ),
          ),
        ],
      ],
    );
  }
}

class _SelectPcStep extends ConsumerWidget {
  const _SelectPcStep({
    required this.overview,
    required this.busy,
    required this.onSelect,
    this.selectingDesktopId,
    this.compact = false,
    this.embedded = false,
  });

  final SetupOverview overview;
  final bool busy;
  final String? selectingDesktopId;
  final Future<void> Function(String desktopId, String name, bool? online)
  onSelect;
  final bool compact;

  /// When true, skip outer [EcoGroupedSurface] (parent already provides one).
  final bool embedded;

  Future<void> _confirmUnpair(
    BuildContext context,
    WidgetRef ref, {
    required String desktopDeviceId,
    required String name,
  }) async {
    final l10n = context.l10n;
    final client = ref.read(ecoCenterClientProvider);
    String? passwordError;

    while (context.mounted) {
      if (!context.mounted) return;
      final password = await showUnpairPcPasswordDialog(
        context,
        desktopName: name,
        initialError: passwordError,
      );
      passwordError = null;
      if (password == null || !context.mounted) return;

      try {
        await client.verifyAccountPassword(password);
        break;
      } on EcoCenterException catch (error) {
        if (!context.mounted) return;
        if (error.kind == EcoCenterErrorKind.invalidCredentials) {
          passwordError = l10n.setupUnpairPcWrongPassword;
          continue;
        }
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(localizedAppError(error, l10n))));
        return;
      } catch (error) {
        if (!context.mounted) return;
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(localizedAppError(error, l10n))));
        return;
      }
    }
    if (!context.mounted) return;

    try {
      await client.disableOwnedDesktop(desktopDeviceId);
      final selected =
          ref.read(selectedDesktopIdProvider) ??
          client.credentials.selectedDesktopId;
      if (selected == desktopDeviceId) {
        ref.read(selectedDesktopIdProvider.notifier).state = null;
      }
      ref.invalidate(bindingsProvider);
      ref.invalidate(desktopPresenceProvider);
      if (!context.mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l10n.setupUnpairPcDone(name))));
    } catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(localizedAppError(error, l10n))));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final presenceAsync = ref.watch(desktopPresenceProvider);
    final selectedDesktop = ref.watch(selectedDesktopIdProvider);

    final presence = presenceAsync.valueOrNull ?? [];
    final presenceLoading =
        presenceAsync.isLoading && presenceAsync.valueOrNull == null;
    final desktops = presence.where((d) => d.disabledAt == null).toList();

    if (presenceLoading && desktops.isEmpty) {
      final skeleton = _PcListSkeleton(dense: compact);
      if (embedded) return skeleton;
      return EcoGroupedSurface(margin: EdgeInsets.zero, child: skeleton);
    }

    if (presenceAsync.hasError && presenceAsync.valueOrNull == null) {
      return AppErrorState(
        title: context.l10n.setupConnectionError,
        message: localizedConnectionError(presenceAsync.error!, context.l10n),
        retryLabel: context.l10n.commonRetry,
        onRetry: () =>
            ref.read(desktopPresenceProvider.notifier).refresh(force: true),
      );
    }

    if (!overview.hasActiveBinding) {
      return _StepBlockedHint(text: context.l10n.setupCompleteLoginFirst);
    }

    if (desktops.isEmpty) {
      return _StepBlockedHint(text: context.l10n.setupNoRegisteredPcs);
    }

    final list = Column(
      children: [
        for (var i = 0; i < desktops.length; i++) ...[
          if (i > 0) const EcoGroupedDivider(indent: 52),
          Builder(
            builder: (context) {
              final device = desktops[i];
              final desktopId = device.id;
              final stableOnline = ref.watch(
                stableDesktopOnlineProvider(desktopId),
              );
              final online = presenceLoading
                  ? stableOnline
                  : stableOnline ?? device.online;
              final name = formatDesktopLabel(device, desktopId);
              final detail = formatDeviceDetail(device, omitLabel: name);
              final selected = selectedDesktop == desktopId;
              return _PcDeviceTile(
                name: name,
                detail: detail,
                online: online,
                selected: selected,
                loading: selectingDesktopId == desktopId,
                dense: compact,
                menuEnabled: !busy,
                onTap: busy ? null : () => onSelect(desktopId, name, online),
                onUnpair: busy
                    ? null
                    : () => _confirmUnpair(
                        context,
                        ref,
                        desktopDeviceId: desktopId,
                        name: name,
                      ),
              );
            },
          ),
        ],
      ],
    );

    if (embedded) return list;

    return EcoGroupedSurface(margin: EdgeInsets.zero, child: list);
  }
}

class _PcListSkeleton extends StatefulWidget {
  const _PcListSkeleton({this.dense = false});

  final bool dense;

  @override
  State<_PcListSkeleton> createState() => _PcListSkeletonState();
}

class _PcListSkeletonState extends State<_PcListSkeleton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final vertical = widget.dense ? 10.0 : 12.0;

    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final t = 0.35 + (_controller.value * 0.35);
        final bone = eco.textMuted.withValues(alpha: t);
        return Column(
          children: [
            for (var i = 0; i < 3; i++) ...[
              if (i > 0) const EcoGroupedDivider(indent: 52),
              Padding(
                padding: EdgeInsets.fromLTRB(16, vertical, 14, vertical),
                child: Row(
                  children: [
                    Container(
                      width: 22,
                      height: 22,
                      decoration: BoxDecoration(
                        color: bone,
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                    const SizedBox(width: 14),
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: bone,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            height: 14,
                            width: i == 1 ? 120 : 160,
                            decoration: BoxDecoration(
                              color: bone,
                              borderRadius: BorderRadius.circular(4),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Container(
                            height: 10,
                            width: i == 2 ? 72 : 96,
                            decoration: BoxDecoration(
                              color: bone.withValues(alpha: t * 0.75),
                              borderRadius: BorderRadius.circular(4),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}

class _PcDeviceTile extends StatelessWidget {
  const _PcDeviceTile({
    required this.name,
    this.detail,
    required this.online,
    required this.selected,
    this.loading = false,
    this.dense = false,
    this.menuEnabled = true,
    this.onTap,
    this.onUnpair,
  });

  final String name;
  final String? detail;
  final bool? online;
  final bool selected;
  final bool loading;
  final bool dense;
  final bool menuEnabled;
  final VoidCallback? onTap;
  final VoidCallback? onUnpair;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return EcoGroupedTile(
      onTap: onTap,
      onLongPress: onUnpair,
      highlighted: selected || loading,
      padding: EdgeInsets.fromLTRB(16, dense ? 10 : 12, 8, dense ? 10 : 12),
      child: Row(
        children: [
          Icon(
            EcoIcons.desktop,
            size: 22,
            color: selected || loading ? eco.accent : eco.textSecondary,
          ),
          const SizedBox(width: 14),
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: switch (online) {
                null => eco.textMuted.withValues(alpha: 0.45),
                true => eco.online,
                false => eco.offline,
              },
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                    fontWeight: selected || loading
                        ? FontWeight.w600
                        : FontWeight.w400,
                    fontSize: 17,
                  ),
                ),
                if (detail != null)
                  Text(
                    detail!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: eco.textMuted),
                  ),
              ],
            ),
          ),
          if (loading)
            const Padding(
              padding: EdgeInsets.only(right: 12),
              child: SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else if (onUnpair != null)
            SizedBox(
              width: 40,
              height: 40,
              child: IgnorePointer(
                ignoring: !menuEnabled,
                child: Opacity(
                  opacity: menuEnabled ? 1 : 0.35,
                  child: PopupMenuButton<String>(
                    tooltip: context.l10n.setupUnpairPc,
                    padding: EdgeInsets.zero,
                    icon: Icon(EcoIcons.more, size: 18, color: eco.textMuted),
                    onSelected: (value) {
                      if (value == 'unpair') onUnpair!();
                    },
                    itemBuilder: (context) => [
                      PopupMenuItem<String>(
                        value: 'unpair',
                        child: Text(
                          context.l10n.setupUnpairPc,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _AccountStatusRow extends StatelessWidget {
  const _AccountStatusRow({required this.email, required this.connected});

  final String email;
  final bool connected;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: eco.cardSurface,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(
            connected ? EcoIcons.checkCircle : EcoIcons.user,
            size: 20,
            color: connected ? eco.success : eco.textSecondary,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              email,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(
                context,
              ).textTheme.bodyLarge?.copyWith(fontSize: 17),
            ),
          ),
        ],
      ),
    );
  }
}

class _ScanFirstView extends StatelessWidget {
  const _ScanFirstView({
    required this.busy,
    required this.onScan,
    required this.onManualSetup,
  });

  final bool busy;
  final VoidCallback onScan;
  final VoidCallback onManualSetup;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Spacer(flex: 2),
            Center(
              child: Icon(
                EcoIcons.qrScan,
                size: 56,
                color: ecoColors(context).accent,
              ),
            ),
            const SizedBox(height: 28),
            Text(
              context.l10n.setupScanPcCode,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 10),
            Text(
              context.l10n.setupScanPcCodeHint,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                color: ecoColors(context).textMuted,
                fontSize: 16,
              ),
            ),
            const Spacer(flex: 3),
            AdaptiveGlassActionButton(
              label: context.l10n.setupScan,
              icon: EcoIcons.qrScan,
              onPressed: busy ? null : onScan,
            ),
            const SizedBox(height: 4),
            TextButton(
              onPressed: busy ? null : onManualSetup,
              child: Text(context.l10n.setupManualConfiguration),
            ),
          ],
        ),
      ),
    );
  }
}

class _ReadyConnectionView extends ConsumerWidget {
  const _ReadyConnectionView({
    required this.overview,
    required this.busy,
    required this.onScan,
    required this.onEnterApp,
    required this.onSelectPc,
    this.selectingDesktopId,
  });

  final SetupOverview overview;
  final bool busy;
  final String? selectingDesktopId;
  final VoidCallback onScan;
  final VoidCallback onEnterApp;
  final Future<void> Function(String desktopId, String name, bool? online)
  onSelectPc;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final eco = ecoColors(context);
    final selectedDesktop = ref.watch(selectedDesktopIdProvider);
    final stableOnline = selectedDesktop == null
        ? null
        : ref.watch(stableDesktopOnlineProvider(selectedDesktop));
    final presenceAsync = ref.watch(desktopPresenceProvider);
    final presence = presenceAsync.valueOrNull ?? [];
    final presenceLoading =
        presenceAsync.isLoading && presenceAsync.valueOrNull == null;
    String? selectedName;
    bool? selectedOnline = stableOnline;
    if (selectedDesktop != null) {
      for (final device in presence) {
        if (device.id == selectedDesktop) {
          selectedName = formatDesktopLabel(device, selectedDesktop);
          selectedOnline ??= presenceLoading ? null : device.online;
          break;
        }
      }
      selectedName ??= formatDesktopLabel(null, selectedDesktop);
    }

    final statusLabel = switch (selectedOnline) {
      true => context.l10n.commonOnline,
      false => context.l10n.commonOffline,
      null =>
        selectedName == null
            ? context.l10n.commonNotSelected
            : context.l10n.commonChecking,
    };
    final statusColor = switch (selectedOnline) {
      true => eco.online,
      false => eco.offline,
      null => eco.textMuted.withValues(alpha: 0.55),
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SafeArea(
            bottom: false,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(0, 8, 0, 24),
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 12, 24, 0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.l10n.setupSelectPc,
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        context.l10n.setupSelectPcHint,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: eco.textMuted,
                          height: 1.4,
                        ),
                      ),
                    ],
                  ),
                ),
                if (selectedName != null)
                  EcoGroupedSection(
                    label: context.l10n.setupCurrent,
                    topSpacing: 28,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
                      child: Row(
                        children: [
                          DecoratedBox(
                            decoration: BoxDecoration(
                              color: eco.composerPillBg,
                              borderRadius: BorderRadius.circular(14),
                            ),
                            child: SizedBox(
                              width: 48,
                              height: 48,
                              child: Icon(
                                EcoIcons.desktop,
                                size: 24,
                                color: eco.accent,
                              ),
                            ),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  selectedName,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context).textTheme.titleMedium
                                      ?.copyWith(fontWeight: FontWeight.w600),
                                ),
                                const SizedBox(height: 4),
                                Row(
                                  children: [
                                    Container(
                                      width: 8,
                                      height: 8,
                                      decoration: BoxDecoration(
                                        shape: BoxShape.circle,
                                        color: statusColor,
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    Text(
                                      statusLabel,
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodySmall
                                          ?.copyWith(color: eco.textMuted),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                EcoGroupedSection(
                  label: context.l10n.setupBound,
                  topSpacing: selectedName == null ? 28 : 20,
                  footer: overview.canEnterApp
                      ? null
                      : context.l10n.setupSelectOnlinePcFirst,
                  child: _SelectPcStep(
                    overview: overview,
                    busy: busy,
                    selectingDesktopId: selectingDesktopId,
                    compact: true,
                    embedded: true,
                    onSelect: onSelectPc,
                  ),
                ),
              ],
            ),
          ),
        ),
        _ReadyConnectionActions(
          busy: busy,
          canEnterApp: overview.canEnterApp,
          onEnterApp: onEnterApp,
          onBindNewPc: onScan,
        ),
      ],
    );
  }
}

class _ReadyConnectionActions extends StatelessWidget {
  const _ReadyConnectionActions({
    required this.busy,
    required this.canEnterApp,
    required this.onEnterApp,
    required this.onBindNewPc,
  });

  final bool busy;
  final bool canEnterApp;
  final VoidCallback onEnterApp;
  final VoidCallback onBindNewPc;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return DecoratedBox(
      decoration: BoxDecoration(color: eco.bgMain),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              AdaptiveGlassActionButton(
                label: context.l10n.setupEnterApp,
                icon: EcoIcons.goForward,
                onPressed: busy || !canEnterApp ? null : onEnterApp,
                height: 54,
                expand: false,
              ),
              const SizedBox(height: 4),
              TextButton.icon(
                onPressed: busy ? null : onBindNewPc,
                icon: Icon(EcoIcons.qrScan, size: 18, color: eco.accent),
                label: Text(
                  context.l10n.setupBindNewPc,
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w400,
                    letterSpacing: -0.2,
                    color: eco.accent,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StepBlockedHint extends StatelessWidget {
  const _StepBlockedHint({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 16),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: Theme.of(
          context,
        ).textTheme.bodyMedium?.copyWith(color: ecoColors(context).textMuted),
      ),
    );
  }
}

class _GlassRefreshSpinner extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final spinner = SizedBox(
      width: 20,
      height: 20,
      child: CircularProgressIndicator(
        strokeWidth: 2,
        color: ecoColors(context).textHeading,
      ),
    );

    const outerSize = sessionToolbarButtonSize; // 40
    if (PlatformInfo.isAndroid) {
      return SizedBox(
        width: outerSize,
        height: outerSize,
        child: Center(
          child: EcoAndroidGlassSurface(
            width: outerSize,
            height: outerSize,
            borderRadius: BorderRadius.circular(outerSize / 2),
            child: Center(child: spinner),
          ),
        ),
      );
    }

    return SizedBox(
      width: outerSize,
      height: outerSize,
      child: Center(
        child: AdaptiveButton.child(
          onPressed: null,
          style: AdaptiveButtonStyle.glass,
          size: AdaptiveButtonSize.medium,
          useSmoothRectangleBorder: false,
          child: SizedBox(
            width: outerSize,
            height: outerSize,
            child: Center(child: spinner),
          ),
        ),
      ),
    );
  }
}
