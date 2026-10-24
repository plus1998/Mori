import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/models/conversation_v2_models.dart';
import '../core/models/conversation_v2_projection_models.dart';
import '../core/storage/conversation_v2_cache.dart';
import '../features/threads/conversation_v2_projection.dart';

/// Consumes the desktop export format through the production SQLite reducer.
/// No credentials, remote client, RPC or command handler exists in this player.
class MobileFeedReplay extends ChangeNotifier {
  MobileFeedReplay(Map<String, dynamic> fixture, this.cache)
    : conversationId = fixture['conversationId'] as String,
      storeEpoch = fixture['storeEpoch'] as String,
      title = (fixture['thread'] as Map)['title'] as String,
      coverage = List<String>.from(fixture['coverage'] as List),
      _events = List<Map<String, dynamic>>.from(
        (fixture['events'] as List).map(
          (e) => Map<String, dynamic>.from(e as Map),
        ),
      ) {
    if (![1, 2].contains(fixture['formatVersion']) ||
        fixture['protocolVersion'] != 2 ||
        (fixture['thread'] as Map)['id'] != conversationId ||
        conversationId.isEmpty ||
        storeEpoch.isEmpty ||
        _events.isEmpty) {
      throw const FormatException('Unsupported replay format or identity.');
    }
    for (var i = 0; i < _events.length; i++) {
      final event = _events[i];
      final effect = ConversationV2Effect.fromJson(event);
      if (effect.seq != i + 1 ||
          effect.effectVersion != 1 ||
          !conversationV2SupportedEffectTypes.contains(effect.type) ||
          event['at'] is! num ||
          !(event['at'] as num).isFinite ||
          (fixture['formatVersion'] == 2 &&
              event.containsKey('requestSpans')) ||
          (fixture['formatVersion'] == 1 &&
              event.containsKey('requestSpanChanges'))) {
        throw FormatException('Invalid replay event at sequence ${i + 1}.');
      }
    }
  }

  final ConversationV2Cache cache;
  final String conversationId;
  final String storeEpoch;
  final String title;
  final List<String> coverage;
  final List<Map<String, dynamic>> _events;
  final _spans = <String, ThreadRunProjectionRequestSpan>{};
  int sequence = 0;
  bool playing = false;
  bool _closed = false;
  int _generation = 0;
  Future<void>? _operation;
  Object? error;
  ThreadRunProjectionSnapshot? projection;
  int get eventCount => _events.length;

  Future<void> seek(int target) async {
    pause();
    await _operation;
    if (target < 0 || target > eventCount) {
      throw RangeError.range(target, 0, eventCount);
    }
    // Production bootstrap deliberately refuses to move a durable cursor back.
    // Recreate this player's isolated in-memory database before rebuilding.
    await cache.close();
    await cache.installBootstrap(
      ConversationV2Bootstrap(
        protocolVersion: 2,
        storeEpoch: storeEpoch,
        conversationId: conversationId,
        snapshotSeq: 0,
        historyRevision: 0,
        messages: const [],
        runs: const [],
        tools: const [],
        olderCursor: null,
        hasOlder: false,
      ),
    );
    sequence = 0;
    error = null;
    _spans.clear();
    // Rewind reconstructs a fresh state. Batch only the non-visible prefix.
    while (sequence < target) {
      await _applyTo((sequence + 200).clamp(0, target));
    }
    await _refresh();
  }

  Future<void> step() async {
    pause();
    await _operation;
    if (sequence < eventCount) {
      await _applyTo(sequence + 1);
      await _refresh();
    }
  }

  void pause() {
    _generation++;
    playing = false;
    notifyListeners();
  }

  Future<void> play({
    double speed = 1,
    int maxGapMs = 1000,
    int? through,
  }) async {
    if (playing) return;
    if (!speed.isFinite || speed <= 0 || maxGapMs < 0) {
      throw ArgumentError('Invalid replay speed/gap.');
    }
    final end = through ?? eventCount;
    if (end < sequence || end > eventCount) {
      throw RangeError.range(end, sequence, eventCount);
    }
    playing = true;
    final generation = ++_generation;
    notifyListeners();
    try {
      while (playing &&
          !_closed &&
          generation == _generation &&
          sequence < end) {
        final gap = sequence == 0
            ? 0
            : ((_events[sequence]['at'] as num) -
                      (_events[sequence - 1]['at'] as num)) /
                  speed;
        await Future<void>.delayed(
          Duration(milliseconds: gap.round().clamp(0, maxGapMs)),
        );
        if (!playing || _closed || generation != _generation) break;
        _operation = () async {
          await _applyTo(sequence + 1);
          await _refresh();
        }();
        await _operation;
      }
    } catch (failure) {
      error = failure;
      rethrow;
    } finally {
      if (generation == _generation) {
        playing = false;
        if (!_closed) notifyListeners();
      }
    }
  }

  Future<void> _applyTo(int target) async {
    final events = _events.sublist(sequence, target);
    await cache.applySyncPage(
      ConversationV2SyncPage(
        protocolVersion: 2,
        storeEpoch: storeEpoch,
        conversationId: conversationId,
        fromSeq: sequence + 1,
        throughSeq: target,
        headSeq: eventCount,
        hasMore: target < eventCount,
        effects: events.map(ConversationV2Effect.fromJson).toList(),
      ),
    );
    for (final event in events) {
      final full = event['requestSpans'] as List?;
      final changes = event['requestSpanChanges'] as Map?;
      if (full != null) _spans.clear();
      for (final id in (changes?['removed'] as List? ?? const [])) {
        _spans.remove(id);
      }
      for (final raw in full ?? changes?['upserts'] as List? ?? const []) {
        final span = ThreadRunProjectionRequestSpan.fromJson(
          Map<String, dynamic>.from(raw as Map),
        );
        _spans[span.requestId] = span;
      }
    }
    sequence = target;
  }

  Future<void> _refresh() async {
    final snapshot = await cache.presentationSnapshot(conversationId);
    projection = buildConversationV2Projection(
      conversationId: conversationId,
      messages: snapshot.messages,
      runs: snapshot.runs,
      tools: snapshot.tools,
      agents: snapshot.agents,
      details: [
        for (final run in snapshot.runs)
          ...await cache.details(conversationId, run.runId),
      ],
      historyRevision: snapshot.cacheState?.historyRevision ?? 0,
      projectionExtras: ConversationV2ProjectionExtras(
        requestSpans: _spans.values.toList(),
      ),
    );
    if (!_closed) notifyListeners();
  }

  Future<void> close() async {
    _closed = true;
    playing = false;
    await _operation;
    await cache.close();
  }
}
