import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/models/codex_account_models.dart';
import '../../core/models/eco_types.dart';
import '../../core/models/thread_runtime_config.dart';
import '../../core/network/desktop_rpc.dart';
import '../../core/providers/app_providers.dart';
import '../../core/providers/desktop_bind_ready.dart';
import '../../core/widgets/lifecycle_tracker.dart';
import 'thread_providers.dart';

// Survives closing/reopening the sheet after an uncertain reset response.
final _resetAttemptsProvider = Provider((ref) => <String, String>{});

final codexQuotaProvider =
    StateNotifierProvider.autoDispose<
      CodexQuotaController,
      AsyncValue<CodexQuotaSnapshot>
    >((ref) {
      final rpc = ref.watch(desktopRpcProvider);
      final config = ref.watch(runtimeConfigProvider);
      final model = config == null ? null : resolveThreadMainModel(config);
      final controller = CodexQuotaController(
        rpc: rpc,
        bindReady: () => ensureDesktopBindReady(ref),
        resetAttempts: ref.watch(_resetAttemptsProvider),
        accountId: model?.providerId == 'openai' ? model?.accountId : null,
      );
      ref.listen(ecoEventsProvider, (_, next) {
        next.whenData((event) {
          if (event.kind == 'openai-accounts.changed') {
            unawaited(controller.refresh(query: false));
          }
        });
      });
      ref.listen(connectionStatusProvider, (previous, next) {
        if (next.valueOrNull?.state == EcoConnectionState.connected &&
            previous?.valueOrNull?.state != EcoConnectionState.connected) {
          unawaited(controller.refresh());
        }
      });
      unawaited(controller.refresh());
      return controller;
    });

class CodexQuotaSnapshot {
  const CodexQuotaSnapshot({required this.accountId, required this.accounts});
  final String? accountId;
  final List<CodexAccount> accounts;
  CodexAccount? get account => accounts
      .where((entry) => entry.id == accountId && entry.canUseCredentials)
      .firstOrNull;
}

class CodexQuotaFailure implements Exception {
  const CodexQuotaFailure(this.code);
  final String code;
  @override
  String toString() => code;
}

/// Bound to one session account. A changed model creates a new controller.
class CodexQuotaController
    extends StateNotifier<AsyncValue<CodexQuotaSnapshot>> {
  CodexQuotaController({
    required this.rpc,
    required this.bindReady,
    required this.resetAttempts,
    required this.accountId,
  }) : super(const AsyncLoading()) {
    _timer = Timer.periodic(const Duration(seconds: 2), (_) {
      if (!AppLifecycleTracker.isForeground || _operation) return;
      if (DateTime.now().difference(_lastQuery) >= const Duration(minutes: 2)) {
        unawaited(refresh());
      }
    });
  }
  final DesktopRpc? rpc;
  final Future<bool> Function() bindReady;
  final Map<String, String> resetAttempts;
  final String? accountId;
  late final Timer _timer;
  Future<void>? _inFlight;
  bool _again = false;
  bool _againQuery = false;
  bool _operation = false;
  DateTime _lastQuery = DateTime.fromMillisecondsSinceEpoch(0);

  Future<void> refresh({bool query = true}) {
    if (!mounted) return Future.value();
    if (_inFlight != null) {
      _again = true;
      _againQuery |= query;
      return _inFlight!;
    }
    final work = _refresh(query);
    _inFlight = work;
    return work.whenComplete(() {
      _inFlight = null;
      if (_again && mounted) {
        final queryAgain = _againQuery;
        _again = false;
        _againQuery = false;
        unawaited(refresh(query: queryAgain));
      }
    });
  }

  Future<void> _refresh(bool query) async {
    if (query) _lastQuery = DateTime.now();
    try {
      final remote = rpc;
      if (remote == null || !await bindReady()) {
        throw const CodexQuotaFailure('disconnected');
      }
      final selectedId = accountId;
      if (selectedId == null) {
        if (mounted) {
          state = const AsyncData(
            CodexQuotaSnapshot(accountId: null, accounts: []),
          );
        }
        return;
      }
      var accounts = await remote.listCodexAccounts();
      var account = accounts
          .where((entry) => entry.id == selectedId)
          .firstOrNull;
      if (account == null) {
        throw const CodexQuotaFailure('removed');
      }
      if (!account.canUseCredentials) {
        throw const CodexQuotaFailure('unavailable');
      }
      final quota = query || account.quota == null
          ? await remote.queryCodexAccountQuota(selectedId)
          : account.quota!;
      // Re-read after a remote call so deletion or logout cannot produce stale UI.
      accounts = await remote.listCodexAccounts();
      account = accounts.where((entry) => entry.id == selectedId).firstOrNull;
      if (account == null) {
        throw const CodexQuotaFailure('removed');
      }
      if (!account.canUseCredentials) {
        throw const CodexQuotaFailure('unavailable');
      }
      if (!mounted) return;
      state = AsyncData(
        CodexQuotaSnapshot(
          accountId: selectedId,
          accounts: [
            for (final entry in accounts)
              entry.id == selectedId ? entry.withQuota(quota) : entry,
          ],
        ),
      );
    } catch (error, stack) {
      if (mounted) state = AsyncError(error, stack);
    }
  }

  Future<String> reset() async {
    final current = state.valueOrNull;
    final remote = rpc;
    if (_operation || remote == null || current?.account == null) {
      throw const CodexQuotaFailure('switching');
    }
    final id = current!.account!.id;
    final key = '${remote.desktopDeviceId}:$id';
    _operation = true;
    try {
      final attempt = resetAttempts.putIfAbsent(key, () => const Uuid().v4());
      final outcome = await remote.resetCodexAccountQuota(id, attempt);
      resetAttempts.remove(key);
      await refresh();
      return outcome;
    } finally {
      _operation = false;
    }
  }

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }
}
