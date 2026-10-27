import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:network_info_plus/network_info_plus.dart';

class DeviceProfile {
  const DeviceProfile({
    required this.displayName,
    required this.model,
    required this.platform,
    this.ipAddress,
  });

  final String displayName;
  final String model;
  final String platform;
  final String? ipAddress;

  Map<String, String> toMetadata() {
    return {
      'model': model,
      'platform': platform,
      if (ipAddress != null && ipAddress!.isNotEmpty) 'ipAddress': ipAddress!,
    };
  }

  static Future<DeviceProfile> collect() async {
    final deviceInfo = DeviceInfoPlugin();
    final networkInfo = NetworkInfo();
    final ipAddress = await _readIpAddress(networkInfo);

    if (Platform.isIOS) {
      final ios = await deviceInfo.iosInfo;
      final model =
          _cleanLabel(ios.utsname.machine) ??
          _cleanLabel(ios.model) ??
          'iPhone';
      final name = _cleanLabel(ios.name);
      return DeviceProfile(
        displayName: name != null && name != model ? '$name ($model)' : model,
        model: model,
        platform: 'iOS ${ios.systemVersion}',
        ipAddress: ipAddress,
      );
    }

    if (Platform.isAndroid) {
      final android = await deviceInfo.androidInfo;
      final manufacturer = _cleanLabel(android.manufacturer);
      final model = _cleanLabel(android.model) ?? 'Android';
      final label =
          manufacturer != null &&
              !model.toLowerCase().contains(manufacturer.toLowerCase())
          ? '$manufacturer $model'
          : model;
      return DeviceProfile(
        displayName: label,
        model: label,
        platform: 'Android ${android.version.release}',
        ipAddress: ipAddress,
      );
    }

    return DeviceProfile(
      displayName: 'Mori',
      model: Platform.operatingSystem,
      platform: Platform.operatingSystemVersion,
      ipAddress: ipAddress,
    );
  }

  static Future<String?> _readIpAddress(NetworkInfo networkInfo) async {
    try {
      final wifiIp = await networkInfo.getWifiIP();
      if (wifiIp != null && wifiIp.isNotEmpty && wifiIp != '0.0.0.0') {
        return wifiIp;
      }
    } catch (_) {}

    try {
      for (final interface in await NetworkInterface.list(
        includeLinkLocal: false,
        type: InternetAddressType.IPv4,
      )) {
        for (final address in interface.addresses) {
          if (address.isLoopback) continue;
          return address.address;
        }
      }
    } catch (_) {}

    return null;
  }

  static String? _cleanLabel(String? value) {
    final trimmed = value?.trim();
    if (trimmed == null || trimmed.isEmpty) {
      return null;
    }
    return trimmed;
  }
}
