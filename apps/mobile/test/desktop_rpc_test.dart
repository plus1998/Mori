import 'dart:convert';
import 'dart:typed_data';

import 'package:eco_mobile/core/models/image_view_models.dart';
import 'package:eco_mobile/core/models/project_orchestration_settings.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/storage/conversation_v2_cache.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'each Stop cancels again after resume at the same history revision',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');
      await rpc.cancelThread('thr_1');
      final first = Map<String, dynamic>.from(client.args!.first as Map);
      await rpc.cancelThread('thr_1');
      final second = client.args!.first as Map<String, dynamic>;
      expect(client.channel, 'thread:cancel');
      expect(first['expectedHistoryRevision'], 0);
      expect(second['expectedHistoryRevision'], 0);
      expect(second['clientCommandId'], isNot(first['clientCommandId']));
    },
  );

  test(
    'conversation V2 RPC preserves every route and paging envelope',
    () async {
      final client = _ConversationV2EcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      final capabilities = await rpc.conversationV2Capabilities();
      expect(capabilities.storeEpoch, 'epoch_1');
      expect(client.lastCall?.channel, 'conversation:capabilities');
      expect(client.lastCall?.args, isEmpty);

      final bootstrap = await rpc.conversationV2Bootstrap(
        'thread_1',
        pageSize: 17,
        maxBytes: 4096,
      );
      expect(bootstrap.snapshotSeq, 8);
      expect(client.lastCall?.channel, 'conversation:bootstrap');
      expect(client.lastCall?.args, const [
        {'conversationId': 'thread_1', 'pageSize': 17, 'maxBytes': 4096},
      ]);

      final extras = await rpc.conversationV2Projection('thread_1');
      expect(extras.requestSpans.single.requestId, 'request_1');
      expect(extras.subagentTimings.single.agentId, 'agent_1');
      expect(extras.billing?.inputTokens, 11);
      expect(extras.context?.occupied, 42);
      expect(client.lastCall?.channel, 'conversation:projection');
      expect(client.lastCall?.args, const [
        {'conversationId': 'thread_1'},
      ]);

      final messages = await rpc.conversationV2MessagesPage(
        'thread_1',
        beforeCursor: 'cursor_before',
        limit: 11,
        maxBytes: 2048,
      );
      expect(messages.readSeq, 8);
      expect(client.lastCall?.channel, 'conversation:messages-page');
      expect(client.lastCall?.args, const [
        {
          'conversationId': 'thread_1',
          'beforeCursor': 'cursor_before',
          'limit': 11,
          'maxBytes': 2048,
        },
      ]);

      final details = await rpc.conversationV2DetailsPage(
        'thread_1',
        'run_1',
        cursor: 'detail_cursor',
        toolCallId: 'tool_1',
        agentInstanceId: 'agent_instance_1',
        limit: 13,
        maxBytes: 1024,
      );
      expect(details.items.single.toJson(), {
        'itemId': 'detail_1',
        'conversationId': 'thread_1',
        'runId': 'run_1',
        'agentId': 'agent_role_1',
        'agentInstanceId': 'agent_instance_1',
        'parentAgentInstanceId': 'parent_instance_1',
        'parentAgentId': 'parent_role_1',
        'parentToolCallId': 'parent_tool_1',
        'toolCallId': 'tool_1',
        'type': 'tool.output',
        'createdSeq': 7,
        'versionSeq': 8,
        'content': '',
        'ref': '',
      });
      expect(client.lastCall?.channel, 'conversation:details-page');
      expect(client.lastCall?.args, const [
        {
          'conversationId': 'thread_1',
          'runId': 'run_1',
          'cursor': 'detail_cursor',
          'toolCallId': 'tool_1',
          'agentInstanceId': 'agent_instance_1',
          'limit': 13,
          'maxBytes': 1024,
        },
      ]);

      final tools = await rpc.conversationV2ToolsPage(
        'thread_1',
        'run_1',
        cursor: 'tool_cursor',
        toolCallId: 'tool_1',
        agentInstanceId: 'agent_instance_1',
        limit: 7,
        maxBytes: 1536,
      );
      expect(tools.totalCount, 1);
      expect(tools.tools.single.toolCallId, 'tool_1');
      expect(client.lastCall?.channel, 'conversation:tools-page');
      expect(client.lastCall?.args, const [
        {
          'conversationId': 'thread_1',
          'runId': 'run_1',
          'cursor': 'tool_cursor',
          'toolCallId': 'tool_1',
          'agentInstanceId': 'agent_instance_1',
          'limit': 7,
          'maxBytes': 1536,
        },
      ]);

      final head = await rpc.conversationV2Head('thread_1');
      expect(head.lastSeq, 8);
      expect(client.lastCall?.channel, 'conversation:head');
      expect(client.lastCall?.args, const ['thread_1']);

      final sync = await rpc.conversationV2Sync(
        'thread_1',
        'epoch_1',
        4,
        throughSeq: 8,
        maxEvents: 23,
        maxBytes: 8192,
      );
      expect(sync.throughSeq, 8);
      expect(client.lastCall?.channel, 'conversation:sync');
      expect(client.lastCall?.args, const [
        {
          'conversationId': 'thread_1',
          'storeEpoch': 'epoch_1',
          'afterSeq': 4,
          'throughSeq': 8,
          'maxEvents': 23,
          'maxBytes': 8192,
        },
      ]);
    },
  );

  test(
    'conversation V2 send forwards the complete idempotent command envelope',
    () async {
      final client = _ConversationV2EcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      final result = await rpc.conversationV2SendMessage(
        principalId: 'user_1',
        conversationId: 'thread_1',
        clientCommandId: 'command_1',
        text: 'hello',
        turnId: 'turn_1',
        messageId: 'message_1',
        attachments: const [
          {'mediaType': 'image/png', 'path': '/tmp/image.png'},
        ],
      );

      expect(result, {
        'protocolVersion': 2,
        'conversationId': 'thread_1',
        'clientCommandId': 'command_1',
        'messageId': 'message_1',
        'turnId': 'turn_1',
        'acceptedSeq': 9,
        'status': 'accepted',
      });
      expect(client.lastCall?.channel, 'conversation:send-message');
      expect(client.lastCall?.args, const [
        {
          'principalId': 'user_1',
          'conversationId': 'thread_1',
          'clientCommandId': 'command_1',
          'text': 'hello',
          'turnId': 'turn_1',
          'messageId': 'message_1',
          'attachments': [
            {'mediaType': 'image/png', 'path': '/tmp/image.png'},
          ],
        },
      ]);
    },
  );

  test(
    'thread delete retries the same complete command envelope without rereading head',
    () async {
      final store = _MemoryThreadDeleteCommandStore();
      final firstClient = _ThreadDeleteEcoCenterClient(failFirstDelete: true);
      final firstRpc = DesktopRpc(
        firstClient,
        'desktop_1',
        threadDeleteCommandStore: store,
      );

      await expectLater(firstRpc.deleteThread('thread_1'), throwsStateError);
      final firstDelete = firstClient.deleteCalls.single;
      expect(firstClient.headCalls, 1);
      expect(await store.pendingThreadDelete('thread_1'), isNotNull);

      final restartedClient = _ThreadDeleteEcoCenterClient();
      final restartedRpc = DesktopRpc(
        restartedClient,
        'desktop_1',
        threadDeleteCommandStore: store,
      );
      await restartedRpc.deleteThread('thread_1');

      expect(restartedClient.headCalls, 0);
      expect(restartedClient.deleteCalls.single, firstDelete);
      expect(await store.pendingThreadDelete('thread_1'), isNull);
      expect(firstDelete, {
        'principalId': 'user_1',
        'clientCommandId': startsWith('thread_delete_'),
        'threadId': 'thread_1',
        'expectedHistoryRevision': 4,
      });

      await restartedRpc.deleteThread('thread_1');
      expect(restartedClient.headCalls, 1);
      expect(restartedClient.deleteCalls, hasLength(2));
    },
  );

  test(
    'thread delete fails before reading head when principal is missing',
    () async {
      final client = _ThreadDeleteEcoCenterClient(userId: null);
      final rpc = DesktopRpc(client, 'desktop_1');

      await expectLater(rpc.deleteThread('thread_1'), throwsStateError);

      expect(client.headCalls, 0);
      expect(client.deleteCalls, isEmpty);
    },
  );

  test(
    'clarification resolution forwards the complete command envelope',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      await rpc.submitClarification(
        principalId: 'user_1',
        clientCommandId: 'clarification_submit_1',
        threadId: 'thread_1',
        toolUseId: 'tool_1',
        selections: const [
          ['A'],
        ],
        expectedHistoryRevision: 7,
      );
      expect(client.channel, 'clarification:submit');
      expect(client.args, const [
        {
          'principalId': 'user_1',
          'clientCommandId': 'clarification_submit_1',
          'threadId': 'thread_1',
          'toolUseId': 'tool_1',
          'selections': [
            ['A'],
          ],
          'expectedHistoryRevision': 7,
        },
      ]);

      await rpc.dismissClarification(
        principalId: 'user_1',
        clientCommandId: 'clarification_dismiss_1',
        threadId: 'thread_1',
        toolUseId: 'tool_1',
        expectedHistoryRevision: 7,
      );
      expect(client.channel, 'clarification:dismiss');
      expect(client.args, const [
        {
          'principalId': 'user_1',
          'clientCommandId': 'clarification_dismiss_1',
          'threadId': 'thread_1',
          'toolUseId': 'tool_1',
          'expectedHistoryRevision': 7,
        },
      ]);
    },
  );

  test(
    'Bash approval resolution forwards the complete command envelope',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      await rpc.resolveBashApproval(
        principalId: 'user_1',
        clientCommandId: 'approval_1',
        threadId: 'thread_1',
        toolUseId: 'tool_1',
        decision: 'approved_for_session',
        feedback: '  proceed  ',
        expectedHistoryRevision: 9,
      );

      expect(client.channel, 'bash-approval:resolve');
      expect(client.args, const [
        {
          'principalId': 'user_1',
          'clientCommandId': 'approval_1',
          'threadId': 'thread_1',
          'toolUseId': 'tool_1',
          'decision': 'approved_for_session',
          'feedback': 'proceed',
          'expectedHistoryRevision': 9,
        },
      ]);
    },
  );

  test('plan resolution forwards the complete command envelope', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    await rpc.approvePlan(
      principalId: 'user_1',
      clientCommandId: 'plan_approve_1',
      threadId: 'thread_1',
      expectedHistoryRevision: 11,
    );
    expect(client.channel, 'thread:approve-plan');
    expect(client.args, const [
      {
        'principalId': 'user_1',
        'clientCommandId': 'plan_approve_1',
        'threadId': 'thread_1',
        'expectedHistoryRevision': 11,
      },
    ]);

    await rpc.dismissPlan(
      principalId: 'user_1',
      clientCommandId: 'plan_dismiss_1',
      threadId: 'thread_1',
      expectedHistoryRevision: 12,
    );
    expect(client.channel, 'thread:dismiss-plan');
    expect(client.args, const [
      {
        'principalId': 'user_1',
        'clientCommandId': 'plan_dismiss_1',
        'threadId': 'thread_1',
        'expectedHistoryRevision': 12,
      },
    ]);
  });

  test('startThread forwards the ACP Harness', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');
    const runtimeConfig = ThreadRuntimeConfig(
      subagentEnabled: {},
      sessionMode: 'agent',
      bashReviewMode: 'always',
    );

    await rpc.startThread(
      workspacePath: '/repo',
      prompt: 'Use ACP',
      coreKind: 'acp',
      runtimeConfig: runtimeConfig,
    );

    expect(client.channel, 'thread:start');
    expect(client.args, [
      {
        'workspacePath': '/repo',
        'prompt': 'Use ACP',
        'coreKind': 'acp',
        'runtimeConfig': runtimeConfig.toJson(),
      },
    ]);
  });

  test(
    'loads the initial thread page without requesting the full list',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      final result = await rpc.listInitialThreads();

      expect(client.channel, 'thread:list-initial');
      expect(client.args, isEmpty);
      expect(result.threads.single.id, 'thr_1');
      expect(result.pages['/repo']?.hasMore, isTrue);
      expect(result.pages['/repo']?.nextCursor?.id, 'thr_1');
    },
  );

  test('loads more threads with a workspace cursor', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');
    const cursor = ThreadListCursor(
      updatedAt: '2026-01-02T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      id: 'thr_1',
    );

    final result = await rpc.listMoreThreads(
      workspacePath: '/repo',
      cursor: cursor,
    );

    expect(client.channel, 'thread:list-more');
    expect(client.args, [
      {'workspacePath': '/repo', 'cursor': cursor.toJson(), 'limit': 20},
    ]);
    expect(result.threads.single.id, 'thr_2');
    expect(result.hasMore, isFalse);
  });

  test('gets and conditionally deletes a composer recovery draft', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    final draft = await rpc.getComposerDraft('thread:thr_1');

    expect(client.channel, 'composer-draft:get');
    expect(client.args, ['thread:thr_1']);
    expect(draft?.prompt, 'restore this');
    expect(draft?.revision, 'revision_1');
    expect(draft?.recoveryReason, 'Cursor session failed');
    expect(draft?.attachments.single.mediaType, 'image/png');

    final deleted = await rpc.deleteComposerDraft(
      contextKey: 'thread:thr_1',
      expectedRevision: 'revision_1',
    );
    expect(deleted, isTrue);
    expect(client.channel, 'composer-draft:delete');
    expect(client.args, [
      {'contextKey': 'thread:thr_1', 'expectedRevision': 'revision_1'},
    ]);
  });

  test('listCursorModels uses the dedicated Cursor CLI channel', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    final models = await rpc.listCursorModels();

    expect(client.desktopDeviceId, 'desktop_1');
    expect(client.channel, 'cursor:models-list');
    expect(client.args, isEmpty);
    expect(models, hasLength(2));
    expect(models.first.id, 'auto');
    expect(models.first.displayName, 'Auto');
    expect(models.first.current, isTrue);
    expect(models.first.isDefault, isTrue);
    expect(models.last.id, 'gpt-5.3-codex');
    expect(models.last.displayName, 'Codex 5.3');
  });

  test(
    'loads a user message edit capability with the stable activity id',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      final result = await rpc.getUserMessageEdit(
        threadId: 'thr_1',
        activityLineId: 'activity_1',
      );

      expect(client.channel, 'thread:user-message-edit-get');
      expect(client.args, [
        {'threadId': 'thr_1', 'activityLineId': 'activity_1'},
      ]);
      expect(result.capability.isReady, isTrue);
      expect(result.text, 'original prompt');
      expect(result.attachments.single.mediaType, 'image/png');
      expect(result.historyRevision, 7);
    },
  );

  test(
    'rewrites a user message without dropping an explicit empty attachment list',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      final thread = await rpc.rewriteThreadFromMessage(
        principalId: 'user_1',
        clientCommandId: 'history_rewrite_1',
        threadId: 'thr_1',
        activityLineId: 'activity_1',
        prompt: 'replacement',
        attachments: const [],
        expectedHistoryRevision: 7,
      );

      expect(client.channel, 'thread:rewrite-from-message');
      expect(client.args, [
        {
          'principalId': 'user_1',
          'clientCommandId': 'history_rewrite_1',
          'threadId': 'thr_1',
          'activityLineId': 'activity_1',
          'prompt': 'replacement',
          'attachments': [],
          'expectedHistoryRevision': 7,
        },
      ]);
      expect(thread.id, 'thr_1');
    },
  );

  test('retries a failed request with the V2 command envelope', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    final thread = await rpc.retryThreadFromMessage(
      principalId: 'user_1',
      clientCommandId: 'history_retry_1',
      threadId: 'thr_1',
      activityLineId: 'activity_1',
      prompt: 'retry prompt',
      hasImages: true,
      expectedHistoryRevision: 7,
    );

    expect(client.channel, 'thread:retry-from-message');
    expect(client.args, [
      {
        'principalId': 'user_1',
        'clientCommandId': 'history_retry_1',
        'threadId': 'thr_1',
        'prompt': 'retry prompt',
        'expectedHistoryRevision': 7,
        'activityLineId': 'activity_1',
        'hasImages': true,
      },
    ]);
    expect(thread.id, 'thr_1');
  });

  test('reads an approved plan through desktop RPC', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    final plan = await rpc.getApprovedPlan('thr_1');

    expect(client.channel, 'thread:get-approved-plan');
    expect(client.args, ['thr_1']);
    expect(plan?.plan, '1. Implement the plan');
  });

  test('reads ASR status and transcribes through desktop RPC', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    final status = await rpc.getAsrStatus();
    expect(status.configured, isTrue);
    expect(status.activeProfileId, 'profile_primary');
    expect(status.activeProfileName, 'Primary ASR');
    expect(client.channel, 'asr-settings:get-status');
    expect(client.args, isEmpty);

    final text = await rpc.transcribeAsr(
      audioWavBase64: 'UklGRg==',
      profileId: 'profile_primary',
    );
    expect(text, 'hello');
    expect(client.channel, 'asr:transcribe');
    expect(client.args, [
      {'audioWavBase64': 'UklGRg==', 'profileId': 'profile_primary'},
    ]);
    expect(client.deadlineMs, 240000);
  });

  test('reads image view data through desktop RPC', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    final image = await rpc.readImageView('/tmp/preview.png');

    expect(client.desktopDeviceId, 'desktop_1');
    expect(client.channel, 'image-view:read');
    expect(client.args, [
      {'path': '/tmp/preview.png'},
    ]);
    expect(image.bytes, [1, 2, 3]);
    expect(image.mimeType, 'image/png');
    expect(image.path, '/tmp/preview.png');
    expect(image.fileName, 'preview.png');
    expect(image.byteLength, 3);
    expect(image.width, 2);
    expect(image.height, 1);
  });

  test(
    'maps image view failures and rejects inconsistent byte counts',
    () async {
      final failureClient = _RecordingEcoCenterClient()
        ..imageViewResponse = {'ok': false, 'code': 'too_large'};
      final failureRpc = DesktopRpc(failureClient, 'desktop_1');

      await expectLater(
        failureRpc.readImageView('/tmp/large.png'),
        throwsA(
          isA<ImageViewReadException>().having(
            (error) => error.code,
            'code',
            ImageViewReadFailureCode.tooLarge,
          ),
        ),
      );

      final invalidClient = _RecordingEcoCenterClient()
        ..imageViewResponse = {
          'ok': true,
          'dataBase64': base64Encode(const [1, 2, 3]),
          'mimeType': 'image/png',
          'path': '/tmp/preview.png',
          'fileName': 'preview.png',
          'bytes': 4,
          'width': 2,
          'height': 1,
        };
      final invalidRpc = DesktopRpc(invalidClient, 'desktop_1');

      await expectLater(
        invalidRpc.readImageView('/tmp/preview.png'),
        throwsA(
          isA<ImageViewReadException>().having(
            (error) => error.code,
            'code',
            ImageViewReadFailureCode.invalidResponse,
          ),
        ),
      );
    },
  );

  test('getBackgroundTerminalTask parses task progress', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    final task = await rpc.getBackgroundTerminalTask('task_1');

    expect(client.channel, 'background-terminal:open');
    expect(client.args, [
      {'taskId': 'task_1'},
    ]);
    expect(task.status, 'running');
    expect(task.output, 'building...');
    expect(task.isActive, isTrue);
  });

  test('stopBackgroundTerminalTask sends task id', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    await rpc.stopBackgroundTerminalTask('task_1');

    expect(client.channel, 'background-terminal:stop');
    expect(client.args, [
      {'taskId': 'task_1'},
    ]);
  });

  test('listCommitModelOptions sends main agent config id', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    await rpc.listCommitModelOptions(mainAgentConfigId: 'main_1');

    expect(client.channel, 'git:list-commit-model-options');
    expect(client.args, [
      {'mainAgentConfigId': 'main_1'},
    ]);
  });

  test(
    'listCommitModelOptions omits main agent config id when absent',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      await rpc.listCommitModelOptions();

      expect(client.channel, 'git:list-commit-model-options');
      expect(client.args, [{}]);
    },
  );

  test('saveCommitModelPreference sends main agent config id', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    await rpc.saveCommitModelPreference(
      candidateModelId: 'candidate_1',
      mainAgentConfigId: 'main_1',
    );

    expect(client.channel, 'git:save-commit-model-preference');
    expect(client.args, [
      {'candidateModelId': 'candidate_1', 'mainAgentConfigId': 'main_1'},
    ]);
  });

  test(
    'saveCommitModelPreference omits main agent config id when absent',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      await rpc.saveCommitModelPreference(candidateModelId: 'candidate_1');

      expect(client.channel, 'git:save-commit-model-preference');
      expect(client.args, [
        {'candidateModelId': 'candidate_1'},
      ]);
    },
  );

  test('generateCommitMessage sends main agent config id', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    await rpc.generateCommitMessage(
      workspacePath: '/repo',
      mainAgentConfigId: 'main_1',
      candidateModelId: 'candidate_1',
    );

    expect(client.channel, 'git:generate-commit-message');
    expect(client.args, [
      {
        'workspacePath': '/repo',
        'mainAgentConfigId': 'main_1',
        'includeUnstaged': true,
        'candidateModelId': 'candidate_1',
      },
    ]);
  });

  test(
    'generateCommitMessage omits main agent config id when absent',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      await rpc.generateCommitMessage(
        workspacePath: '/repo',
        candidateModelId: 'candidate_1',
      );

      expect(client.channel, 'git:generate-commit-message');
      expect(client.args, [
        {
          'workspacePath': '/repo',
          'includeUnstaged': true,
          'candidateModelId': 'candidate_1',
        },
      ]);
    },
  );

  test('commitChanges sends main agent config id', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    await rpc.commitChanges(
      workspacePath: '/repo',
      mainAgentConfigId: 'main_1',
      includeUnstaged: false,
      message: 'feat: compose orchestration',
    );

    expect(client.channel, 'git:commit');
    expect(client.args, [
      {
        'workspacePath': '/repo',
        'mainAgentConfigId': 'main_1',
        'includeUnstaged': false,
        'message': 'feat: compose orchestration',
      },
    ]);
  });

  test('commitChanges with a message omits main agent config id', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    await rpc.commitChanges(
      workspacePath: '/repo',
      includeUnstaged: false,
      message: 'feat: typed commit message',
    );

    expect(client.channel, 'git:commit');
    expect(client.args, [
      {
        'workspacePath': '/repo',
        'includeUnstaged': false,
        'message': 'feat: typed commit message',
      },
    ]);
  });

  test('getProjectOrchestrationSettings sends workspace path', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    final settings = await rpc.getProjectOrchestrationSettings('/repo');

    expect(client.channel, 'project-orchestration-settings:get');
    expect(client.args, ['/repo']);
    expect(settings.workspacePath, '/repo');
    expect(settings.orchestrationSelection?.mainAgentConfigId, 'main_1');
  });

  test('saveProjectOrchestrationSettings sends complete selection', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');
    const selection = OrchestrationSelection(
      mainAgentConfigId: 'main_1',
      mainPrompt: BuiltinMainAgentPromptSelection(),
      subagents: NoneSubagentSelection(),
    );

    await rpc.saveProjectOrchestrationSettings(
      const ProjectOrchestrationSettingsSnapshot(
        workspacePath: '/repo',
        orchestrationSelection: selection,
      ),
    );

    expect(client.channel, 'project-orchestration-settings:save');
    expect(client.args, [
      {'workspacePath': '/repo', 'orchestrationSelection': selection.toJson()},
    ]);
  });

  test(
    'each repeated queue action has a fresh command id at an unchanged history revision',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');
      for (final action in <Future<void> Function()>[
        () async {
          await rpc.followUpSetEditing(threadId: 'thr_1', followUpId: 'fup_1');
        },
        () async {
          await rpc.followUpSetEditing(threadId: 'thr_1');
        },
        () => rpc.followUpEnqueue(threadId: 'thr_1', prompt: 'same prompt'),
        () => rpc.followUpUpdate(
          threadId: 'thr_1',
          followUpId: 'fup_1',
          prompt: 'same prompt',
        ),
        () => rpc.followUpEscalate(threadId: 'thr_1', followUpId: 'fup_1'),
        () => rpc.followUpCancel(threadId: 'thr_1', followUpId: 'fup_1'),
        () async {
          await rpc.followUpSetQueuePaused(threadId: 'thr_1', paused: true);
        },
        () async {
          await rpc.followUpSetQueuePaused(threadId: 'thr_1', paused: false);
        },
        () async {
          await rpc.followUpReorder(threadId: 'thr_1', followUpIds: ['fup_1']);
        },
      ]) {
        await action();
        final first = Map<String, dynamic>.from(
          client.args!.single as Map<String, dynamic>,
        );
        await action();
        final second = client.args!.single as Map<String, dynamic>;
        expect(second['clientCommandId'], isNot(first['clientCommandId']));
        expect(
          second['expectedHistoryRevision'],
          first['expectedHistoryRevision'],
        );
      }
    },
  );

  test(
    'followUpEnqueue forwards per-message mode and omits default override',
    () async {
      final client = _RecordingEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');
      for (final mode in [null, ...FollowUpDeliveryMode.values]) {
        await rpc.followUpEnqueue(
          threadId: 'thr_1',
          prompt: 'next message',
          deliveryMode: mode,
        );
        expect(client.channel, 'thread:follow-up-enqueue');
        final request = client.args!.single as Map<String, dynamic>;
        if (mode == null) {
          expect(request.containsKey('followUpDeliveryMode'), isFalse);
        } else {
          expect(request['followUpDeliveryMode'], mode.name);
        }
      }
    },
  );

  test('followUpSetEditing forwards acquire and release payloads', () async {
    final client = _RecordingEcoCenterClient();
    final rpc = DesktopRpc(client, 'desktop_1');

    final acquired = await rpc.followUpSetEditing(
      threadId: 'thr_1',
      followUpId: 'fup_1',
    );

    expect(acquired, isTrue);
    expect(client.channel, 'thread:follow-up-editing');
    expect(client.args, [
      {
        'principalId': 'user_1',
        'clientCommandId': startsWith('command_editing-acquire_'),
        'threadId': 'thr_1',
        'followUpId': 'fup_1',
        'expectedHistoryRevision': 0,
      },
    ]);

    final released = await rpc.followUpSetEditing(threadId: 'thr_1');

    expect(released, isFalse);
    expect(client.args, [
      {
        'principalId': 'user_1',
        'clientCommandId': startsWith('command_editing-release_'),
        'threadId': 'thr_1',
        'expectedHistoryRevision': 0,
      },
    ]);
  });

  test(
    'uploadPromptImageChunked stages bytes with resume and progress',
    () async {
      final client = _ChunkedUploadEcoCenterClient(failFirstChunkOnce: true);
      final rpc = DesktopRpc(client, 'desktop_1');
      final bytes = Uint8List.fromList(
        List<int>.generate(90 * 1024, (i) => i % 256),
      );
      final progress = <(int, int)>[];

      final path = await rpc.uploadPromptImageChunked(
        contextKey: 'thread:thr_1',
        imageId: 'img_1',
        mediaType: 'image/png',
        bytes: bytes,
        onProgress: (sent, total) => progress.add((sent, total)),
      );

      expect(path, endsWith('img_1.png'));
      expect(client.channels, contains('prompt-image:upload-begin'));
      expect(client.channels, contains('prompt-image:upload-chunk'));
      expect(client.channels, contains('prompt-image:upload-finish'));
      expect(
        client.chunkAttempts,
        greaterThan(1),
      ); // retried after forced failure
      expect(progress.first.$1, 0);
      expect(progress.last, (bytes.length, bytes.length));
      expect(client.assembled, bytes);
    },
  );

  test(
    'downloadPromptImage forwards the context key with the durable reference',
    () async {
      final client = _PromptImageDownloadEcoCenterClient();
      final rpc = DesktopRpc(client, 'desktop_1');

      final bytes = await rpc.downloadPromptImage(
        contextKey: 'thread:thr_1',
        contentRef:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mediaType: 'image/png',
      );

      expect(bytes, [1, 2, 3]);
      expect(client.args, [
        {
          'contextKey': 'thread:thr_1',
          'contentRef':
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'mediaType': 'image/png',
          'offset': 0,
          'maxBytes': 64 * 1024,
        },
      ]);
    },
  );
}

class _RecordingEcoCenterClient extends EcoCenterClient {
  _RecordingEcoCenterClient() : super(store: CredentialStore());

  String? desktopDeviceId;
  String? channel;
  List<dynamic>? args;
  int? deadlineMs;
  Object? imageViewResponse;

  @override
  AppCredentials get credentials =>
      AppCredentials(supabaseUrl: '', userId: 'user_1');

  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    this.desktopDeviceId = desktopDeviceId;
    this.channel = channel;
    this.args = args;
    this.deadlineMs = deadlineMs;
    if (channel == 'conversation:head') {
      return {
            'protocolVersion': 2,
            'storeEpoch': 'epoch_1',
            'conversationId': 'thr_1',
            'lastSeq': 8,
            'historyRevision': 0,
          }
          as T;
    }
    if (channel == 'composer-draft:get') {
      return {
            'contextKey': 'thread:thr_1',
            'prompt': 'restore this',
            'attachments': [
              {'mediaType': 'image/png', 'data': 'AQI='},
            ],
            'recoveryReason': 'Cursor session failed',
            'revision': 'revision_1',
            'updatedAt': '2026-08-22T00:00:00.000Z',
          }
          as T;
    }
    if (channel == 'thread:follow-up-queue-paused') {
      final payload = args.first as Map<String, dynamic>;
      return {
            'paused': payload['paused'],
            'thread': {
              'id': 'thr_1',
              'title': 'Thread',
              'prompt': '',
              'workspacePath': '/repo',
              'status': 'completed',
              'createdAt': '2026-10-05T09:39:00.000Z',
              'updatedAt': '2026-10-05T09:42:00.000Z',
              'followUpQueuePaused': payload['paused'],
            },
          }
          as T;
    }
    if (channel == 'thread:follow-up-editing') {
      final payload = args.first as Map<String, dynamic>;
      return {'editing': payload.containsKey('followUpId')} as T;
    }
    if (channel == 'thread:list-initial') {
      return {
            'threads': [
              {
                'id': 'thr_1',
                'title': 'Thread 1',
                'prompt': 'prompt',
                'workspacePath': '/repo',
                'status': 'idle',
                'createdAt': '2026-01-01T00:00:00.000Z',
                'updatedAt': '2026-01-02T00:00:00.000Z',
                'message': '',
              },
            ],
            'pages': {
              '/repo': {
                'hasMore': true,
                'totalCount': 2,
                'nextCursor': {
                  'updatedAt': '2026-01-02T00:00:00.000Z',
                  'createdAt': '2026-01-01T00:00:00.000Z',
                  'id': 'thr_1',
                },
              },
            },
          }
          as T;
    }
    if (channel == 'thread:list-more') {
      return {
            'threads': [
              {
                'id': 'thr_2',
                'title': 'Thread 2',
                'prompt': 'prompt',
                'workspacePath': '/repo',
                'status': 'idle',
                'createdAt': '2026-01-03T00:00:00.000Z',
                'updatedAt': '2026-01-04T00:00:00.000Z',
                'message': '',
              },
            ],
            'hasMore': false,
            'totalCount': 2,
          }
          as T;
    }
    if (channel == 'composer-draft:delete') {
      return {'ok': true, 'deleted': true} as T;
    }
    if (channel == 'cursor:models-list') {
      return [
            {
              'id': 'auto',
              'displayName': 'Auto',
              'current': true,
              'default': true,
            },
            {
              'id': 'gpt-5.3-codex',
              'displayName': 'Codex 5.3',
              'current': false,
              'default': false,
            },
          ]
          as T;
    }
    if (channel == 'thread:user-message-edit-get') {
      return {
            'threadId': 'thr_1',
            'activityLineId': 'activity_1',
            'text': 'original prompt',
            'attachments': [
              {'mediaType': 'image/png', 'data': 'AQI='},
            ],
            'historyRevision': 7,
            'capability': {'status': 'ready'},
          }
          as T;
    }
    if (channel == 'thread:rewrite-from-message') {
      return {
            'thread': {
              'id': 'thr_1',
              'title': 'Thread',
              'prompt': 'replacement',
              'workspacePath': '/tmp/project',
              'status': 'running',
              'createdAt': '2026-01-01T00:00:00.000Z',
              'updatedAt': '2026-01-01T00:00:00.000Z',
              'message': 'running',
            },
          }
          as T;
    }
    if (channel == 'thread:retry-from-message') {
      return {
            'thread': {
              'id': 'thr_1',
              'title': 'Thread',
              'prompt': 'retry prompt',
              'workspacePath': '/tmp/project',
              'status': 'running',
              'createdAt': '2026-01-01T00:00:00.000Z',
              'updatedAt': '2026-01-01T00:00:00.000Z',
              'message': 'running',
            },
          }
          as T;
    }
    if (channel == 'thread:get-approved-plan') {
      return {
            'threadId': 'thr_1',
            'userPrompt': 'Implement feature',
            'analysis': '',
            'plan': '1. Implement the plan',
            'workspacePath': '/tmp/project',
            'worktreePath': '/tmp/project',
          }
          as T;
    }
    if (channel == 'asr-settings:get-status') {
      return {
            'hasApiKey': true,
            'apiKeyEncryptionAvailable': true,
            'model': 'qwen3-asr-flash-2026-xx',
            'activeProfileId': 'profile_primary',
            'activeProfileName': 'Primary ASR',
          }
          as T;
    }
    if (channel == 'asr:transcribe') {
      return {'text': ' hello '} as T;
    }
    if (channel == 'image-view:read') {
      return (imageViewResponse ??
              {
                'ok': true,
                'dataBase64': base64Encode(const [1, 2, 3]),
                'mimeType': 'image/png',
                'path': '/tmp/preview.png',
                'fileName': 'preview.png',
                'bytes': 3,
                'width': 2,
                'height': 1,
              })
          as T;
    }
    if (channel == 'background-terminal:open') {
      return {
            'taskId': 'task_1',
            'sessionId': 'session_1',
            'status': 'running',
            'command': ['npm', 'run', 'build'],
            'output': 'building...',
          }
          as T;
    }
    if (channel == 'background-terminal:stop') {
      return {'stopped': true} as T;
    }
    if (channel == 'git:list-commit-model-options') {
      return {'options': [], 'savedCandidateModelId': 'auto'} as T;
    }
    if (channel == 'git:generate-commit-message') {
      return {
            'message': 'feat: compose orchestration',
            'candidateModelId': 'candidate_1',
            'modelId': 'model_1',
            'providerName': 'Provider',
          }
          as T;
    }
    if (channel == 'git:commit') {
      return {
            'commitSha': 'abc123',
            'message': 'feat: compose orchestration',
            'generated': false,
          }
          as T;
    }
    if (channel.startsWith('project-orchestration-settings:')) {
      return {
            'workspacePath': '/repo',
            'orchestrationSelection': {
              'mainAgentConfigId': 'main_1',
              'mainPrompt': {'mode': 'builtin'},
              'subagents': {'mode': 'none'},
            },
          }
          as T;
    }
    return {
          'thread': {
            'threadId': 'thr_1',
            'status': 'running',
            'generatedAt': '2026-01-01T00:00:00.000Z',
          },
          'agents': [],
          'timeline': [],
          'requestSpans': [],
          'sourceEventCount': 1,
        }
        as T;
  }
}

class _ConversationV2EcoCenterClient extends EcoCenterClient {
  _ConversationV2EcoCenterClient() : super(store: CredentialStore());

  ({String channel, List<dynamic> args})? lastCall;

  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    expect(desktopDeviceId, 'desktop_1');
    lastCall = (channel: channel, args: args);
    final response = switch (channel) {
      'conversation:capabilities' => {
        'protocolVersion': 2,
        'eventSchemaVersion': 1,
        'effectVersion': 1,
        'maxEvents': 200,
        'maxBytes': 524288,
        'storeEpoch': 'epoch_1',
      },
      'conversation:bootstrap' => {
        'protocolVersion': 2,
        'storeEpoch': 'epoch_1',
        'conversationId': 'thread_1',
        'snapshotSeq': 8,
        'historyRevision': 0,
        'messages': <dynamic>[],
        'runs': <dynamic>[],
        'tools': <dynamic>[],
        'agents': <dynamic>[],
        'olderCursor': null,
        'hasOlder': false,
      },
      'conversation:projection' => {
        'requestSpans': [
          {
            'requestId': 'request_1',
            'status': 'completed',
            'startedAt': '2026-01-01T00:00:00.000Z',
            'firstTokenAt': '2026-01-01T00:00:00.100Z',
            'endedAt': '2026-01-01T00:00:01.000Z',
          },
        ],
        'billing': {
          'plannerTokenCostUsd': 0.1,
          'ecoCostUsd': 0.05,
          'savedUsd': 0.05,
          'savedPct': 50,
          'pricingResolved': true,
          'totalTokens': {
            'input': 11,
            'output': 7,
            'cacheRead': 3,
            'cacheCreation': 1,
          },
          'byModel': <dynamic>[],
        },
        'context': {
          'occupied': 42,
          'limit': 100,
          'occupancyPct': 42,
          'limitsResolved': true,
          'segments': <dynamic>[],
          'roles': <dynamic>[],
          'instances': <dynamic>[],
        },
        'subagentTimings': [
          {
            'agentId': 'agent_1',
            'role': 'coder',
            'status': 'active',
            'startedAt': '2026-01-01T00:00:00.000Z',
            'lastActiveAt': '2026-01-01T00:00:01.000Z',
            'accumulatedMs': 1000,
            'durationMs': 1000,
          },
        ],
      },
      'conversation:messages-page' => {
        'protocolVersion': 2,
        'storeEpoch': 'epoch_1',
        'conversationId': 'thread_1',
        'readSeq': 8,
        'historyRevision': 0,
        'messages': <dynamic>[],
        'runs': <dynamic>[],
        'tools': <dynamic>[],
        'agents': <dynamic>[],
        'nextCursor': null,
        'hasMore': false,
      },
      'conversation:details-page' => {
        'protocolVersion': 2,
        'storeEpoch': 'epoch_1',
        'conversationId': 'thread_1',
        'readSeq': 8,
        'historyRevision': 0,
        'items': [
          {
            'itemId': 'detail_1',
            'conversationId': 'thread_1',
            'runId': 'run_1',
            'agentId': 'agent_role_1',
            'agentInstanceId': 'agent_instance_1',
            'parentAgentInstanceId': 'parent_instance_1',
            'parentAgentId': 'parent_role_1',
            'parentToolCallId': 'parent_tool_1',
            'toolCallId': 'tool_1',
            'type': 'tool.output',
            'createdSeq': 7,
            'versionSeq': 8,
            'content': '',
            'ref': '',
          },
        ],
        'nextCursor': null,
        'hasMore': false,
      },
      'conversation:tools-page' => {
        'protocolVersion': 2,
        'storeEpoch': 'epoch_1',
        'conversationId': 'thread_1',
        'runId': 'run_1',
        'readSeq': 8,
        'historyRevision': 0,
        'tools': [
          {
            'toolCallId': 'tool_1',
            'conversationId': 'thread_1',
            'runId': 'run_1',
            'name': 'Read',
            'status': 'completed',
            'createdSeq': 6,
            'versionSeq': 8,
          },
        ],
        'totalCount': 1,
        'nextCursor': null,
        'hasMore': false,
      },
      'conversation:head' => {
        'protocolVersion': 2,
        'storeEpoch': 'epoch_1',
        'conversationId': 'thread_1',
        'lastSeq': 8,
        'historyRevision': 0,
      },
      'conversation:sync' => {
        'protocolVersion': 2,
        'storeEpoch': 'epoch_1',
        'conversationId': 'thread_1',
        'fromSeq': 5,
        'throughSeq': 8,
        'headSeq': 8,
        'hasMore': false,
        'effects': <dynamic>[],
      },
      'conversation:send-message' => {
        'protocolVersion': 2,
        'conversationId': 'thread_1',
        'clientCommandId': 'command_1',
        'messageId': 'message_1',
        'turnId': 'turn_1',
        'acceptedSeq': 9,
        'status': 'accepted',
      },
      _ => throw StateError('unexpected channel $channel'),
    };
    return response as T;
  }
}

class _ThreadDeleteEcoCenterClient extends EcoCenterClient {
  _ThreadDeleteEcoCenterClient({
    this.userId = 'user_1',
    this.failFirstDelete = false,
  }) : super(store: CredentialStore());

  final String? userId;
  final bool failFirstDelete;
  int headCalls = 0;
  final List<Map<String, dynamic>> deleteCalls = [];

  @override
  AppCredentials get credentials =>
      AppCredentials(supabaseUrl: '', userId: userId);

  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    expect(desktopDeviceId, 'desktop_1');
    if (channel == 'conversation:head') {
      headCalls += 1;
      return {
            'protocolVersion': 2,
            'storeEpoch': 'epoch_1',
            'conversationId': 'thread_1',
            'lastSeq': 8,
            'historyRevision': 4,
          }
          as T;
    }
    if (channel == 'thread:delete') {
      final request = Map<String, dynamic>.from(args.single as Map);
      deleteCalls.add(request);
      if (failFirstDelete && deleteCalls.length == 1) {
        throw StateError('simulated lost delete response');
      }
      return {'ok': true, 'alreadyDeleted': deleteCalls.length > 1} as T;
    }
    throw StateError('unexpected channel $channel');
  }
}

class _MemoryThreadDeleteCommandStore
    implements ConversationV2ThreadDeleteCommandStore {
  final Map<String, ConversationV2PendingThreadDelete> _commands = {};

  @override
  Future<ConversationV2PendingThreadDelete?> pendingThreadDelete(
    String threadId,
  ) async => _commands[threadId];

  @override
  Future<void> putPendingThreadDelete(
    ConversationV2PendingThreadDelete command,
  ) async {
    _commands[command.threadId] = command;
  }

  @override
  Future<void> removePendingThreadDelete(
    String threadId,
    String clientCommandId,
  ) async {
    if (_commands[threadId]?.clientCommandId == clientCommandId) {
      _commands.remove(threadId);
    }
  }
}

class _ChunkedUploadEcoCenterClient extends EcoCenterClient {
  _ChunkedUploadEcoCenterClient({this.failFirstChunkOnce = false})
    : super(store: CredentialStore());

  final bool failFirstChunkOnce;
  final channels = <String>[];
  final assembledBuilder = BytesBuilder(copy: false);
  var chunkAttempts = 0;
  var _failedOnce = false;

  Uint8List get assembled => assembledBuilder.takeBytes();

  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    channels.add(channel);
    final payload = Map<String, dynamic>.from(args.first as Map);
    if (channel == 'prompt-image:upload-begin') {
      return {
            'path': r'C:\eco\prompt-images\spool\thread_thr_1\img_1.png',
            'receivedBytes': assembledBuilder.length,
            'complete': false,
          }
          as T;
    }
    if (channel == 'prompt-image:upload-chunk') {
      chunkAttempts += 1;
      if (failFirstChunkOnce && !_failedOnce) {
        _failedOnce = true;
        throw Exception('forced chunk failure');
      }
      final offset = (payload['offset'] as num).toInt();
      expect(offset, assembledBuilder.length);
      final chunk = base64Decode(payload['data'] as String);
      assembledBuilder.add(chunk);
      return {'receivedBytes': assembledBuilder.length} as T;
    }
    if (channel == 'prompt-image:upload-finish') {
      final total = (payload['totalBytes'] as num).toInt();
      expect(assembledBuilder.length, total);
      return {'path': r'C:\eco\prompt-images\spool\thread_thr_1\img_1.png'}
          as T;
    }
    throw StateError('unexpected channel $channel');
  }
}

class _PromptImageDownloadEcoCenterClient extends EcoCenterClient {
  _PromptImageDownloadEcoCenterClient() : super(store: CredentialStore());

  List<dynamic>? args;

  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    expect(channel, 'prompt-image:read-chunk');
    this.args = args;
    return {
          'contentRef':
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'mediaType': 'image/png',
          'offset': 0,
          'nextOffset': 3,
          'totalBytes': 3,
          'complete': true,
          'data': base64Encode([1, 2, 3]),
        }
        as T;
  }
}
