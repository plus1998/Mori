import 'package:flutter/foundation.dart';
import '../../core/models/thread_models.dart';

/// Extra for `/threads/:threadId` when handing off from the landing composer
/// (`new`) to a real thread id without remounting the page.
class ThreadSessionRouteExtra {
  const ThreadSessionRouteExtra({
    this.handoff = false,
    this.prompt,
    this.attachments = const [],
  });

  final bool handoff;
  final String? prompt;
  final List<PromptImageAttachment> attachments;
}

/// Stable page key so `new` → real id updates the same route entry in place.
const ValueKey<String> threadSessionComposerPageKey = ValueKey<String>(
  'thread-session-composer',
);

/// Path segment for the empty composer / landing session.
const String threadSessionNewPathSegment = 'new';

LocalKey resolveThreadSessionPageKey({
  required String rawThreadId,
  required ValueKey<String> defaultPageKey,
  Object? extra,
}) {
  final isNew = rawThreadId == threadSessionNewPathSegment;
  final handoff = extra is ThreadSessionRouteExtra && extra.handoff == true;
  if (isNew || handoff) {
    return threadSessionComposerPageKey;
  }
  return defaultPageKey;
}
