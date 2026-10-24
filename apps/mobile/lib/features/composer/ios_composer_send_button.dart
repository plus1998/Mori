import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/models/thread_models.dart';

/// UIKit owns both tap-to-send and the long-press UIMenu. On iOS 26 the
/// system presents that menu with Liquid Glass, including its animation.
class IOSComposerSendButton extends StatefulWidget {
  const IOSComposerSendButton({
    super.key,
    required this.size,
    required this.busy,
    required this.backgroundColor,
    required this.foregroundColor,
    required this.label,
    required this.queueLabel,
    required this.steerLabel,
    required this.scheduleLabel,
    required this.onSend,
    this.onSendWithMode,
    this.onSchedule,
  });

  final double size;
  final bool busy;
  final Color backgroundColor;
  final Color foregroundColor;
  final String label;
  final String queueLabel;
  final String steerLabel;
  final String scheduleLabel;
  final VoidCallback? onSend;
  final ValueChanged<FollowUpDeliveryMode>? onSendWithMode;
  final VoidCallback? onSchedule;

  @override
  State<IOSComposerSendButton> createState() => _IOSComposerSendButtonState();
}

class _IOSComposerSendButtonState extends State<IOSComposerSendButton> {
  MethodChannel? _channel;
  Map<String, Object>? _lastConfiguration;

  Future<void> _handleMethodCall(MethodCall call) async {
    if (!mounted || widget.busy) return;
    switch (call.method) {
      case 'pressed':
        widget.onSend?.call();
      case 'selected':
        switch (call.arguments) {
          case 'queue':
            if (widget.onSend != null) {
              widget.onSendWithMode?.call(FollowUpDeliveryMode.queue);
            }
          case 'schedule':
            widget.onSchedule?.call();
          case 'steer':
            if (widget.onSend != null) {
              widget.onSendWithMode?.call(FollowUpDeliveryMode.steer);
            }
        }
    }
  }

  Map<String, Object> _configuration() => {
    'enabled':
        (widget.onSend != null || widget.onSchedule != null) && !widget.busy,
    'busy': widget.busy,
    'allowDelivery': widget.onSend != null && widget.onSendWithMode != null,
    'allowSchedule': widget.onSchedule != null,
    'backgroundColor': widget.backgroundColor.toARGB32(),
    'foregroundColor': widget.foregroundColor.toARGB32(),
    'isDark': Theme.of(context).brightness == Brightness.dark,
    'label': widget.label,
    'queueLabel': widget.queueLabel,
    'steerLabel': widget.steerLabel,
    'scheduleLabel': widget.scheduleLabel,
  };

  @override
  void didUpdateWidget(covariant IOSComposerSendButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncConfiguration();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncConfiguration();
  }

  void _syncConfiguration() {
    if (_channel == null) return;
    final configuration = _configuration();
    // Streaming feed rebuilds must not replace an open UIKit menu.
    if (mapEquals(configuration, _lastConfiguration)) return;
    _lastConfiguration = configuration;
    _channel!.invokeMethod<void>('update', configuration);
  }

  @override
  void dispose() {
    _channel?.setMethodCallHandler(null);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: widget.size,
    child: UiKitView(
      viewType: 'eco_mobile/composer_send_button',
      creationParams: _configuration(),
      creationParamsCodec: const StandardMessageCodec(),
      gestureRecognizers: {
        Factory<OneSequenceGestureRecognizer>(EagerGestureRecognizer.new),
      },
      onPlatformViewCreated: (id) {
        if (!mounted) return;
        _channel = MethodChannel('eco_mobile/composer_send_button_$id')
          ..setMethodCallHandler(_handleMethodCall);
        // Input, theme or locale may have changed while UIKit was creating it.
        _syncConfiguration();
      },
    ),
  );
}
