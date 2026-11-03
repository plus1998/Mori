import 'package:eco_mobile/core/models/composer_reference_models.dart';
import 'package:eco_mobile/core/models/integration_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/features/composer/composer_reference_providers.dart';
import 'package:eco_mobile/features/composer/composer_runtime_config_provider.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _config = ThreadRuntimeConfig(
  subagentEnabled: {},
  sessionMode: 'agent',
  bashReviewMode: 'always',
);

class _Rpc extends DesktopRpc {
  _Rpc() : super(EcoCenterClient(store: CredentialStore()), 'desktop');

  @override
  Future<ComposerReferenceSearchResult> searchComposerReferences({
    required String query,
    String? kind,
    int limit = 12,
  }) async => const ComposerReferenceSearchResult(items: [], hasMore: false);
}

class _SendClient extends EcoCenterClient {
  _SendClient() : super(store: CredentialStore());
  Map<String, dynamic>? request;

  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    expect(channel, 'thread:start');
    request = Map<String, dynamic>.from(args.single as Map);
    return {
          'thread': {
            'id': 'thr-image',
            'title': 'Draw',
            'prompt': request!['prompt'],
            'workspacePath': '/project',
            'status': 'queued',
            'createdAt': '2026-11-03T00:00:00Z',
            'updatedAt': '2026-11-03T00:00:00Z',
            'runtimeConfig': request!['runtimeConfig'],
          },
        }
        as T;
  }
}

void main() {
  ProviderContainer container({
    Map<String, bool> projectEnabled = const {'imageGeneration': true},
    Object? projectError,
  }) {
    final container = ProviderContainer(
      overrides: [
        desktopRpcProvider.overrideWithValue(_Rpc()),
        projectIntegrationsSettingsProvider('/project').overrideWith((
          ref,
        ) async {
          if (projectError != null) throw projectError;
          return ProjectIntegrationsSettingsSnapshot(
            workspacePath: '/project',
            enabled: projectEnabled,
          );
        }),
        workflowSettingsProvider.overrideWith(
          (ref) async => const WorkflowSettingsSnapshot(
            sessionMode: 'agent',
            integrationsEnabled: {'browser': true},
          ),
        ),
        integrationAvailabilityProvider.overrideWith(
          (ref) async => const IntegrationAvailabilitySnapshot(
            integrations: [
              IntegrationAvailabilityItem(
                id: 'imageGeneration',
                enabled: true,
                available: true,
              ),
            ],
          ),
        ),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  test(
    'offered image integration is included in the runtime config sent to desktop',
    () async {
      final scope = container();
      final references = await scope.read(
        composerReferenceSearchProvider((
          query: '创意绘画',
          kind: 'integration',
          runtimeConfig: _config,
          workspacePath: '/project',
          coreKind: 'codex',
        )).future,
      );
      expect(references.items.single.id, 'imageGeneration');

      final config = await scope.read(
        effectiveComposerRuntimeConfigProvider((
          runtimeConfig: _config,
          workspacePath: '/project',
        )).future,
      );
      expect(config.toJson()['integrationsEnabled'], {'imageGeneration': true});
      expect(config.sessionMode, _config.sessionMode);
      expect(_config.integrationsEnabled, isNull);

      final client = _SendClient();
      final thread = await DesktopRpc(client, 'desktop').startThread(
        workspacePath: '/project',
        prompt: references.items.single.token,
        runtimeConfig: config,
        coreKind: 'codex',
      );
      final wireConfig = client.request!['runtimeConfig'] as Map;
      expect(wireConfig['integrationsEnabled'], {'imageGeneration': true});
      expect(thread.runtimeConfig?.integrationsEnabled, {
        'imageGeneration': true,
      });
    },
  );

  for (final enabled in [
    <String, bool>{},
    {'imageGeneration': false},
  ]) {
    test(
      'explicit session selection $enabled overrides project defaults',
      () async {
        final scope = container(
          projectError: StateError('must not fetch project'),
        );
        final config = _config.copyWith(integrationsEnabled: enabled);
        final effective = await scope.read(
          effectiveComposerRuntimeConfigProvider((
            runtimeConfig: config,
            workspacePath: '/project',
          )).future,
        );
        expect(effective, same(config));
        final references = await scope.read(
          composerReferenceSearchProvider((
            query: '',
            kind: 'integration',
            runtimeConfig: config,
            workspacePath: '/project',
            coreKind: 'codex',
          )).future,
        );
        expect(references.items, isEmpty);
      },
    );
  }

  test(
    'empty project selection stays disabled despite enabled workflow defaults',
    () async {
      final scope = container(projectEnabled: {});
      final config = await scope.read(
        effectiveComposerRuntimeConfigProvider((
          runtimeConfig: _config,
          workspacePath: '/project',
        )).future,
      );
      expect(config.integrationsEnabled, isEmpty);
    },
  );

  test(
    'without a project, workflow defaults are materialized for sending',
    () async {
      final scope = container();
      final config = await scope.read(
        effectiveComposerRuntimeConfigProvider((
          runtimeConfig: _config,
          workspacePath: '',
        )).future,
      );
      expect(config.toJson()['integrationsEnabled'], {'browser': true});
    },
  );

  test(
    'settings errors fail both reference search and send config resolution',
    () async {
      final error = StateError('project settings unavailable');
      final scope = container(projectError: error);
      await expectLater(
        scope.read(
          effectiveComposerRuntimeConfigProvider((
            runtimeConfig: _config,
            workspacePath: '/project',
          )).future,
        ),
        throwsA(same(error)),
      );
      await expectLater(
        scope.read(
          composerReferenceSearchProvider((
            query: '',
            kind: 'integration',
            runtimeConfig: _config,
            workspacePath: '/project',
            coreKind: 'codex',
          )).future,
        ),
        throwsA(same(error)),
      );
    },
  );
}
