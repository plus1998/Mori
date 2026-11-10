import 'package:eco_mobile/core/widgets/eco_markdown.dart';
import 'package:eco_mobile/core/widgets/streaming_eco_markdown.dart';
import 'package:eco_mobile/core/widgets/web_page_viewer.dart';
import 'package:eco_mobile/l10n/generated/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

const pageUrl =
    'http://119.91.205.109:8000/functions/v1/html-page-view/kbMIWGnJdb8uutAw23';
const linkLabel = '查看「消息时效面板」交互原型';

Widget app(Widget child) => MaterialApp(
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(body: child),
);

void main() {
  late TestWebViewPlatform platform;
  final previousPlatform = WebViewPlatform.instance;

  setUp(() {
    platform = TestWebViewPlatform();
    WebViewPlatform.instance = platform;
  });

  tearDown(() {
    if (previousPlatform != null) WebViewPlatform.instance = previousPlatform;
  });

  for (final selectable in [true, false]) {
    testWidgets('bold published link opens WebView, selectable=$selectable', (
      tester,
    ) async {
      await tester.pumpWidget(
        app(
          EcoMarkdown(
            text: '**[$linkLabel]($pageUrl)**',
            selectable: selectable,
          ),
        ),
      );
      await tester.tap(find.text(linkLabel, findRichText: true));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));

      expect(find.byType(WebPageViewer), findsOneWidget);
      expect(platform.controller.request?.uri.toString(), pageUrl);
      expect(platform.controller.javaScriptMode, JavaScriptMode.unrestricted);
      expect(
        find.descendant(
          of: find.byType(AppBar),
          matching: find.text(linkLabel),
        ),
        findsOneWidget,
      );
      platform.delegate.onPageFinished(pageUrl);
      await tester.pumpAndSettle();
      expect(find.byType(CircularProgressIndicator), findsNothing);

      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byType(WebPageViewer), findsNothing);
      expect(find.byType(EcoMarkdown), findsOneWidget);
    });
  }

  testWidgets('completed streaming reference link opens the same viewer', (
    tester,
  ) async {
    await tester.pumpWidget(
      app(
        const StreamingEcoMarkdown(
          text: '[$linkLabel][page]\n\n[page]: $pageUrl\n\n尾段\n',
          tailStyle: TextStyle(),
        ),
      ),
    );
    await tester.tapOnText(find.textRange.ofSubstring(linkLabel));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.byType(WebPageViewer), findsOneWidget);
    expect(platform.controller.request?.uri.toString(), pageUrl);
  });

  testWidgets('unsupported links show an error without opening a WebView', (
    tester,
  ) async {
    await tester.pumpWidget(
      app(const EcoMarkdown(text: '[本地文件](file:///tmp/example.html)')),
    );
    await tester.tap(find.text('本地文件', findRichText: true));
    await tester.pumpAndSettle();
    expect(find.byType(WebPageViewer), findsNothing);
    expect(find.byType(SnackBar), findsOneWidget);
  });

  testWidgets('subresource failures keep the page; main frame errors display', (
    tester,
  ) async {
    await tester.pumpWidget(
      app(const WebPageViewer(title: linkLabel, url: pageUrl)),
    );
    platform.delegate.onPageFinished(pageUrl);
    platform.delegate.onWebResourceError(
      const WebResourceError(
        errorCode: -1,
        description: 'Image failed',
        isForMainFrame: false,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('web-content')), findsOneWidget);
    expect(find.text('Image failed'), findsNothing);

    platform.delegate.onWebResourceError(
      const WebResourceError(
        errorCode: -2,
        description: 'Page failed',
        isForMainFrame: true,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Page failed'), findsOneWidget);
    expect(find.byKey(const ValueKey('web-content')), findsNothing);
  });
}

class TestWebViewPlatform extends WebViewPlatform {
  late TestWebViewController controller;
  late TestNavigationDelegate delegate;

  @override
  PlatformWebViewController createPlatformWebViewController(
    PlatformWebViewControllerCreationParams params,
  ) => controller = TestWebViewController(params);

  @override
  PlatformNavigationDelegate createPlatformNavigationDelegate(
    PlatformNavigationDelegateCreationParams params,
  ) => delegate = TestNavigationDelegate(params);

  @override
  PlatformWebViewWidget createPlatformWebViewWidget(
    PlatformWebViewWidgetCreationParams params,
  ) => TestWebViewWidget(params);
}

class TestWebViewController extends PlatformWebViewController {
  TestWebViewController(super.params) : super.implementation();

  LoadRequestParams? request;
  JavaScriptMode? javaScriptMode;

  @override
  Future<void> loadRequest(LoadRequestParams params) async => request = params;

  @override
  Future<void> setJavaScriptMode(JavaScriptMode mode) async =>
      javaScriptMode = mode;

  @override
  Future<void> setPlatformNavigationDelegate(
    PlatformNavigationDelegate handler,
  ) async {}
}

class TestNavigationDelegate extends PlatformNavigationDelegate {
  TestNavigationDelegate(super.params) : super.implementation();

  late PageEventCallback onPageFinished;
  late WebResourceErrorCallback onWebResourceError;

  @override
  Future<void> setOnPageStarted(PageEventCallback callback) async {}

  @override
  Future<void> setOnPageFinished(PageEventCallback callback) async =>
      onPageFinished = callback;

  @override
  Future<void> setOnWebResourceError(WebResourceErrorCallback callback) async =>
      onWebResourceError = callback;
}

class TestWebViewWidget extends PlatformWebViewWidget {
  TestWebViewWidget(super.params) : super.implementation();

  @override
  Widget build(BuildContext context) =>
      const SizedBox(key: ValueKey('web-content'));
}
