import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/app_providers.dart';
import '../models/eco_types.dart';
import '../services/eco_tts_service.dart';

/// Stops TTS when the app leaves the foreground so playback cannot resume later.
class TtsLifecycleBinder extends ConsumerStatefulWidget {
  const TtsLifecycleBinder({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<TtsLifecycleBinder> createState() => _TtsLifecycleBinderState();
}

class _TtsLifecycleBinderState extends ConsumerState<TtsLifecycleBinder>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
      case AppLifecycleState.inactive:
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        unawaited(ref.read(ecoTtsServiceProvider).stop());
      case AppLifecycleState.resumed:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(connectionStatusProvider, (previous, next) {
      if (next.valueOrNull?.state != EcoConnectionState.connected &&
          ref.read(ecoTtsServiceProvider).engine == TtsEngine.online) {
        unawaited(ref.read(ecoTtsServiceProvider).connectionLost());
      }
    });
    ref.listen(selectedDesktopIdProvider, (previous, next) {
      if (previous != next) unawaited(ref.read(ecoTtsServiceProvider).stop());
    });
    return widget.child;
  }
}
