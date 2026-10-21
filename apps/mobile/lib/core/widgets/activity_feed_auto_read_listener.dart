import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../features/threads/activity_feed.dart';
import '../providers/activity_feed_auto_read_provider.dart';
import '../providers/app_providers.dart';
import '../models/eco_types.dart';
import '../utils/activity_feed_speak_candidate.dart';
import 'read_aloud_thread_scope.dart';

class ActivityFeedAutoReadListener extends ConsumerStatefulWidget {
  const ActivityFeedAutoReadListener({
    super.key,
    required this.threadId,
    required this.entries,
    required this.child,
    this.running = false,
    this.ready = true,
  });
  final String threadId;
  final List<ActivityFeedEntry> entries;
  final Widget child;
  final bool running;
  final bool ready;
  @override
  ConsumerState<ActivityFeedAutoReadListener> createState() =>
      _ActivityFeedAutoReadListenerState();
}

class _ActivityFeedAutoReadListenerState
    extends ConsumerState<ActivityFeedAutoReadListener>
    with WidgetsBindingObserver {
  var _tracker = ReadAloudAutoReadTracker();
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      _tracker = ReadAloudAutoReadTracker();
    }
  }

  bool _scheduled = false;
  @override
  void deactivate() {
    unawaited(ref.read(ecoTtsServiceProvider).stop());
    super.deactivate();
  }

  @override
  void didUpdateWidget(ActivityFeedAutoReadListener oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.threadId != widget.threadId) {
      unawaited(ref.read(ecoTtsServiceProvider).stop());
    }
  }

  void _observe() {
    if (!mounted || !widget.ready) return;
    String? runningRunId;
    for (final entry in widget.entries) {
      if (entry.kind == ActivityFeedKind.turn && entry.running) {
        runningRunId = entry.runAttemptId;
      }
    }
    final next = _tracker.observe(
      widget.threadId,
      widget.running,
      findLatestFinalAssistantSpeakCandidate(widget.entries),
      ref.read(activityFeedAutoReadProvider) &&
          ref.read(connectionStatusProvider).valueOrNull?.state ==
              EcoConnectionState.connected &&
          (WidgetsBinding.instance.lifecycleState == null ||
              WidgetsBinding.instance.lifecycleState ==
                  AppLifecycleState.resumed),
      runningRunId: runningRunId,
    );
    if (next == null) return;
    final locale = Localizations.localeOf(context);
    final tts = ref.read(ecoTtsServiceProvider);
    unawaited(
      tts
          .speak(
            entryId: next.id,
            sourceText: next.text,
            locale: locale,
            threadId: widget.threadId,
          )
          .then((started) {
            if (!started && mounted && tts.lastError != null) {
              ScaffoldMessenger.of(
                context,
              ).showSnackBar(SnackBar(content: Text(tts.lastError!)));
            }
          }),
    );
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(connectionStatusProvider, (previous, next) {
      if (next.valueOrNull?.state != EcoConnectionState.connected) {
        _tracker = ReadAloudAutoReadTracker();
      }
    });
    ref.listen<bool>(activityFeedAutoReadProvider, (previous, next) {
      if (!next) unawaited(ref.read(ecoTtsServiceProvider).stop());
      _observe();
    });
    if (!_scheduled) {
      _scheduled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _scheduled = false;
        _observe();
      });
    }
    return ReadAloudThreadScope(threadId: widget.threadId, child: widget.child);
  }
}
