import '../models/eco_types.dart';

String threadSessionSubtitleLabel({
  String? projectName,
  required String workspacePath,
  String? desktopLabel,
}) {
  final project = projectName?.trim().isNotEmpty == true
      ? projectName!.trim()
      : (workspacePath.isNotEmpty ? workspaceDisplayName(workspacePath) : null);
  final host = desktopLabel?.trim();
  if (project != null && host != null && host.isNotEmpty) {
    return '$project · $host';
  }
  if (project != null) return project;
  if (host != null && host.isNotEmpty) return host;
  return '';
}

String formatDesktopLabel(PublicDevice? device, String deviceId) {
  return formatDeviceLabel(device, deviceId, kind: 'desktop');
}

String formatMobileLabel(PublicDevice? device, String deviceId) {
  return formatDeviceLabel(device, deviceId, kind: 'mobile');
}

String formatDeviceLabel(
  PublicDevice? device,
  String deviceId, {
  required String kind,
}) {
  final metadata = device?.metadata;

  if (kind == 'desktop') {
    final name = device?.name.trim();
    if (name != null &&
        name.isNotEmpty &&
        !_isGenericDeviceName(name, kind: kind)) {
      return name;
    }

    final hostname = metadata?.hostname?.trim();
    if (hostname != null && hostname.isNotEmpty) {
      return hostname;
    }
  }

  final model = metadata?.model?.trim();
  if (model != null && model.isNotEmpty) {
    return model;
  }

  final name = device?.name.trim();
  if (name != null &&
      name.isNotEmpty &&
      !_isGenericDeviceName(name, kind: kind)) {
    return name;
  }

  return shortenDeviceId(deviceId);
}

String? formatDeviceDetail(PublicDevice? device, {String? omitLabel}) {
  final parts = <String>[];
  final omit = omitLabel?.trim();
  final hostname = device?.metadata.hostname?.trim();
  final ipAddress = device?.metadata.ipAddress?.trim();
  final platform = device?.metadata.platform?.trim();
  if (hostname != null &&
      hostname.isNotEmpty &&
      (omit == null || omit.isEmpty || hostname != omit)) {
    parts.add(hostname);
  }
  if (ipAddress != null && ipAddress.isNotEmpty) {
    parts.add(ipAddress);
  }
  if (platform != null && platform.isNotEmpty) {
    parts.add(platform);
  }
  return parts.isEmpty ? null : parts.join(' · ');
}

bool _isGenericDeviceName(String name, {required String kind}) {
  final normalized = name.trim().toLowerCase();
  if (normalized == 'mori') return true;
  if (kind == 'mobile') {
    return normalized == 'mori mobile' ||
        normalized == 'morimobile' ||
        normalized == 'eco mobile' ||
        normalized == 'ecomobile';
  }
  return normalized == 'mori desktop' ||
      normalized == 'moridesktop' ||
      normalized == 'eco desktop' ||
      normalized == 'ecodesktop';
}

String shortenDeviceId(String deviceId) {
  final trimmed = deviceId.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return '${trimmed.substring(0, 8)}…${trimmed.substring(trimmed.length - 4)}';
}
