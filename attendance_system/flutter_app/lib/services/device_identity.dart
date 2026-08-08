import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';

/// Returns a stable, per-device identifier used for GCash-style device
/// binding: the account is tied to the first phone that registers or signs
/// in, and signing in from a different phone is blocked until an admin
/// resets the binding.
///
/// On Android this is the Android ID (SSAID) — stable across app re-installs
/// and tied to the device + app signing key. On iOS it is the vendor
/// identifier. On other platforms (web/desktop) it returns an empty string,
/// which the backend treats as "no device binding".
class DeviceIdentity {
  static String? _cached;

  static Future<String> getId() async {
    if (_cached != null) return _cached!;
    String id = '';
    try {
      if (kIsWeb) return '';
      final plugin = DeviceInfoPlugin();
      if (Platform.isAndroid) {
        final info = await plugin.androidInfo;
        id = info.id;
      } else if (Platform.isIOS) {
        final info = await plugin.iosInfo;
        id = info.identifierForVendor ?? '';
      }
    } catch (_) {
      // Never let device-identity lookup break login; empty means "no binding".
      id = '';
    }
    _cached = id;
    return id;
  }
}
