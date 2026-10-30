import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/models/codex_account_models.dart';
import '../../core/models/eco_types.dart';
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
      final controller = CodexQuotaController(
        rpc: rpc,
        bindReady: () => ensureDesktopBindReady(ref),
        resetAttempts: ref.watch(_resetAttemptsProvider),
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
  const CodexQuotaSnapshot({required this.active, required this.accounts});
  final CodexActiveAccount active;
  final List<CodexAccount> accounts;
  CodexAccount? get account {
    for (final account in accounts) {
      if (account.id == active.id && active.canUseCredentials) return account;
    }
    return null;
  }

  List<CodexAccount> get candidates => accounts
      .where((account) => account.id != active.id && account.canUseCredentials)
      .toList();
}

class CodexQuotaFailure implements Exception {
  const CodexQuotaFailure(this.code);
  final String code;
  @override
  String toString() => code;
}

/// One refresh at a time. Confirm identity after every quota read, so an older
/// request can never label the previous account's quota as the new account's.
class CodexQuotaController
    extends StateNotifier<AsyncValue<CodexQuotaSnapshot>> {
  CodexQuotaController({
    required this.rpc,
    required this.bindReady,
    required this.resetAttempts,
  }) : super(const AsyncLoading()) {
    _timer = Timer.periodic(const Duration(seconds: 2), (_) {
      if (!AppLifecycleTracker.isForeground || _operation) return;
      if (state.valueOrNull?.active.hasPending == true) {
        unawaited(refresh(query: false));
      } else if (DateTime.now().difference(_lastQuery) >=
          const Duration(minutes: 2)) {
        unawaited(refresh());
      }
    });
  }
  final DesktopRpc? rpc;
  final Future<bool> Function() bindReady;
  final Map<String, String> resetAttempts;
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
      final active = await remote.getActiveCodexAccount();
      if (!mounted) return;
      // Immediately clear an old identity before waiting on the new quota.
      if (state.valueOrNull?.active.signature != active.signature) {
        state = const AsyncLoading();
      }
      if (active.syncState != 'ok') {
        throw StateError(active.syncMessage ?? 'Codex account sync failed');
      }
      var accounts = await remote.listCodexAccounts();
      if (active.id != null && active.canUseCredentials) {
        final found = accounts.where((a) => a.id == active.id).firstOrNull;
        if (found == null) throw const CodexQuotaFailure('removed');
        final quota = query || found.quota == null
            ? await remote.queryCodexAccountQuota(active.id!)
            : found.quota!;
        if (query || found.quota == null) _lastQuery = DateTime.now();
        accounts = [
          for (final a in accounts) a.id == active.id ? a.withQuota(quota) : a,
        ];
      } else {
        _lastQuery = DateTime.now();
      }
      final confirmed = await remote.getActiveCodexAccount();
      if (!mounted) return;
      if (confirmed.signature != active.signature) {
        state = const AsyncLoading();
        _again = true;
        _againQuery = true;
        return;
      }
      state = AsyncData(
        CodexQuotaSnapshot(active: confirmed, accounts: accounts),
      );
    } catch (error, stack) {
      if (mounted) state = AsyncError(error, stack);
    }
  }

  Future<void> refreshCandidate(String id) async {
    if (_operation) return;
    final current = state.valueOrNull;
    final remote = rpc;
    if (current == null || remote == null) return;
    final quota = await remote.queryCodexAccountQuota(id);
    if (!mounted ||
        state.valueOrNull?.active.signature != current.active.signature) {
      return;
    }
    final latest = state.valueOrNull!;
    state = AsyncData(
      CodexQuotaSnapshot(
        active: latest.active,
        accounts: [
          for (final a in latest.accounts) a.id == id ? a.withQuota(quota) : a,
        ],
      ),
    );
  }

  Future<void> switchAccount(String id) async {
    if (_operation) return;
    _operation = true;
    try {
      final remote = rpc;
      if (remote == null) throw const CodexQuotaFailure('disconnected');
      final accounts = await remote.listCodexAccounts();
      final quota = await remote.queryCodexAccountQuota(id);
      final account = accounts.where((a) => a.id == id).firstOrNull;
      if (account == null || !account.withQuota(quota).available) {
        await refresh(query: false);
        throw const CodexQuotaFailure('unavailable');
      }
      await remote.setActiveCodexAccount(id);
      await refresh();
    } finally {
      _operation = false;
    }
  }

  Future<String> reset() async {
    final current = state.valueOrNull;
    final remote = rpc;
    if (_operation ||
        remote == null ||
        current?.account == null ||
        current!.active.hasPending) {
      throw const CodexQuotaFailure('switching');
    }
    final id = current.account!.id;
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
