import 'package:adaptive_platform_ui/adaptive_platform_ui.dart';
import 'package:flutter/material.dart';

import 'eco_icons.dart';

/// SF Symbol name for an [EcoIcons] glyph on iOS 26+ native widgets.
String? ecoIconSfSymbol(IconData icon) {
  return switch (icon) {
    EcoIcons.sessions => 'bubble.left.and.bubble.right',
    EcoIcons.settings => 'gearshape',
    EcoIcons.desktop => 'display',
    EcoIcons.back => 'arrow.left',
    EcoIcons.goForward => 'arrow.right.circle',
    EcoIcons.refresh => 'arrow.clockwise',
    EcoIcons.qrScan => 'qrcode.viewfinder',
    EcoIcons.folderOpen => 'folder',
    EcoIcons.search => 'magnifyingglass',
    EcoIcons.close => 'xmark',
    EcoIcons.chevronLeft => 'chevron.left',
    EcoIcons.newThread => 'square.and.pencil',
    EcoIcons.more => 'ellipsis.circle',
    EcoIcons.notifications => 'bell',
    EcoIcons.schedule => 'clock',
    EcoIcons.todos => 'checklist',
    EcoIcons.planApproval => 'checklist',
    EcoIcons.codeReview => 'doc.text.magnifyingglass',
    EcoIcons.commitPush => 'arrow.up.doc',
    EcoIcons.pull => 'arrow.down.circle',
    EcoIcons.npmScripts => 'terminal',
    EcoIcons.volume2 => 'speaker.wave.2',
    EcoIcons.speaking => 'waveform',
    EcoIcons.copy => 'doc.on.doc',
    _ => null,
  };
}

/// Icon payload for adaptive widgets: SF Symbol [String] on iOS 26+, else [IconData].
dynamic adaptivePlatformIcon(IconData icon) {
  if (PlatformInfo.isIOS26OrHigher()) {
    return ecoIconSfSymbol(icon) ?? icon;
  }
  return icon;
}
