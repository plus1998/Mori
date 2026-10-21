import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/generated/app_localizations.dart';
import '../models/app_error.dart';
import '../models/eco_types.dart';
import '../models/asr_models.dart';
import '../models/image_view_models.dart';
import '../utils/center_server_auth.dart';

String localizedAppError(Object error, AppLocalizations l10n) {
  // Riverpod StateProvider updates wrap listener failures in this type; the
  // useful message is the nested cause, not the StateController wrapper.
  if (error is StateNotifierListenerError && error.errors.isNotEmpty) {
    return localizedAppError(error.errors.first, l10n);
  }
  if (error is ImageViewReadException) {
    return switch (error.code) {
      ImageViewReadFailureCode.invalidPath =>
        l10n.activityImageViewErrorInvalidPath,
      ImageViewReadFailureCode.notFound => l10n.activityImageViewErrorNotFound,
      ImageViewReadFailureCode.symbolicLink =>
        l10n.activityImageViewErrorSymbolicLink,
      ImageViewReadFailureCode.notFile => l10n.activityImageViewErrorNotFile,
      ImageViewReadFailureCode.tooLarge => l10n.activityImageViewErrorTooLarge,
      ImageViewReadFailureCode.unsupportedType =>
        l10n.activityImageViewErrorUnsupportedType,
      ImageViewReadFailureCode.bridgeUnavailable =>
        l10n.activityImageViewErrorBridgeUnavailable,
      ImageViewReadFailureCode.invalidResponse =>
        l10n.activityImageViewErrorReadFailed,
    };
  }
  if (error is EcoCenterException) {
    final nativeMessage = error.nativeMessage?.trim();
    final localized = switch (error.kind) {
      EcoCenterErrorKind.invalidServerScheme => l10n.errorInvalidServerScheme,
      EcoCenterErrorKind.deviceCredentialsRequired =>
        l10n.errorDeviceCredentialsRequired,
      EcoCenterErrorKind.quickPairQrOutdated => l10n.errorQuickPairQrOutdated,
      EcoCenterErrorKind.serverUnreachable => l10n.errorServerUnreachable,
      EcoCenterErrorKind.websocketDisconnected =>
        l10n.errorWebSocketDisconnected,
      EcoCenterErrorKind.rpcTimeout => l10n.errorRpcTimeout,
      EcoCenterErrorKind.serverUrlRequired => l10n.errorServerUrlRequired,
      EcoCenterErrorKind.anonKeyRequired => l10n.errorAnonKeyRequired,
      EcoCenterErrorKind.connectionAborted => l10n.errorConnectionAborted,
      EcoCenterErrorKind.websocketTimeout => l10n.errorWebSocketTimeout,
      EcoCenterErrorKind.rpcFailed => l10n.errorRpcFailed,
      EcoCenterErrorKind.userSessionExpired => l10n.authRelogin,
      EcoCenterErrorKind.deviceCredentialsMissing =>
        l10n.errorDeviceCredentialsMissing,
      EcoCenterErrorKind.serverOutdated => l10n.errorServerOutdated,
      EcoCenterErrorKind.httpRequestFailed => l10n.errorHttpRequestFailed(
        error.code ?? 0,
      ),
      EcoCenterErrorKind.networkRequestFailed => l10n.errorNetworkRequestFailed,
      EcoCenterErrorKind.invalidPairQr => l10n.errorInvalidPairQr,
      EcoCenterErrorKind.reauthRequired => l10n.authRelogin,
      EcoCenterErrorKind.bindingRequired => l10n.errorBindingRequired,
      EcoCenterErrorKind.invalidCredentials => l10n.authInvalidCredentials,
      null => null,
    };
    if (localized != null) return localized;
    if (nativeMessage?.isNotEmpty == true) return nativeMessage!;
    return error.message;
  }
  if (error is AsrServiceException) {
    return switch (error.code) {
      'desktop_offline' => l10n.asrDesktopOffline,
      'not_configured' => l10n.asrNotConfigured,
      'cancelled' => l10n.asrCancelled,
      'timeout' => l10n.asrTimeout,
      'audio_too_large' => l10n.asrAudioTooLarge,
      'missing_config' => l10n.asrMissingConfig,
      'auth_failed' => l10n.asrAuthFailed,
      'rate_limited' => l10n.asrRateLimited,
      'invalid_response' => l10n.asrInvalidResponse,
      'network' => l10n.asrNetwork,
      'permission_denied' => l10n.speechPermissionDenied,
      'unavailable' => l10n.speechUnavailable,
      'busy' => l10n.speechBusy,
      'no_match' ||
      'empty_recording' ||
      'empty_response' => l10n.composerNoSpeech,
      _ => l10n.speechRecognitionFailed,
    };
  }
  if (error is AppErrorCodeException) {
    return switch (error.code) {
      AppErrorCode.threadNoPcSelected => l10n.projectNoPcSelected,
      AppErrorCode.threadProjectionNoPcSelected =>
        l10n.threadProjectionNoPcSelected,
    };
  }
  if (error is String && error == threadNoPcSelectedErrorCode) {
    return l10n.projectNoPcSelected;
  }
  return error.toString();
}

/// Returns a safe message for connectivity-dependent content.
///
/// Unlike [localizedAppError], this deliberately does not expose arbitrary
/// native SDK or HTTP exception text. Recovery actions are shown when known;
/// unknown failures receive a stable generic message.
String localizedConnectionError(Object error, AppLocalizations l10n) {
  if (error is EcoCenterException) {
    final recovery =
        error.recovery ??
        classifyCenterServerAuthError(error.nativeMessage ?? error.message);
    if (recovery != CenterServerAuthRecovery.unknown) {
      return localizedCenterServerRecovery(recovery, l10n);
    }
    if (error.kind != null) {
      return localizedAppError(error, l10n);
    }
  }
  return l10n.authUnknown;
}

String localizedEcoCenterNotice(EcoCenterNotice notice, AppLocalizations l10n) {
  return switch (notice.kind) {
    EcoCenterNoticeKind.deviceInactive => l10n.authDeviceInactive,
    EcoCenterNoticeKind.localSignOutCleanupFailed => l10n.signOutCleanupFailed(
      notice.nativeMessage ?? '',
    ),
  };
}

String? localizedEcoCenterMessageKey(String? message, AppLocalizations l10n) {
  if (message == null || !message.startsWith('eco_center.')) return null;
  final kindName = message.substring('eco_center.'.length);
  for (final kind in EcoCenterErrorKind.values) {
    if (kind.name == kindName) {
      return localizedAppError(EcoCenterException.app(kind), l10n);
    }
  }
  return null;
}

String localizedCenterServerRecovery(
  CenterServerAuthRecovery recovery,
  AppLocalizations l10n,
) {
  return switch (recovery) {
    CenterServerAuthRecovery.network => l10n.authNetwork,
    CenterServerAuthRecovery.deviceInactive => l10n.authDeviceInactive,
    CenterServerAuthRecovery.accountUnusable => l10n.authAccountUnusable,
    CenterServerAuthRecovery.relogin => l10n.authRelogin,
    CenterServerAuthRecovery.unknown => l10n.authUnknown,
  };
}
