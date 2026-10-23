import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:eco_mobile/core/utils/activity_display.dart';
import 'package:eco_mobile/core/utils/feed_action_kind.dart';

void main() {
  final l10n = lookupAppLocalizations(const Locale('zh'));

  test('lowercase PI tool names classify', () {
    expect(resolveActionKind(toolName: 'bash').kind, ActionKind.command);
    expect(resolveActionKind(toolName: 'read').kind, ActionKind.read);
  });

  test('resolveActionKind maps aliases case-insensitively', () {
    expect(resolveActionKind(toolName: 'Read').kind, ActionKind.read);
    expect(resolveActionKind(toolName: 'Read').icon, ActivityActionIcon.read);
    expect(resolveActionKind(toolName: 'Write').kind, ActionKind.write);
    expect(resolveActionKind(toolName: 'WebFetch').kind, ActionKind.webFetch);
    expect(resolveActionKind(toolName: 'webfetch').kind, ActionKind.webFetch);
    expect(
      resolveActionKind(toolName: 'Bash').icon,
      ActivityActionIcon.terminal,
    );
    expect(resolveActionKind(toolName: 'bash').kind, ActionKind.command);
  });

  test('Write + fileChange stays write', () {
    final resolved = resolveActionKind(
      toolName: 'Write',
      payload: const ActionKindPayload(
        fileChange: ActionKindFileChange(
          path: '/repo/auth.ts',
          fileName: 'auth.ts',
        ),
      ),
    );
    expect(resolved.kind, ActionKind.write);
    expect(resolved.bucket, ActionGroupBucket.writtenFiles);
  });

  test('fileChange payload only applies when the name is unknown', () {
    expect(
      resolveActionKind(
        toolName: 'MysteryPatch',
        payload: const ActionKindPayload(
          fileChange: ActionKindFileChange(path: '/repo/a.ts'),
        ),
      ).kind,
      ActionKind.edit,
    );
  });

  test('mcpDiscovery.search wins before generic mcp alias', () {
    expect(
      resolveActionKind(
        toolName: 'mcp',
        payload: const ActionKindPayload(
          mcpDiscovery: ActionKindMcpDiscovery(kind: 'search'),
        ),
      ).kind,
      ActionKind.mcpSearch,
    );
  });

  test('webSearch.mode fetch upgrades webSearch to webFetch', () {
    expect(
      resolveActionKind(
        toolName: 'WebSearch',
        payload: const ActionKindPayload(
          webSearch: ActionKindWebSearch(
            mode: 'fetch',
            url: 'https://example.com',
          ),
        ),
      ).kind,
      ActionKind.webFetch,
    );
  });

  test('eco browser and image tools classify', () {
    final click = resolveActionKind(
      toolName: 'mcp__eco_agent_browser__agent_browser_click',
    );
    expect(click.kind, ActionKind.browser);
    expect(click.namedSuffix, 'agent_browser_click');
    expect(
      resolveActionKind(
        toolName: 'mcp__eco_ab_ea4a60abe66__agent_browser_open',
      ).kind,
      ActionKind.browser,
    );
    expect(
      resolveActionKind(
        toolName: 'eco_agent_browser_agent_browser_open',
      ).namedSuffix,
      'agent_browser_open',
    );
    expect(
      resolveActionKind(
        toolName: 'mcp__eco_image_generation__create_image',
      ).kind,
      ActionKind.imageCreate,
    );
    expect(resolveActionKind(toolName: 'ViewImage').kind, ActionKind.imageView);
    expect(resolveActionKind(toolName: 'ViewImage').icon, ActivityActionIcon.images);
    expect(
      resolveActionKind(toolName: 'mcp__eco_image_view__view_image').kind,
      ActionKind.imageView,
    );
    expect(
      resolveActionKind(toolName: 'mcp__eco_image_view__view_image').icon,
      ActivityActionIcon.images,
    );
    expect(
      resolveActionKind(toolName: 'mcp__eco_image_display__display_image').kind,
      ActionKind.imageDisplay,
    );
    expect(
      resolveActionKind(toolName: 'mcp__eco_image_display__display_image').icon,
      ActivityActionIcon.images,
    );
    expect(
      resolveActionKind(toolName: 'mcp__eco_html_host__publish_html').kind,
      ActionKind.htmlHost,
    );
    expect(
      resolveActionKind(toolName: 'mcp__eco_html_host__publish_html').icon,
      ActivityActionIcon.browser,
    );
    expect(
      resolveActionKind(toolName: 'mcp__eco_web_search__search').kind,
      ActionKind.webSearch,
    );
    expect(
      resolveActionKind(toolName: 'mcp__eco_web_search__search').icon,
      ActivityActionIcon.network,
    );
  });

  test('formatMcpToolDisplayName maps built-in eco tools', () {
    expect(
      formatMcpToolDisplayName('mcp__eco_image_display__display_image', l10n),
      '展示图像',
    );
    expect(
      formatMcpToolDisplayName('mcp__eco_html_host__publish_html', l10n),
      '发布 HTML 页面',
    );
    expect(
      formatMcpToolDisplayName('mcp__eco_computer_use__click', l10n),
      '电脑操作',
    );
    expect(
      formatMcpToolDisplayName('mcp__eco_web_search__search', l10n),
      '联网搜索',
    );
    expect(
      formatMcpToolDisplayName('mcp__eco_image_view__view_image', l10n),
      '查看图像',
    );
  });

  test('imageDisplay and htmlHost action lines', () {
    final display = resolveActionKind(
      toolName: 'mcp__eco_image_display__display_image',
    );
    expect(
      formatActionLine(
        resolved: display,
        phase: ActionLinePhase.running,
        l10n: l10n,
      ),
      '正在展示 1 张图像',
    );
    expect(
      formatActionLine(
        resolved: display,
        phase: ActionLinePhase.done,
        l10n: l10n,
      ),
      '已展示 1 张图像',
    );
    final html = resolveActionKind(
      toolName: 'mcp__eco_html_host__publish_html',
    );
    expect(
      formatActionLine(
        resolved: html,
        phase: ActionLinePhase.running,
        l10n: l10n,
      ),
      '正在发布 HTML 页面',
    );
    expect(
      formatActionLine(resolved: html, phase: ActionLinePhase.done, l10n: l10n),
      '已发布 HTML 页面',
    );
  });

  test('mcp tools are not stolen by skill heuristic', () {
    expect(
      resolveActionKind(toolName: 'mcp__foo__read_skill').kind,
      ActionKind.mcp,
    );
    expect(resolveActionKind(toolName: 'ReadSkill').kind, ActionKind.skill);
    expect(
      resolveActionKind(toolName: 'custom_skill_loader').kind,
      ActionKind.skill,
    );
  });

  test('eco computer use tools classify', () {
    final resolved = resolveActionKind(
      toolName: 'mcp__eco_computer_use__click',
    );
    expect(resolved.kind, ActionKind.computerUse);
    expect(resolved.icon, ActivityActionIcon.computer);
    expect(resolved.bucket, ActionGroupBucket.computerUse);
    expect(
      formatActionLine(
        resolved: resolved,
        phase: ActionLinePhase.running,
        l10n: l10n,
      ),
      '正在操控电脑',
    );
    expect(
      formatActionLine(
        resolved: resolved,
        phase: ActionLinePhase.done,
        l10n: l10n,
      ),
      '操控了电脑',
    );
  });

  test('unknown tools use kind tool and icon tool', () {
    final resolved = resolveActionKind(toolName: 'TotallyUnknown');
    expect(resolved.kind, ActionKind.tool);
    expect(resolved.icon, ActivityActionIcon.tool);
    expect(resolved.bucket, ActionGroupBucket.otherTools);
    expect(resolveActionKind(toolName: '').kind, ActionKind.tool);
    expect(resolveActionKind().kind, ActionKind.tool);
  });

  test('done line includes basename', () {
    expect(
      formatActionLine(
        resolved: resolveActionKind(toolName: 'Read'),
        phase: ActionLinePhase.done,
        rawTarget: '/repo/auth.ts',
        l10n: l10n,
      ),
      '读取了 auth.ts',
    );
  });

  test('done line falls back without target', () {
    expect(
      formatActionLine(
        resolved: resolveActionKind(toolName: 'Read'),
        phase: ActionLinePhase.done,
        l10n: l10n,
      ),
      '读取了文件',
    );
  });

  test('running line includes target', () {
    expect(
      formatActionLine(
        resolved: resolveActionKind(toolName: 'Read'),
        phase: ActionLinePhase.running,
        rawTarget: 'auth.ts',
        l10n: l10n,
      ),
      '正在读取 auth.ts',
    );
  });

  test('WebFetch copy is not webSearch copy', () {
    expect(
      formatActionLine(
        resolved: resolveActionKind(toolName: 'WebFetch'),
        phase: ActionLinePhase.done,
        payload: const ActionKindPayload(
          webSearch: ActionKindWebSearch(
            mode: 'fetch',
            url: 'https://huggingface.co/docs',
          ),
        ),
        l10n: l10n,
      ),
      '获取了 huggingface.co',
    );
  });

  test(
    'summarizeActionGroup counts without filenames and splits web from search',
    () {
      final items = [
        resolveActionKind(toolName: 'Read'),
        resolveActionKind(toolName: 'Read'),
        resolveActionKind(toolName: 'WebFetch'),
        resolveActionKind(toolName: 'Grep'),
      ];
      final summary = summarizeActionGroup(items, l10n);
      expect(summary.label, contains('已读取 2 个文件'));
      expect(summary.label, isNot(contains('auth.ts')));
      expect(summary.label, contains('已联网 1 次'));
      expect(summary.label, contains('已搜索代码 1 次'));
      expect(summary.label, isNot(contains('已联网搜索')));
      expect(summary.icon, ActivityActionIcon.read);
    },
  );

  test('summarizeActionGroup en joinMany does not use Chinese顿号', () {
    final en = lookupAppLocalizations(const Locale('en'));
    final items = [
      resolveActionKind(toolName: 'Read'),
      resolveActionKind(toolName: 'Edit'),
      resolveActionKind(toolName: 'Grep'),
    ];
    final summary = summarizeActionGroup(items, en);
    expect(summary.label, isNot(contains('、')));
    expect(summary.label, contains(', '));
  });

  test(
    'summarizeActionGroup icon priority uses network for mcp and browser for browser',
    () {
      expect(
        summarizeActionGroup([resolveActionKind(toolName: 'mcp')], l10n).icon,
        ActivityActionIcon.network,
      );
      expect(
        summarizeActionGroup([
          resolveActionKind(
            toolName: 'mcp__eco_agent_browser__agent_browser_click',
          ),
        ], l10n).icon,
        ActivityActionIcon.browser,
      );
      expect(
        summarizeActionGroup([
          resolveActionKind(toolName: 'Read'),
          resolveActionKind(toolName: 'mcp'),
        ], l10n).icon,
        ActivityActionIcon.read,
      );
    },
  );
}
