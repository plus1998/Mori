import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/display_control_models.dart';
import '../../core/models/eco_types.dart';
import '../../core/providers/desktop_bind_ready.dart';
import '../../core/widgets/eco_grouped_list.dart';
import '../../core/widgets/lifecycle_tracker.dart';
import 'settings_disclosure_row.dart';
import '../threads/thread_providers.dart';

final _bindReadyProvider = Provider(
  (ref) =>
      () => ensureDesktopBindReady(ref),
);

class SettingsDesktopDisplayPage extends ConsumerStatefulWidget {
  const SettingsDesktopDisplayPage({super.key});

  @override
  ConsumerState<SettingsDesktopDisplayPage> createState() =>
      _DesktopDisplayPageState();
}

class _DesktopDisplayPageState extends ConsumerState<SettingsDesktopDisplayPage>
    with WidgetsBindingObserver {
  DesktopDisplayState? _state;
  String? _error;
  DateTime? _checkedAt;
  bool _busy = false;
  bool _patrol = true;
  late final Timer _timer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _timer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (_patrol && AppLifecycleTracker.isForeground) unawaited(_refresh());
    });
    Future.microtask(_refresh);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_refresh());
  }

  Future<void> _refresh({String? control, bool? enabled}) async {
    if (!mounted || _busy) return;
    final rpc = ref.read(desktopRpcProvider);
    final connectFirst = context.l10n.settingsConnectPcFirst;
    setState(() => _busy = true);
    try {
      if (rpc == null || !await ref.read(_bindReadyProvider)()) {
        throw StateError(connectFirst);
      }
      if (!mounted || ref.read(desktopRpcProvider) != rpc) return;
      final state = control == null
          ? await rpc.getDisplayControl()
          : await rpc.setDisplayControl(control, enabled!);
      if (!mounted || ref.read(desktopRpcProvider) != rpc) return;
      setState(() {
        _state = state;
        _checkedAt = DateTime.now();
        _error = state.error;
      });
    } catch (error) {
      if (!mounted || ref.read(desktopRpcProvider) != rpc) return;
      setState(() {
        _state = null;
        _checkedAt = null;
        _error =
            error is EcoCenterException &&
                (error.code == EcoRpcConstants.methodNotFound ||
                    error.code == EcoRpcConstants.invalidParams)
            ? context.l10n.desktopDisplayUpgrade
            : error.toString();
      });
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        if (ref.read(desktopRpcProvider) != rpc) unawaited(_refresh());
      }
    }
  }

  @override
  void dispose() {
    _timer.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(desktopRpcProvider, (_, next) {
      setState(() {
        _state = null;
        _checkedAt = null;
        _error = null;
      });
      unawaited(_refresh());
    });
    final l = context.l10n;
    final state = _state;
    return Scaffold(
      appBar: AppBar(
        title: Text(l.desktopDisplayTitle),
        actions: [
          IconButton(
            onPressed: _busy ? null : _refresh,
            tooltip: l.commonRetry,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: ListView(
        children: [
          EcoGroupedSection(
            label: l.desktopDisplayTitle,
            footer: l.desktopDisplayHint,
            child: Column(
              children: [
                SettingsSwitchRow(
                  title: l.desktopPreventAutoLock,
                  subtitle: state == null
                      ? l.desktopDisplayUnknown
                      : state.preventAutoLock
                      ? l.desktopAutoLockPrevented
                      : l.desktopAutoLockAllowed,
                  value: state?.preventAutoLock ?? false,
                  enabled: state != null && !_busy,
                  onChanged: (value) =>
                      _refresh(control: 'preventAutoLock', enabled: value),
                ),
                const EcoGroupedDivider(),
                SettingsSwitchRow(
                  title: l.desktopDimScreen,
                  subtitle: state == null
                      ? l.desktopDisplayUnknown
                      : state.dimmed
                      ? l.desktopScreenDimmed
                      : l.desktopScreenNotDimmed,
                  value: state?.dimmed ?? false,
                  enabled:
                      state != null &&
                      !_busy &&
                      (state.brightnessAvailable || state.pendingRestores > 0),
                  onChanged: (value) =>
                      _refresh(control: 'dimmed', enabled: value),
                ),
                const EcoGroupedDivider(),
                SettingsSwitchRow(
                  title: l.desktopDisplayPatrol,
                  subtitle: l.desktopDisplayPatrolHint,
                  value: _patrol,
                  enabled: true,
                  onChanged: (value) {
                    setState(() => _patrol = value);
                    if (value) unawaited(_refresh());
                  },
                ),
              ],
            ),
          ),
          if (_busy && state == null)
            const Center(child: CircularProgressIndicator()),
          if (_checkedAt != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                l.desktopDisplayCheckedAt(DateFormat.Hms().format(_checkedAt!)),
              ),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          if (state != null) ...[
            for (final display in state.displays)
              ListTile(
                title: Text(display.name),
                subtitle: Text(
                  display.error ??
                      switch (display.status) {
                        'dimmed' => l.desktopScreenDimmed,
                        'ready' => l.desktopScreenNotDimmed,
                        'restorePending' => l.desktopDisplayRestorePending,
                        _ => l.desktopDisplayUnsupported,
                      },
                ),
              ),
            if (state.pendingRestores > 0)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(l.desktopDisplayRestorePending),
              ),
          ],
        ],
      ),
    );
  }
}
