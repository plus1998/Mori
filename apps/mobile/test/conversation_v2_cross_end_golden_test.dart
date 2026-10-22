import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/models/conversation_v2_models.dart';
import 'package:eco_mobile/core/models/conversation_v2_projection_models.dart';
import 'package:eco_mobile/core/preferences/thinking_display_preferences.dart';
import 'package:eco_mobile/core/utils/agent_role.dart';
import 'package:eco_mobile/core/utils/subagent_projection_feed.dart';
import 'package:eco_mobile/features/threads/activity_feed.dart';
import 'package:eco_mobile/features/threads/conversation_v2_projection.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';

/// The mobile half of the cross-end Feed contract.
///
/// The desktop half (`apps/desktop/test/conversation-v2-cross-end-golden.test.ts`) asserts
/// that the desktop renderer draws the shape recorded in
/// `apps/desktop/test/fixtures/feed-parity/v2-render/<id>.json` from the payload in
/// `.../v2-bootstrap/<id>.json`. This file asserts the same two things for the mobile
/// renderer, reading the same fixtures: a divergence is a difference between the renderers,
/// not between two fixtures.
///
/// A row is compared by what a reader can see: where it is, which role wrote it, when it
/// happened, which call it reports and whether it is the turn's own output. Wording is not
/// compared for tool rows: the two renderers word a call differently on purpose (the mobile
/// Feed localizes the action label and prefers a structured target; the desktop Feed prints
/// `Tool: Name · target`), which is recorded as a deliberate divergence in
/// `docs/plans/feed-regression-test-plan.md` §4.13 K10.
/// Mobile also places later tool groups before intervening progress narration.
/// The one affected corpus segment is asserted explicitly below; all row fields
/// and the rest of the corpus order are still compared without normalization.
void main() {
  final fixtures = '../desktop/test/fixtures/feed-parity';
  // Read from the fixtures, not from a list kept here: a hand-written list stops at the
  // conversations it was written with, so three of the nine corpus conversations were never
  // rendered by the mobile renderer while this suite stayed green.
  final corpusIds =
      Directory('$fixtures/v2-render')
          .listSync()
          .map((entity) => entity.uri.pathSegments.last)
          .where((name) => name.endsWith('.json'))
          .map((name) => name.substring(0, name.length - '.json'.length))
          .toList()
        ..sort();
  final dump = Platform.environment['ECO_CROSS_END_DUMP'] == '1';

  test('the desktop fixtures are readable from the mobile suite', () {
    expect(corpusIds, isNotEmpty);
    final bootstraps =
        Directory('$fixtures/v2-bootstrap')
            .listSync()
            .map((entity) => entity.uri.pathSegments.last)
            .where((name) => name.endsWith('.json'))
            .map((name) => name.substring(0, name.length - '.json'.length))
            .toList()
          ..sort();
    expect(bootstraps, corpusIds);
    for (final id in corpusIds) {
      expect(
        File('$fixtures/v2-bootstrap/$id.json').existsSync(),
        isTrue,
        reason: '先跑 bun apps/desktop/scripts/feed-cross-end-fixture.ts',
      );
      expect(File('$fixtures/v2-render/$id.json').existsSync(), isTrue);
    }
  });

  for (final id in corpusIds) {
    test('mobile renders what the desktop renders for $id', () {
      final bootstrap =
          jsonDecode(File('$fixtures/v2-bootstrap/$id.json').readAsStringSync())
              as Map<String, dynamic>;
      final historical =
          jsonDecode(File('$fixtures/v2-render/$id.json').readAsStringSync())
              as Map<String, dynamic>;
      // Preserve the recorded events/identities; only canonicalize the renamed role.
      Map<String, dynamic> row(dynamic item) => {
        ...item as Map<String, dynamic>,
        'role': item['role'] == null
            ? null
            : normalizeAgentRole(item['role'] as String),
      };
      final expectedFeed = (historical['feed'] as List).map(row).toList();
      if (id == 'thr_1789537718627') {
        // Deliberate mobile presentation: this progress paragraph follows the
        // next four-tool group. Pin the recorded row so fixture drift fails.
        expect(expectedFeed[72]['text'], '<text#1cc3db0afd:len113>');
        expect(
          expectedFeed.sublist(73, 77).every((item) => item['callId'] != null),
          isTrue,
        );
        final progress = expectedFeed.removeAt(72);
        expectedFeed.insert(76, progress);
      }
      final golden = {
        ...historical,
        'feed': expectedFeed,
        'cards': [
          for (final card in historical['cards'] as List)
            {
              ...card as Map<String, dynamic>,
              'role': normalizeAgentRole(card['role'] as String),
              'rows': (card['rows'] as List).map(row).toList(),
            },
        ],
      };
      final actual = mobileCrossEndShape(bootstrap);
      if (Platform.environment['ECO_CROSS_END_IDS'] == '1') {
        final debug = mobileCrossEndDebug(bootstrap);
        // ignore: avoid_print
        print('IDS $id\n${const JsonEncoder.withIndent(' ').convert(debug)}');
      }
      if (dump) {
        // ignore: avoid_print
        print('=== $id\n${const JsonEncoder.withIndent(' ').convert(actual)}');
        return;
      }
      expect(actual['feed'], golden['feed'], reason: '$id: main Feed 行');
      expect(actual['cards'], golden['cards'], reason: '$id: 子代理卡片');
      expect(actual['attempts'], golden['attempts'], reason: '$id: attempts');
    });
  }
}

/// Renders the payload through the production mobile path and serializes the result into the
/// shared cross-end schema (see `apps/desktop/test/support/cross-end-shape.ts`).
Map<String, dynamic> mobileCrossEndShape(Map<String, dynamic> bootstrapJson) {
  final bootstrap = ConversationV2Bootstrap.fromJson(bootstrapJson);
  final projection = buildConversationV2Projection(
    conversationId: bootstrap.conversationId,
    messages: bootstrap.messages,
    runs: bootstrap.runs,
    tools: bootstrap.tools,
    agents: bootstrap.agents,
    hasEarlier: bootstrap.hasOlder,
  );
  final entries = buildActivityFeed(
    threadPrompt: '',
    threadId: bootstrap.conversationId,
    runProjection: projection,
    subagentSessions: const [],
    l10n: lookupAppLocalizations(const Locale('zh')),
    thinkingDisplayMode: ThinkingDisplayMode.collapsed,
  );

  final feed = <Map<String, dynamic>>[];
  void addEntry(ActivityFeedEntry entry, {bool isFinal = false}) {
    final text = entry.text.trim();
    if (text.isEmpty) return;
    final callId = _callIdOf(entry);
    final status = entry.toolEventType?.trim();
    final row = <String, dynamic>{
      // A tool row's wording is the renderer's own (localized label), so the comparison
      // keeps the call's identity and outcome instead of the sentence.
      if (callId == null) 'text': text,
      // The role is the row's author: the Feed picks a turn's final output by it, and the
      // desktop draws it. A grouped or synthesized row has no single author.
      'role': entry.role,
      'at': entry.at,
      'callId': callId,
    };
    if (status case final value?) row['status'] = value;
    if (isFinal) row['final'] = true;
    feed.add(row);
  }

  // The mobile Feed aggregates consecutive calls of the same kind into one row whose
  // children are the calls ("已运行 2 条命令"); the desktop draws one row per call. The
  // aggregation is a mobile presentation choice, so the comparison walks into the groups and
  // compares the calls themselves — a call that stops being drawn is still a lost call.
  void addEntryOrChildren(ActivityFeedEntry entry, {bool isFinal = false}) {
    if (entry.kind == ActivityFeedKind.actionGroup &&
        entry.actionChildren.isNotEmpty) {
      for (final child in entry.actionChildren) {
        addEntryOrChildren(child);
      }
      if (isFinal) {
        for (final child in entry.actionChildren) {
          addEntryOrChildren(child, isFinal: true);
        }
      }
      return;
    }
    addEntry(entry, isFinal: isFinal);
  }

  for (final entry in entries) {
    if (entry.kind == ActivityFeedKind.turn) {
      for (final child in entry.processEntries) {
        if (child.kind == ActivityFeedKind.subagentMission) continue;
        addEntryOrChildren(child);
      }
      final finalOutput = entry.finalOutput;
      switch (finalOutput) {
        case final output?:
          addEntryOrChildren(output, isFinal: true);
        case null:
          break;
      }
      continue;
    }
    if (entry.kind == ActivityFeedKind.subagentMission) continue;
    addEntryOrChildren(entry);
  }

  return {
    'feed': feed,
    // Cards are compared by identity, not by list position: each renderer draws a card where
    // the spawn row it absorbed used to be, so the list order is each end's own bookkeeping
    // rather than a fact either end can be wrong about. Code-unit order, matching the desktop
    // serializer: the two runtimes collate differently and the contract must not depend on it.
    'cards': _sortedCardShapes(projection),
    'attempts': [
      for (final attempt in projection.attempts)
        {'attemptId': attempt.attemptId, 'status': attempt.status},
    ],
  };
}

Map<String, dynamic> _cardRowShape(ThreadRunProjectionTimelineItem item) {
  final callId = _callIdOfItem(item);
  return {
    // Card rows carry no time in the contract: their position inside a card comes from the
    // read models' approximation on both ends, and membership and order are what is compared.
    if (callId == null) 'text': item.text.trim(),
    'role': item.role?.trim(),
    'at': null,
    'callId': callId,
    if (item.eventType.startsWith('tool.')) 'status': item.eventType,
  };
}

/// Diagnostic: which row ids the feed produced and which the role map knows.
Map<String, dynamic> mobileCrossEndDebug(Map<String, dynamic> bootstrapJson) {
  final bootstrap = ConversationV2Bootstrap.fromJson(bootstrapJson);
  final projection = buildConversationV2Projection(
    conversationId: bootstrap.conversationId,
    messages: bootstrap.messages,
    runs: bootstrap.runs,
    tools: bootstrap.tools,
    agents: bootstrap.agents,
    hasEarlier: bootstrap.hasOlder,
  );
  final entries = buildActivityFeed(
    threadPrompt: '',
    threadId: bootstrap.conversationId,
    runProjection: projection,
    subagentSessions: const [],
    l10n: lookupAppLocalizations(const Locale('zh')),
    thinkingDisplayMode: ThinkingDisplayMode.collapsed,
  );
  return {
    'agents': [
      for (final agent in projection.agents)
        {
          'agentId': agent.agentId,
          'parentToolUseId': agent.parentToolUseId,
          'taskName': agent.taskName,
          'ids': [for (final item in agent.timeline) item.id],
        },
    ],
    'timelineIds': [
      for (final item in projection.timeline)
        {'id': item.id, 'role': item.role, 'kind': item.eventType},
    ],
    'entryIds': [for (final entry in entries) ..._debugRows(entry)],
    'feedDebug': [
      for (final entry in _flatFeedRows(entries))
        {
          'id': entry.id,
          'kind': entry.kind.name,
          'lifecycle': entry.lifecycle?.name,
          'toolUseId': entry.toolUseId,
        },
    ],
  };
}

List<ActivityFeedEntry> _flatFeedRows(List<ActivityFeedEntry> entries) {
  final rows = <ActivityFeedEntry>[];
  void walk(ActivityFeedEntry entry) {
    if (entry.kind == ActivityFeedKind.turn) {
      for (final child in entry.processEntries) {
        walk(child);
      }
      final finalOutput = entry.finalOutput;
      if (finalOutput != null) walk(finalOutput);
      return;
    }
    if (entry.kind == ActivityFeedKind.actionGroup &&
        entry.actionChildren.isNotEmpty) {
      for (final child in entry.actionChildren) {
        walk(child);
      }
      return;
    }
    rows.add(entry);
  }

  for (final entry in entries) {
    walk(entry);
  }
  return rows;
}

List<Map<String, dynamic>> _debugRows(
  ActivityFeedEntry entry, [
  String prefix = '',
]) {
  final rows = <Map<String, dynamic>>[
    {
      'id': '$prefix${entry.id}',
      'kind': entry.kind.name,
      'text': entry.text.trim().substring(
        0,
        entry.text.trim().length.clamp(0, 24),
      ),
      'toolUseId': entry.toolUseId,
      'at': entry.at,
      'role': entry.role,
    },
  ];
  for (final child in entry.processEntries) {
    rows.addAll(_debugRows(child, '$prefix  '));
  }
  for (final child in entry.actionChildren) {
    rows.addAll(_debugRows(child, '$prefix  *'));
  }
  final finalOutput = entry.finalOutput;
  if (finalOutput != null) {
    rows.addAll(_debugRows(finalOutput, '$prefix  #'));
  }
  return rows;
}

List<Map<String, dynamic>> _sortedCardShapes(
  ThreadRunProjectionSnapshot projection,
) {
  final cards = [
    for (final agent in projection.agents)
      if (agent.kind == 'subagent') _cardShape(agent, projection),
  ];
  cards.sort(
    (left, right) =>
        (left['agentId'] as String).compareTo(right['agentId'] as String),
  );
  return cards;
}

Map<String, dynamic> _cardShape(
  ThreadRunProjectionAgent agent,
  ThreadRunProjectionSnapshot projection,
) => {
  'agentId': agent.agentId,
  'role': agent.role,
  'kind': agent.kind,
  'status': agent.status,
  'missionText': resolveSubagentCardMissionText(
    agent,
    mainTimeline: projection.timeline,
  ),
  'taskName': agent.taskName,
  'parentToolUseId': agent.parentToolUseId,
  'rows': [
    for (final item in agent.timeline)
      if (item.text.trim().isNotEmpty) _cardRowShape(item),
  ],
};

String? _callIdOf(ActivityFeedEntry entry) {
  final direct = entry.toolUseId?.trim();
  return direct == null || direct.isEmpty ? null : direct;
}

String? _callIdOfItem(ThreadRunProjectionTimelineItem item) {
  final tool = item.metadata?['tool'];
  final id = tool is Map ? tool['toolUseId'] : null;
  return id is String && id.trim().isNotEmpty ? id.trim() : null;
}
