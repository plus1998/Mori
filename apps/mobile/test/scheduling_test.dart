import 'dart:async';
import 'dart:convert';

import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/models/scheduling_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/project_models.dart';
import 'package:eco_mobile/features/projects/project_providers.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/providers/desktop_bind_ready.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/features/scheduling/schedule_editor.dart';
import 'package:eco_mobile/features/scheduling/scheduling_providers.dart';
import 'package:eco_mobile/features/scheduling/scheduling_screen.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> definition({
  String id = 'sch_1',
  String kind = 'session_message',
  bool enabled = true,
}) => {
  'id': id,
  'kind': kind,
  'name': 'Reminder',
  'prompt': 'Original content',
  'trigger': {
    'type': 'at',
    'at': DateTime.now().add(const Duration(days: 1)).toUtc().toIso8601String(),
  },
  'enabled': enabled,
  'revision': 3,
  'maxLatenessSeconds': 86400,
  'threadId': 'thread_1',
  'nextRunAt': null,
};

class Client extends EcoCenterClient {
  Client() : super(store: CredentialStore());
  final calls = <({String channel, List<dynamic> args})>[];
  bool failCreate = false;
  bool failRun = false;
  String? imageData;
  Map<String, dynamic> snapshot = {
    'schedules': <dynamic>[],
    'occurrences': <dynamic>[],
  };
  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    calls.add((channel: channel, args: args));
    if ((channel == 'scheduling:create' && failCreate) ||
        (channel == 'scheduling:run-now' && failRun)) {
      throw EcoCenterException.native('response lost');
    }
    if (channel == 'prompt-image:read-chunk' && imageData != null) {
      final input = args.single as Map;
      final length = base64Decode(imageData!).length;
      return {
            'contentRef': input['contentRef'],
            'mediaType': input['mediaType'],
            'offset': 0,
            'nextOffset': length,
            'totalBytes': length,
            'data': imageData,
            'complete': true,
          }
          as T;
    }
    if (channel == 'prompt-image:upload-begin') {
      return {'receivedBytes': 0} as T;
    }
    if (channel == 'prompt-image:upload-chunk') {
      return {'receivedBytes': base64Decode(args.single['data']).length} as T;
    }
    if (channel == 'prompt-image:upload-finish') {
      return {
            'path': '/tmp/staged-schedule-image.png',
            'contentRef': 'sha256:${'a' * 64}',
            'byteLength': args.single['totalBytes'],
          }
          as T;
    }
    final dynamic result = channel == 'scheduling:list'
        ? snapshot
        : channel == 'scheduling:preview'
        ? ['2027-01-01T00:00:00Z']
        : null;
    return result as T;
  }
}

Widget app(Client client, Widget child) => ProviderScope(
  overrides: [
    desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'desktop')),
    modelSettingsProvider.overrideWith((ref) async => null),
    workflowSettingsProvider.overrideWith(
      (ref) async => const WorkflowSettingsSnapshot(
        sessionMode: 'agent',
        defaultCoreKind: 'acp',
        acpCursorModelId: 'test-model',
      ),
    ),
    mcpSettingsProvider.overrideWith((ref) async => null),
    cursorModelsProvider.overrideWith((ref) async => []),
    projectListProvider.overrideWith((ref) => const AsyncData(<EcoProject>[])),
    selectedProjectPathProvider.overrideWith(
      () => SelectedProjectPathNotifierForTest(),
    ),
    schedulingSnapshotProvider.overrideWith(
      (ref) async => SchedulingSnapshot.fromJson(client.snapshot),
    ),
  ],
  child: MaterialApp(
    locale: const Locale('en'),
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: child,
  ),
);

class SelectedProjectPathNotifierForTest extends SelectedProjectPathNotifier {
  @override
  Future<String?> build() async => '/workspace';
}

void main() {
  test(
    'wire schedule timestamps preserve the instant with UTC millisecond precision',
    () {
      expect(
        scheduleTimestamp(DateTime.parse('2026-10-24T02:00:00.123456+08:00')),
        '2026-10-23T18:00:00.123Z',
      );
    },
  );
  test(
    'relative creation retries freeze both time and request id; edits rotate the identity',
    () {
      final attempt = ScheduleCreateAttempt();
      var triggerCalls = 0;
      Map<String, dynamic> trigger() => {
        'type': 'at',
        'at': '${++triggerCalls}',
      };
      final first = attempt.prepare(
        {'prompt': 'hello'},
        trigger,
        timingIdentity: 60,
      );
      final retry = attempt.prepare(
        {'prompt': 'hello'},
        trigger,
        timingIdentity: 60,
      );
      expect(retry, first);
      expect(triggerCalls, 1);
      final changedTime = attempt.prepare(
        {'prompt': 'hello'},
        trigger,
        timingIdentity: 120,
      );
      expect(changedTime['requestId'], isNot(first['requestId']));
      expect(triggerCalls, 2);
    },
  );

  test(
    'RPC preserves revisions, trigger fields and immediate-run identity',
    () async {
      final client = Client();
      final rpc = DesktopRpc(client, 'desktop');
      client.snapshot['schedules'] = [definition()];
      final snapshot = await rpc.listSchedules();
      expect(snapshot.schedules.single.revision, 3);
      await rpc.updateSchedule({
        'id': 'sch_1',
        'expectedRevision': 3,
        'enabled': false,
      });
      expect(client.calls.last.channel, 'scheduling:update');
      expect(client.calls.last.args.single['expectedRevision'], 3);
      await rpc.runScheduleNow('sch_1', 'retry-id');
      expect(client.calls.last.args.single, {
        'id': 'sch_1',
        'requestId': 'retry-id',
      });
      expect(
        await rpc.previewSchedule({
          'type': 'cron',
          'expression': '0 9 * * *',
          'timezone': 'Asia/Shanghai',
        }),
        ['2027-01-01T00:00:00Z'],
      );
      await rpc.deleteSchedule('sch_1');
      expect(client.calls.last.args, ['sch_1']);
    },
  );

  test(
    'snapshot refreshes after desktop changes and when switching desktops',
    () async {
      final events = StreamController<EcoEventEnvelope>();
      final client = Client();
      final container = ProviderContainer(
        overrides: [
          desktopRpcProvider.overrideWith(
            (ref) => DesktopRpc(
              client,
              ref.watch(selectedDesktopIdProvider) ?? 'desktop',
            ),
          ),
          desktopBindReadyOverrideProvider.overrideWithValue(true),
          connectionStatusProvider.overrideWith(
            (ref) => const Stream<CenterServerConnectionStatus>.empty(),
          ),
          ecoEventsProvider.overrideWith((ref) => events.stream),
        ],
      );
      final subscription = container.listen(
        schedulingSnapshotProvider,
        (_, _) {},
      );
      await container.read(schedulingSnapshotProvider.future);
      client.snapshot['schedules'] = [definition()];
      events.add(
        EcoEventEnvelope(
          id: 'evt',
          kind: 'scheduling.changed',
          source: 'desktop',
          occurredAt: '',
          payload: {},
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(
        (await container.read(schedulingSnapshotProvider.future)).schedules,
        hasLength(1),
      );
      container.read(selectedDesktopIdProvider.notifier).state = 'other';
      await container.read(schedulingSnapshotProvider.future);
      expect(
        client.calls.where((c) => c.channel == 'scheduling:list'),
        hasLength(3),
      );
      subscription.close();
      container.dispose();
      await events.close();
    },
  );

  testWidgets('new message retries keep payload and do not close on failure', (
    tester,
  ) async {
    final client = Client()..failCreate = true;
    await tester.pumpWidget(
      app(
        client,
        const ScheduleEditor(threadId: 'thread_1', initialPrompt: 'Remind me'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(find.text('response lost'), findsOneWidget);
    final first = client.calls.single.args.single as Map;
    expect(first['threadId'], 'thread_1');
    expect(first['name'], 'Remind me');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(client.calls.last.args.single, first);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'new conversation schedule stages images under landing and retries one creation',
    (tester) async {
      final client = Client()..failCreate = true;
      const newThread = ScheduledMessageNewThread(
        workspacePath: '/workspace',
        coreKind: 'acp',
        runtimeConfig: ThreadRuntimeConfig(
          subagentEnabled: {},
          sessionMode: 'agent',
          bashReviewMode: 'manual',
          cursorModelId: 'fixed-model',
        ),
      );
      await tester.pumpWidget(
        app(
          client,
          const ScheduleEditor(
            threadId: 'thr_reserved',
            newThread: newThread,
            initialPrompt: 'First message at the scheduled time',
            initialAttachments: [
              PromptImageAttachment(
                id: 'first-image',
                mediaType: 'image/png',
                data:
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGkAAAAASUVORK5CYII=',
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        client.calls,
        isEmpty,
        reason: 'Opening or cancelling creates no server records',
      );
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(
        client.calls.first.args.single['contextKey'],
        'landing:/workspace',
      );
      final first = client.calls.last.args.single as Map;
      expect(first['kind'], 'session_message');
      expect(first['threadId'], 'thr_reserved');
      expect(first['newThread'], newThread.toJson());
      expect(first['prompt'], 'First message at the scheduled time');
      expect(first['attachments'], hasLength(1));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(client.calls.last.args.single, first);
      expect(
        client.calls.where((c) => c.channel == 'prompt-image:upload-finish'),
        hasLength(1),
      );
      expect(client.calls.where((c) => c.channel == 'thread:start'), isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'new conversation previews restored images using their landing authorization',
    (tester) async {
      final client = Client()
        ..imageData =
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGkAAAAASUVORK5CYII=';
      await tester.pumpWidget(
        app(
          client,
          ScheduleEditor(
            threadId: 'thr_not_created_yet',
            newThread: const ScheduledMessageNewThread(
              workspacePath: '/workspace',
              coreKind: 'acp',
              runtimeConfig: ThreadRuntimeConfig(
                subagentEnabled: {},
                sessionMode: 'agent',
                bashReviewMode: 'manual',
                cursorModelId: 'fixed-model',
              ),
            ),
            initialAttachments: [
              PromptImageAttachment(
                mediaType: 'image/png',
                data: '',
                contentRef: 'sha256:${'a' * 64}',
                byteLength: base64Decode(client.imageData!).length,
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      final reads = client.calls.where(
        (c) => c.channel == 'prompt-image:read-chunk',
      );
      expect(reads, hasLength(1));
      expect(reads.single.args.single['contextKey'], 'landing:/workspace');
      expect(find.text('Failed to read the image.'), findsNothing);
      expect(
        client.calls.where((c) => c.channel == 'scheduling:create'),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'todo image-only draft uploads once and keeps exact scheduling identity on retry',
    (tester) async {
      const png =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGkAAAAASUVORK5CYII=';
      final client = Client()..failCreate = true;
      await tester.pumpWidget(
        app(
          client,
          const ScheduleEditor(
            threadId: 'thread_1',
            initialAttachments: [
              PromptImageAttachment(
                id: 'todo_image',
                mediaType: 'image/png',
                data: png,
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      final first = client.calls.last.args.single as Map;
      expect(first['prompt'], '');
      expect(first['name'], 'Image');
      expect(first['attachments'], [
        {
          'mediaType': 'image/png',
          'contentRef': 'sha256:${'a' * 64}',
          'byteLength': base64Decode(png).length,
        },
      ]);
      expect(find.text('response lost'), findsOneWidget);
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(client.calls.last.args.single, first);
      expect(
        client.calls.where((c) => c.channel == 'prompt-image:upload-finish'),
        hasLength(1),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('unreadable scheduled images show an explicit read failure', (
    tester,
  ) async {
    final d = definition()
      ..['attachments'] = [
        {
          'mediaType': 'image/png',
          'contentRef': 'sha256:${'a' * 64}',
          'byteLength': 68,
        },
      ];
    await tester.pumpWidget(
      app(Client(), ScheduleEditor(definition: ScheduleDefinition.fromJson(d))),
    );
    await tester.pumpAndSettle();
    expect(find.text('Failed to read the image.'), findsOneWidget);
  });

  testWidgets(
    'editing a schedule keeps images, or explicitly removes them without changing its date',
    (tester) async {
      final client = Client();
      final d = definition()
        ..['attachments'] = [
          {
            'mediaType': 'image/png',
            'contentRef': 'sha256:${'a' * 64}',
            'byteLength': 68,
            'data':
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGkAAAAASUVORK5CYII=',
          },
        ];
      await tester.pumpWidget(
        app(client, ScheduleEditor(definition: ScheduleDefinition.fromJson(d))),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      final saved = client.calls.single.args.single as Map;
      expect(saved['attachments'], hasLength(1));
      expect(saved.containsKey('trigger'), false);
      expect((saved['attachments'] as List).single.containsKey('data'), false);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(
        app(client, ScheduleEditor(definition: ScheduleDefinition.fromJson(d))),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byTooltip('Remove image 1'));
      await tester.tap(find.byTooltip('Remove image 1'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(client.calls.last.args.single['attachments'], isEmpty);
    },
  );

  testWidgets(
    'editing content preserves the original schedule without resetting time',
    (tester) async {
      final client = Client();
      final d = ScheduleDefinition.fromJson(definition());
      await tester.pumpWidget(app(client, ScheduleEditor(definition: d)));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, 'Updated content');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      final input = client.calls.single.args.single as Map;
      expect(input['prompt'], 'Updated content');
      expect(input['expectedRevision'], 3);
      expect(input.containsKey('trigger'), isFalse);
    },
  );

  testWidgets(
    'new independent task saves selected workspace and explicit runtime profile',
    (tester) async {
      final client = Client();
      await tester.pumpWidget(app(client, const ScheduleEditor()));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField).at(0),
        'Run an independent task with all context',
      );
      await tester.enterText(find.byType(TextField).at(1), 'Daily task');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      final input = client.calls.single.args.single as Map;
      expect(input['kind'], 'scheduled_task');
      expect(input['workspacePath'], '/workspace');
      expect(input.containsKey('threadId'), isFalse);
      expect(input['executionProfile']['coreKind'], 'acp');
      expect(
        input['executionProfile']['runtimeConfig']['cursorModelId'],
        'test-model',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('due pending messages show their execution status in the list', (
    tester,
  ) async {
    final client = Client();
    final d = definition();
    client.snapshot['schedules'] = [d];
    client.snapshot['occurrences'] = [
      {
        'scheduleId': 'sch_1',
        'scheduledAt': '2026-10-23T18:00:00Z',
        'status': 'pending',
        'definition': d,
      },
    ];
    await tester.pumpWidget(
      app(client, const SchedulingScreen(threadId: 'thread_1')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Pending'), findsOneWidget);
    expect(find.textContaining('Enabled'), findsNothing);
  });

  testWidgets(
    'manager filters current-thread messages and reuses immediate-send request on retry',
    (tester) async {
      final client = Client()..failRun = true;
      client.snapshot['schedules'] = [
        definition(),
        definition(id: 'task', kind: 'scheduled_task'),
      ];
      await tester.pumpWidget(
        app(client, const SchedulingScreen(threadId: 'thread_1')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Reminder'), findsOneWidget);
      await tester.tap(find.text('Reminder'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Send now'));
      await tester.tap(find.text('Send now'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Submit'));
      await tester.pumpAndSettle();
      final first = client.calls.single.args.single;
      await tester.tap(find.text('Reminder'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Send now'));
      await tester.tap(find.text('Send now'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Submit'));
      await tester.pumpAndSettle();
      expect(client.calls.last.args.single, first);
      expect(find.text('response lost'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
