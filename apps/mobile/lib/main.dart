import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:refresh_rate/refresh_rate.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'core/locale/app_locale_preference.dart';
import 'core/providers/activity_feed_auto_read_provider.dart';
import 'core/providers/app_locale_provider.dart';
import 'core/providers/app_theme_provider.dart';
import 'core/providers/desktop_auto_connect_provider.dart';
import 'core/providers/thinking_display_provider.dart';
import 'core/theme/app_theme_preference.dart';
import 'core/widgets/progressive_blur.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Flutter engine does not call Android Surface.setFrameRate by default (#160952).
  // iOS has no qualified engine-control backend in refresh_rate 2.x; keeping
  // this request Android-only avoids an unnecessary native call on every iOS
  // launch while retaining the Android high-refresh behavior.
  if (defaultTargetPlatform == TargetPlatform.android) {
    unawaited(RefreshRate.enable());
  }

  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(systemNavigationBarColor: Colors.transparent),
  );

  // Pre-compile progressive frost so the first session paint is smooth.
  await ProgressiveBlur.preload();

  final prefs = await SharedPreferences.getInstance();
  final stored = AppThemePreference.tryParse(
    prefs.getString(AppThemePreference.storageKey),
  );
  final initialTheme = stored ?? AppThemePreference.system;
  final storedLocale = AppLocalePreference.tryParse(
    prefs.getString(AppLocalePreference.storageKey),
  );
  final initialLocale = storedLocale ?? AppLocalePreference.system;
  final initialAutoRead =
      prefs.getBool(activityFeedAutoReadStorageKey) ?? false;
  final initialThinkingDisplay = readStoredThinkingDisplayMode(prefs);

  runApp(
    ProviderScope(
      overrides: [
        appThemeBootstrapProvider.overrideWithValue(initialTheme),
        appLocaleBootstrapProvider.overrideWithValue(initialLocale),
        activityFeedAutoReadBootstrapProvider.overrideWithValue(
          initialAutoRead,
        ),
        thinkingDisplayBootstrapProvider.overrideWithValue(
          initialThinkingDisplay,
        ),
        desktopAutoConnectBootstrapProvider.overrideWithValue(
          DesktopAutoConnectPreference.read(prefs),
        ),
      ],
      child: const EcoApp(),
    ),
  );
}
