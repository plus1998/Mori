import '../models/conversation_v2_projection_models.dart';
import '../../l10n/generated/app_localizations.dart';

/// The main agent owns the main Feed's slot. A request can finish its narrative
/// before writing its next call, so request completion does not end this state.
ThreadRunProjectionRequestSpan? resolveToolWritingSpan(
  Iterable<ThreadRunProjectionRequestSpan> spans,
) {
  ThreadRunProjectionRequestSpan? newest;
  for (final span in spans) {
    if (span.ownerAgentId != null) continue;
    final writing = span.writingTool;
    if (writing == null ||
        ((writing.name?.isEmpty ?? true) &&
            (writing.kind?.isEmpty ?? true) &&
            (writing.target?.isEmpty ?? true))) {
      continue;
    }
    if (newest == null ||
        writing.since.compareTo(newest.writingTool!.since) > 0) {
      newest = span;
    }
  }
  return newest;
}

String toolWritingLabel(
  ThreadRunProjectionWritingTool writing,
  AppLocalizations l10n,
) {
  final rawTarget = writing.target;
  final target = rawTarget == null || rawTarget.isEmpty
      ? null
      : rawTarget.length > 64
      ? '${rawTarget.substring(0, 63)}…'
      : rawTarget;
  return switch (writing.kind) {
    'file' =>
      target == null
          ? l10n.activityWritingFile
          : l10n.activityWritingFileTarget(target),
    'read' =>
      target == null
          ? l10n.activityWritingRead
          : l10n.activityWritingReadTarget(target),
    'command' =>
      target == null
          ? l10n.activityWritingCommand
          : l10n.activityWritingCommandTarget(target),
    _ =>
      (target ?? writing.name)?.isNotEmpty == true
          ? l10n.activityWritingTool(target ?? writing.name!)
          : l10n.activityWritingUnknown,
  };
}
