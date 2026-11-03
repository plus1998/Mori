import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/plan_execution.dart';
import 'package:eco_mobile/core/theme/eco_icons.dart';
import 'package:eco_mobile/features/approvals/plan_approval_panel.dart';
import 'package:eco_mobile/features/composer/composer_dock_shell.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const plan = ThreadPendingPlan(
    threadId: 'thread-1',
    userPrompt: 'Ship the mobile plan sheet',
    analysis: 'Keep approve/dismiss on the dock.',
    plan: '''
## Implementation Plan

- Add a fullscreen control to the plan popup.
- Expand the markdown body so a long plan is readable.
- Keep ignore and execute actions visible.
''',
    workspacePath: '/tmp/workspace',
    worktreePath: '/tmp/worktree',
  );

  testWidgets(
    'tap approves; long press exposes options and cancelling does not approve',
    (tester) async {
      var approvals = 0;
      var scheduled = 0;
      var newSessions = 0;
      await tester.pumpWidget(
        _LocalizedTestApp(
          child: PlanApprovalPanel(
            plan: plan,
            busy: false,
            onApprove: () async => approvals++,
            onDismiss: _noop,
            onScheduleExecution: () async => scheduled++,
            onStartNewSession: () async => newSessions++,
          ),
        ),
      );
      final button = find.byKey(const Key('plan-approval-execute'));
      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(approvals, 1);
      await tester.longPress(button);
      await tester.pumpAndSettle();
      expect(find.text('More plan execution options'), findsOneWidget);
      expect(approvals, 1);
      // Dismiss through the modal barrier.
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();
      expect(scheduled, 0);
      expect(newSessions, 0);
      await tester.longPress(button);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-execution-schedule')));
      await tester.pumpAndSettle();
      expect(scheduled, 1);
      expect(approvals, 1);
      await tester.longPress(button);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-execution-new-session')));
      await tester.pumpAndSettle();
      expect(newSessions, 1);
      expect(approvals, 1);
    },
  );

  testWidgets(
    'subagent menu blocks read-only roles and preserves additional instructions',
    (tester) async {
      PlanExecutionTarget? target;
      await tester.pumpWidget(
        _LocalizedTestApp(
          child: PlanApprovalPanel(
            plan: plan,
            busy: false,
            onApprove: _noop,
            onDismiss: _noop,
            delegationAgents: const [
              PlanDelegationAgentOption(
                agentKey: 'explore',
                displayName: 'Explore',
                canExecutePlan: false,
              ),
              PlanDelegationAgentOption(
                agentKey: 'coder',
                displayName: 'Coder',
                canExecutePlan: true,
              ),
            ],
            onApproveWithSubagent: (value) async => target = value,
          ),
        ),
      );
      await tester.longPress(find.byKey(const Key('plan-approval-execute')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-execution-subagent')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Explore'));
      await tester.pumpAndSettle();
      expect(target, isNull);
      await tester.enterText(
        find.byKey(const Key('plan-execution-additional-message')),
        '  Run the integration checks\nthen implement.  ',
      );
      await tester.tap(find.text('Coder'));
      await tester.pumpAndSettle();
      expect(target?.toJson(), {
        'kind': 'subagent',
        'agentKey': 'coder',
        'additionalMessage': 'Run the integration checks\nthen implement.',
      });
    },
  );

  testWidgets('busy plan cannot approve or open execution options', (
    tester,
  ) async {
    var calls = 0;
    await tester.pumpWidget(
      _LocalizedTestApp(
        child: PlanApprovalPanel(
          plan: plan,
          busy: true,
          onApprove: () async => calls++,
          onDismiss: _noop,
          onScheduleExecution: () async => calls++,
        ),
      ),
    );
    await tester.longPress(find.byKey(const Key('plan-approval-execute')));
    await tester.pump();
    expect(find.text('More plan execution options'), findsNothing);
    expect(calls, 0);
  });

  test('expanded height prefers 85 percent when chrome leaves enough room', () {
    expect(
      planApprovalExpandedHeight(
        viewportHeight: 800,
        paddingTop: 0,
        paddingBottom: 0,
      ),
      closeTo(800 * planApprovalExpandedHeightFactor, 0.5),
    );
  });

  test('expanded height stays below title chrome and home indicator', () {
    const viewportHeight = 844.0;
    const paddingTop = 101.0;
    const paddingBottom = 34.0;
    final height = planApprovalExpandedHeight(
      viewportHeight: viewportHeight,
      paddingTop: paddingTop,
      paddingBottom: paddingBottom,
    );
    final panelTop =
        viewportHeight -
        height -
        planApprovalPanelBottomPadding -
        paddingBottom -
        composerDockTopSpacing;
    expect(height, lessThan(viewportHeight * planApprovalExpandedHeightFactor));
    expect(panelTop, greaterThanOrEqualTo(paddingTop));
  });

  testWidgets('plan dock expands to about 85 percent of the viewport', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      const _LocalizedTestApp(
        child: PlanApprovalPanel(
          plan: plan,
          busy: false,
          onApprove: _noop,
          onDismiss: _noop,
        ),
      ),
    );

    final collapsedHeight = tester
        .getSize(find.byKey(const Key('plan-approval-panel')))
        .height;
    expect(collapsedHeight, lessThan(800 * 0.5));
    expect(find.byIcon(EcoIcons.expandFullscreen), findsOneWidget);

    await tester.tap(find.byKey(const Key('plan-approval-expand')));
    await tester.pumpAndSettle();

    expect(
      tester.getSize(find.byKey(const Key('plan-approval-panel'))).height,
      closeTo(
        planApprovalExpandedHeight(
          viewportHeight: 800,
          paddingTop: 0,
          paddingBottom: 0,
        ),
        0.5,
      ),
    );
    expect(find.byIcon(EcoIcons.collapseFullscreen), findsOneWidget);

    await tester.tap(find.byKey(const Key('plan-approval-expand')));
    await tester.pumpAndSettle();

    expect(
      tester.getSize(find.byKey(const Key('plan-approval-panel'))).height,
      closeTo(collapsedHeight, 0.5),
    );
  });

  testWidgets('expanded plan dock stays below the session title chrome', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    tester.view.padding = FakeViewPadding(top: 101, bottom: 34);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPadding);

    await tester.pumpWidget(
      const _LocalizedTestApp(
        child: ComposerDockShell(
          child: PlanApprovalPanel(
            plan: plan,
            busy: false,
            onApprove: _noop,
            onDismiss: _noop,
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('plan-approval-expand')));
    await tester.pumpAndSettle();

    final dockTop = tester.getTopLeft(find.byType(ComposerDockShell)).dy;
    expect(dockTop, greaterThanOrEqualTo(101));
  });
}

Future<void> _noop() async {}

class _LocalizedTestApp extends StatelessWidget {
  const _LocalizedTestApp({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      locale: const Locale('en'),
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(
        body: Align(alignment: Alignment.bottomCenter, child: child),
      ),
    );
  }
}
