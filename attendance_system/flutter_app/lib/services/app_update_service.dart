import 'dart:convert';

import 'package:flutter/services.dart';

import '../constants.dart';
import 'api_client.dart';

class AppUpdateInfo {
  final String latestVersion;
  final String minSupportedVersion;
  final bool forceUpdate;
  final String apkUrl;
  final String releaseNotes;

  const AppUpdateInfo({
    required this.latestVersion,
    required this.minSupportedVersion,
    required this.forceUpdate,
    required this.apkUrl,
    required this.releaseNotes,
  });

  factory AppUpdateInfo.fromJson(Map<String, dynamic> json) {
    return AppUpdateInfo(
      latestVersion: json['latest_version']?.toString() ?? '',
      minSupportedVersion: json['min_supported_version']?.toString() ?? '',
      forceUpdate: json['force_update'] == true,
      apkUrl: json['apk_url']?.toString() ?? '',
      releaseNotes: json['release_notes']?.toString() ?? '',
    );
  }
}

class AppUpdateService {
  static const _channel = MethodChannel('kvsk.attendance/app_update');

  static Future<AppUpdateInfo?> checkForUpdate() async {
    final res = await ApiClient.get(
      '/app-release',
      timeout: const Duration(seconds: 5),
    );
    if (res.statusCode != 200) return null;
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) return null;
    final info = AppUpdateInfo.fromJson(decoded);
    if (info.latestVersion.isEmpty) return null;
    return info;
  }

  static bool shouldShowUpdate(AppUpdateInfo info) {
    return _compareVersions(info.latestVersion, AppConstants.appVersion) > 0 ||
        _compareVersions(info.minSupportedVersion, AppConstants.appVersion) > 0;
  }

  static bool isRequired(AppUpdateInfo info) {
    return info.forceUpdate ||
        _compareVersions(info.minSupportedVersion, AppConstants.appVersion) > 0;
  }

  static Future<void> openUpdateUrl(String url) async {
    if (url.trim().isEmpty) return;
    await _channel.invokeMethod('openUrl', {'url': url.trim()});
  }

  static int _compareVersions(String a, String b) {
    final left = _versionParts(a);
    final right = _versionParts(b);
    final len = left.length > right.length ? left.length : right.length;
    for (var i = 0; i < len; i++) {
      final l = i < left.length ? left[i] : 0;
      final r = i < right.length ? right[i] : 0;
      if (l != r) return l.compareTo(r);
    }
    return 0;
  }

  static List<int> _versionParts(String value) {
    return value
        .split('+')
        .first
        .split('.')
        .map((part) => int.tryParse(part.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0)
        .toList();
  }
}

