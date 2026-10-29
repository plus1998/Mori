import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/constants/bash_review_ui.dart';
import '../../core/locale/app_locale_preference.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../l10n/generated/app_localizations.dart';
import '../../core/models/eco_types.dart';
import '../../core/models/thread_models.dart';
import '../../core/providers/app_locale_provider.dart';
import '../../core/providers/app_providers.dart';
import '../../core/providers/app_theme_provider.dart';
import '../../core/theme/app_theme_preference.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/model_id.dart';
import '../../core/widgets/adaptive_nav_bar.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../../core/widgets/shell_toolbar_actions.dart';
import '../threads/thread_providers.dart';
import '../threads/thread_session_app_bar.dart';
import 'settings_disclosure_row.dart';
import 'settings_labels.dart';
import 'settings_workflow_persistence.dart';
import '../../core/preferences/thinking_display_preferences.dart';
import '../../core/providers/thinking_display_provider.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final credentials = ref.watch(credentialsProvider);
    final l10n = context.l10n;
    final themePreference = ref.watch(appThemePreferenceProvider);
    final localePreference = ref.watch(appLocalePreferenceProvider);
    final thinkingDisplayMode = ref.watch(thinkingDisplayModeProvider);
    final workflowAsync = ref.watch(workflowSettingsProvider);
    final modelSettingsAsync = ref.watch(modelSettingsProvider);
    final workflow = workflowAsync.valueOrNull;
    final modelSettings = modelSettingsAsync.valueOrNull;
    final desktopConnected = ref.watch(desktopRpcProvider) != null;
    final settingsLoadFailed =
        modelSettingsAsync.hasError || workflowAsync.hasError;

    final themeValue = switch (themePreference) {
      AppThemePreference.system => l10n.settingsThemeSystem,
      AppThemePreference.dark => l10n.settingsThemeDark,
      AppThemePreference.light => l10n.settingsThemeLight,
    };
    final languageValue = switch (localePreference) {
      AppLocalePreference.system => l10n.settingsLanguageSystem,
      AppLocalePreference.zhCN => l10n.settingsLanguageChinese,
      AppLocalePreference.enUS => l10n.settingsLanguageEnglish,
    };
    final thinkingValue = switch (thinkingDisplayMode) {
      ThinkingDisplayMode.ephemeral => l10n.settingsThinkingContentEphemeral,
      ThinkingDisplayMode.collapsed => l10n.settingsThinkingContentCollapsed,
      ThinkingDisplayMode.expanded => l10n.settingsThinkingContentExpanded,
    };
    final bashReviewMode = normalizeBashReviewMode(
      workflow?.defaultBashReviewMode,
    );
    final bashReviewValue = bashReviewUi(bashReviewMode, l10n).title;
    final contextLimit =
        workflow?.contextWindowLimitTokens ?? defaultContextWindowLimitTokens;
    final contextValue = contextWindowLimitLabel(contextLimit);
    final maxOutputLimit =
        workflow?.maxOutputLimitTokens ?? defaultMaxOutputLimitTokens;
    final maxOutputValue = maxOutputLimit == defaultMaxOutputLimitTokens
        ? l10n.settingsMaxOutputDynamic
        : maxOutputLimitLabel(maxOutputLimit as int);

    final selection = workflow?.defaultOrchestrationSelection;
    final mainAgentId = selection?.mainAgentConfigId.trim() ?? '';
    final mainAgentName = modelSettings?.mainAgentConfigs
        .where((config) => config.id == mainAgentId)
        .map((config) => config.name)
        .firstOrNull;
    final orchestrationValue = settingsLoadFailed
        ? l10n.settingsRealtimeError
        : (mainAgentName == null || mainAgentName.isEmpty)
        ? l10n.commonNotConfigured
        : mainAgentName;

    final auxiliaryModel = workflow?.defaultAuxiliaryModel;
    final modelsValue = settingsLoadFailed
        ? l10n.settingsRealtimeError
        : auxiliaryModel == null
        ? l10n.commonNotConfigured
        : shortenModelId(auxiliaryModel.modelId);

    final frostCanvas = ecoColors(context).bgMain;

    return Scaffold(
      backgroundColor: Colors.transparent,
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        forceMaterialTransparency: true,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        title: Text(l10n.settingsTitle),
        actions: const [ShellToolbarActions()],
      ),
      // Measure AppBar clearance from body MediaQuery (not parent of Scaffold).
      body: Builder(
        builder: (bodyContext) {
          final listTopPad = sessionAppBarChromeHeight(bodyContext);
          final listBottomPad = adaptiveNavOverlayInset(bodyContext);
          return Stack(
            fit: StackFit.expand,
            children: [
              credentials.when(
                data: (creds) {
                  final signedIn = creds.hasUserSession || creds.isProvisioned;
                  return ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: EdgeInsets.only(
                      top: listTopPad,
                      bottom: listBottomPad,
                    ),
                    children: [
                      _AccountHeader(
                        email: creds.userEmail ?? l10n.settingsNotSignedIn,
                        subtitle:
                            creds.userDisplayName ??
                            creds.deviceName ??
                            (signedIn ? null : l10n.settingsConnectPcFirst),
                        signedIn: signedIn,
                      ),
                      EcoGroupedSection(
                        label: l10n.settingsAppearance,
                        topSpacing: 28,
                        child: Column(
                          children: [
                            SettingsDisclosureRow(
                              title: l10n.settingsTheme,
                              value: themeValue,
                              onTap: () => context.push('/settings/theme'),
                            ),
                            const EcoGroupedDivider(),
                            SettingsDisclosureRow(
                              title: l10n.settingsLanguage,
                              value: languageValue,
                              onTap: () => context.push('/settings/language'),
                            ),
                            const EcoGroupedDivider(),
                            SettingsDisclosureRow(
                              title: l10n.settingsThinkingContent,
                              value: thinkingValue,
                              onTap: () =>
                                  context.push('/settings/thinking-content'),
                            ),
                            const EcoGroupedDivider(),
                            SettingsDisclosureRow(
                              title: l10n.readAloudTitle,
                              onTap: () => context.push('/settings/read-aloud'),
                            ),
                            const EcoGroupedDivider(),
                            SettingsSwitchRow(
                              title: l10n.settingsShowBilling,
                              subtitle: l10n.settingsShowBillingSubtitle,
                              value: workflow?.showBilling ?? true,
                              enabled: desktopConnected,
                              onChanged: (value) => saveSettingsShowBilling(
                                ref,
                                context: context,
                                nextValue: value,
                              ),
                            ),
                          ],
                        ),
                      ),
                      EcoGroupedSection(
                        label: l10n.settingsSessionDefaults,
                        topSpacing: 28,
                        child: Column(
                          children: [
                            SettingsDisclosureRow(
                              title: l10n.settingsDefaultBashReviewMode,
                              value: bashReviewValue,
                              onTap: () => context.push(
                                '/settings/default-bash-review',
                              ),
                            ),
                            const EcoGroupedDivider(),
                            SettingsDisclosureRow(
                              title: l10n.settingsContextWindow,
                              value: contextValue,
                              onTap: () =>
                                  context.push('/settings/context-window'),
                            ),
                            const EcoGroupedDivider(),
                            SettingsDisclosureRow(
                              title: l10n.settingsMaxOutput,
                              value: maxOutputValue,
                              onTap: () => context.push('/settings/max-output'),
                            ),
                            const EcoGroupedDivider(),
                            SettingsDisclosureRow(
                              title: l10n.settingsRuntimeConfig,
                              value: orchestrationValue,
                              onTap: () =>
                                  context.push('/settings/orchestration'),
                            ),
                            const EcoGroupedDivider(),
                            SettingsDisclosureRow(
                              title: l10n.settingsModels,
                              value: modelsValue,
                              onTap: () => context.push('/settings/models'),
                            ),
                          ],
                        ),
                      ),
                      if (signedIn)
                        EcoGroupedSection(
                          label: l10n.settingsAccount,
                          topSpacing: 28,
                          child: Column(
                            children: [
                              SettingsDisclosureRow(
                                icon: EcoIcons.desktop,
                                title: l10n.settingsSwitchPc,
                                subtitle: l10n.settingsSwitchPcSubtitle,
                                onTap: () => context.push('/connect'),
                              ),
                              const EcoGroupedDivider(indent: 52),
                              SettingsDisclosureRow(
                                icon: EcoIcons.logout,
                                title: l10n.settingsSignOut,
                                destructive: true,
                                onTap: () async {
                                  final client = ref.read(
                                    ecoCenterClientProvider,
                                  );
                                  await client.clearSession();
                                  ref.invalidate(credentialsProvider);
                                  ref.invalidate(bindingsProvider);
                                  ref.invalidate(desktopPresenceProvider);
                                  ref
                                          .read(
                                            selectedDesktopIdProvider.notifier,
                                          )
                                          .state =
                                      null;
                                  if (context.mounted) {
                                    context.go('/connect');
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      SnackBar(
                                        content: Text(l10n.settingsSignedOut),
                                      ),
                                    );
                                  }
                                },
                              ),
                            ],
                          ),
                        ),
                    ],
                  );
                },
                loading: () => const SafeArea(
                  child: Center(
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
                error: (error, _) => SafeArea(
                  child: Center(child: Text(error.toString())),
                ),
              ),
              SessionTopFrostOverlay(canvasColor: frostCanvas),
            ],
          );
        },
      ),
    );
  }
}

class _AccountHeader extends ConsumerWidget {
  const _AccountHeader({
    required this.email,
    this.subtitle,
    required this.signedIn,
  });

  final String email;
  final String? subtitle;
  final bool signedIn;

  String _initials() {
    final source = (subtitle?.trim().isNotEmpty == true ? subtitle! : email)
        .trim();
    if (source.isEmpty || !signedIn) return '?';
    final parts = source.split(RegExp(r'\s+'));
    if (parts.length >= 2) {
      return '${parts.first[0]}${parts[1][0]}'.toUpperCase();
    }
    return source[0].toUpperCase();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final eco = ecoColors(context);
    final connectionStatus = ref.watch(connectionStatusProvider).valueOrNull;
    final realtimeState = connectionStatus?.state ??
        EcoConnectionState.disconnected;

    final realtimeStatusConfig = _realtimeStatusConfig(realtimeState, context.l10n, eco);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
      child: Row(
        children: [
          DecoratedBox(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: eco.composerPillBg,
            ),
            child: SizedBox(
              width: 64,
              height: 64,
              child: Center(
                child: Text(
                  _initials(),
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w500,
                    color: eco.textSecondary,
                    letterSpacing: -0.3,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  email,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: realtimeStatusConfig.$1,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      realtimeStatusConfig.$2,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall?.copyWith(color: eco.textMuted),
                    ),
                  ],
                ),
                if (subtitle != null && subtitle!.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    subtitle!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: eco.textMuted),
                  ),
                ] else if (!signedIn) ...[
                  const SizedBox(height: 2),
                  Text(
                    context.l10n.settingsConnectPcFirst,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: eco.textMuted),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  (Color, String) _realtimeStatusConfig(
    EcoConnectionState state,
    AppLocalizations l10n,
    EcoColors eco,
  ) {
    return switch (state) {
      EcoConnectionState.connected => (eco.online, l10n.settingsRealtimeConnected),
      EcoConnectionState.connecting => (eco.warnAccent, l10n.settingsRealtimeConnecting),
      EcoConnectionState.error => (eco.danger, l10n.settingsRealtimeError),
      EcoConnectionState.disconnected => (eco.textMuted, l10n.settingsRealtimeDisconnected),
    };
  }
}
