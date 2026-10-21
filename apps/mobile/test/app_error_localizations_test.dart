import 'package:eco_mobile/core/locale/app_error_localizations.dart';
import 'package:eco_mobile/core/models/app_error.dart';
import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/models/asr_models.dart';
import 'package:eco_mobile/core/utils/center_server_auth.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  final en = lookupAppLocalizations(const Locale('en'));
  final zh = lookupAppLocalizations(const Locale('zh'));

  test('localizes stable Eco Center error kinds', () {
    final error = EcoCenterException.app(EcoCenterErrorKind.serverUnreachable);

    expect(
      localizedAppError(error, en),
      'Cannot reach the server. Check the address and network.',
    );
    expect(localizedAppError(error, zh), '无法访问服务器，请检查地址与网络。');
  });

  test('preserves external Eco Center messages verbatim', () {
    final error = EcoCenterException.native('Server supplied detail');

    expect(localizedAppError(error, en), 'Server supplied detail');
    expect(error.nativeMessage, 'Server supplied detail');
  });

  test('connection errors do not expose native SDK exception text', () {
    final error = EcoCenterException.native(
      'AuthRetryableFetchException('
      'message: 502 Bad Gateway, statusCode: 502)',
      recovery: CenterServerAuthRecovery.network,
    );

    expect(
      localizedConnectionError(error, en),
      'Cannot connect to the server. Check your network and try again.',
    );
    expect(localizedConnectionError(error, zh), '无法连接服务端，请检查网络后重试。');
    expect(localizedConnectionError(error, en), isNot(contains('502')));
  });

  test('connection errors use a stable fallback for unknown failures', () {
    expect(
      localizedConnectionError(StateError('Unexpected protocol shape'), en),
      'Connection failed. Try again later.',
    );
    expect(
      localizedConnectionError(StateError('Unexpected protocol shape'), zh),
      '连接失败，请稍后重试。',
    );
  });

  test('localizes stable thread errors', () {
    expect(
      localizedAppError(
        const AppErrorCodeException(AppErrorCode.threadProjectionNoPcSelected),
        en,
      ),
      'Select a PC before requesting projection details',
    );
    expect(localizedAppError(threadNoPcSelectedErrorCode, zh), '未选择 PC');
  });

  test('retains speech error localization for mobile ASR errors', () {
    expect(
      localizedAppError(
        const AsrServiceException('permission_denied', 'native detail'),
        en,
      ),
      'Microphone permission is required for cloud speech recognition',
    );
    expect(
      localizedAppError(
        const AsrServiceException('permission_denied', 'native detail'),
        zh,
      ),
      '需要麦克风权限才能使用云端语音识别',
    );
    expect(
      localizedAppError(
        const AsrServiceException('network', 'native detail'),
        zh,
      ),
      '云端语音识别请求失败',
    );
  });

  test(
    'localizes every stable ASR error code without exposing native text',
    () {
      const codes = [
        'desktop_offline',
        'not_configured',
        'cancelled',
        'timeout',
        'audio_too_large',
        'missing_config',
        'auth_failed',
        'rate_limited',
        'invalid_response',
        'network',
      ];

      for (final code in codes) {
        const nativeMessage = '原始中文服务端错误';
        final error = AsrServiceException(code, nativeMessage);
        final english = localizedAppError(error, en);
        final chinese = localizedAppError(error, zh);

        expect(english, isNot(nativeMessage), reason: code);
        expect(english, isNotEmpty, reason: code);
        expect(chinese, isNotEmpty, reason: code);
      }
    },
  );

  test('unwraps StateNotifierListenerError to the nested cause', () {
    final controller = StateController<int>(0);
    controller.onError = (_, _) {};
    controller.addListener((_) {
      throw EcoCenterException.app(EcoCenterErrorKind.bindingRequired);
    }, fireImmediately: false);

    Object? thrown;
    try {
      controller.state = 1;
    } catch (error) {
      thrown = error;
    }

    expect(thrown, isA<StateNotifierListenerError>());
    expect(localizedAppError(thrown!, zh), '请先与 Desktop 配对后再打开 Realtime 通道。');
  });
}
