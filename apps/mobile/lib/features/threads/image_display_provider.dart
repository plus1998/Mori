import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/image_display_models.dart';
import '../../core/models/image_view_models.dart';
import '../../core/utils/activity_display.dart';
import '../../core/providers/desktop_bind_ready.dart';
import '../../core/providers/app_providers.dart';
import 'thread_providers.dart';

/// Shared by the session menu and gallery. V2 owns the change signal; the
/// desktop artifact list owns IDs and file metadata, including older images
/// outside the currently loaded tool window.
final threadImageDisplayArtifactsProvider = FutureProvider.autoDispose
    .family<List<ImageDisplayArtifact>, String>((ref, threadId) async {
      ref.watch(
        conversationV2SessionProvider(threadId).select(
          (state) => (
            historyRevision: state.historyRevision,
            syncState: state.syncState,
            displayTools: state.tools
                .where((tool) => isEcoImageDisplayToolName(tool.name))
                .map((tool) => (tool.toolCallId, tool.versionSeq).toString())
                .join('|'),
          ),
        ),
      );
      ref.listen(ecoEventsProvider, (_, next) {
        final event = next.valueOrNull;
        if (event?.threadId == threadId &&
            event?.payload is Map &&
            event?.payload['type'] == 'thread.media_deleted') {
          ref.invalidateSelf();
        }
      });
      final rpc = ref.watch(desktopRpcProvider);
      if (rpc == null || threadId.isEmpty) return const [];
      if (!await ensureDesktopBindReady(ref)) {
        throw const ImageViewReadException(
          ImageViewReadFailureCode.bridgeUnavailable,
        );
      }
      final artifacts = [...await rpc.listImageDisplayArtifacts(threadId)]
        ..sort((left, right) {
          final byCreated = left.createdAt.compareTo(right.createdAt);
          return byCreated != 0 ? byCreated : left.id.compareTo(right.id);
        });
      return List<ImageDisplayArtifact>.unmodifiable(artifacts);
    });
