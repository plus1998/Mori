import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_error_localizations.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_models.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../composer/composer_controls.dart';
import '../threads/thread_providers.dart';
import 'settings_workflow_persistence.dart';

class SettingsOrchestrationPage extends ConsumerStatefulWidget {
  const SettingsOrchestrationPage({super.key});

  @override
  ConsumerState<SettingsOrchestrationPage> createState() =>
      _SettingsOrchestrationPageState();
}

class _SettingsOrchestrationPageState
    extends ConsumerState<SettingsOrchestrationPage> {
  final _writer = SettingsGlobalOrchestrationWriter();
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

  void _onChanged(ThreadRuntimeConfigInput config) {
    setState(() => _config = config);
    _writer.queue(
      ref,
      context: context,
      config: config,
      onSavingChanged: () {
        if (mounted) setState(() {});
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final modelSettingsAsync = ref.watch(modelSettingsProvider);
    final modelSettings = modelSettingsAsync.valueOrNull;
    final desktopConnected = ref.watch(desktopRpcProvider) != null;
    final mcpServers =
        ref.watch(mcpSettingsProvider).valueOrNull?.servers ?? const [];
    final config = _config;
    final providerError =
        modelSettingsAsync.hasError ? modelSettingsAsync.error : null;
    final error = _loadError ?? providerError;

    final Widget body;
    if (_loading ||
        (config == null && error == null && modelSettingsAsync.isLoading)) {
      body = const Center(child: CircularProgressIndicator(strokeWidth: 2));
    } else if (error != null) {
      body = _SettingsLoadError(
        message: localizedAppError(error, l10n),
        onRetry: _retry,
      );
    } else if (modelSettings != null && config != null) {
      body = ListView(
        padding: EdgeInsets.only(
          bottom: MediaQuery.paddingOf(context).bottom + 24,
        ),
        children: [
          EcoGroupedSection(
            caption: desktopConnected
                ? l10n.composerSelectOrchestrationSelection
                : l10n.settingsConnectPcFirst,
            topSpacing: 28,
            child: OrchestrationCompositionSelectors(
              settings: modelSettings,
              runtimeConfig: config,
              threadId: '',
              canEdit: desktopConnected && !_writer.saving,
              onChanged: _onChanged,
              workspacePath: '',
              mcpServers: mcpServers,
              rememberedMcp: null,
              showOrchestrationPickers: true,
              showAuxiliaryModelPicker: false,
              showVisionModelPicker: false,
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
      appBar: AppBar(title: Text(l10n.settingsRuntimeConfig)),
      body: body,
    );
  }
}

class _SettingsLoadError extends StatelessWidget {
  const _SettingsLoadError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: Text(l10n.commonRetry)),
          ],
        ),
      ),
    );
  }
}
