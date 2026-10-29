import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_error_localizations.dart';
import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/composer_reference_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/utils/composer_references.dart';
import '../../core/widgets/composer_prompt_editing_controller.dart';
import '../../l10n/generated/app_localizations.dart';
import '../threads/thread_providers.dart';
import 'composer_reference_providers.dart';

/// A compact, keyboard-preserving picker in the composer. Search stays in the
/// message field, so selecting context never pushes another keyboard or route.
class ComposerReferencePicker extends ConsumerStatefulWidget {
  const ComposerReferencePicker({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.runtimeConfig,
    required this.workspacePath,
    this.coreKind,
  });

  final ComposerPromptEditingController controller;
  final FocusNode focusNode;
  final ThreadRuntimeConfig runtimeConfig;
  final String workspacePath;
  final String? coreKind;

  @override
  ConsumerState<ComposerReferencePicker> createState() =>
      _ComposerReferencePickerState();
}

class _ComposerReferencePickerState
    extends ConsumerState<ComposerReferencePicker> {
  Timer? _debounce;
  ComposerMentionQuery? _mention;
  ComposerMentionQuery? _dismissed;
  String? _category;
  ({String query, String? kind})? _ready;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_sync);
    widget.focusNode.addListener(_sync);
    _sync(rebuild: false);
  }

  @override
  void didUpdateWidget(covariant ComposerReferencePicker oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller ||
        oldWidget.focusNode != widget.focusNode) {
      oldWidget.controller.removeListener(_sync);
      oldWidget.focusNode.removeListener(_sync);
      widget.controller.addListener(_sync);
      widget.focusNode.addListener(_sync);
      _dismissed = null;
      _sync(rebuild: false);
    }
  }

  void _sync({bool rebuild = true}) {
    final next = widget.focusNode.hasFocus
        ? widget.controller.mentionQuery
        : null;
    if (next != _mention) {
      if (next == null ||
          next.start != _mention?.start ||
          next.kind != _mention?.kind) {
        _category = next?.kind;
      }
      _mention = next;
      if (next == null) _dismissed = null;
      _schedule();
    }
    if (rebuild && mounted) setState(() {});
  }

  void _schedule() {
    _debounce?.cancel();
    _ready = null;
    if (_mention == null) return;
    final request = (query: _mention!.query, kind: _category);
    _debounce = Timer(const Duration(milliseconds: 120), () {
      if (mounted) setState(() => _ready = request);
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    widget.controller.removeListener(_sync);
    widget.focusNode.removeListener(_sync);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final mention = _mention;
    if (mention == null || mention == _dismissed) {
      return const SizedBox.shrink();
    }
    final l10n = context.l10n;
    final eco = ecoColors(context);
    final request = (
      query: mention.query,
      kind: _category,
      runtimeConfig: widget.runtimeConfig,
      workspacePath: widget.workspacePath,
      coreKind: widget.coreKind,
    );
    final connected = ref.watch(desktopRpcProvider) != null;
    final result = _ready == (query: mention.query, kind: _category)
        ? ref.watch(composerReferenceSearchProvider(request))
        : const AsyncLoading<ComposerReferenceSearchResult>();
    final referenced = parseComposerPrompt(widget.controller.prompt)
        .where((part) => part.isReference)
        .map((part) => '${part.kind}:${part.id}')
        .toSet();
    final items =
        result.valueOrNull?.items
            .where((item) => !referenced.contains(item.key))
            .toList() ??
        [];
    // Scaffold removes viewInsets from its body MediaQuery after resizing it.
    // Read the view too, so a native keyboard still bounds this inline panel.
    final keyboardHeight = math.max(
      MediaQuery.viewInsetsOf(context).bottom,
      View.of(context).viewInsets.bottom / View.of(context).devicePixelRatio,
    );
    final availableHeight = MediaQuery.sizeOf(context).height - keyboardHeight;
    final height = math.min(290.0, math.max(160.0, availableHeight * .5));
    return TextFieldTapRegion(
      child: Container(
        key: const ValueKey('composer-reference-picker'),
        height: height,
        margin: const EdgeInsets.fromLTRB(4, 0, 4, 12),
        decoration: BoxDecoration(
          color: eco.textPrimary.withValues(alpha: .035),
          borderRadius: BorderRadius.circular(18),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 12, right: 2),
              child: Row(
                children: [
                  Icon(
                    Icons.alternate_email_rounded,
                    size: 16,
                    color: eco.textSecondary,
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      l10n.composerReferencesChoose,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: eco.textPrimary,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: l10n.commonClose,
                    constraints: const BoxConstraints(
                      minWidth: 44,
                      minHeight: 44,
                    ),
                    visualDensity: VisualDensity.compact,
                    onPressed: () => setState(() => _dismissed = mention),
                    icon: Icon(EcoIcons.close, size: 16, color: eco.textMuted),
                  ),
                ],
              ),
            ),
            SizedBox(
              height: math.max(
                44,
                MediaQuery.textScalerOf(context).scale(12) * 1.3 + 20,
              ),
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                children: [
                  for (final kind in const [
                    null,
                    'ssh',
                    'web',
                    'conversation',
                    'integration',
                    'todo',
                    'mcp',
                    'subagent',
                  ])
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 3),
                      child: Semantics(
                        selected: _category == kind,
                        child: Material(
                          color: Colors.transparent,
                          borderRadius: BorderRadius.circular(20),
                          child: InkWell(
                            canRequestFocus: false,
                            borderRadius: BorderRadius.circular(20),
                            onTap: () => setState(() {
                              _category = kind;
                              _schedule();
                            }),
                            child: Center(
                              child: DecoratedBox(
                                decoration: BoxDecoration(
                                  color: _category == kind
                                      ? eco.textPrimary
                                      : Colors.transparent,
                                  borderRadius: BorderRadius.circular(999),
                                ),
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 12,
                                    vertical: 6,
                                  ),
                                  child: Text(
                                    _kindLabel(l10n, kind),
                                    style: TextStyle(
                                      fontSize: 12,
                                      height: 1.2,
                                      fontWeight: FontWeight.w500,
                                      color: _category == kind
                                          ? Theme.of(
                                              context,
                                            ).colorScheme.surface
                                          : eco.textSecondary,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            Expanded(
              child: !connected
                  ? _notice(l10n.composerReferencesDisconnected)
                  : result.hasError
                  ? SingleChildScrollView(
                      child: Column(
                        children: [
                          _notice(localizedAppError(result.error!, l10n)),
                          TextButton(
                            onPressed: () => ref.invalidate(
                              composerReferenceSearchProvider(request),
                            ),
                            child: Text(l10n.commonRetry),
                          ),
                        ],
                      ),
                    )
                  : result.isLoading
                  ? Center(
                      child: Semantics(
                        label: l10n.composerReferencesLoading,
                        child: const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      ),
                    )
                  : items.isEmpty
                  ? _notice(l10n.composerReferencesEmpty)
                  : ListView.builder(
                      key: ValueKey((mention.query, _category)),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 4,
                      ),
                      itemCount: items.length,
                      itemBuilder: (context, index) {
                        final item = items[index];
                        final label = item.kind == 'integration'
                            ? switch (item.id) {
                                'browser' => l10n.composerBrowser,
                                'imageGeneration' =>
                                  l10n.composerImageGeneration,
                                'computerUse' => l10n.composerComputerUse,
                                'tts' => l10n.composerReferencesSpeech,
                                _ => item.label,
                              }
                            : item.label;
                        return Material(
                          color: Colors.transparent,
                          child: InkWell(
                            canRequestFocus: false,
                            borderRadius: BorderRadius.circular(12),
                            onTap: () {
                              widget.controller.insertReference(
                                composerReferenceToken(
                                  kind: item.kind,
                                  id: item.id,
                                  label: label,
                                  detail: item.detail,
                                ),
                                mention,
                              );
                              widget.focusNode.requestFocus();
                            },
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 9,
                              ),
                              child: Row(
                                children: [
                                  Container(
                                    width: 32,
                                    height: 32,
                                    decoration: BoxDecoration(
                                      color: eco.composerContextBg,
                                      borderRadius: BorderRadius.circular(10),
                                    ),
                                    child: Icon(
                                      _referenceIcon(item),
                                      size: 16,
                                      color: eco.textSecondary,
                                    ),
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          label,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                            fontSize: 14,
                                            fontWeight: FontWeight.w500,
                                            color: eco.textPrimary,
                                          ),
                                        ),
                                        Text(
                                          [
                                            _kindLabel(l10n, item.kind),
                                            if (item.detail.isNotEmpty)
                                              item.detail,
                                          ].join(' · '),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                            fontSize: 11,
                                            color: eco.textMuted,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  Icon(
                                    Icons.add_rounded,
                                    size: 17,
                                    color: eco.textMuted,
                                  ),
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    ),
            ),
            if (result.valueOrNull?.hasMore == true && !result.isLoading)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 2, 12, 8),
                child: Text(
                  l10n.composerReferencesMore,
                  style: TextStyle(fontSize: 11, color: eco.textMuted),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _notice(String message) => Center(
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Text(
        message,
        textAlign: TextAlign.center,
        style: TextStyle(
          fontSize: 12,
          height: 1.4,
          color: ecoColors(context).textMuted,
        ),
      ),
    ),
  );
}

String _kindLabel(AppLocalizations l10n, String? kind) => switch (kind) {
  'ssh' => l10n.composerReferencesSsh,
  'web' => l10n.composerReferencesWeb,
  'conversation' => l10n.composerReferencesConversation,
  'integration' => l10n.composerIntegrations,
  'todo' => l10n.todosTitle,
  'mcp' => 'MCP',
  'subagent' => l10n.composerSubagents,
  _ => l10n.composerReferencesAll,
};

IconData _referenceIcon(ComposerReference reference) =>
    switch (reference.kind) {
      'ssh' => EcoIcons.terminal,
      'web' => EcoIcons.browser,
      'conversation' => EcoIcons.sessions,
      'integration' => switch (reference.id) {
        'browser' => EcoIcons.browser,
        'imageGeneration' => EcoIcons.image,
        'computerUse' => EcoIcons.computer,
        'tts' => EcoIcons.volume2,
        _ => EcoIcons.tool,
      },
      'todo' => EcoIcons.todos,
      'mcp' => EcoIcons.mcp,
      'subagent' => EcoIcons.subagents,
      _ => Icons.alternate_email_rounded,
    };
