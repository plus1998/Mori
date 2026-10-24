import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/models/project_models.dart';
import 'package:eco_mobile/core/models/project_todo_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/providers/app_providers.dart';
import 'package:eco_mobile/core/providers/desktop_bind_ready.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/features/projects/project_providers.dart';
import 'package:eco_mobile/features/threads/thread_providers.dart';
import 'package:eco_mobile/features/todos/project_todos_screen.dart';
import 'package:eco_mobile/features/todos/todo_editor.dart';
import 'package:eco_mobile/features/todos/todo_providers.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/features/threads/thread_session_route.dart';

Map<String, dynamic> row(
  String id,
  String text, {
  String project = '/a',
  bool completed = false,
}) => {
  'id': id,
  'revision': 3,
  'text': text,
  'projectPath': project,
  'images': <dynamic>[],
  'completed': completed,
  'createdAt': '2026-10-23T00:00:00Z',
  'updatedAt': '2026-10-23T00:00:00Z',
};

class TodoClient extends EcoCenterClient {
  TodoClient() : super(store: CredentialStore());
  final calls = <({String channel, List<dynamic> args})>[];
  final items = <Map<String, dynamic>>[
    row('1', 'Fix mobile layout'),
    row('2', 'Review API', project: '/b'),
    row('3', 'Completed task', completed: true),
  ];
  bool conflict = false;
  bool malformedChunk = false;
  final deleted = <String>{};
  final imageBytes = List<int>.generate(150000, (i) => i % 251);
  final uploadedImageBytes = <int>[];

  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    calls.add((channel: channel, args: args));
    dynamic result;
    switch (channel) {
      case 'prompt-image:upload-begin':
        result = {'receivedBytes': uploadedImageBytes.length};
      case 'prompt-image:upload-chunk':
        final input = args.first as Map;
        uploadedImageBytes.addAll(base64Decode(input['data'] as String));
        result = {'receivedBytes': uploadedImageBytes.length};
      case 'prompt-image:upload-finish':
        result = {
          'path': '/desktop/todo.png',
          'contentRef': 'todo-image-ref',
          'byteLength': uploadedImageBytes.length,
        };
      case 'workspace:open-path':
        result = {
          'path': args.first,
          'name': 'Alpha',
          'isGitRepository': false,
        };
      case 'project-todo:list':
        result = items.where((item) => !deleted.contains(item['id'])).toList();
      case 'project-todo:get':
        result = items.firstWhere((item) => item['id'] == args[0]);
      case 'project-todo:save':
        if (conflict) {
          throw EcoCenterException.native(
            'Todo changed. Reopen it before saving.',
          );
        }
        final input = Map<String, dynamic>.from(args.first as Map);
        final id = input['id'] as String? ?? 'new';
        final saved = {
          ...row(id, input['text'] as String),
          ...input,
          'revision': 4,
        };
        items.removeWhere((item) => item['id'] == id);
        items.add(saved);
        result = saved;
      case 'project-todo:trash':
        final input = args.first as Map;
        if (input['deleted'] == true) {
          deleted.add(input['id'] as String);
        } else {
          deleted.remove(input['id']);
        }
        result = (input['revision'] as int) + 1;
      case 'project-todo:image-read':
        final offset = (args.first as Map)['offset'] as int;
        final end = (offset + 65536).clamp(0, imageBytes.length);
        result = {
          'data': base64Encode(imageBytes.sublist(offset, end)),
          'totalBytes': imageBytes.length,
          'nextOffset': malformedChunk ? offset : end,
        };
      default:
        throw StateError('Unexpected RPC $channel');
    }
    return result as T;
  }
}

class SelectedProject extends SelectedProjectPathNotifier {
  @override
  Future<String?> build() async => '/a';
  @override
  Future<void> select(String path) async {
    state = AsyncData(path);
  }
}

class TodoThreads extends ThreadListNotifier {
  @override
  Future<List<ThreadSummary>> build() async => [];
}

Widget app(TodoClient client, {Widget? home, double scale = 1}) =>
    ProviderScope(
      overrides: [
        desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'desktop')),
        ecoEventsProvider.overrideWith((ref) => const Stream.empty()),
        connectionStatusProvider.overrideWith((ref) => const Stream.empty()),
        selectedDesktopIdProvider.overrideWith((ref) => 'desktop'),
        threadListProvider.overrideWith(TodoThreads.new),
        projectWorkspaceContextProvider.overrideWith(
          (ref) async => const ProjectWorkspaceContext(homeProjectPath: '/a'),
        ),
        projectListProvider.overrideWithValue(
          const AsyncData([
            EcoProject(path: '/a', name: 'Alpha'),
            EcoProject(path: '/b', name: 'Beta'),
          ]),
        ),
        selectedProjectPathProvider.overrideWith(SelectedProject.new),
        projectTodosProvider.overrideWith(
          (ref) async =>
              (await ref.watch(desktopRpcProvider)!.listProjectTodos()),
        ),
      ],
      child: MaterialApp(
        theme: buildEcoLightTheme(),
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: home ?? const ProjectTodosScreen(),
      ),
    );

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  testWidgets(
    'adding a todo image avoids full photo metadata and uploads on save',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final directory = Directory.systemTemp.createTempSync('eco-todo-image-');
      addTearDown(() => directory.deleteSync(recursive: true));
      final bytes = base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGNQSlv1H4QZYAwASUAIxW/CcsIAAAAASUVORK5CYII=',
      );
      final file = File('${directory.path}/todo.png')..writeAsBytesSync(bytes);
      const channel = MethodChannel('plugins.flutter.io/image_picker');
      final picks = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        picks.add(call);
        return file.path;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final client = TodoClient();
      await tester.pumpWidget(app(client));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('New to-do'));
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        await tester.tap(find.text('Add image'));
        for (var attempt = 0; attempt < 100; attempt++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          await tester.pump();
          if (find.byTooltip('Remove image').evaluate().isNotEmpty) break;
        }
      });
      await tester.pumpAndSettle();
      expect(picks.single.method, 'pickImage');
      expect((picks.single.arguments as Map)['requestFullMetadata'], isFalse);
      expect(find.byTooltip('Remove image'), findsOneWidget);
      expect(tester.takeException(), isNull);
      expect(client.uploadedImageBytes, isEmpty);
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.byType(TodoEditor), findsNothing);
      expect(client.uploadedImageBytes, bytes);
      final saved = client.calls.lastWhere(
        (c) => c.channel == 'project-todo:save',
      );
      final image =
          ((saved.args.single as Map)['images'] as List).single as Map;
      expect(image['contentRef'], 'todo-image-ref');
      expect(image['thumbnail'], startsWith('data:image/png;base64,'));
      expect(tester.takeException(), isNull);
    },
  );

  test(
    'downloads original image chunks and rejects a stalled transfer',
    () async {
      final client = TodoClient();
      final rpc = DesktopRpc(client, 'desktop');
      final todo = ProjectTodo.fromJson(client.items.first);
      const image = ProjectTodoImage(
        id: 'image',
        mediaType: 'image/png',
        thumbnail: '',
      );
      final original = await rpc.downloadProjectTodoImage(todo, image);
      expect(base64Decode(original), client.imageBytes);
      expect(
        client.calls
            .where((c) => c.channel == 'project-todo:image-read')
            .length,
        3,
      );
      expect((client.calls.last.args.first as Map)['revision'], 3);
      client.malformedChunk = true;
      await expectLater(
        rpc.downloadProjectTodoImage(todo, image),
        throwsFormatException,
      );
    },
  );

  test('desktop changes invalidate the mobile snapshot', () async {
    final client = TodoClient();
    final events = StreamController<EcoEventEnvelope>.broadcast();
    final container = ProviderContainer(
      overrides: [
        desktopRpcProvider.overrideWithValue(DesktopRpc(client, 'desktop')),
        selectedDesktopIdProvider.overrideWith((ref) => 'desktop'),
        desktopBindReadyOverrideProvider.overrideWithValue(true),
        ecoEventsProvider.overrideWith((ref) => events.stream),
        connectionStatusProvider.overrideWith((ref) => const Stream.empty()),
      ],
    );
    final sub = container.listen(projectTodosProvider, (_, _) {});
    addTearDown(() {
      sub.close();
      container.dispose();
      events.close();
    });
    await container.read(projectTodosProvider.future);
    client.items.add(row('4', 'Added on desktop'));
    await Future<void>.delayed(Duration.zero);
    events.add(
      const EcoEventEnvelope(
        id: 'event',
        kind: 'project-todo.changed',
        source: 'desktop',
        occurredAt: '',
        payload: {},
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect((await container.read(projectTodosProvider.future)).length, 4);
    expect(
      client.calls.where((c) => c.channel == 'project-todo:list').length,
      2,
    );
  });

  testWidgets(
    'search, completed section, toggle and delete undo use shared revisions',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final client = TodoClient();
      await tester.pumpWidget(app(client));
      await tester.pumpAndSettle();
      expect(find.text('Fix mobile layout'), findsOneWidget);
      expect(find.text('Completed task'), findsNothing);
      await tester.enterText(find.byType(TextField), 'API');
      await tester.pumpAndSettle();
      expect(find.text('Review API'), findsOneWidget);
      expect(find.text('Fix mobile layout'), findsNothing);
      await tester.enterText(find.byType(TextField), '');
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Mark complete').first);
      await tester.pumpAndSettle();
      expect(
        (client.calls
                .firstWhere((c) => c.channel == 'project-todo:save')
                .args
                .first
            as Map)['revision'],
        3,
      );
      expect(find.text('Fix mobile layout'), findsNothing);
      await tester.tap(find.text('Completed · 2'));
      await tester.pumpAndSettle();
      expect(find.text('Completed task'), findsOneWidget);
      await tester.tap(find.byTooltip('To-do actions').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();
      expect(client.deleted, contains('2'));
      await tester.tap(find.text('Undo'));
      await tester.pumpAndSettle();
      expect(client.deleted, isEmpty);
      final trash = client.calls
          .where((c) => c.channel == 'project-todo:trash')
          .toList();
      expect((trash.last.args.first as Map)['revision'], 4);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('conflicting saves keep editor text visible and unsent', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final client = TodoClient()..conflict = true;
    final todo = ProjectTodo.fromJson(client.items.first);
    await tester.pumpWidget(
      app(
        client,
        home: Scaffold(
          body: TodoEditor(projects: const {'/a': 'Alpha'}, todo: todo),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'My unsaved mobile changes');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(find.text('My unsaved mobile changes'), findsOneWidget);
    expect(find.textContaining('changed on another device'), findsOneWidget);
    expect(client.calls.any((c) => c.channel == 'thread:start'), isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('small screens and large text keep actions accessible', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 640);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final client = TodoClient();
    await tester.pumpWidget(app(client, scale: 1.6));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.tap(find.byTooltip('New to-do'));
    await tester.pumpAndSettle();
    expect(find.text('Save'), findsOneWidget);
    expect(tester.takeException(), isNull);
    tester.view.viewInsets = const FakeViewPadding(bottom: 280);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpAndSettle();
    expect(tester.getBottomRight(find.text('Save')).dy, lessThanOrEqualTo(360));
    expect(tester.takeException(), isNull);
    await tester.enterText(find.byType(TextField).last, 'A mobile idea');
    await tester.tap(find.byTooltip('Close').last);
    await tester.pumpAndSettle();
    expect(find.text('Discard changes?'), findsOneWidget);
    expect(client.calls.any((c) => c.channel == 'project-todo:save'), isFalse);
  });
  testWidgets(
    'bringing a todo into a new conversation preserves text and original image without sending',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final client = TodoClient();
      client.items.first['images'] = [
        {
          'id': 'image',
          'mediaType': 'image/png',
          'thumbnail':
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        },
      ];
      ThreadSessionRouteExtra? draft;
      final router = GoRouter(
        initialLocation: '/todos',
        routes: [
          GoRoute(
            path: '/todos',
            builder: (_, _) => const ProjectTodosScreen(),
          ),
          GoRoute(
            path: '/threads/:id',
            builder: (_, state) {
              draft = state.extra as ThreadSessionRouteExtra;
              return const Scaffold(body: Text('Composer ready'));
            },
          ),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(
        app(client, home: Router.withConfig(config: router)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Bring into conversation').first);
      await tester.pumpAndSettle();
      expect(find.textContaining('review and send'), findsOneWidget);
      await tester.tap(find.text('New conversation'));
      await tester.pumpAndSettle();
      expect(find.text('Composer ready'), findsOneWidget);
      expect(draft?.prompt, 'Fix mobile layout');
      expect(base64Decode(draft!.attachments.single.data), client.imageBytes);
      expect(client.items.length, 3);
      expect(client.deleted, isEmpty);
      expect(
        client.calls.any(
          (c) =>
              c.channel == 'thread:start' ||
              c.channel == 'conversation:send-message',
        ),
        isFalse,
      );
      expect(tester.takeException(), isNull);
    },
  );
}
