import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/models/image_display_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/providers/desktop_bind_ready.dart';
import 'package:eco_mobile/core/storage/conversation_v2_cache.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/sync/conversation_v2_session.dart';
import 'package:eco_mobile/core/sync/conversation_v2_sync_engine.dart';
import 'package:eco_mobile/features/threads/image_display_provider.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'V2 display completion refreshes the shared list without legacy projection',
    () async {
      final session = _Session('thread');
      final other = _Session('other');
      final rpc = _Rpc();
      final container = ProviderContainer(
        overrides: [
          desktopRpcProvider.overrideWithValue(rpc),
          desktopBindReadyOverrideProvider.overrideWithValue(true),
          conversationV2SessionProvider('thread').overrideWith((_) => session),
          conversationV2SessionProvider('other').overrideWith((_) => other),
        ],
      );
      addTearDown(container.dispose);
      final provider = threadImageDisplayArtifactsProvider('thread');
      final subscription = container.listen(provider, (_, _) {});
      addTearDown(subscription.close);
      expect(await container.read(provider.future), isEmpty);
      expect(rpc.calls, ['thread']);

      rpc.artifacts['thread'] = [_artifact('image', 'thread')];
      session.emit(
        ConversationV2SessionState(
          tools: [_tool('display', 'mcp__eco_image_display__display_image', 2)],
        ),
      );
      expect((await container.read(provider.future)).single.id, 'image');
      expect(rpc.calls, ['thread', 'thread']);

      session.emit(
        ConversationV2SessionState(
          tools: [
            _tool('display', 'mcp__eco_image_display__display_image', 2),
            _tool('shell', 'exec_command', 3),
          ],
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(rpc.calls, [
        'thread',
        'thread',
      ], reason: 'Other streamed tools do not reload image files');

      final otherProvider = threadImageDisplayArtifactsProvider('other');
      final otherSubscription = container.listen(otherProvider, (_, _) {});
      addTearDown(otherSubscription.close);
      expect(await container.read(otherProvider.future), isEmpty);
      expect(container.read(provider).value!.single.threadId, 'thread');

      // Desktop returns newest first; the gallery's `last` must remain newest.
      rpc.artifacts['thread'] = [
        _artifact('after-reconnect', 'thread', at: '2026-10-23T10:00:00Z'),
        _artifact('older', 'thread', at: '2026-10-22T10:00:00Z'),
      ];
      session.emit(
        ConversationV2SessionState(
          syncState: ConversationV2SyncState.live,
          tools: [_tool('display', 'mcp__eco_image_display__display_image', 2)],
        ),
      );
      expect((await container.read(provider.future)).map((image) => image.id), [
        'older',
        'after-reconnect',
      ]);
      expect(container.read(otherProvider).value, isEmpty);
    },
  );

  test(
    'an artifact-list failure remains an error rather than a successful empty list',
    () async {
      final rpc = _Rpc()..error = StateError('Desktop image list unavailable');
      final container = ProviderContainer(
        overrides: [
          desktopRpcProvider.overrideWithValue(rpc),
          desktopBindReadyOverrideProvider.overrideWithValue(true),
          conversationV2SessionProvider(
            'thread',
          ).overrideWith((_) => _Session('thread')),
        ],
      );
      addTearDown(container.dispose);
      final provider = threadImageDisplayArtifactsProvider('thread');
      final subscription = container.listen(provider, (_, _) {});
      addTearDown(subscription.close);
      await expectLater(container.read(provider.future), throwsStateError);
      expect(container.read(provider).hasError, isTrue);
    },
  );
}

ImageDisplayArtifact _artifact(String id, String thread, {String at = ''}) =>
    ImageDisplayArtifact(
      id: id,
      threadId: thread,
      status: 'completed',
      sourceKind: 'path',
      mimeType: 'image/png',
      filePath: '/desktop/$id.png',
      bytes: 1,
      createdAt: at,
      updatedAt: '',
    );

ConversationV2Tool _tool(String id, String name, int version) =>
    ConversationV2Tool(
      toolCallId: id,
      conversationId: 'thread',
      runId: 'run',
      name: name,
      status: 'completed',
      createdSeq: version,
      versionSeq: version,
    );

class _Session extends ConversationV2SessionController {
  _Session(String id)
    : super(
        conversationId: id,
        cache: ConversationV2Cache(
          accountId: 'test',
          desktopDeviceId: 'desktop',
        ),
        remote: _UnusedRemote(),
        enabled: false,
      );
  void emit(ConversationV2SessionState next) => state = next;
}

class _UnusedRemote implements ConversationV2Remote {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _Rpc extends DesktopRpc {
  _Rpc() : super(EcoCenterClient(store: CredentialStore()), 'desktop');
  final artifacts = <String, List<ImageDisplayArtifact>>{};
  final calls = <String>[];
  Object? error;

  @override
  Future<List<ImageDisplayArtifact>> listImageDisplayArtifacts(
    String threadId,
  ) async {
    calls.add(threadId);
    if (error != null) throw error!;
    return artifacts[threadId] ?? const [];
  }
}
