import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/locale/app_error_localizations.dart';
import 'core/locale/app_localizations_ext.dart';
import 'core/models/eco_types.dart';
import 'core/providers/app_locale_provider.dart';
import 'core/providers/app_providers.dart';
import 'core/providers/app_session.dart';
import 'core/providers/app_theme_provider.dart';
import 'core/theme/eco_icons.dart';
import 'core/theme/eco_theme.dart';
import 'core/utils/center_server_auth.dart';
import 'core/widgets/adaptive_nav_bar.dart';
import 'core/widgets/app_theme_media_query.dart';
import 'core/widgets/launch_splash_handoff.dart';
import 'core/widgets/tts_lifecycle_binder.dart';
import 'features/home/home_screen.dart';
import 'features/home/setup_status.dart';
import 'features/projects/project_providers.dart';
import 'features/settings/settings_context_window_page.dart';
import 'features/settings/settings_default_bash_review_page.dart';
import 'features/settings/settings_default_mode_page.dart';
import 'features/settings/settings_language_page.dart';
import 'features/settings/settings_max_output_page.dart';
import 'features/settings/settings_models_page.dart';
import 'features/settings/settings_orchestration_page.dart';
import 'features/settings/settings_screen.dart';
import 'features/settings/settings_read_aloud_page.dart';
import 'features/settings/settings_theme_page.dart';
import 'features/settings/settings_thinking_content_page.dart';
import 'features/threads/thread_providers.dart';
import 'features/threads/thread_session_route.dart';
import 'features/threads/thread_session_screen.dart';
import 'features/threads/threads_screen.dart';
import 'l10n/generated/app_localizations.dart';

final _rootNavigatorKey = GlobalKey<NavigatorState>();
final _scaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();

class _RouterRefreshNotifier extends ChangeNotifier {
  _RouterRefreshNotifier(this._ref) {
    _ref.listen(setupOverviewProvider, (previous, next) {
      if (previous?.setupComplete != next.setupComplete) {
        _scheduleRefresh();
      }
    });
    _ref.listen(selectedDesktopIdProvider, (previous, next) {
      if (previous != next) {
        _scheduleRefresh();
      }
    });
    _ref.listen(pendingAuthRecoveryProvider, (previous, next) {
      if (previous != next) {
        _scheduleRefresh();
      }
    });
    _ref.listen(credentialsProvider, (previous, next) {
      final wasLoggedIn = previous?.valueOrNull?.hasUserSession ?? false;
      final isLoggedIn = next.valueOrNull?.hasUserSession ?? false;
      if (wasLoggedIn != isLoggedIn) {
        _scheduleRefresh();
      }
    });
  }

  final Ref _ref;
  var _disposed = false;
  var _refreshScheduled = false;

  /// Defer GoRouter refresh out of the Riverpod/StateController notify loop.
  ///
  /// Updating [selectedDesktopIdProvider] (and friends) notifies listeners
  /// synchronously. Calling [notifyListeners] here would let GoRouter
  /// `setState` mid-cascade and surface as StateNotifierListenerError:
  /// "At least listener of the StateNotifier StateController#… threw…".
  void _scheduleRefresh() {
    if (_disposed || _refreshScheduled) return;
    _refreshScheduled = true;
    scheduleMicrotask(() {
      _refreshScheduled = false;
      if (_disposed) return;
      notifyListeners();
    });
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

final _routerRefreshProvider = Provider<_RouterRefreshNotifier>((ref) {
  final notifier = _RouterRefreshNotifier(ref);
  ref.onDispose(notifier.dispose);
  return notifier;
});

final appRouterProvider = Provider<GoRouter>((ref) {
  final refresh = ref.watch(_routerRefreshProvider);

  return GoRouter(
    navigatorKey: _rootNavigatorKey,
    initialLocation: '/',
    refreshListenable: refresh,
    redirect: (context, state) {
      final overview = ref.read(setupOverviewProvider);
      final location = state.matchedLocation;
      final pendingRecovery = ref.read(pendingAuthRecoveryProvider);

      if (location == '/') {
        return overview.setupComplete ? '/threads' : '/connect';
      }

      // Session expired or setup incomplete — leave the main shell for connect/login.
      final mustLeaveShell =
          pendingRecovery != null || !overview.setupComplete;
      if (mustLeaveShell &&
          (location.startsWith('/threads') ||
              location.startsWith('/settings'))) {
        return '/connect';
      }
      return null;
    },
    routes: [
      GoRoute(
        path: '/connect',
        builder: (context, state) => const HomeScreen(),
      ),
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) {
          return MainShell(navigationShell: navigationShell);
        },
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/threads',
                builder: (context, state) => const ThreadsScreen(),
                routes: [
                  GoRoute(
                    path: ':threadId',
                    parentNavigatorKey: _rootNavigatorKey,
                    pageBuilder: (context, state) {
                      final rawThreadId = state.pathParameters['threadId']!;
                      return MaterialPage<void>(
                        key: resolveThreadSessionPageKey(
                          rawThreadId: rawThreadId,
                          defaultPageKey: state.pageKey,
                          extra: state.extra,
                        ),
                        name: state.name,
                        arguments: state.extra,
                        child: ThreadSessionScreen(threadId: rawThreadId),
                      );
                    },
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/settings',
                builder: (context, state) => const SettingsScreen(),
                routes: [
                  GoRoute(path: 'read-aloud', parentNavigatorKey: _rootNavigatorKey, builder: (context, state) => const SettingsReadAloudPage()),
                  GoRoute(
                    path: 'theme',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (context, state) => const SettingsThemePage(),
                  ),
                  GoRoute(
                    path: 'language',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (context, state) => const SettingsLanguagePage(),
                  ),
                  GoRoute(
                    path: 'thinking-content',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (context, state) =>
                        const SettingsThinkingContentPage(),
                  ),
                  GoRoute(
                    path: 'default-mode',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (context, state) =>
                        const SettingsDefaultModePage(),
                  ),
                  GoRoute(
                    path: 'default-bash-review',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (context, state) =>
                        const SettingsDefaultBashReviewPage(),
                  ),
                  GoRoute(
                    path: 'context-window',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (context, state) =>
                        const SettingsContextWindowPage(),
                  ),
                  GoRoute(
                    path: 'max-output',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (context, state) => const SettingsMaxOutputPage(),
                  ),
                  GoRoute(
                    path: 'orchestration',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (context, state) =>
                        const SettingsOrchestrationPage(),
                  ),
                  GoRoute(
                    path: 'models',
                    parentNavigatorKey: _rootNavigatorKey,
                    builder: (context, state) => const SettingsModelsPage(),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
});

class MainShell extends ConsumerWidget {
  const MainShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final eco = ecoColors(context);
    final projectsAsync = ref.watch(displayProjectsProvider);
    final hideNavForThreadsBoot =
        navigationShell.currentIndex == 0 &&
        projectsAsync.isLoading &&
        !projectsAsync.hasValue;

    return ColoredBox(
      color: eco.bgMain,
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: Stack(
          fit: StackFit.expand,
          children: [
            navigationShell,
            if (!hideNavForThreadsBoot)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: AdaptiveNavBar(
                  selectedIndex: navigationShell.currentIndex,
                  onDestinationSelected: navigationShell.goBranch,
                  destinations: [
                    AdaptiveNavDestination(
                      icon: EcoIcons.sessions,
                      label: context.l10n.navSessions,
                    ),
                    AdaptiveNavDestination(
                      icon: EcoIcons.settings,
                      label: context.l10n.navSettings,
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class EcoApp extends ConsumerWidget {
  const EcoApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(appSessionProvider);
    ref.watch(globalSettingsSyncBootstrapProvider);
    ref.watch(desktopSwitchBootstrapProvider);
    final router = ref.watch(appRouterProvider);
    final themePreference = ref.watch(appThemePreferenceProvider);
    final localePreference = ref.watch(appLocalePreferenceProvider);
    return MaterialApp.router(
      onGenerateTitle: (context) => context.l10n.appTitle,
      locale: localePreference.locale,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildEcoLightTheme(),
      darkTheme: buildEcoDarkTheme(),
      themeMode: themePreference.themeMode,
      scaffoldMessengerKey: _scaffoldMessengerKey,
      routerConfig: router,
      builder: (context, child) => AppThemeMediaQuery(
        child: TtsLifecycleBinder(
          child: LaunchSplashHandoff(
            child: _ConnectionStatusNotice(
              child: child ?? const SizedBox.shrink(),
            ),
          ),
        ),
      ),
    );
  }
}

class _ConnectionStatusNotice extends ConsumerStatefulWidget {
  const _ConnectionStatusNotice({required this.child});

  final Widget child;

  @override
  ConsumerState<_ConnectionStatusNotice> createState() =>
      _ConnectionStatusNoticeState();
}

class _ConnectionStatusNoticeState
    extends ConsumerState<_ConnectionStatusNotice> {
  EcoConnectionState? _lastState;
  var _hadConnected = false;
  var _unreachableNotified = false;
  var _authRecoveryNotified = false;
  Timer? _unreachableTimer;

  static const _unreachableDelay = Duration(seconds: 15);

  @override
  void dispose() {
    _unreachableTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(connectionStatusProvider, (_, next) {
      next.whenData(_handleStatus);
    });
    ref.listen(pendingAuthRecoveryProvider, (previous, next) {
      if (next == null) {
        _authRecoveryNotified = false;
      }
    });
    return Stack(
      fit: StackFit.expand,
      children: [
        widget.child,
        const _ConnectionBannerOverlay(),
      ],
    );
  }

  void _handleStatus(CenterServerConnectionStatus status) {
    final previous = _lastState;
    if (previous == status.state && status.state != EcoConnectionState.error) {
      return;
    }
    _lastState = status.state;
    if (previous == null) {
      if (status.state == EcoConnectionState.connected) {
        _hadConnected = true;
      }
      return;
    }

    switch (status.state) {
      case EcoConnectionState.connected:
        _hadConnected = true;
        _authRecoveryNotified = false;
        _clearUnreachableWatch();
        return;
      case EcoConnectionState.connecting:
        // Quiet while auto-reconnect is in progress.
        return;
      case EcoConnectionState.disconnected:
        // Intentional stop — no toast.
        _clearUnreachableWatch();
        return;
      case EcoConnectionState.error:
        _handleConnectionError(status);
    }
  }

  void _handleConnectionError(CenterServerConnectionStatus status) {
    if (!mounted) return;
    final recovery =
        status.authRecovery ??
        classifyCenterServerAuthError(status.lastError);
    if (shouldStopCenterServerReconnect(recovery)) {
      _clearUnreachableWatch();
      unawaited(_startCredentialRecovery(recovery));
      return;
    }

    // Transient network blip: only remind if we were online and stay down.
    if (!_hadConnected) return;
    _scheduleUnreachableNotice();
  }

  Future<void> _startCredentialRecovery(
    CenterServerAuthRecovery recovery,
  ) async {
    final started = await beginCredentialRecovery(ref, recovery);
    if (!mounted || !started || _authRecoveryNotified) return;
    _authRecoveryNotified = true;
    _showNotice(
      localizedCenterServerRecovery(recovery, context.l10n),
      duration: const Duration(seconds: 4),
    );
  }

  void _scheduleUnreachableNotice() {
    if (_unreachableNotified || _unreachableTimer != null) return;
    _unreachableTimer = Timer(_unreachableDelay, () {
      _unreachableTimer = null;
      if (!mounted || _unreachableNotified) return;
      final current = ref.read(connectionStatusProvider).valueOrNull;
      if (current == null || current.state == EcoConnectionState.connected) {
        return;
      }
      _unreachableNotified = true;
      _showNotice(
        context.l10n.connectionStillUnreachable,
        duration: const Duration(seconds: 3),
      );
    });
  }

  void _clearUnreachableWatch() {
    _unreachableTimer?.cancel();
    _unreachableTimer = null;
    _unreachableNotified = false;
  }

  void _showNotice(String message, {required Duration duration}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final messenger = _scaffoldMessengerKey.currentState;
      if (messenger == null || !messenger.mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(message), duration: duration),
        );
    });
  }
}

/// Lightweight floating connection status banner shown during reconnection.
///
/// Initial bind / session boot already has a full-screen loading surface — do
/// not also show "Connecting…". That copy is reserved for reconnect after a
/// prior successful Realtime session.
class _ConnectionBannerOverlay extends ConsumerStatefulWidget {
  const _ConnectionBannerOverlay();

  @override
  ConsumerState<_ConnectionBannerOverlay> createState() =>
      _ConnectionBannerOverlayState();
}

class _ConnectionBannerOverlayState
    extends ConsumerState<_ConnectionBannerOverlay> {
  var _hadConnected = false;

  @override
  Widget build(BuildContext context) {
    ref.listen(connectionStatusProvider, (previous, next) {
      next.whenData((status) {
        if (status.state == EcoConnectionState.connected && !_hadConnected) {
          setState(() => _hadConnected = true);
        }
      });
    });

    final status = ref.watch(connectionStatusProvider).valueOrNull;
    if (status == null) return const SizedBox.shrink();
    // listen() does not replay; seed from the current snapshot.
    if (!_hadConnected && status.state == EcoConnectionState.connected) {
      _hadConnected = true;
    }

    final l10n = context.l10n;
    final eco = ecoColors(context);

    final ({Color bg, Color text, String message})? config = switch (status.state) {
      EcoConnectionState.connected => null,
      // First-time connect overlaps session/boot loading — stay quiet.
      EcoConnectionState.connecting => _hadConnected
          ? (
              bg: eco.warnAccent.withValues(alpha: 0.9),
              text: eco.bgMain,
              message: l10n.connectionReconnectBanner,
            )
          : null,
      EcoConnectionState.error => (
          bg: eco.danger,
          text: eco.onAccent,
          message: l10n.connectionLostBanner,
        ),
      EcoConnectionState.disconnected => null,
    };

    if (config == null) return const SizedBox.shrink();

    return Positioned(
      top: MediaQuery.of(context).padding.top + 8,
      left: 16,
      right: 16,
      child: IgnorePointer(
        child: Align(
          alignment: Alignment.topCenter,
          child: Container(
            constraints: const BoxConstraints(maxHeight: 36),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            decoration: BoxDecoration(
              color: config.bg,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: config.text.withValues(alpha: 0.2)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 14,
                  height: 14,
                  child: status.state == EcoConnectionState.connecting
                      ? CircularProgressIndicator(
                          strokeWidth: 1.5,
                          valueColor: AlwaysStoppedAnimation(config.text),
                        )
                      : Icon(Icons.cloud_off, size: 14, color: config.text),
                ),
                const SizedBox(width: 6),
                Text(
                  config.message,
                  style: TextStyle(
                    color: config.text,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    decoration: TextDecoration.none,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
