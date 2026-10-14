import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_error_localizations.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_models.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../composer/composer_controls.dart';
import '../threads/thread_providers.dart';
import 'settings_workflow_persistence.dart';

class SettingsModelsPage extends ConsumerStatefulWidget {
  const SettingsModelsPage({super.key});

  @override
  ConsumerState<SettingsModelsPage> createState() => _SettingsModelsPageState();
}

class _SettingsModelsPageState extends ConsumerState<SettingsModelsPage> {
  ThreadRuntimeConfigInput? _config;
  bool _loading = true;
  Object? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final config = await loadGlobalRuntimeConfig(ref);
      if (!mounted) return;
      setState(() {
        _config = config;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loadError = error;
        _loading = false;
      });
    }
  }

  void _retry() {
    ref.invalidate(modelSettingsProvider);
    ref.invalidate(workflowSettingsProvider);
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final modelSettingsAsync = ref.watch(modelSettingsProvider);
    final modelSettings = modelSettingsAsync.valueOrNull;
    final desktopConnected = ref.watch(desktopRpcProvider) != null;
    final workflow = ref.watch(workflowSettingsProvider).valueOrNull;
    final mcpServers =
        ref.watch(mcpSettingsProvider).valueOrNull?.servers ?? const [];
    final config = _config;
    final isAcp = workflow?.defaultCoreKind == 'acp';
    final providerError =
        modelSettingsAsync.hasError ? modelSettingsAsync.error : null;
    final error = _loadError ?? providerError;

    final Widget body;
    if (_loading ||
        (config == null && error == null && modelSettingsAsync.isLoading)) {
      body = const Center(child: CircularProgressIndicator(strokeWidth: 2));
    } else if (error != null) {
      body = Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                localizedAppError(error, l10n),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              FilledButton(onPressed: _retry, child: Text(l10n.commonRetry)),
            ],
          ),
        ),
      );
    } else if (modelSettings != null &&
        !isAcp &&
        config != null) {
      body = ListView(
        padding: EdgeInsets.only(
          bottom: MediaQuery.paddingOf(context).bottom + 24,
        ),
        children: [
          EcoGroupedSection(
            caption: desktopConnected
                ? l10n.settingsModelsCaption
                : l10n.settingsConnectPcFirst,
            topSpacing: 28,
            child: OrchestrationCompositionSelectors(
              settings: modelSettings,
              runtimeConfig: config,
              threadId: '',
              canEdit: desktopConnected,
              onChanged: (next) => setState(() => _config = next),
              workspacePath: '',
              mcpServers: mcpServers,
              rememberedMcp: null,
              showOrchestrationPickers: false,
              showAuxiliaryModelPicker: true,
              showApprovalModelPicker: true,
              showVisionModelPicker: true,
            ),
          ),
        ],
      );
    } else if (isAcp && config != null) {
      body = ListView(
        padding: EdgeInsets.only(
          bottom: MediaQuery.paddingOf(context).bottom + 24,
        ),
        children: [
          EcoGroupedSection(
            caption: desktopConnected
                ? l10n.settingsModelsCaption
                : l10n.settingsConnectPcFirst,
            topSpacing: 28,
            child: Column(
              children: [
                ComposerAuxiliaryModelSection(
                  runtimeConfig: config,
                  threadId: '',
                  canEdit: desktopConnected,
                  onChanged: (next) => setState(() => _config = next),
                  mainAgentConfigId: '',
                  isAcp: true,
                ),
                ComposerApprovalModelSection(
                  runtimeConfig: config,
                  threadId: '',
                  canEdit: desktopConnected,
                  onChanged: (next) => setState(() => _config = next),
                  mainAgentConfigId: '',
                  isAcp: true,
                ),
                ComposerVisionModelSection(
                  runtimeConfig: config,
                  threadId: '',
                  canEdit: desktopConnected,
                  onChanged: (next) => setState(() => _config = next),
                  mainAgentConfigId: '',
                  isAcp: true,
                ),
              ],
            ),
          ),
        ],
      );
    } else {
      body = Padding(
        padding: const EdgeInsets.fromLTRB(20, 40, 20, 0),
        child: Text(
          desktopConnected
              ? l10n.composerOrchestrationNotConfigured
              : l10n.settingsConnectPcFirst,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsModels)),
      body: body,
    );
  }
}
