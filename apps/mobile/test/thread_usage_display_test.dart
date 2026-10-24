import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/models/agent_orchestration.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/thread_runtime_config.dart';
import 'package:eco_mobile/core/models/thread_usage_models.dart';
import 'package:eco_mobile/core/theme/subagent_theme.dart';
import 'package:eco_mobile/core/utils/thread_usage_display.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';

final _zh = lookupAppLocalizations(const Locale('zh'));

void main() {
  test('formatCostUsd formats small and large values', () {
    expect(formatCostUsd(0), '\$0');
    expect(formatCostUsd(0.0042), '\$0.0042');
    expect(formatCostUsd(1.23), '\$1.23');
  });

  test('formatBillingCacheHitRate uses all prompt tokens', () {
    const billing = ThreadBillingSnapshot(
      plannerTokenCostUsd: 0.2,
      ecoCostUsd: 0.1,
      savedUsd: 0.1,
      savedPct: 50,
      pricingResolved: true,
      inputTokens: 100,
      cacheReadTokens: 300,
      cacheCreationTokens: 100,
    );

    expect(formatBillingCacheHitRate(billing), '60%');
  });

  test('resolveBillingMainModelLabel prefers the current session model', () {
    const billing = ThreadBillingSnapshot(
      plannerTokenCostUsd: 0.2,
      ecoCostUsd: 0.1,
      savedUsd: 0.1,
      savedPct: 50,
      pricingResolved: true,
      plannerModelLabel: 'gpt-5.5 · OpenAI',
    );

    expect(
      resolveBillingMainModelLabel(
        billing,
        currentMainModelId: 'anthropic/claude-sonnet-4',
      ),
      'claude-sonnet-4',
    );
  });

  test('resolvePlannerOccupancyPct prefers planner role', () {
    final context = ThreadContextSnapshot.fromJson({
      'occupied': 1000,
      'limit': 200000,
      'occupancyPct': 1,
      'limitsResolved': true,
      'roles': [
        {
          'role': 'main',
          'occupied': 120000,
          'limit': 200000,
          'occupancyPct': 60,
          'limitsResolved': true,
          'segments': [],
        },
      ],
    });

    expect(resolvePlannerOccupancyPct(context), 60);
  });

  test('roleDisplayLabel uses Main Agent for planner', () {
    expect(roleDisplayLabel('main', _zh), 'Main Agent');
    expect(roleDisplayLabel('explore', _zh), '探索');
  });

  test(
    'buildFlatSubagentContextRows prefers instances over role aggregates',
    () {
      final context = ThreadContextSnapshot.fromJson({
        'occupied': 1000,
        'limit': 200000,
        'occupancyPct': 1,
        'limitsResolved': true,
        'roles': [
          {
            'role': 'coder',
            'occupied': 5000,
            'limit': 200000,
            'occupancyPct': 3,
            'limitsResolved': true,
            'segments': [],
          },
        ],
        'instances': [
          {
            'agentId': 'agent_coder_1',
            'role': 'coder',
            'occupied': 12000,
            'limit': 200000,
            'occupancyPct': 6,
            'limitsResolved': true,
            'segments': [],
          },
        ],
      });

      final rows = buildFlatSubagentContextRows(context, l10n: _zh);
      expect(rows, hasLength(1));
      expect(rows.first.key, 'agent_coder_1');
      expect(rows.first.title, contains('编程'));
      expect(rows.first.accentColor, resolveSubagentThemeColor('coder'));
    },
  );

  test('buildFlatSubagentContextRows applies theme overrides', () {
    const themeSource = SubagentThemeSource(
      agents: [
        AgentInstanceConfig(
          agentKey: 'coder',
          templateId: 'builtin.coding.coder',
          enabled: true,
          themeColor: '#112233',
          modelRef: OrchestrationModelRef(
            providerId: 'provider-1',
            modelId: 'gpt-5.6-sol',
          ),
          tools: ToolPolicy(),
        ),
      ],
    );
    final context = ThreadContextSnapshot.fromJson({
      'occupied': 1000,
      'limit': 200000,
      'occupancyPct': 1,
      'limitsResolved': true,
      'roles': [
        {
          'role': 'coder',
          'occupied': 5000,
          'limit': 200000,
          'occupancyPct': 3,
          'limitsResolved': true,
          'segments': [],
        },
      ],
    });

    final rows = buildFlatSubagentContextRows(
      context,
      themeSource: themeSource,
      l10n: _zh,
    );
    expect(rows.first.accentColor, const Color(0xFF112233));
  });

  test('V2 billing and context models parse projection extras', () {
    final billing = ThreadBillingSnapshot.fromJson({
      'plannerTokenCostUsd': 0.12,
      'ecoCostUsd': 0.05,
      'savedUsd': 0.07,
      'savedPct': 58,
      'pricingResolved': true,
      'totalTokens': {'input': 100, 'output': 20},
      'byModel': [
        {
          'modelId': 'anthropic/claude-sonnet-4',
          'roles': ['main', 'coder'],
          'inputTokens': 80,
          'outputTokens': 20,
          'cacheReadTokens': 0,
          'cacheCreationTokens': 0,
          'ecoCostUsd': 0.04,
        },
      ],
    });
    final context = ThreadContextSnapshot.fromJson({
      'occupied': 1000,
      'limit': 200000,
      'occupancyPct': 1,
      'limitsResolved': true,
      'segments': [],
      'instances': [
        {
          'agentId': 'agent_explore_1',
          'role': 'explore',
          'occupied': 8000,
          'limit': 200000,
          'occupancyPct': 4,
          'limitsResolved': true,
          'segments': [],
        },
      ],
    });

    expect(billing.ecoCostUsd, 0.05);
    expect(billing.byModel, hasLength(1));
    expect(billing.byModel.first.ecoCostUsd, 0.04);
    expect(context.instances, hasLength(1));
  });
}
