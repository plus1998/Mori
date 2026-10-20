import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/tts_models.dart';
import '../../core/providers/app_providers.dart';
import '../../core/services/eco_tts_service.dart';
import '../../core/widgets/eco_grouped_list.dart';
import 'settings_disclosure_row.dart';

final readAloudStatusProvider = FutureProvider.autoDispose<ReadAloudStatus>((
  ref,
) {
  ref.watch(selectedDesktopIdProvider);
  ref.watch(connectionStatusProvider);
  return ref.read(ecoTtsServiceProvider).getOnlineStatus();
});

class SettingsReadAloudPage extends ConsumerStatefulWidget {
  const SettingsReadAloudPage({super.key});
  @override
  ConsumerState<SettingsReadAloudPage> createState() =>
      _SettingsReadAloudPageState();
}

class _SettingsReadAloudPageState extends ConsumerState<SettingsReadAloudPage> {
  bool _saving = false;
  @override
  void initState() {
    super.initState();
    unawaited(ref.read(ecoTtsServiceProvider).loadPreferences());
  }

  Future<void> _select(TtsEngine engine) async {
    setState(() => _saving = true);
    try {
      await ref.read(ecoTtsServiceProvider).setEngine(engine);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tts = ref.watch(ecoTtsServiceProvider);
    final status = ref.watch(readAloudStatusProvider);
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.readAloudTitle)),
      body: ListView(
        children: [
          EcoGroupedSection(
            label: l10n.readAloudEngine,
            child: Column(
              children: [
                SettingsRadioOption(
                  title: l10n.readAloudOnline,
                  subtitle: l10n.readAloudOnlineHint,
                  selected: tts.engine == TtsEngine.online,
                  enabled: !_saving,
                  onTap: () => _select(TtsEngine.online),
                ),
                const EcoGroupedDivider(),
                SettingsRadioOption(
                  title: l10n.readAloudSystem,
                  subtitle: l10n.readAloudSystemHint,
                  selected: tts.engine == TtsEngine.system,
                  enabled: !_saving,
                  onTap: () => _select(TtsEngine.system),
                ),
              ],
            ),
          ),
          EcoGroupedSection(
            label: l10n.readAloudDesktopConfig,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: status.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (error, stack) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(error.toString()),
                    TextButton(
                      onPressed: () => ref.invalidate(readAloudStatusProvider),
                      child: Text(l10n.commonRetry),
                    ),
                  ],
                ),
                data: (config) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (!config.available)
                      Text(config.reason ?? l10n.commonNotConfigured),
                    if (config.profileName != null)
                      Text(
                        config.profileName!,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    if (config.voice != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text('${l10n.readAloudVoice}：${config.voice}'),
                      ),
                    if (config.style != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(config.style!),
                      ),
                    const SizedBox(height: 8),
                    Text(l10n.readAloudConfigHint),
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
