import 'dart:async';

import 'package:flutter/widgets.dart';

import '../utils/stream_text.dart';

typedef PacedStreamTextBuilder =
    Widget Function(BuildContext context, String displayText, bool revealing);

class PacedStreamText extends StatefulWidget {
  const PacedStreamText({
    super.key,
    required this.text,
    required this.streaming,
    required this.builder,
  });

  final String text;
  final bool streaming;
  final PacedStreamTextBuilder builder;

  @override
  State<PacedStreamText> createState() => _PacedStreamTextState();
}

class _PacedStreamTextState extends State<PacedStreamText>
    with WidgetsBindingObserver {
  late String _displayText;
  late String _targetText;
  Timer? _revealTimer;
  bool _visible = true;
  bool _reduceMotion = false;

  @override
  void initState() {
    super.initState();
    _targetText = widget.text;
    _displayText = _targetText;
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _visible = TickerMode.valuesOf(context).enabled;
    _reduceMotion = MediaQuery.disableAnimationsOf(context);
    _syncReveal();
  }

  @override
  void didUpdateWidget(covariant PacedStreamText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_targetText != widget.text) {
      // Feed entries provide cumulative snapshots. Ignore a stale shorter
      // snapshot, but replace non-prefix repairs instead of concatenating them.
      if (!_targetText.startsWith(widget.text)) {
        _targetText = widget.text;
      }
    }
    _syncReveal();
  }

  void _syncReveal() {
    if (!widget.streaming || _reduceMotion) {
      // 已定稿或不再是逐字目标：直接补齐全量。
      _cancelReveal();
      if (_displayText != _targetText) {
        _displayText = _targetText;
      }
      return;
    }
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    if (!_visible ||
        (lifecycle != null && lifecycle != AppLifecycleState.resumed)) {
      _cancelReveal();
      return;
    }
    _scheduleReveal();
  }

  void _onTick() {
    _revealTimer = null;
    final nextText = revealPacedStreamText(
      _displayText,
      _targetText,
      streaming: widget.streaming,
    );
    if (nextText != _displayText && mounted) {
      setState(() => _displayText = nextText);
    }
    _scheduleReveal();
  }

  void _scheduleReveal() {
    if (_displayText == _targetText || _revealTimer != null) return;
    _revealTimer = Timer(pacedStreamInterval, _onTick);
  }

  void _cancelReveal() {
    _revealTimer?.cancel();
    _revealTimer = null;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _syncReveal();

  @override
  void dispose() {
    _cancelReveal();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return widget.builder(context, _displayText, _displayText != _targetText);
  }
}
