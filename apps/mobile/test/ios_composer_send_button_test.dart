import 'dart:async';

import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/features/composer/ios_composer_send_button.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
    'native send menu keeps single sends, overrides and disabled state separate',
    (tester) async {
      final messenger = tester.binding.defaultBinaryMessenger;
      int? viewId;
      final updates = <Map<Object?, Object?>>[];
      messenger.setMockMethodCallHandler(SystemChannels.platform_views, (
        call,
      ) async {
        if (call.method == 'create') {
          final arguments = call.arguments as Map<Object?, Object?>;
          expect(arguments['viewType'], 'eco_mobile/composer_send_button');
          viewId = arguments['id'] as int;
          messenger.setMockMethodCallHandler(
            MethodChannel('eco_mobile/composer_send_button_$viewId'),
            (call) async {
              if (call.method == 'update') {
                updates.add(call.arguments as Map<Object?, Object?>);
              }
              return null;
            },
          );
        }
        return null;
      });
      addTearDown(() {
        messenger.setMockMethodCallHandler(SystemChannels.platform_views, null);
        if (viewId != null) {
          messenger.setMockMethodCallHandler(
            MethodChannel('eco_mobile/composer_send_button_$viewId'),
            null,
          );
        }
      });

      var sends = 0;
      var schedules = 0;
      var scheduling = false;
      final modes = <FollowUpDeliveryMode>[];
      var busy = false;
      var enabled = true;
      var dark = false;
      var queueLabel = 'Queue';
      var steerLabel = 'Guide direction';
      late StateSetter rebuild;
      await tester.pumpWidget(
        MaterialApp(
          home: StatefulBuilder(
            builder: (context, setState) {
              rebuild = setState;
              return Theme(
                data: dark ? ThemeData.dark() : ThemeData.light(),
                child: Center(
                  child: IOSComposerSendButton(
                    size: 36,
                    busy: busy,
                    backgroundColor: Colors.blue,
                    foregroundColor: Colors.white,
                    label: 'Send',
                    queueLabel: queueLabel,
                    steerLabel: steerLabel,
                    scheduleLabel: '定时发送',
                    onSend: enabled ? () => sends++ : null,
                    onSendWithMode: scheduling ? null : modes.add,
                    onSchedule: scheduling ? () => schedules++ : null,
                  ),
                ),
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(viewId, isNotNull);
      expect(updates.last['enabled'], isTrue);
      expect(updates.last['queueLabel'], 'Queue');
      expect(updates.last['steerLabel'], 'Guide direction');

      Future<void> native(String method, [Object? arguments]) async {
        final response = Completer<void>();
        messenger.handlePlatformMessage(
          'eco_mobile/composer_send_button_$viewId',
          const StandardMethodCodec().encodeMethodCall(
            MethodCall(method, arguments),
          ),
          (_) => response.complete(),
        );
        await response.future;
      }

      await native('pressed');
      expect(sends, 1);
      await native('selected', 'queue');
      await native('selected', 'steer');
      await native('selected', 'unknown');
      expect(sends, 1);
      expect(modes, [FollowUpDeliveryMode.queue, FollowUpDeliveryMode.steer]);
      await native('pressed');
      expect(sends, 2);

      final beforeRebuild = updates.length;
      rebuild(() {});
      await tester.pump();
      expect(
        updates.length,
        beforeRebuild,
        reason: 'Feed rebuilds preserve the open menu',
      );

      rebuild(() => busy = true);
      await tester.pump();
      expect(updates.last['enabled'], isFalse);
      expect(updates.last['busy'], isTrue);
      // A menu selection already in flight must not send again after submission.
      await native('pressed');
      await native('selected', 'queue');
      expect(sends, 2);
      expect(modes, hasLength(2));

      rebuild(() {
        busy = false;
        enabled = false;
      });
      await tester.pump();
      await native('selected', 'steer');
      expect(updates.last['enabled'], isFalse);
      expect(modes, hasLength(2));

      rebuild(() {
        enabled = true;
        dark = true;
        queueLabel = '排队';
        steerLabel = '引导';
      });
      await tester.pump();
      expect(updates.last['enabled'], isTrue);
      expect(updates.last['isDark'], isTrue);
      expect(updates.last['queueLabel'], '排队');
      expect(updates.last['steerLabel'], '引导');
      await native('selected', 'steer');
      expect(modes.last, FollowUpDeliveryMode.steer);
      expect(modes, hasLength(3));

      rebuild(() => scheduling = true);
      await tester.pump();
      expect(updates.last['allowSchedule'], isTrue);
      expect(updates.last['allowDelivery'], isFalse);
      expect(updates.last['scheduleLabel'], '定时发送');
      await native('selected', 'queue');
      expect(modes, hasLength(3));
      await native('selected', 'schedule');
      expect(schedules, 1);
      expect(sends, 2);
      rebuild(() => busy = true);
      await tester.pump();
      await native('selected', 'schedule');
      expect(schedules, 1);
      rebuild(() {
        busy = false;
        scheduling = false;
      });
      await tester.pump();
      expect(updates.last['allowDelivery'], isTrue);
      expect(updates.last['allowSchedule'], isFalse);
      await native('selected', 'schedule');
      expect(schedules, 1);

      await tester.pumpWidget(const SizedBox.shrink());
      await native('pressed');
      expect(sends, 2);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.iOS),
  );
}
