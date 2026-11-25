import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/thread_models.dart';
import '../threads/thread_providers.dart';

typedef ComposerRuntimeConfigScope = ({
  ThreadRuntimeConfig runtimeConfig,
  String workspacePath,
});

/// Persist the same integration selection that the composer offers as references.
/// Desktop execution only reads the saved thread config, not project defaults.
final effectiveComposerRuntimeConfigProvider = FutureProvider.autoDispose
    .family<ThreadRuntimeConfig, ComposerRuntimeConfigScope>((
      ref,
      input,
    ) async {
      final config = input.runtimeConfig;
      if (config.integrationsEnabled != null) return config;
      if (ref.watch(desktopRpcProvider) == null) {
        throw StateError('引用服务尚未连接');
      }
      if (input.workspacePath.isNotEmpty) {
        final project = await ref.watch(
          projectIntegrationsSettingsProvider(input.workspacePath).future,
        );
        if (project == null) throw StateError('无法读取项目集成工具设置');
        return config.copyWith(integrationsEnabled: project.enabled);
      }
      final workflow = await ref.watch(workflowSettingsProvider.future);
      if (workflow == null) throw StateError('无法读取集成工具默认设置');
      return config.copyWith(
        integrationsEnabled: workflow.integrationsEnabled ?? const {},
      );
    });

final newThreadComposerRuntimeConfigProvider = FutureProvider.autoDispose
    .family<ThreadRuntimeConfig, ComposerRuntimeConfigScope>((
      ref,
      input,
    ) async {
      final selected = input.runtimeConfig.integrationsEnabled;
      if (selected != null &&
          !selected.containsKey('browser') &&
          input.workspacePath.isNotEmpty) {
        final project = await ref.watch(
          projectIntegrationsSettingsProvider(input.workspacePath).future,
        );
        if (project == null) throw StateError('无法读取项目集成工具设置');
        return input.runtimeConfig.copyWith(
          integrationsEnabled: {
            ...selected,
            'browser': project.enabled['browser'] ?? true,
          },
        );
      }
      final config = await ref.watch(
        effectiveComposerRuntimeConfigProvider(input).future,
      );
      final enabled = config.integrationsEnabled;
      if (enabled?.containsKey('browser') == true) return config;
      return config.copyWith(
        integrationsEnabled: {...?enabled, 'browser': true},
      );
    });
