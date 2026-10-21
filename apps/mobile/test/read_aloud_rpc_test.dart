import 'dart:convert';
import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/models/tts_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

class _Client extends EcoCenterClient {
  _Client() : super(store: CredentialStore());
  dynamic response;
  Object? error;
  String? channel;
  List<dynamic>? args;
  int? deadline;
  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    this.channel = channel;
    this.args = args;
    deadline = deadlineMs;
    if (error != null) throw error!;
    return response as T;
  }
}

void main() {
  test(
    'reading RPC envelopes preserve request identity, chunk ranges and synthesis deadline',
    () async {
      final client = _Client();
      final rpc = DesktopRpc(client, 'desktop');
      client.response = {
        'available': true,
        'profileName': '豆包',
        'voice': 'voice',
        'style': '平稳',
      };
      expect((await rpc.getReadAloudStatus()).voice, 'voice');
      expect(client.channel, 'tts-read-aloud:status');
      client.response = {'requestId': 'request', 'segmentCount': 2};
      expect(
        (await rpc.startReadAloud(
          requestId: 'request',
          threadId: 'thread',
          entryId: 'entry',
          sourceText: '正文',
        )).segmentCount,
        2,
      );
      expect(client.args!.single, {
        'requestId': 'request',
        'threadId': 'thread',
        'entryId': 'entry',
        'sourceText': '正文',
      });
      client.response = {'mimeType': 'audio/wav', 'totalBytes': 2};
      await rpc.synthesizeReadAloudSegment('request', 1);
      expect(client.deadline, 660000);
      client.response = {
        'mimeType': 'audio/wav',
        'totalBytes': 2,
        'offset': 0,
        'chunkBytes': 2,
        'dataBase64': base64Encode([1, 2]),
      };
      expect((await rpc.readReadAloudChunk('request', 1, 0, 2)).bytes, [1, 2]);
      expect(client.args!.single, {
        'requestId': 'request',
        'index': 1,
        'offset': 0,
        'length': 2,
      });
      client.response = null;
      await rpc.cancelReadAloud('request');
      expect(client.channel, 'tts-read-aloud:cancel');
    },
  );
  test('malformed chunk lengths and identities are rejected', () async {
    final client = _Client();
    final rpc = DesktopRpc(client, 'desktop');
    client.response = {'requestId': 'other', 'segmentCount': 1};
    await expectLater(
      rpc.startReadAloud(
        requestId: 'request',
        threadId: 'thread',
        entryId: 'entry',
        sourceText: '正文',
      ),
      throwsA(isA<ReadAloudException>()),
    );
    client.response = {
      'mimeType': 'audio/wav',
      'totalBytes': 2,
      'offset': 0,
      'chunkBytes': 2,
      'dataBase64': 'AA==',
    };
    await expectLater(
      rpc.readReadAloudChunk('request', 0, 0, 2),
      throwsA(isA<ReadAloudException>()),
    );
    client.response = {'mimeType': 'text/html', 'totalBytes': 2};
    await expectLater(
      rpc.synthesizeReadAloudSegment('request', 0),
      throwsA(isA<ReadAloudException>()),
    );
  });
  test(
    'old desktop versions and disconnected computers produce actionable errors',
    () async {
      final client = _Client();
      final rpc = DesktopRpc(client, 'desktop');
      client.error = EcoCenterException.native(
        'Unknown desktop command channel: tts-read-aloud:status',
        code: EcoRpcConstants.invalidParams,
      );
      await expectLater(
        rpc.getReadAloudStatus(),
        throwsA(predicate((error) => error.toString().contains('升级'))),
      );
      client.error = EcoCenterException.app(
        EcoCenterErrorKind.websocketDisconnected,
      );
      await expectLater(
        rpc.getReadAloudStatus(),
        throwsA(predicate((error) => error.toString().contains('离线'))),
      );
    },
  );
}
