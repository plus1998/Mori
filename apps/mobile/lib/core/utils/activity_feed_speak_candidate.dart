import '../../features/threads/activity_feed.dart';

class ActivityFeedSpeakCandidate {
  const ActivityFeedSpeakCandidate({
    required this.id,
    required this.text,
    required this.streaming,
    this.runId,
  });

  final String id;
  final String text;
  final bool streaming;
  final String? runId;
}

/// Returns the latest assistant narrative block in chronological feed order.
ActivityFeedSpeakCandidate? findLatestAssistantSpeakCandidate(
  List<ActivityFeedEntry> entries,
) {
  ActivityFeedSpeakCandidate? latest;

  void visit(ActivityFeedEntry entry) {
    if (entry.kind == ActivityFeedKind.assistant &&
        entry.text.trim().isNotEmpty) {
      latest = ActivityFeedSpeakCandidate(
        id: entry.id,
        text: entry.text,
        streaming: entry.streaming,
      );
    }

    if (entry.kind == ActivityFeedKind.turn) {
      for (final child in entry.processEntries) {
        visit(child);
      }
      final output = entry.finalOutput;
      if (output != null) {
        visit(output);
      }
    }

    for (final child in entry.actionChildren) {
      visit(child);
    }
  }

  for (final entry in entries) {
    visit(entry);
  }
  return latest;
}

/// Auto-read only uses full final output from a successful root turn.
ActivityFeedSpeakCandidate? findLatestFinalAssistantSpeakCandidate(
  List<ActivityFeedEntry> entries,
) {
  ActivityFeedSpeakCandidate? latest;
  for (final entry in entries) {
    if (entry.kind != ActivityFeedKind.turn ||
        entry.running ||
        entry.turnStatus != 'completed') {
      continue;
    }
    final output = entry.finalOutput;
    if (output == null ||
        output.kind != ActivityFeedKind.assistant ||
        output.streaming ||
        output.text.trim().isEmpty) {
      continue;
    }
    latest = ActivityFeedSpeakCandidate(
      id: output.id,
      text: output.text,
      streaming: false,
      runId: entry.runAttemptId,
    );
  }
  return latest;
}

class ReadAloudAutoReadTracker {
  String? _threadId;
  String? _baseline;
  final _observedRuns = <String>{};

  ActivityFeedSpeakCandidate? observe(
    String threadId,
    bool running,
    ActivityFeedSpeakCandidate? candidate,
    bool enabled, {
    String? runningRunId,
  }) {
    if (threadId != _threadId || !enabled) {
      _threadId = threadId;
      _baseline = candidate?.id;
      _observedRuns.clear();
      if (enabled && running && runningRunId != null) {
        _observedRuns.add(runningRunId);
      }
      return null;
    }
    if (running && runningRunId != null) {
      _observedRuns.add(runningRunId);
    }
    if (candidate != null &&
        candidate.id != _baseline &&
        candidate.text.trim().isNotEmpty &&
        candidate.runId != null &&
        _observedRuns.remove(candidate.runId)) {
      _baseline = candidate.id;
      return candidate;
    }
    if (_observedRuns.isEmpty) _baseline = candidate?.id;
    return null;
  }
}
