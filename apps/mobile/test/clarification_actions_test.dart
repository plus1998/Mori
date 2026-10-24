import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/providers/desktop_bind_ready.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final dismiss in [false, true]) {
    test(
      '${dismiss ? 'dismiss' : 'answer'} uses the current V2 history revision',
      () async {
        final client = _QuestionClient();
        final container = await _container(client);
        final notifier = container.read(
          threadSessionProvider('thread_1').notifier,
        );
        expect(
          container.read(threadSessionProvider('thread_1')).runProjection,
          isNull,
        );
        if (dismiss) {
          await notifier.dismissClarification('question_1');
        } else {
          await notifier.submitClarification(
            'question_1',
            [
              ['my own answer'],
            ],
            customInputIndices: [0],
          );
        }
        expect(client.resolutions.single['expectedHistoryRevision'], 7);
        expect(client.resolutions.single['toolUseId'], 'question_1');
        if (!dismiss) {
          expect(client.resolutions.single['customInputIndices'], [0]);
        }
        expect(
          container
              .read(threadSessionProvider('thread_1'))
              .pendingClarification,
          isNull,
        );
      },
    );
  }

  test(
    'unconfirmed delivery keeps the question and explicit retry identity',
    () async {
      final client = _QuestionClient()..unknownDelivery = true;
      final container = await _container(client);
      final notifier = container.read(
        threadSessionProvider('thread_1').notifier,
      );
      await expectLater(
        notifier.submitClarification('question_1', [
          ['custom answer'],
        ]),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'message',
            contains('未能确认送达'),
          ),
        ),
      );
      expect(
        container
            .read(threadSessionProvider('thread_1'))
            .pendingClarification
            ?.toolUseId,
        'question_1',
      );
      expect(client.resolutions, hasLength(1), reason: '不能自动重发回答');
      client.unknownDelivery = false;
      await notifier.submitClarification('question_1', [
        ['custom answer'],
      ]);
      expect(client.resolutions, hasLength(2));
      expect(
        client.resolutions[0]['clientCommandId'],
        client.resolutions[1]['clientCommandId'],
      );
      expect(
        container.read(threadSessionProvider('thread_1')).pendingClarification,
        isNull,
      );
    },
  );
}

Future<ProviderContainer> _container(_QuestionClient client) async {
  final container = ProviderContainer(
    overrides: [
      desktopRpcProvider.overrideWithValue(_QuestionRpc(client)),
      credentialsProvider.overrideWith(
        (_) async => const AppCredentials(supabaseUrl: '', userId: 'user_1'),
      ),
      connectionStatusProvider.overrideWith((_) => const Stream.empty()),
      ecoEventsProvider.overrideWith((_) => const Stream.empty()),
      desktopBindReadyOverrideProvider.overrideWithValue(true),
    ],
  );
  final subscription = container.listen(
    threadSessionProvider('thread_1'),
    (_, _) {},
  );
  addTearDown(() {
    subscription.close();
    container.dispose();
  });
  await container.read(credentialsProvider.future);
  for (var i = 0; i < 100; i++) {
    if (!container.read(threadSessionProvider('thread_1')).loading) {
      return container;
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('Session bootstrap did not complete.');
}

class _QuestionRpc extends DesktopRpc {
  _QuestionRpc(_QuestionClient client) : super(client, 'desktop_1');
  @override
  Future<ThreadSessionBootstrapResult> sessionBootstrap(
    String threadId,
  ) async => const ThreadSessionBootstrapResult(
    thread: ThreadSummary(
      id: 'thread_1',
      title: 'Question',
      prompt: '',
      workspacePath: '/tmp/test',
      status: 'running',
      createdAt: '',
      updatedAt: '',
      message: '',
    ),
    pendingClarification: ClarificationRequest(
      toolUseId: 'question_1',
      threadId: 'thread_1',
      questions: [
        ClarificationQuestion(question: 'Describe the issue', options: []),
      ],
    ),
  );
  @override
  Future<ComposerDraftRecord?> getComposerDraft(String contextKey) async =>
      null;
}

class _QuestionClient extends EcoCenterClient {
  _QuestionClient() : super(store: CredentialStore());
  final resolutions = <Map<String, dynamic>>[];
  bool unknownDelivery = false;

  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    if (channel == 'conversation:head') {
      return {
            'protocolVersion': 2,
            'storeEpoch': 'epoch_1',
            'conversationId': 'thread_1',
            'lastSeq': 10,
            'historyRevision': 7,
          }
          as T;
    }
    if (channel == 'clarification:submit' ||
        channel == 'clarification:dismiss') {
      final command = Map<String, dynamic>.from(args.single as Map);
      if (command['expectedHistoryRevision'] != 7) {
        throw StateError(
          'Conversation history changed before the command was accepted.',
        );
      }
      resolutions.add(command);
      return {
            'ok': true,
            if (unknownDelivery)
              'delivery': {'state': 'unknown', 'message': 'test interruption'},
          }
          as T;
    }
    if (channel == 'clarification:get-pending') return null as T;
    throw StateError('Unexpected test RPC: $channel');
  }
}
