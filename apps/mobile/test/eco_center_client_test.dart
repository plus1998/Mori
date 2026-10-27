import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/network/eco_realtime.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'repeated initialize does not rebroadcast unchanged connection state',
    () async {
      final client = EcoCenterClient(store: _MemoryCredentialStore());
      final states = <EcoConnectionState>[];
      final subscription = client.connectionStatus.listen(
        (s) => states.add(s.state),
      );
      await client.initialize();
      await client.initialize();
      await client.initialize();
      await Future<void>.delayed(Duration.zero);
      expect(states, [EcoConnectionState.disconnected]);
      await subscription.cancel();
      await client.dispose();
    },
  );

  test('Realtime reconnect backs off and caps repeated failures', () {
    expect(
      List.generate(8, (attempt) => ecoRealtimeReconnectDelayMs(3000, attempt)),
      [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000],
    );
  });

  group('normalizeSupabaseProjectUrl', () {
    test('strips trailing slash', () {
      expect(
        normalizeSupabaseProjectUrl('https://abc.supabase.co/'),
        'https://abc.supabase.co',
      );
    });

    test('rejects unsupported scheme', () {
      expect(
        () => normalizeSupabaseProjectUrl('ftp://example.com'),
        throwsA(isA<EcoCenterException>()),
      );
    });
  });

  group('normalizeCenterServerHttpUrl', () {
    test('delegates to supabase normalizer', () {
      expect(
        normalizeCenterServerHttpUrl('http://127.0.0.1:54321/'),
        'http://127.0.0.1:54321',
      );
    });
  });

  group('tokenStillValid', () {
    test('returns false when expiring within 30s', () {
      final now = DateTime.parse('2030-01-01T00:00:00Z');
      expect(tokenStillValid('2030-01-01T00:00:20Z', now), isFalse);
    });

    test('returns true when more than 30s remain', () {
      final now = DateTime.parse('2030-01-01T00:00:00Z');
      expect(tokenStillValid('2030-01-01T00:01:00Z', now), isTrue);
    });
  });

  group('unwrapInvokeResult', () {
    test('unwraps desktop invoke envelope', () {
      final value = EcoCenterClient.unwrapInvokeResult<Map<String, dynamic>>({
        'channel': 'thread:list',
        'result': {'ok': true},
      });
      expect(value['ok'], isTrue);
    });

    test('returns raw result when not wrapped', () {
      expect(EcoCenterClient.unwrapInvokeResult<List<dynamic>>([1, 2]), [1, 2]);
    });
  });

  group('JSON-RPC errors', () {
    test('preserves the desktop V2 domain code and data', () {
      final error = ecoCenterExceptionFromRpcError({
        'code': -32602,
        'message': 'Conversation protocol is unsupported.',
        'data': {
          'conversationCode': 'unsupported_version',
          'expectedProtocolVersion': 2,
        },
      });

      expect(error, isA<EcoCenterException>());
      expect(error.code, -32602);
      expect(error.domainCode, 'unsupported_version');
      expect(error.domainData, {
        'conversationCode': 'unsupported_version',
        'expectedProtocolVersion': 2,
      });
    });
  });

  group('channel subscription lifecycle', () {
    test('reruns onSubscribed after channel rejoin', () async {
      var subscribedCalls = 0;
      final failures = <EcoCenterException>[];
      final lifecycle = EcoChannelSubscriptionLifecycle(
        topic: 'eco:user:user_1',
        onSubscribed: () async {
          subscribedCalls += 1;
        },
        onUnhealthy: failures.add,
      );

      lifecycle.handle(EcoChannelSubscribeStatus.subscribed);
      await lifecycle.initialSubscription;
      expect(subscribedCalls, 1);

      lifecycle.handle(EcoChannelSubscribeStatus.subscribed);
      await Future<void>.delayed(Duration.zero);
      expect(subscribedCalls, 2);
      expect(failures, isEmpty);
    });

    test('reports retrack failure as unhealthy after initial join', () async {
      var subscribedCalls = 0;
      final failures = <EcoCenterException>[];
      final lifecycle = EcoChannelSubscriptionLifecycle(
        topic: 'eco:user:user_1',
        onSubscribed: () async {
          subscribedCalls += 1;
          if (subscribedCalls == 2) {
            throw EcoCenterException.native('presence retrack failed');
          }
        },
        onUnhealthy: failures.add,
      );

      lifecycle.handle(EcoChannelSubscribeStatus.subscribed);
      await lifecycle.initialSubscription;
      lifecycle.handle(EcoChannelSubscribeStatus.subscribed);
      await Future<void>.delayed(Duration.zero);

      expect(subscribedCalls, 2);
      expect(failures, hasLength(1));
      expect(failures.single.message, 'presence retrack failed');
    });

    test('fails initial subscription on channel authorization error', () async {
      final lifecycle = EcoChannelSubscriptionLifecycle(
        topic: 'eco:user:user_1',
        onSubscribed: () async {},
        onUnhealthy: (_) {},
      );

      lifecycle.handle(
        EcoChannelSubscribeStatus.channelError,
        Exception('Unauthorized'),
      );

      await expectLater(
        lifecycle.initialSubscription,
        throwsA(
          isA<EcoCenterException>().having(
            (error) => error.message,
            'message',
            contains('Unauthorized'),
          ),
        ),
      );
    });
  });

  group('eco realtime envelope', () {
    test('wrap and unwrap round-trip', () {
      final message = buildEcoPingRequest('ping_1');
      final envelope = wrapEcoRpcForBroadcast(message);
      expect(envelope['event'], EcoRealtimeTopics.broadcastEvent);
      expect(unwrapEcoRpcFromBroadcast(envelope)?['id'], 'ping_1');
    });

    test('bind topic', () {
      expect(
        EcoRealtimeTopics.bindTopic('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'),
        'eco:bind:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      );
    });
  });

  group('parsePairingQrPayload', () {
    for (final scheme in ['mori', 'eco']) {
      test('parses $scheme connection and pairing links', () {
        final connection = parsePairingQrPayload(
          '$scheme://center?supabase=https%3A%2F%2Fabc.supabase.co&anon=key%2B%2F%3D',
        );
        expect(connection.supabaseUrl, 'https://abc.supabase.co');
        expect(connection.anonKey, 'key+/=');
        expect(connection.code, '');
        expect(connection.canConfigureServer, isTrue);
        final pairing = parsePairingQrPayload(
          '$scheme://pair?supabase=https%3A%2F%2Fabc.supabase.co&anon=key&code=abcd1234&token=boot',
        );
        expect(pairing.code, 'ABCD1234');
        expect(pairing.bootstrapToken, 'boot');
        expect(pairing.canQuickJoin, isTrue);
        expect(
          parsePairingCodeFromQr('$scheme://pair?code=abcd1234'),
          'ABCD1234',
        );
      });
    }

    test('rejects unknown schemes and lookalike hosts', () {
      for (final link in [
        'https://center?supabase=https://abc.supabase.co&anon=key',
        'mori-evil://center?supabase=https://abc.supabase.co&anon=key',
        'mori://center-evil?supabase=https://abc.supabase.co&anon=key',
        'eco://pair-evil?code=abcd1234',
        'mori://[',
      ]) {
        expect(
          () => parsePairingQrPayload(link),
          throwsA(isA<EcoCenterException>()),
        );
      }
    });

    test('parses legacy quick-join uri', () {
      final payload = parsePairingQrPayload(
        'eco://pair?server=http%3A%2F%2F192.168.1.2%3A3128&code=abcd1234&token=secret-token',
      );
      expect(payload.code, 'ABCD1234');
      expect(payload.serverUrl, 'http://192.168.1.2:3128');
      expect(payload.projectUrl, 'http://192.168.1.2:3128');
      expect(payload.bootstrapToken, 'secret-token');
      // No anon key → cannot fill project config from QR alone.
      expect(payload.canConfigureServer, isFalse);
      expect(payload.canQuickJoin, isFalse);
    });

    test('parses eco center server-only uri', () {
      final payload = parsePairingQrPayload(
        'eco://center?supabase=https%3A%2F%2Fabc.supabase.co&anon=anon-public',
      );
      expect(payload.code, '');
      expect(payload.supabaseUrl, 'https://abc.supabase.co');
      expect(payload.anonKey, 'anon-public');
      expect(payload.canConfigureServer, isTrue);
      expect(payload.canQuickJoin, isFalse);
    });

    test('parses supabase url + anon key', () {
      final payload = parsePairingQrPayload(
        'eco://pair?supabase=https%3A%2F%2Fabc.supabase.co&anon=anon-public&code=xyzw9876&token=boot',
      );
      expect(payload.code, 'XYZW9876');
      expect(payload.supabaseUrl, 'https://abc.supabase.co');
      expect(payload.anonKey, 'anon-public');
      expect(payload.projectUrl, 'https://abc.supabase.co');
      expect(payload.canConfigureServer, isTrue);
      expect(payload.canQuickJoin, isTrue);
    });

    test('parses legacy eco pair uri', () {
      final payload = parsePairingQrPayload('eco://pair?code=abcd1234');
      expect(payload.code, 'ABCD1234');
      expect(payload.canQuickJoin, isFalse);
    });

    test('uppercases manual code', () {
      expect(parsePairingQrPayload('abcd1234').code, 'ABCD1234');
    });
  });

  group('parsePairingCodeFromQr', () {
    test('parses eco pair uri', () {
      expect(parsePairingCodeFromQr('eco://pair?code=abcd1234'), 'ABCD1234');
    });

    test('uppercases manual code', () {
      expect(parsePairingCodeFromQr('abcd1234'), 'ABCD1234');
    });
  });

  group('AppCredentials', () {
    test('requires anon key for project config', () {
      const ready = AppCredentials(
        supabaseUrl: 'https://abc.supabase.co',
        anonKey: 'anon',
      );
      expect(ready.hasProjectConfig, isTrue);
      expect(ready.serverUrl, 'https://abc.supabase.co');

      const missingAnon = AppCredentials(
        supabaseUrl: 'https://abc.supabase.co',
      );
      expect(missingAnon.hasProjectConfig, isFalse);
    });

    test('keeps user and device token bundles separate', () {
      const credentials = AppCredentials(
        supabaseUrl: 'https://abc.supabase.co',
        anonKey: 'anon',
        userId: 'user_1',
        userEmail: 'owner@example.com',
        userRefreshToken: 'user_refresh',
        userAccessToken: 'user_access',
        userAccessTokenExpiresAt: '2030-01-01T00:10:00Z',
        deviceId: 'dev_mobile',
        deviceSecret: 'device_secret',
        deviceRefreshToken: 'device_refresh',
        deviceAccessToken: 'device_access',
        deviceAccessTokenExpiresAt: '2030-01-01T00:10:00Z',
        selectedDesktopId: 'dev_desktop',
      );

      expect(credentials.hasUserSession, isTrue);
      expect(credentials.hasDeviceCredentials, isTrue);

      final signedOut = credentials.copyWith(
        clearUserSession: true,
        clearDeviceCredentials: true,
        clearSelectedDesktop: true,
      );

      expect(signedOut.hasUserSession, isFalse);
      expect(signedOut.hasDeviceCredentials, isFalse);
      expect(signedOut.userRefreshToken, isNull);
      expect(signedOut.userId, isNull);
      expect(signedOut.deviceRefreshToken, isNull);
      expect(signedOut.selectedDesktopId, isNull);
    });

    test('uses user id rather than email as account identity', () {
      const first = AppCredentials(
        supabaseUrl: 'https://abc.supabase.co',
        anonKey: 'anon',
        userId: 'user_1',
        userEmail: 'shared@example.com',
        userRefreshToken: 'refresh',
        deviceId: 'mobile_1',
        deviceSecret: 'secret',
        selectedDesktopId: 'desktop_1',
        bindingId: 'binding_1',
      );

      final cleared = first.copyWith(
        userId: 'user_2',
        clearDeviceCredentials: true,
        clearSelectedDesktop: true,
        clearBindingId: true,
      );
      expect(cleared.userId, 'user_2');
      expect(cleared.deviceId, isNull);
      expect(cleared.bindingId, isNull);
    });
  });

  group('EcoSupabaseFunctions', () {
    test('documents Track A function names', () {
      expect(EcoSupabaseFunctions.deviceRegister, 'device-register');
      expect(
        EcoSupabaseFunctions.deviceSessionRegister,
        'device-session-register',
      );
      expect(EcoSupabaseFunctions.bindingEnsure, 'binding-ensure');
      expect(EcoSupabaseFunctions.pairingJoin, 'pairing-join');
      expect(EcoSupabaseFunctions.pairingCreate, 'pairing-create');
    });
  });

  group('project identity isolation', () {
    test(
      'switching project clears account, device, and binding credentials',
      () async {
        final store = _MemoryCredentialStore();
        final client = EcoCenterClient(store: store);
        await client.updateCredentials(
          const AppCredentials(
            supabaseUrl: 'https://old.supabase.co',
            anonKey: 'old-anon',
            userId: 'user-1',
            userEmail: 'owner@example.com',
            userRefreshToken: 'refresh',
            deviceId: 'mobile-1',
            deviceSecret: 'secret',
            selectedDesktopId: 'desktop-1',
            bindingId: 'binding-1',
          ),
        );

        await client.setProjectConfig(
          supabaseUrl: 'https://new.supabase.co/',
          anonKey: 'new-anon',
        );

        expect(client.credentials.supabaseUrl, 'https://new.supabase.co');
        expect(client.credentials.userId, isNull);
        expect(client.credentials.userRefreshToken, isNull);
        expect(client.credentials.deviceId, isNull);
        expect(client.credentials.selectedDesktopId, isNull);
        expect(client.credentials.bindingId, isNull);
        await client.dispose();
      },
    );

    test(
      'rotating anon key on same project preserves account identity',
      () async {
        final store = _MemoryCredentialStore();
        final client = EcoCenterClient(store: store);
        await client.updateCredentials(
          const AppCredentials(
            supabaseUrl: 'https://same.supabase.co',
            anonKey: 'old-anon',
            userId: 'user-1',
            userEmail: 'owner@example.com',
            userRefreshToken: 'refresh',
            deviceId: 'mobile-1',
            deviceSecret: 'secret',
          ),
        );

        await client.setProjectConfig(
          supabaseUrl: 'https://same.supabase.co/',
          anonKey: 'new-anon',
        );

        expect(client.credentials.userId, 'user-1');
        expect(client.credentials.deviceId, 'mobile-1');
        await client.dispose();
      },
    );
  });

  group('applyPairingProjectConfig', () {
    test(
      'saves QR project details and probes the resulting endpoint',
      () async {
        final client = _RecordingProjectProbeClient();
        final payload = parsePairingQrPayload(
          'eco://center?supabase=https%3A%2F%2Fnew.supabase.co&anon=new-anon',
        );

        final reachable = await client.applyPairingProjectConfig(payload);

        expect(reachable, isTrue);
        expect(client.credentials.supabaseUrl, 'https://new.supabase.co');
        expect(client.credentials.anonKey, 'new-anon');
        expect(client.probedUrls, ['https://new.supabase.co']);
        expect(client.probedAnonKeys, ['new-anon']);
        await client.dispose();
      },
    );

    test(
      'reuses the saved anon key when the QR targets the same project',
      () async {
        final client = _RecordingProjectProbeClient();
        await client.updateCredentials(
          const AppCredentials(
            supabaseUrl: 'https://same.supabase.co',
            anonKey: 'saved-anon',
          ),
        );
        final payload = parsePairingQrPayload(
          'eco://center?supabase=https%3A%2F%2Fsame.supabase.co',
        );

        final reachable = await client.applyPairingProjectConfig(payload);

        expect(reachable, isTrue);
        expect(client.probedUrls, ['https://same.supabase.co']);
        expect(client.probedAnonKeys, ['saved-anon']);
        await client.dispose();
      },
    );

    test('does not pair a new project URL with an old anon key', () async {
      final client = _RecordingProjectProbeClient();
      await client.updateCredentials(
        const AppCredentials(
          supabaseUrl: 'https://old.supabase.co',
          anonKey: 'old-anon',
        ),
      );
      final payload = parsePairingQrPayload(
        'eco://center?supabase=https%3A%2F%2Fnew.supabase.co',
      );

      final reachable = await client.applyPairingProjectConfig(payload);

      expect(reachable, isNull);
      expect(client.credentials.supabaseUrl, 'https://old.supabase.co');
      expect(client.credentials.anonKey, 'old-anon');
      expect(client.probedUrls, isEmpty);
      await client.dispose();
    });
  });
}

class _MemoryCredentialStore extends CredentialStore {
  AppCredentials value = const AppCredentials(supabaseUrl: '');

  @override
  Future<AppCredentials> load() async => value;

  @override
  Future<void> save(AppCredentials credentials) async {
    value = credentials;
  }
}

class _RecordingProjectProbeClient extends EcoCenterClient {
  _RecordingProjectProbeClient() : super(store: _MemoryCredentialStore());

  final probedUrls = <String>[];
  final probedAnonKeys = <String?>[];

  @override
  Future<bool> testConnection(String supabaseUrl, {String? anonKey}) async {
    probedUrls.add(supabaseUrl);
    probedAnonKeys.add(anonKey);
    return probedAnonKeys.length == 1;
  }
}
