import 'dart:async';

import 'package:eco_mobile/core/models/eco_types.dart';
import 'package:eco_mobile/core/network/eco_realtime.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

void main() {
  test(
    'actual Dart SDK nests RPC and binding hints in Broadcast payload',
    () async {
      final socket = _Socket();
      final channel = socket.channel('eco:bind:test');
      final joined = Completer<void>();
      channel.subscribe((status, error) {
        if (status == RealtimeSubscribeStatus.subscribed) joined.complete();
      });
      await joined.future;
      final message = wrapEcoRpcForBroadcast(buildEcoPingRequest('wire_ping'));
      await sendEcoRealtimeBroadcast(
        channel,
        event: EcoRealtimeTopics.broadcastEvent,
        payload: message,
      );
      await sendEcoRealtimeBroadcast(
        channel,
        event: EcoRealtimeTopics.bindingsChangedEvent,
        payload: {'desktopDeviceId': 'desktop'},
      );
      final broadcasts = socket.frames
          .where((f) => f['event'] == 'broadcast')
          .toList();
      expect(broadcasts[0]['payload'], {
        'type': 'broadcast',
        'event': 'eco.rpc',
        'payload': message,
      });
      expect(broadcasts[1]['payload'], {
        'type': 'broadcast',
        'event': 'eco.bindings.changed',
        'payload': {'desktopDeviceId': 'desktop'},
      });
      // The SDK must not mutate the application envelope while adding metadata.
      expect(message.containsKey('type'), isFalse);
      socket.connected = false;
      expect(
        () => sendEcoRealtimeBroadcast(
          channel,
          event: 'eco.rpc',
          payload: message,
        ),
        throwsA(isA<EcoCenterException>()),
      );
      expect(
        socket.frames.where((f) => f['event'] == 'broadcast'),
        hasLength(2),
      );
      socket.connected = true;
      await socket.removeAllChannels();
      await socket.disconnect();
    },
  );
}

class _Socket extends RealtimeClient {
  _Socket()
    : super(
        'wss://example.invalid/realtime',
        disconnectOnEmptyChannelsAfter: Duration.zero,
      );
  bool connected = true;
  final frames = <Map<String, dynamic>>[];
  @override
  bool get isConnected => connected;
  @override
  String? push(dynamic message) {
    final frame = Map<String, dynamic>.from(message.toJson() as Map);
    frames.add(frame);
    final channel = getChannels().single;
    scheduleMicrotask(() {
      // Exercise the real SDK join and push implementation without networking.
      // ignore: invalid_use_of_internal_member
      channel.trigger('phx_reply', <String, dynamic>{
        'status': 'ok',
        'response': <String, dynamic>{},
      }, frame['ref'] as String?);
    });
    return null;
  }
}
