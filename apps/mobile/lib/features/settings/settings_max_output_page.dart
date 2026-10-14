import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../threads/thread_providers.dart';
import 'settings_disclosure_row.dart';
import 'settings_labels.dart';
import 'settings_workflow_persistence.dart';

class SettingsMaxOutputPage extends ConsumerStatefulWidget {
  const SettingsMaxOutputPage({super.key});

  @override
  ConsumerState<SettingsMaxOutputPage> createState() =>
      _SettingsMaxOutputPageState();
}

class _SettingsMaxOutputPageState extends ConsumerState<SettingsMaxOutputPage> {
  Object? _maxOutputLimitTokens;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final workflow = await ref.read(workflowSettingsProvider.future);
    if (!mounted) return;
    setState(() {
      _maxOutputLimitTokens =
          workflow?.maxOutputLimitTokens ?? defaultMaxOutputLimitTokens;
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final selected = _maxOutputLimitTokens;
    final desktopConnected = ref.watch(desktopRpcProvider) != null;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsMaxOutput)),
      body: selected == null
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : ListView(
              padding: EdgeInsets.only(
                bottom: MediaQuery.paddingOf(context).bottom + 24,
              ),
              children: [
                EcoGroupedSection(
                  caption: desktopConnected
                      ? (selected == defaultMaxOutputLimitTokens
                            ? l10n.settingsMaxOutputDynamicCaption
                            : l10n.settingsMaxOutputCaption)
                      : l10n.settingsConnectPcFirst,
                  topSpacing: 28,
                  child: Column(
                    children: [
                      SettingsRadioOption(
                        title: l10n.settingsMaxOutputDynamic,
                        subtitle: l10n.settingsMaxOutputDynamicCaption,
                        icon: EcoIcons.send,
                        selected: selected == defaultMaxOutputLimitTokens,
                        enabled: desktopConnected,
                        onTap: () async {
                          await saveSettingsMaxOutputLimit(
                            ref,
                            context: context,
                            nextLimit: defaultMaxOutputLimitTokens,
                            previousLimit: selected,
                            onOptimistic: (value) =>
                                setState(() => _maxOutputLimitTokens = value),
                            onRevert: (value) =>
                                setState(() => _maxOutputLimitTokens = value),
                          );
                        },
                      ),
                      const EcoGroupedDivider(indent: 52),
                      for (
                        var i = 0;
                        i < maxOutputLimitPresets.length;
                        i++
                      ) ...[
                        if (i > 0) const EcoGroupedDivider(indent: 52),
                        SettingsRadioOption(
                          title: maxOutputLimitLabel(maxOutputLimitPresets[i]),
                          subtitle: l10n.settingsMaxOutputTokens(
                            maxOutputLimitPresets[i],
                          ),
                          icon: EcoIcons.send,
                          selected: selected == maxOutputLimitPresets[i],
                          enabled: desktopConnected,
                          onTap: () async {
                            final previous = selected;
                            await saveSettingsMaxOutputLimit(
                              ref,
                              context: context,
                              nextLimit: maxOutputLimitPresets[i],
                              previousLimit: previous,
                              onOptimistic: (value) {
                                setState(() => _maxOutputLimitTokens = value);
                              },
                              onRevert: (value) {
                                setState(() => _maxOutputLimitTokens = value);
                              },
                            );
                          },
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
    );
  }
}
