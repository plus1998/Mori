import 'dart:async';

import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/eco_types.dart';

int ecoRealtimeReconnectDelayMs(int baseDelayMs, int attempt) =>
    (baseDelayMs * (1 << attempt.clamp(0, 5))).clamp(0, 60000);

/// Send the same Broadcast frame shape as supabase-js. realtime_client 2.x
/// adds type/event directly to its argument; the application data belongs in
/// its nested payload. A disconnected RPC must never use SDK HTTP delivery.
Future<ChannelResponse> sendEcoRealtimeBroadcast(
  RealtimeChannel channel, {
  required String event,
  required Map<String, dynamic> payload,
}) {
  if (!channel.canPush) {
    throw EcoCenterException.app(EcoCenterErrorKind.websocketDisconnected);
  }
  return channel.sendBroadcastMessage(
    event: event,
    payload: {'payload': payload},
  );
}

/// Drives channel subscription lifecycle independent of the Supabase channel.
///
/// Realtime can emit [EcoChannelSubscribeStatus.subscribed] again after a
/// reconnect/rejoin. [onSubscribed] therefore runs on every successful join,
/// while [initialSubscription] only settles once.
enum EcoChannelSubscribeStatus { subscribed, channelError, timedOut, closed }

class EcoChannelSubscriptionLifecycle {
  EcoChannelSubscriptionLifecycle({
    required this.topic,
    required this.onSubscribed,
    required this.onUnhealthy,
  });

  final String topic;
  final Future<void> Function() onSubscribed;
  final void Function(EcoCenterException exception) onUnhealthy;
  final Completer<void> _initialSubscription = Completer<void>();
  bool _handlingSubscribed = false;

  Future<void> get initialSubscription => _initialSubscription.future;

  void handle(EcoChannelSubscribeStatus status, [Object? error]) {
    if (status == EcoChannelSubscribeStatus.subscribed) {
      if (_handlingSubscribed) return;
      _handlingSubscribed = true;
      unawaited(() async {
        try {
          await onSubscribed();
          if (!_initialSubscription.isCompleted) {
            _initialSubscription.complete();
          }
        } catch (error) {
          final exception = error is EcoCenterException
              ? error
              : EcoCenterException.native(error.toString());
          if (!_initialSubscription.isCompleted) {
            _initialSubscription.completeError(exception);
          } else {
            onUnhealthy(exception);
          }
        } finally {
          _handlingSubscribed = false;
        }
      }());
      return;
    }

    final exception = EcoCenterException.native(
      'Realtime channel $topic status=${status.name}'
      '${error == null ? '' : ': $error'}.',
    );
    if (!_initialSubscription.isCompleted) {
      _initialSubscription.completeError(exception);
    } else {
      onUnhealthy(exception);
    }
  }
}

/// Channel topic helpers aligned with `packages/shared` + supabase migrations.
class EcoRealtimeTopics {
  static const userPrefix = 'eco:user:';
  static const bindPrefix = 'eco:bind:';
  static const vaultPrefix = 'eco:vault:';

  static const broadcastEvent = 'eco.rpc';
  static const bindingsChangedEvent = 'eco.bindings.changed';
  static const bindingReadyEvent = 'eco.binding.ready';
  static const envelopeVersion = 1;

  static String bindTopic(String bindingId) =>
      '$bindPrefix${bindingId.trim().toLowerCase()}';

  static String userTopic(String userId) =>
      '$userPrefix${userId.trim().toLowerCase()}';

  static String? parseBindId(String topic) {
    if (!topic.startsWith(bindPrefix)) return null;
    final id = topic.substring(bindPrefix.length).trim().toLowerCase();
    return id.isEmpty ? null : id;
  }
}

/// Broadcast envelope: `{ v, event, message }` around Eco JSON-RPC.
Map<String, dynamic> wrapEcoRpcForBroadcast(Map<String, dynamic> message) {
  return {
    'v': EcoRealtimeTopics.envelopeVersion,
    'event': EcoRealtimeTopics.broadcastEvent,
    'message': message,
  };
}

Map<String, dynamic>? unwrapEcoRpcFromBroadcast(dynamic value) {
  if (value is! Map) return null;
  final map = Map<String, dynamic>.from(value);
  if (map['v'] != EcoRealtimeTopics.envelopeVersion) return null;
  if (map['event'] != EcoRealtimeTopics.broadcastEvent) return null;
  final message = map['message'];
  if (message is! Map) return null;
  return Map<String, dynamic>.from(message);
}

Map<String, dynamic> buildEcoPingRequest(String id) {
  return {
    'jsonrpc': EcoRpcConstants.jsonRpcVersion,
    'id': id,
    'method': EcoRpcConstants.methodPing,
    'params': <String, dynamic>{},
  };
}

Map<String, dynamic> buildEcoInvokeRequest({
  required String id,
  required String desktopDeviceId,
  required String channel,
  required List<dynamic> args,
  required int deadlineMs,
}) {
  return {
    'jsonrpc': EcoRpcConstants.jsonRpcVersion,
    'id': id,
    'method': EcoRpcConstants.methodInvoke,
    'params': {
      'desktopDeviceId': desktopDeviceId,
      'channel': channel,
      'args': args,
      'deadlineMs': deadlineMs,
    },
  };
}
