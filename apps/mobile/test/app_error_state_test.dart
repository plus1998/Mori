import 'package:eco_mobile/core/theme/eco_icons.dart';
import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/widgets/app_error_state.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('renders an accessible error state and retries in place', (
    tester,
  ) async {
    var retries = 0;
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('zh'),
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildEcoLightTheme(),
        home: Scaffold(
          body: AppErrorState(
            title: '连接异常',
            message: '无法连接服务端，请检查网络后重试。',
            retryLabel: '重试',
            onRetry: () async {
              retries += 1;
            },
          ),
        ),
      ),
    );

    expect(find.byIcon(EcoIcons.error), findsOneWidget);
    expect(find.text('连接异常'), findsOneWidget);
    expect(find.text('无法连接服务端，请检查网络后重试。'), findsOneWidget);

    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();

    expect(retries, 1);
  });
}
