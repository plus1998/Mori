import 'package:eco_mobile/core/theme/eco_theme.dart';
import 'package:eco_mobile/core/widgets/eco_markdown.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final platform in [TargetPlatform.iOS, TargetPlatform.android]) {
    for (final padding in [
      EdgeInsets.zero,
      const EdgeInsets.only(top: 44, bottom: 34),
      const EdgeInsets.fromLTRB(44, 0, 44, 21),
    ]) {
      testWidgets('code scrollbar stays below text: $platform, $padding', (
        tester,
      ) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: buildEcoLightTheme().copyWith(platform: platform),
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            home: Scaffold(
              body: MediaQuery(
                data: MediaQueryData(padding: padding, viewPadding: padding),
                child: const Align(
                  alignment: Alignment.topLeft,
                  child: SizedBox(
                    width: 300,
                    child: EcoMarkdown(
                      text: '''
```text
POST /EXT/auth/feature-user/api/primary/mig/qr/prepare
HTTP 403
response body: empty
```
''',
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final scrollView = find.byWidgetPredicate(
          (widget) =>
              widget is SingleChildScrollView &&
              widget.scrollDirection == Axis.horizontal,
        );
        expect(scrollView, findsOneWidget);
        final controller = tester
            .widget<SingleChildScrollView>(scrollView)
            .controller!;
        expect(controller.position.maxScrollExtent, greaterThan(0));

        // Inspect the thumb while an actual horizontal drag is in progress.
        final gesture = await tester.startGesture(
          tester.getBottomLeft(scrollView) + const Offset(150, -8),
        );
        await gesture.moveBy(const Offset(-24, 0));
        await tester.pump();
        await gesture.moveBy(const Offset(-90, 0));
        await tester.pump(const Duration(milliseconds: 300));
        expect(controller.offset, greaterThan(0));

        final scrollbar = find
            .byWidgetPredicate((widget) => widget is RawScrollbar)
            .last;
        final paintedScrollbar = find.descendant(
          of: scrollbar,
          matching: find.byWidgetPredicate(
            (widget) =>
                widget is CustomPaint &&
                widget.foregroundPainter is ScrollbarPainter,
          ),
        );
        final painter = tester
            .widget<CustomPaint>(paintedScrollbar)
            .foregroundPainter!;
        final size = tester.getSize(paintedScrollbar);
        final textBottom =
            tester.getBottomLeft(find.byType(SelectableText)).dy -
            tester.getTopLeft(scrollbar).dy;
        expect(
          (Canvas canvas) => painter.paint(canvas, size),
          paints..something((method, arguments) {
            if (method != #drawRRect && method != #drawRect) return false;
            if ((arguments[1] as Paint).color.a == 0) return false;
            final thumb = method == #drawRRect
                ? (arguments.first as RRect).outerRect
                : arguments.first as Rect;
            expect(thumb.top, greaterThan(textBottom));
            expect(
              thumb.bottom,
              inInclusiveRange(size.height - 8, size.height),
            );
            expect(thumb.left, greaterThanOrEqualTo(0));
            expect(thumb.right, lessThanOrEqualTo(size.width));
            return true;
          }),
        );
        await gesture.up();
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      });
    }
  }
}
