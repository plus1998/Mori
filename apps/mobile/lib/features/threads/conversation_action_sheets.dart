import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/locale/app_error_localizations.dart';
import '../../core/models/conversation_actions.dart';
import '../../core/models/thread_models.dart';
import '../../core/providers/app_providers.dart';
import '../../core/widgets/web_page_viewer.dart';
import 'thread_providers.dart';
import 'thread_session_route.dart';

Future<void> openExistingConversation(
  BuildContext context,
  WidgetRef ref,
  String threadId, {
  String? messageId,
  ThreadSessionRouteExtra? draft,
}) async {
  final rpc = ref.read(desktopRpcProvider);
  if (rpc == null) throw StateError('Desktop is not connected');
  final thread = await rpc.getThread(threadId);
  if (!context.mounted) return;
  if (thread == null) throw StateError(context.l10n.conversationMissing);
  ref.read(threadListProvider.notifier).upsertThread(thread, countAsNew: false);
  context.push(
    Uri(
      path: '/threads/$threadId',
      queryParameters: messageId == null ? null : {'messageId': messageId},
    ).toString(),
    extra: draft,
  );
}

Future<void> showConversationShare(BuildContext context, String threadId) =>
    Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => _ConversationSharePage(threadId: threadId),
      ),
    );

class _ConversationSharePage extends ConsumerStatefulWidget {
  const _ConversationSharePage({required this.threadId});
  final String threadId;
  @override
  ConsumerState<_ConversationSharePage> createState() =>
      _ConversationSharePageState();
}

class _ConversationSharePageState
    extends ConsumerState<_ConversationSharePage> {
  ConversationShare? _share;
  Object? _error;
  bool _busy = false;
  Future<void> _publish() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final rpc = ref.read(desktopRpcProvider);
      if (rpc == null) throw StateError('Desktop is not connected');
      final result = await rpc.shareConversation(widget.threadId);
      if (mounted) setState(() => _share = result);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final share = _share;
    return Scaffold(
      appBar: AppBar(title: Text(l.conversationShare)),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text(l.conversationShareHint),
          const SizedBox(height: 20),
          if (_error != null)
            SelectableText(
              localizedAppError(_error!, l),
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          if (share != null) ...[
            SelectableText(share.url),
            const SizedBox(height: 12),
            Text(
              '${l.conversationShareExpires}: ${DateFormat.yMd(l.localeName).add_Hm().format(share.expiresAt.toLocal())}',
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () async {
                try {
                  await Clipboard.setData(ClipboardData(text: share.url));
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(l.activityMessageCopied)),
                    );
                  }
                } catch (error) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(localizedAppError(error, l))),
                    );
                  }
                }
              },
              icon: const Icon(Icons.copy),
              label: Text(l.conversationShareCopy),
            ),
            OutlinedButton.icon(
              onPressed: () => Navigator.of(context).push<void>(
                MaterialPageRoute(
                  builder: (_) => WebPageViewer(
                    title: l.conversationSharePreview,
                    url: share.url,
                  ),
                ),
              ),
              icon: const Icon(Icons.open_in_new),
              label: Text(l.conversationSharePreview),
            ),
          ],
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : _publish,
            child: _busy
                ? const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(l.conversationShareCreate),
          ),
        ],
      ),
    );
  }
}

final planExecutionLinksProvider = FutureProvider.autoDispose
    .family<List<PlanExecutionLink>, String>((ref, threadId) async {
      final rpc = ref.watch(desktopRpcProvider);
      ref.watch(appForegroundProvider);
      ref.watch(connectionStatusProvider);
      ref.listen(ecoEventsProvider, (_, next) {
        final event = next.valueOrNull;
        if (event?.kind == 'thread.plan' && event?.threadId == threadId) {
          ref.invalidateSelf();
        }
      });
      if (rpc == null) throw StateError('Desktop is not connected');
      return rpc.listPlanExecutions(threadId);
    });

Future<void> showPlanExecutionLinks(BuildContext context, String threadId) =>
    Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => _PlanExecutionLinksPage(threadId: threadId),
      ),
    );

class _PlanExecutionLinksPage extends ConsumerWidget {
  const _PlanExecutionLinksPage({required this.threadId});
  final String threadId;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final links = ref.watch(planExecutionLinksProvider(threadId));
    final l = context.l10n;
    return Scaffold(
      appBar: AppBar(
        title: Text(l.conversationPlanLinks),
        actions: [
          IconButton(
            onPressed: () =>
                ref.invalidate(planExecutionLinksProvider(threadId)),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: links.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => _LoadFailure(
          error: error,
          retry: () => ref.invalidate(planExecutionLinksProvider(threadId)),
        ),
        data: (items) => items.isEmpty
            ? Center(child: Text(l.threadPlanEmpty))
            : ListView(
                children: [
                  for (final item in items)
                    Builder(
                      builder: (context) {
                        final source = item.sourceThreadId == threadId;
                        final deleted = source
                            ? item.executionDeleted
                            : item.sourceDeleted;
                        final status = switch (item.status) {
                          'queued' => l.schedulingPending,
                          'running' => l.schedulingRunning,
                          'completed' => l.schedulingCompleted,
                          'failed' => l.schedulingFailed,
                          'cancelled' => l.schedulingCancelled,
                          'interrupted' => l.schedulingInterrupted,
                          _ => item.status,
                        };
                        return ListTile(
                          leading: const Icon(Icons.account_tree_outlined),
                          title: Text(
                            '${source ? l.conversationPlanExecution : l.conversationPlanSource} · v${item.version} · $status',
                          ),
                          subtitle: Text(
                            [
                              item.planTitle,
                              source ? item.executionTitle : item.sourceTitle,
                              if (item.message.isNotEmpty) item.message,
                              if (deleted) l.conversationMissing,
                            ].join('\n'),
                          ),
                          enabled: !deleted,
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () async {
                            try {
                              await openExistingConversation(
                                context,
                                ref,
                                source
                                    ? item.executionThreadId
                                    : item.sourceThreadId,
                              );
                            } catch (error) {
                              if (context.mounted) {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(
                                    content: Text(localizedAppError(error, l)),
                                  ),
                                );
                              }
                            }
                          },
                        );
                      },
                    ),
                ],
              ),
      ),
    );
  }
}

Future<void> showWechatCompletionSettings(
  BuildContext context,
  String threadId,
) => Navigator.of(context).push<void>(
  MaterialPageRoute(builder: (_) => _WechatCompletionPage(threadId: threadId)),
);

class _WechatCompletionPage extends ConsumerStatefulWidget {
  const _WechatCompletionPage({required this.threadId});
  final String threadId;
  @override
  ConsumerState<_WechatCompletionPage> createState() =>
      _WechatCompletionPageState();
}

class _WechatCompletionPageState extends ConsumerState<_WechatCompletionPage> {
  late Future<ThreadSummary?> _thread;
  bool _busy = false;
  Object? _error;
  Future<ThreadSummary?> _load() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) throw StateError('Desktop is not connected');
    return rpc.getThread(widget.threadId);
  }

  @override
  void initState() {
    super.initState();
    _thread = _load();
  }

  Future<void> _change(bool enabled) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final rpc = ref.read(desktopRpcProvider);
      if (rpc == null) throw StateError('Desktop is not connected');
      final thread = await rpc.setWechatFollow(widget.threadId, enabled);
      if (!mounted) return;
      ref
          .read(threadSessionProvider(widget.threadId).notifier)
          .applyThreadSummary(thread);
      setState(() {
        _thread = Future.value(thread);
      });
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(ecoEventsProvider, (_, next) {
      final event = next.valueOrNull;
      if (!_busy &&
          event?.threadId == widget.threadId &&
          event?.payload is Map &&
          event?.payload['type'] == 'thread.wechat_follow_updated') {
        setState(() {
          _thread = _load();
        });
      }
    });
    return Scaffold(
      appBar: AppBar(title: Text(context.l10n.conversationWechat)),
      body: FutureBuilder<ThreadSummary?>(
        future: _thread,
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return _LoadFailure(
              error: snapshot.error!,
              retry: () => setState(() {
                _thread = _load();
              }),
            );
          }
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.data == null) {
            return Center(child: Text(context.l10n.conversationMissing));
          }
          return ListView(
            children: [
              SwitchListTile(
                title: Text(context.l10n.conversationWechat),
                subtitle: Text(context.l10n.conversationWechatHint),
                value: snapshot.data!.wechatFollowEnabled,
                onChanged: _busy ? null : _change,
              ),
              if (_busy) const LinearProgressIndicator(),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: SelectableText(
                    localizedAppError(_error!, context.l10n),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _LoadFailure extends StatelessWidget {
  const _LoadFailure({required this.error, required this.retry});
  final Object error;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SelectableText(localizedAppError(error, context.l10n)),
          TextButton(onPressed: retry, child: Text(context.l10n.commonRetry)),
        ],
      ),
    ),
  );
}
