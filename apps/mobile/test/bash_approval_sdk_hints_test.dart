import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/features/approvals/bash_approval_panel.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final request = BashApprovalRequest.fromJson({
    'toolUseId': 'sdk-hint',
    'threadId': 'thread-sdk',
    'command': 'node script.js',
    'cwd': '/tmp',
    'reason': 'SDK permission request',
    'riskScore': 50,
    'riskLevel': 'medium',
    'defaultToNo': true,
    'suppressAlwaysAllowRule': true,
  });

  test('desktop SDK permission hints survive mobile decoding', () {
    expect(request.defaultToNo, isTrue);
    expect(request.suppressAlwaysAllowRule, isTrue);
    final legacy = BashApprovalRequest.fromJson({'toolUseId': 'legacy'});
    expect(legacy.defaultToNo, isFalse);
    expect(legacy.suppressAlwaysAllowRule, isFalse);
  });

  testWidgets('SDK prompt starts on decline and hides persistent approval', (
    tester,
  ) async {
    final resolutions = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: BashApprovalPanel(
            request: request,
            busy: false,
            onResolve: ({required decision, feedback}) async {
              resolutions.add(decision);
            },
            onSkip: () async {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.textContaining("don't ask again", findRichText: true),
      findsNothing,
    );
    final submit = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Submit ↵'),
    );
    expect(submit.onPressed, isNull);
    expect(resolutions, isEmpty);
    // Explicitly tapping the one-time allow row remains supported.
    await tester.tap(find.text('Yes'));
    await tester.pumpAndSettle();
    expect(resolutions, ['approved']);
  });

  for (final suppressed in [false, true]) {
    testWidgets('MCP remember action respects suppress=$suppressed', (
      tester,
    ) async {
      final request = BashApprovalRequest.fromJson({
        'toolUseId': 'mcp-call',
        'threadId': 'thread-mcp',
        'command': 'mcp__mysql__read',
        'filesystemTool': 'MCP',
        'filesystemPath': 'mysql/read',
        'suppressAlwaysAllowRule': suppressed,
        'mcpToolApproval': {'serverName': 'mysql', 'toolName': 'read'},
      });
      expect(request.mcpToolName, 'read');
      final resolutions = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('en'),
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: BashApprovalPanel(
              request: request,
              busy: false,
              onResolve: ({required decision, feedback}) async {
                resolutions.add(decision);
              },
              onSkip: () async {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final remember = find.textContaining(
        'Allow this tool without asking again',
        findRichText: true,
      );
      if (suppressed) {
        expect(remember, findsNothing);
      } else {
        expect(remember, findsOneWidget);
        await tester.tap(remember);
        await tester.pumpAndSettle();
        expect(resolutions, ['approved_remember_mcp_tool']);
      }
    });
  }
}
