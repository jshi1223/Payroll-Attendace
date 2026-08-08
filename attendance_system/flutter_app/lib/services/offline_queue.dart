import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'api_client.dart';

class QueuedAttendance {
  final String type;
  final String timestamp;
  final String employeeToken;

  const QueuedAttendance({
    required this.type,
    required this.timestamp,
    required this.employeeToken,
  });

  Map<String, dynamic> toJson() => {
        'type': type,
        'timestamp': timestamp,
        'token': employeeToken,
      };

  factory QueuedAttendance.fromJson(Map<String, dynamic> json) {
    return QueuedAttendance(
      type: json['type']?.toString() ?? 'present',
      timestamp: json['timestamp']?.toString() ?? '',
      employeeToken: json['token']?.toString() ?? '',
    );
  }
}

/// Stores attendance marks that failed to upload because the device was
/// offline. The queue is replayed against the server once connectivity returns.
class OfflineAttendanceQueue {
  static const String _key = 'offline_attendance_queue_v1';

  static Future<List<QueuedAttendance>> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_key) ?? const [];
    final items = <QueuedAttendance>[];
    for (final entry in raw) {
      try {
        final decoded = jsonDecode(entry);
        if (decoded is Map<String, dynamic>) {
          items.add(QueuedAttendance.fromJson(decoded));
        }
      } catch (_) {}
    }
    return items;
  }

  static Future<void> enqueue({
    required String type,
    required DateTime timestamp,
    required String employeeToken,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final list = (prefs.getStringList(_key) ?? const []).toList();
    list.add(
      jsonEncode(
        QueuedAttendance(
          type: type,
          timestamp: timestamp.toIso8601String(),
          employeeToken: employeeToken,
        ).toJson(),
      ),
    );
    await prefs.setStringList(_key, list);
  }

  static Future<void> removeAt(int index) async {
    final prefs = await SharedPreferences.getInstance();
    final list = (prefs.getStringList(_key) ?? const []).toList();
    if (index < 0 || index >= list.length) return;
    list.removeAt(index);
    await prefs.setStringList(_key, list);
  }

  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }

  static Future<int> length() async {
    final prefs = await SharedPreferences.getInstance();
    return (prefs.getStringList(_key) ?? const []).length;
  }
}

/// Attempts to replay queued attendance marks against the server.
class OfflineSyncService {
  static Future<SyncResult> syncAll() async {
    final items = await OfflineAttendanceQueue.load();
    if (items.isEmpty) return const SyncResult(0, 0);

    var synced = 0;
    var failed = 0;
    final stillQueued = <QueuedAttendance>[];

    for (final item in items) {
      final ok = await _syncOne(item);
      if (ok) {
        synced++;
      } else {
        failed++;
        stillQueued.add(item);
      }
    }

    if (synced > 0) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(
        OfflineAttendanceQueue._key,
        stillQueued
            .map((item) => jsonEncode(item.toJson()))
            .toList(),
      );
    }
    return SyncResult(synced, failed);
  }

  static Future<bool> _syncOne(QueuedAttendance item) async {
    if (item.employeeToken.isEmpty) return false;
    try {
      final body = {'timestamp': item.timestamp};
      final path = item.type == 'time_out' ? '/timeout' : '/present';
      final response = await ApiClient.postJson(
        path,
        headers: {'Authorization': 'Bearer ${item.employeeToken}'},
        body: body,
        timeout: const Duration(seconds: 15),
      );
      final ok = response.statusCode >= 200 && response.statusCode < 300;
      // Permanent rejections are dropped instead of retried forever. This
      // includes auth failures (401/403) — e.g. the session was superseded by
      // a login on another device — where this queued item can never sync
      // again with the stored token.
      if (!ok &&
          (response.statusCode == 400 ||
              response.statusCode == 401 ||
              response.statusCode == 403 ||
              response.statusCode == 409)) {
        return true;
      }
      return ok;
    } catch (_) {
      return false;
    }
  }
}

class SyncResult {
  final int synced;
  final int failed;

  const SyncResult(this.synced, this.failed);
}
