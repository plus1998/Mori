import '../models/thread_models.dart';
import 'composer_references.dart';
import '../../l10n/generated/app_localizations.dart';

bool isFollowUpThreadLiveEvent({
  required String kind,
  required String liveType,
  bool hasFollowUp = false,
}) {
  return kind == 'thread.follow_up' ||
      liveType.startsWith('thread.follow_up.') ||
      hasFollowUp;
}

String? resolveThreadEventThreadId({
  String? envelopeThreadId,
  String? payloadThreadId,
}) {
  final envelope = envelopeThreadId?.trim();
  if (envelope != null && envelope.isNotEmpty) {
    return envelope;
  }
  final payload = payloadThreadId?.trim();
  if (payload != null && payload.isNotEmpty) {
    return payload;
  }
  return null;
}

bool isLiveFollowUpThreadStatus(String? status) {
  return status == 'running' || status == 'queued';
}

/// Composer should enqueue (not continue) while live, editing, or queue-paused.
bool shouldComposerUseFollowUpQueue({
  String? status,
  String? editingFollowUpId,
  bool followUpQueuePaused = false,
}) {
  return isLiveFollowUpThreadStatus(status) ||
      (editingFollowUpId != null && editingFollowUpId.isNotEmpty) ||
      followUpQueuePaused;
}

/// Whether the row's Guide action can be used.
/// Normal rows are always escalatable. An already-escalated row only becomes usable
/// again while the queue is paused: it is stuck there (escalate does not drain past the
/// pause), so tapping it means "send this one now".
bool canEscalateFollowUp({
  required String priority,
  required bool queuePaused,
}) {
  return priority != 'escalated' || queuePaused;
}

List<ThreadPendingFollowUp> sortThreadFollowUps(
  List<ThreadPendingFollowUp> followUps,
) {
  final sorted = [...followUps];
  sorted.sort(_compareThreadFollowUps);
  return sorted;
}

List<ThreadPendingFollowUp> queuedThreadFollowUps(
  List<ThreadPendingFollowUp> followUps,
) {
  return sortThreadFollowUps(
    followUps,
  ).where((followUp) => followUp.status == 'queued').toList();
}

List<ThreadPendingFollowUp> mergeThreadFollowUp(
  List<ThreadPendingFollowUp> current,
  ThreadPendingFollowUp followUp,
) {
  return mergeThreadFollowUps(current, [followUp]);
}

/// Merge RPC replies and live events by update time; stale rows cannot undo delivery.
List<ThreadPendingFollowUp> mergeThreadFollowUps(
  List<ThreadPendingFollowUp> current,
  List<ThreadPendingFollowUp> incoming,
) {
  final next = {for (final item in current) item.id: item};
  for (final item in incoming) {
    final existing = next[item.id];
    if (existing != null) {
      if (existing.updatedAt.compareTo(item.updatedAt) > 0) continue;
      if (existing.updatedAt == item.updatedAt &&
          _isTerminalFollowUp(existing) &&
          !_isTerminalFollowUp(item)) {
        continue;
      }
      if (existing.updatedAt == item.updatedAt &&
          ['cancelled', 'superseded', 'failed'].contains(existing.status) &&
          item.status == 'applied') {
        continue;
      }
    }
    next[item.id] = item;
  }
  return sortThreadFollowUps(next.values.toList());
}

bool _isTerminalFollowUp(ThreadPendingFollowUp item) =>
    item.status != 'queued' && item.status != 'delivered';

String formatThreadFollowUpPreview(
  ThreadPendingFollowUp followUp,
  AppLocalizations l10n,
) {
  final prompt = composerPromptDisplayText(followUp.prompt).trim();
  final imageCount = followUp.attachments.length;
  final imageLabel = l10n.followUpImages(imageCount);
  if (prompt.length > 120) {
    final clipped = '${prompt.substring(0, 117)}...';
    return imageCount > 0 ? '$clipped ($imageLabel)' : clipped;
  }
  if (prompt.isNotEmpty) {
    return imageCount > 0 ? '$prompt ($imageLabel)' : prompt;
  }
  return imageCount > 0 ? imageLabel : l10n.followUpEmptyGuidance;
}

int _compareThreadFollowUps(
  ThreadPendingFollowUp left,
  ThreadPendingFollowUp right,
) {
  final positionDelta =
      (left.queuePosition ?? 0x7fffffffffffffff) -
      (right.queuePosition ?? 0x7fffffffffffffff);
  if (positionDelta != 0) {
    return positionDelta;
  }
  final priorityDelta = _priorityRank(left) - _priorityRank(right);
  if (priorityDelta != 0) {
    return priorityDelta;
  }
  final createdDelta = left.createdAt.compareTo(right.createdAt);
  if (createdDelta != 0) {
    return createdDelta;
  }
  return left.id.compareTo(right.id);
}

int _priorityRank(ThreadPendingFollowUp followUp) {
  return followUp.priority == 'escalated' ? 0 : 1;
}
