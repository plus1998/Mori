import 'dart:convert';
import 'thread_models.dart';

import 'package:uuid/uuid.dart';

/// The desktop wire format uses UTC milliseconds, while Dart clocks can carry
/// microseconds. Keep compatibility with desktops that validate this precision.
String scheduleTimestamp(DateTime value) => DateTime.fromMillisecondsSinceEpoch(
  value.millisecondsSinceEpoch,
  isUtc: true,
).toIso8601String();

class ScheduledMessageNewThread {
  const ScheduledMessageNewThread({
    required this.workspacePath,
    required this.coreKind,
    required this.runtimeConfig,
  });
  final String workspacePath, coreKind;
  final ThreadRuntimeConfigInput runtimeConfig;

  Map<String, dynamic> toJson() => {
    'workspacePath': workspacePath,
    'executionProfile': {
      'coreKind': coreKind,
      'runtimeConfig': runtimeConfig.toJson(),
    },
  };
}

class ScheduleDefinition {
  ScheduleDefinition.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String,
      kind = json['kind'] as String,
      name = json['name'] as String,
      prompt = json['prompt'] as String,
      trigger = Map<String, dynamic>.from(json['trigger'] as Map),
      attachments = (json['attachments'] as List? ?? const [])
          .map(
            (a) => PromptImageAttachment.fromJson(
              Map<String, dynamic>.from(a as Map),
            ),
          )
          .toList(),
      enabled = json['enabled'] as bool,
      revision = json['revision'] as int,
      maxLatenessSeconds = json['maxLatenessSeconds'] as int,
      threadId = json['threadId'] as String?,
      workspacePath = json['workspacePath'] as String?,
      executionProfile = json['executionProfile'] == null
          ? null
          : Map<String, dynamic>.from(json['executionProfile'] as Map),
      nextRunAt = json['nextRunAt'] as String?,
      error = json['error'] as String?;

  final String id, kind, name, prompt;
  final Map<String, dynamic> trigger;
  final List<PromptImageAttachment> attachments;
  final bool enabled;
  final int revision, maxLatenessSeconds;
  final String? threadId, workspacePath, nextRunAt, error;
  final Map<String, dynamic>? executionProfile;
  bool get isMessage => kind == 'session_message';
  bool get isExpiredOneShot =>
      trigger['type'] == 'at' &&
      !DateTime.parse(trigger['at'] as String).isAfter(DateTime.now());
}

class ScheduleOccurrence {
  ScheduleOccurrence.fromJson(Map<String, dynamic> json)
    : scheduleId = json['scheduleId'] as String,
      scheduledAt = json['scheduledAt'] as String,
      status = json['status'] as String,
      definition = ScheduleDefinition.fromJson(
        Map<String, dynamic>.from(json['definition'] as Map),
      ),
      threadId = json['threadId'] as String?,
      error = json['error'] as String?;
  final String scheduleId, scheduledAt, status;
  final ScheduleDefinition definition;
  final String? threadId, error;
}

class SchedulingSnapshot {
  const SchedulingSnapshot({
    required this.schedules,
    required this.occurrences,
  });
  factory SchedulingSnapshot.fromJson(
    Map<String, dynamic> json,
  ) => SchedulingSnapshot(
    schedules: (json['schedules'] as List)
        .map(
          (e) =>
              ScheduleDefinition.fromJson(Map<String, dynamic>.from(e as Map)),
        )
        .toList(),
    occurrences: (json['occurrences'] as List)
        .map(
          (e) =>
              ScheduleOccurrence.fromJson(Map<String, dynamic>.from(e as Map)),
        )
        .toList(),
  );
  final List<ScheduleDefinition> schedules;
  final List<ScheduleOccurrence> occurrences;
}

/// Freeze the complete payload, including relative time, across lost-response
/// retries. Any user edit starts a new request identity.
class ScheduleCreateAttempt {
  String? _signature;
  Map<String, dynamic>? _payload;

  Map<String, dynamic> prepare(
    Map<String, dynamic> fields,
    Map<String, dynamic> Function() trigger, {
    Object? timingIdentity,
  }) {
    final signature = jsonEncode([fields, timingIdentity]);
    if (_signature != signature) {
      final next = trigger();
      _payload = {...fields, 'trigger': next, 'requestId': const Uuid().v4()};
      _signature = signature;
    }
    return Map<String, dynamic>.from(_payload!);
  }
}
