import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';

import 'package:eco_mobile/core/models/git_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/theme/eco_adaptive_icons.dart';
import 'package:eco_mobile/core/utils/thread_session_menu_visibility.dart';
import 'package:eco_mobile/features/threads/thread_session_menu.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';

final _zh = lookupAppLocalizations(const Locale('zh'));

void main() {
  test('every native session menu entry has an SF Symbol', () {
    for (final autoReadEnabled in [false, true]) {
      for (final behindCount in [0, 2]) {
        final entries = buildThreadSessionMenuEntries(
          _zh,
          hasThread: true,
          workspacePath: '/repo',
          isRunning: false,
          autoReadEnabled: autoReadEnabled,
          gitStatus: _gitStatus(behindCount: behindCount),
          visibility: const ThreadSessionMenuVisibility(
            showProgress: true,
            showPlan: true,
            showImageDisplay: true,
            showImageGeneration: true,
            showHtmlHost: true,
          ),
        );
        for (final entry in entries) {
          expect(
            ecoIconSfSymbol(entry.icon),
            isNotEmpty,
            reason: '${entry.value} must render in the native iOS menu',
          );
        }
      }
    }
  });

  test('remote sync action matches desktop fetch and pull behavior', () {
    expect(resolveGitRemoteSyncAction(0), 'fetch');
    expect(resolveGitRemoteSyncAction(2), 'pull');
  });

  test('remote sync label shows fetch or behind count', () {
    expect(resolveGitRemoteSyncLabel(null, _zh), '抓取');
    expect(resolveGitRemoteSyncLabel(_gitStatus(behindCount: 0), _zh), '抓取');
    expect(
      resolveGitRemoteSyncLabel(_gitStatus(behindCount: 3), _zh),
      '拉取（落后 3）',
    );
  });

  test('GitFetchResult parses desktop response', () {
    final result = GitFetchResult.fromJson({'output': 'Fetched origin'});
    expect(result.output, 'Fetched origin');
  });

  test('progress menu visibility matches desktop hasProgressInfo', () {
    expect(threadMenuShouldShowProgress(const []), isFalse);
    expect(
      threadMenuShouldShowProgress([
        _todo(status: 'completed'),
        _todo(status: 'stopped'),
      ]),
      isFalse,
    );
    expect(threadMenuShouldShowProgress([_todo(status: 'running')]), isTrue);
    expect(threadMenuShouldShowProgress([_todo(status: 'pending')]), isTrue);
    expect(threadMenuShouldShowProgress([_todo(status: 'blocked')]), isTrue);
  });

  test('plan menu visibility requires non-empty approved plan', () {
    expect(threadMenuShouldShowPlan(), isFalse);
    expect(threadMenuShouldShowPlan(pendingPlan: _plan()), isFalse);
    expect(
      threadMenuShouldShowPlan(
        approvedPlan: _plan(plan: ''),
      ),
      isFalse,
    );
    expect(threadMenuShouldShowPlan(approvedPlan: _plan()), isTrue);
  });

  test('dynamic card entries are omitted when content is absent', () {
    final withoutCards = buildThreadSessionMenuEntries(
      _zh,
      hasThread: true,
      workspacePath: '/repo',
      isRunning: false,
      autoReadEnabled: false,
      gitStatus: _gitStatus(behindCount: 0),
    );
    final withoutValues = withoutCards.map((entry) => entry.value).toList();
    expect(withoutValues, isNot(contains('todos')));
    expect(withoutValues, isNot(contains('plan')));
    expect(withoutValues, isNot(contains('image_display')));
    expect(withoutValues, isNot(contains('image_generation')));
    expect(withoutValues, isNot(contains('html_host')));
    expect(withoutValues, contains('auto_read'));

    final withCards = buildThreadSessionMenuEntries(
      _zh,
      hasThread: true,
      workspacePath: '/repo',
      isRunning: false,
      autoReadEnabled: true,
      gitStatus: _gitStatus(behindCount: 0),
      visibility: const ThreadSessionMenuVisibility(
        showProgress: true,
        showPlan: true,
        showImageDisplay: true,
        showImageGeneration: true,
        showHtmlHost: true,
      ),
    );
    expect(
      withCards.map((entry) => entry.value).toList(),
      containsAll([
        'todos',
        'plan',
        'image_display',
        'image_generation',
        'html_host',
        'auto_read',
      ]),
    );
  });
}

GitWorkingTreeStatus _gitStatus({required int behindCount}) {
  return GitWorkingTreeStatus(
    workspacePath: '/repo',
    isGitRepository: true,
    hasGitCommits: true,
    dirtyFileCount: 0,
    insertions: 0,
    deletions: 0,
    canCommit: false,
    aheadCount: 0,
    behindCount: behindCount,
    hasUpstream: true,
    branch: 'main',
  );
}

CoderTodoItem _todo({required String status}) {
  return CoderTodoItem(
    id: 'todo-$status',
    threadId: 'thr_1',
    title: 'Task',
    detail: '',
    status: status,
    position: 0,
    updatedAt: '',
  );
}

ThreadPendingPlan _plan({String plan = '# Plan'}) {
  return ThreadPendingPlan(
    threadId: 'thr_1',
    userPrompt: '',
    analysis: '',
    plan: plan,
    workspacePath: '/repo',
    worktreePath: '',
  );
}
