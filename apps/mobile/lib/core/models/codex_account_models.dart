import 'thread_models.dart';

/// The same account-backed Codex selection used by the desktop quota card.
bool usesCodexAccount(
  ThreadRuntimeConfig config,
  String? coreKind, {
  ResolvedOrchestrationSnapshot? resolvedSnapshot,
}) {
  if (coreKind != 'codex') return false;
  final provider =
      config.mainAgentModelOverride?.providerId ??
      (config.resolvedOrchestrationSnapshot ?? resolvedSnapshot)
          ?.mainAgent
          .modelRef
          .providerId;
  return provider == 'openai' ||
      (provider == null &&
          config.orchestrationSelection?.mainAgentConfigId ==
              '__openai_official__');
}

class CodexQuotaWindow {
  const CodexQuotaWindow({
    required this.usedPercent,
    required this.seconds,
    required this.resetAfterSeconds,
    required this.resetAt,
  });
  factory CodexQuotaWindow.fromJson(Map<String, dynamic> json) =>
      CodexQuotaWindow(
        usedPercent: (json['usedPercent'] as num).toDouble(),
        seconds: (json['limitWindowSeconds'] as num).toInt(),
        resetAfterSeconds: (json['resetAfterSeconds'] as num).toInt(),
        resetAt: (json['resetAt'] as num).toInt(),
      );
  final double usedPercent;
  final int seconds;
  final int resetAfterSeconds;
  final int resetAt;
  bool get valid =>
      usedPercent.isFinite && usedPercent >= 0 && usedPercent <= 100;
  double get remaining => 100 - usedPercent;
  DateTime? resetsAt(int fetchedAt) => resetAt > 0
      ? DateTime.fromMillisecondsSinceEpoch(resetAt * 1000)
      : resetAfterSeconds > 0
      ? DateTime.fromMillisecondsSinceEpoch(
          fetchedAt + resetAfterSeconds * 1000,
        )
      : null;
}

class CodexAccountQuota {
  const CodexAccountQuota({
    required this.planType,
    required this.email,
    required this.allowed,
    required this.limitReached,
    required this.windows,
    required this.resetCreditsAvailable,
    required this.fetchedAt,
  });
  factory CodexAccountQuota.fromJson(Map<String, dynamic> json) {
    final rate = Map<String, dynamic>.from(json['rateLimit'] as Map);
    return CodexAccountQuota(
      planType: json['planType'] as String,
      email: json['email'] as String,
      allowed: rate['allowed'] as bool,
      limitReached: rate['limitReached'] as bool,
      windows: [
        for (final key in ['primaryWindow', 'secondaryWindow'])
          if (rate[key] != null)
            CodexQuotaWindow.fromJson(
              Map<String, dynamic>.from(rate[key] as Map),
            ),
      ],
      resetCreditsAvailable: (json['resetCreditsAvailable'] as num).toInt(),
      fetchedAt: (json['fetchedAt'] as num).toInt(),
    );
  }
  final String planType;
  final String email;
  final bool allowed;
  final bool limitReached;
  final List<CodexQuotaWindow> windows;
  final int resetCreditsAvailable;
  final int fetchedAt;
  bool get available =>
      allowed &&
      !limitReached &&
      windows.isNotEmpty &&
      windows.every((w) => w.valid && w.remaining > 0);
}

/// Only display fields are kept on mobile; credentials never travel with this model.
class CodexAccount {
  const CodexAccount({
    required this.id,
    required this.name,
    required this.email,
    required this.isLoggedIn,
    required this.authState,
    this.quota,
  });
  factory CodexAccount.fromJson(Map<String, dynamic> json) => CodexAccount(
    id: json['id'] as String,
    name: json['name'] as String,
    email: json['email'] as String? ?? '',
    isLoggedIn: json['isLoggedIn'] as bool,
    authState: json['authState'] as String,
    quota: json['quota'] == null
        ? null
        : CodexAccountQuota.fromJson(
            Map<String, dynamic>.from(json['quota'] as Map),
          ),
  );
  final String id;
  final String name;
  final String email;
  final bool isLoggedIn;
  final String authState;
  final CodexAccountQuota? quota;
  bool get configured => isLoggedIn && authState == 'configured';
  bool get available => configured && quota?.available == true;
  CodexAccount withQuota(CodexAccountQuota value) => CodexAccount(
    id: id,
    name: name,
    email: email,
    isLoggedIn: isLoggedIn,
    authState: authState,
    quota: value,
  );
}

class CodexActiveAccount {
  const CodexActiveAccount({
    required this.id,
    required this.isLoggedIn,
    required this.syncState,
    this.syncMessage,
    this.pendingId,
    this.hasPending = false,
  });
  factory CodexActiveAccount.fromJson(Map<String, dynamic> json) {
    final sync = Map<String, dynamic>.from(json['syncStatus'] as Map);
    return CodexActiveAccount(
      id: json['activeAccountId'] as String?,
      isLoggedIn: json['isLoggedIn'] as bool,
      syncState: sync['state'] as String,
      syncMessage: sync['message'] as String?,
      pendingId: json['pendingAccountId'] as String?,
      hasPending: json.containsKey('pendingAccountId'),
    );
  }
  final String? id;
  final bool isLoggedIn;
  final String syncState;
  final String? syncMessage;
  final String? pendingId;
  final bool hasPending;
  Object get signature =>
      (id, isLoggedIn, syncState, syncMessage, hasPending, pendingId);
}
