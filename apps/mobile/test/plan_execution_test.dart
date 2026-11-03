import 'dart:convert';

import 'package:eco_mobile/core/models/plan_execution.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:flutter_test/flutter_test.dart';

ResolvedOrchestrationSnapshot snapshot(List<Map<String, dynamic>> agents) =>
    ResolvedOrchestrationSnapshot.fromJson(
      jsonDecode(
        jsonEncode({
          'selection': {
            'mainAgentConfigId': 'main',
            'mainPrompt': {'mode': 'builtin'},
            'subagents': {'mode': 'none'},
          },
          'mainAgent': {},
          'agents': agents,
        }),
      ),
    );

void main() {
  test('delegation roster uses enabled roles and the desktop write policy', () {
    const write = {
      'filesystem': {'write': 'workspace'},
    };
    final roles = listPlanDelegationAgents(
      snapshot([
        {
          'agentKey': 'coder',
          'displayName': 'Coder',
          'enabled': true,
          'tools': write,
        },
        {'agentKey': 'coder', 'enabled': true, 'tools': write},
        {'agentKey': 'disabled', 'enabled': false, 'tools': write},
        {
          'agentKey': 'explore',
          'enabled': true,
          'tools': {
            'filesystem': {'write': 'none'},
          },
        },
        {
          'agentKey': 'codex_read_only',
          'enabled': true,
          'tools': {
            ...write,
            'coreOverrides': {
              'codex': {'sandboxMode': 'read-only'},
            },
          },
        },
        {
          'agentKey': 'claude_read_only',
          'enabled': true,
          'tools': {
            ...write,
            'coreOverrides': {
              'claude': {
                'disallowedTools': ['Edit'],
              },
            },
          },
        },
        {
          'agentKey': 'denied',
          'enabled': true,
          'tools': {
            ...write,
            'disallowed': ['apply_patch'],
          },
        },
      ]),
    );
    expect(roles.map((role) => role.agentKey), [
      'coder',
      'explore',
      'codex_read_only',
      'claude_read_only',
      'denied',
    ]);
    expect(roles.map((role) => role.canExecutePlan), [
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(roles.first.displayName, 'Coder');
    expect(roles[1].displayName, 'explore');
    expect(listPlanDelegationAgents(null), isEmpty);
  });

  test('pending plan retains immutable reference identity and version', () {
    final plan = ThreadPendingPlan.fromJson({
      'threadId': 'source',
      'referenceId': 'plan_v3',
      'version': 3,
      'plan': '  Full plan\n',
    });
    expect(plan.referenceId, 'plan_v3');
    expect(plan.version, 3);
    expect(plan.plan, '  Full plan\n');
  });

  test(
    'source worktree survives updates and list merges for linked execution',
    () {
      final source = ThreadSummary.fromJson({
        'id': 'source',
        'workLocation': {
          'mode': 'isolated',
          'worktree': {'id': 'worktree_1'},
        },
      });
      expect(
        source.copyWith(title: 'Updated').workLocation?.worktreeId,
        'worktree_1',
      );
      final merged = mergeThreadSummaryFromRemoteList(
        current: source,
        listed: ThreadSummary.fromJson({'id': 'source', 'title': 'New title'}),
      );
      expect(merged.workLocation?.mode, 'isolated');
      expect(merged.workLocation?.worktreeId, 'worktree_1');
    },
  );
}
