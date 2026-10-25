import '../../core/models/conversation_v2_projection_models.dart';
import 'activity_feed.dart';

class InterruptedCodexContinueTarget {
  const InterruptedCodexContinueTarget({
    required this.user,
    required this.failureId,
    required this.sourceAttemptId,
  });

  final ActivityFeedEntry user;
  final String failureId;
  final String sourceAttemptId;
}

/// Match desktop's empty-input continuation: only the latest settled,
/// interrupted Codex attempt can continue. Prior output is retained.
InterruptedCodexContinueTarget? resolveInterruptedCodexContinueTarget({
  required String? coreKind,
  required String? threadStatus,
  required bool isRunning,
  required ThreadRunProjectionSnapshot projection,
  required List<ActivityFeedEntry> entries,
}) {
  if (coreKind != 'codex' ||
      isRunning ||
      !const {'failed', 'blocked', 'idle'}.contains(threadStatus)) {
    return null;
  }
  final latest = projection.attempts.lastOrNull;
  if (latest == null ||
      !const {'failed', 'cancelled'}.contains(latest.status)) {
    return null;
  }
  ActivityFeedEntry? user;
  ActivityFeedEntry? failure;
  void visit(ActivityFeedEntry entry) {
    if (entry.kind == ActivityFeedKind.user) {
      user = entry;
      failure = null;
    } else if (entry.kind == ActivityFeedKind.error &&
        entry.agentId == null &&
        entry.canRetryRequest &&
        entry.runAttemptId == latest.attemptId) {
      failure = entry;
    } else if (entry.kind == ActivityFeedKind.turn) {
      for (final child in entry.processEntries) {
        visit(child);
      }
      final output = entry.finalOutput;
      if (output != null) visit(output);
    }
  }

  for (final entry in entries) {
    visit(entry);
  }
  final prompt = user;
  final error = failure;
  if (prompt == null ||
      prompt.activityLineId?.trim().isNotEmpty != true ||
      error == null) {
    return null;
  }
  return InterruptedCodexContinueTarget(
    user: prompt,
    failureId: error.id,
    sourceAttemptId: latest.attemptId,
  );
}
