import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

/// Whether iOS Liquid Glass `UiKitView` chrome may be shown for this [context].
///
/// Platform views sit outside Flutter's transform/clip stack and punch through
/// covering routes (especially during iOS interactive pop). Shell chrome lives
/// under a nested Navigator that stays "current" while root detail routes are
/// open, so we key off the full GoRouter location rather than [Navigator.canPop]
/// (which can stick / mis-rebuild after theme changes).
bool allowNativePlatformView(BuildContext context) {
  final navigator = Navigator.maybeOf(context);
  final rootNavigator = Navigator.maybeOf(context, rootNavigator: true);
  final onRootNavigator = navigator != null &&
      rootNavigator != null &&
      identical(navigator, rootNavigator);

  // Root-stack pages (session, /connect, settings details): native only while
  // this route is the topmost current page (hidden during cover / peer stacks).
  if (onRootNavigator) {
    final route = ModalRoute.of(context);
    return route?.isCurrent ?? true;
  }

  // Nested shell (threads list, settings home, tab bar): hide whenever any
  // full-screen root route is active — session, settings/*, /connect (切换 PC),
  // etc. Bidirectional with connect/settings: both shell chrome and underlying
  // glass must not punch through the page on top.
  return !isShellCoveredByRootDetail(context);
}

/// True when the app location is a full-screen root route covering the shell.
bool isShellCoveredByRootDetail(BuildContext context) {
  final router = GoRouter.maybeOf(context);
  if (router == null) return false;
  return isShellCoveredLocation(router.state.uri.path);
}

/// Pure path check (also used by unit tests).
///
/// Only bare shell tab roots keep nested Platform Views. Everything else
/// (sessions, settings subpages, switch-PC `/connect`) covers the shell.
bool isShellCoveredLocation(String path) {
  return path != '/threads' && path != '/todos' && path != '/settings';
}
