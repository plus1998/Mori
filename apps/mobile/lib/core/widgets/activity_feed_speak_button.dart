import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../locale/app_localizations_ext.dart';
import '../providers/app_providers.dart';
import '../theme/eco_icons.dart';
import '../theme/eco_theme.dart';
import '../services/eco_tts_service.dart';
import 'read_aloud_thread_scope.dart';

const activityFeedMessageActionIconSize = 15.0;
const activityFeedMessageActionGap = 2.0;
const activityFeedMessageActionTapSize = 30.0;

TextStyle? activityFeedMetaLabelStyle(BuildContext context) {
  final eco = ecoColors(context);
  return Theme.of(context).textTheme.labelSmall?.copyWith(
    color: eco.textMuted.withValues(alpha: 0.7),
    height: 1.2,
  );
}

ButtonStyle activityFeedMessageActionStyle(
  BuildContext context, {
  bool active = false,
}) {
  final eco = ecoColors(context);
  return IconButton.styleFrom(
    foregroundColor: active
        ? eco.accentText
        : eco.textMuted.withValues(alpha: 0.7),
    minimumSize: const Size(
      activityFeedMessageActionTapSize,
      activityFeedMessageActionTapSize,
    ),
    maximumSize: const Size(
      activityFeedMessageActionTapSize,
      activityFeedMessageActionTapSize,
    ),
    padding: EdgeInsets.zero,
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    visualDensity: VisualDensity.compact,
  );
}

class ActivityFeedCopyButton extends StatelessWidget {
  const ActivityFeedCopyButton({
    super.key,
    required this.onPressed,
    this.tooltip,
  });

  final VoidCallback onPressed;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      onPressed: onPressed,
      icon: const Icon(EcoIcons.copy, size: activityFeedMessageActionIconSize),
      tooltip: tooltip ?? context.l10n.activityCopyMessage,
      style: activityFeedMessageActionStyle(context),
    );
  }
}

class ActivityFeedSpeakButton extends ConsumerWidget {
  const ActivityFeedSpeakButton({
    super.key,
    required this.entryId,
    required this.sourceText,
  });

  final String entryId;
  final String sourceText;

  Future<void> _handleTap(BuildContext context, WidgetRef ref) async {
    final tts = ref.read(ecoTtsServiceProvider);
    if (tts.isSpeakingEntry(entryId)) {
      await tts.stop();
      return;
    }

    final locale = Localizations.localeOf(context);
    final started = await tts.speak(
      entryId: entryId,
      sourceText: sourceText,
      locale: locale,
      threadId: ReadAloudThreadScope.of(context),
    );
    if (!started && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(tts.lastError ?? context.l10n.ttsUnavailable)),
      );
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tts = ref.watch(ecoTtsServiceProvider);
    final speaking = tts.isSpeakingEntry(entryId);

    return IconButton(
      onPressed: () => _handleTap(context, ref),
      icon: speaking && tts.state == TtsPlaybackState.preparing
          ? const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 1.5),
            )
          : Icon(
              speaking ? EcoIcons.speaking : EcoIcons.volume2,
              size: activityFeedMessageActionIconSize,
            ),
      tooltip: speaking
          ? context.l10n.activityStopSpeaking
          : context.l10n.activitySpeakMessage,
      style: activityFeedMessageActionStyle(context, active: speaking),
    );
  }
}

class ActivityFeedMessageActions extends StatelessWidget {
  const ActivityFeedMessageActions({
    super.key,
    required this.entryId,
    required this.sourceText,
  });

  final String entryId;
  final String sourceText;

  Future<void> _copy(BuildContext context) async {
    final text = sourceText.trim();
    if (text.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: text));
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(context.l10n.activityMessageCopied)),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          ActivityFeedCopyButton(onPressed: () => _copy(context)),
          const SizedBox(width: activityFeedMessageActionGap),
          ActivityFeedSpeakButton(entryId: entryId, sourceText: sourceText),
        ],
      ),
    );
  }
}
