import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/utils/package_script_run.dart';

void main() {
  test('quoted device names stay in one argument', () {
    const args = '-d "苹 果 时 期 Pro"';
    for (final manager in ['bun', 'npm', 'pnpm', 'yarn']) {
      final command = buildRunCommand(manager, 'install:ios', args);
      expect(command.sublist(command.length - 2), ['-d', '苹 果 时 期 Pro']);
    }
    expect(
      formatRunCommand('bun', 'install:ios', args),
      'bun run install:ios $args',
    );
    expect(
      joinPrefixedCommand(null, buildRunCommand('bun', 'install:ios', args)),
      'bun run install:ios $args',
    );
  });

  test('arguments support escapes, mixed quotes and empty values', () {
    expect(
      buildRunCommand(
        'bun',
        'dev',
        r''' 'a b' c\ d --title="e f" "" "a\"b" ''',
      ),
      ['bun', 'run', 'dev', 'a b', 'c d', '--title=e f', '', 'a"b'],
    );
    expect(
      () => buildRunCommand('bun', 'dev', '-d "unfinished'),
      throwsFormatException,
    );
    expect(
      () => buildRunCommand('bun', 'dev', 'trailing\\'),
      throwsFormatException,
    );
    expect(
      formatRunCommand('bun', 'dev', '-d "unfinished'),
      'bun run dev -d "unfinished',
    );
  });

  test('formatRunCommand appends args with npm separator', () {
    expect(
      formatRunCommand('npm', 'dev', '--port 3000'),
      'npm run dev -- --port 3000',
    );
  });

  test('formatRunCommand keeps explicit separator for pnpm', () {
    expect(
      formatRunCommand('pnpm', 'test', '-- --watch'),
      'pnpm run test -- --watch',
    );
  });

  test('formatRunCommand prefixes leading commands', () {
    expect(
      formatRunCommand('npm', 'dev', '--port 3000', 'nvm use 20'),
      'nvm use 20 && npm run dev -- --port 3000',
    );
  });

  test('formatRunCommand drops a trailing connector in the prefix', () {
    expect(
      formatRunCommand('bun', 'dev', null, 'nvm use 20 &&'),
      'nvm use 20 && bun run dev',
    );
  });

  test('formatRunCommand ignores blank prefixes', () {
    expect(
      formatRunCommand('bun', 'dev', '--watch', '   '),
      'bun run dev --watch',
    );
  });
}
