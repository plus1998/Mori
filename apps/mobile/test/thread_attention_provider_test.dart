import 'dart:async';
import 'dart:convert';

import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _ApprovalClient extends EcoCenterClient {
  _ApprovalClient({this.legacyEnvelope = false})
    : super(store: CredentialStore());

  final bool legacyEnvelope;
  final pending = <String, Map<String, dynamic>>{};

  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    if (channel != 'bash-approval:get-pending') {
      throw StateError('Unexpected RPC $channel');
    }
    final result = pending[args.single];
    // Exercise the real mobile decoder after the desktop envelope crosses JSON.
    return EcoCenterClient.unwrapInvokeResult<T>(
      jsonDecode(
        jsonEncode({
          'channel': channel,
          if (!legacyEnvelope || result != null) 'result': result,
        }),
      ),
    );
  }
}

class _RunningThreads extends ThreadListNotifier {
  @override
  Future<List<ThreadSummary>> build() async => [
    for (var i = 1; i <= 3; i++)
      ThreadSummary.fromJson({
        'id': 'thread-$i',
        'title': 'Running thread $i',
        'prompt': 'Task',
        'workspacePath': '/project',
        'status': 'running',
        'createdAt': '2026-01-01T00:00:00.000Z',
        'updatedAt': '2026-01-01T00:00:01.000Z',
      }),
  ];
}

ProviderContainer _container(
  _ApprovalClient client, {
  Stream<EcoEventEnvelope> events = const Stream.empty(),
  Stream<CenterServerConnectionStatus> connection = const Stream.empty(),
}) => ProviderContainer(
  overrides: [
    desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'desktop')),
    threadListProvider.overrideWith(_RunningThreads.new),
    ecoEventsProvider.overrideWith((ref) => events),
    connectionStatusProvider.overrideWith((ref) => connection),
    appForegroundProvider.overrideWithValue(true),
  ],
);

void main() {
  for (final legacy in [false, true]) {
    test(
      'running threads without approvals create no notifications (legacy=$legacy)',
      () async {
        final client = _ApprovalClient(legacyEnvelope: legacy);
        final container = _container(client);
        addTearDown(container.dispose);
        addTearDown(client.dispose);
        final subscription = container.listen(
          threadAttentionProvider,
          (_, _) {},
        );
        addTearDown(subscription.close);
        expect(await container.read(threadAttentionProvider.future), isEmpty);
      },
    );
  }

  test(
    'approval events refresh attention without a thread status change',
    () async {
      final client = _ApprovalClient();
      final events = StreamController<EcoEventEnvelope>.broadcast();
      final container = _container(client, events: events.stream);
      addTearDown(container.dispose);
      addTearDown(client.dispose);
      addTearDown(events.close);
      final subscription = container.listen(threadAttentionProvider, (_, _) {});
      addTearDown(subscription.close);
      expect(await container.read(threadAttentionProvider.future), isEmpty);

      Future<void> changed(String type) async {
        events.add(
          EcoEventEnvelope(
            id: type,
            kind: 'thread.bash_approval',
            source: 'desktop',
            occurredAt: '2026-01-01T00:00:02.000Z',
            payload: {'threadId': 'thread-1', 'type': type},
          ),
        );
        await Future<void>.delayed(Duration.zero);
      }

      client.pending['thread-1'] = {
        'toolUseId': 'tool-1',
        'threadId': 'thread-1',
        'command': 'git status',
      };
      await changed('bash_approval.requested');
      final items = await container.read(threadAttentionProvider.future);
      expect(items.single.id, 'bash:thread-1:tool-1');
      expect(items.single.detail, 'git status');

      client.pending.clear();
      await changed('bash_approval.resolved');
      expect(await container.read(threadAttentionProvider.future), isEmpty);
      expect(
        container.read(threadListProvider).requireValue.first.status,
        'running',
      );
    },
  );

  test(
    'reconnect removes an approval resolved while the phone was offline',
    () async {
      final client = _ApprovalClient();
      client.pending['thread-1'] = {
        'toolUseId': 'tool-1',
        'threadId': 'thread-1',
      };
      final connection =
          StreamController<CenterServerConnectionStatus>.broadcast();
      final container = _container(client, connection: connection.stream);
      addTearDown(container.dispose);
      addTearDown(client.dispose);
      addTearDown(connection.close);
      final subscription = container.listen(threadAttentionProvider, (_, _) {});
      addTearDown(subscription.close);
      expect(
        await container.read(threadAttentionProvider.future),
        hasLength(1),
      );
      client.pending.clear();
      connection.add(
        const CenterServerConnectionStatus(state: EcoConnectionState.connected),
      );
      await Future<void>.delayed(Duration.zero);
      expect(await container.read(threadAttentionProvider.future), isEmpty);
    },
  );
}
