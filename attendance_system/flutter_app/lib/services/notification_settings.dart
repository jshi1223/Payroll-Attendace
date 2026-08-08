import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class NotificationSettings {
  static const String _prefsKey = 'notif_settings_v1';

  static const Map<String, String> _typeToCategory = {
    'payslip_ready': 'payslip',
    'payslip_unlocked': 'payslip',
    'payslip_approved': 'payslip',
    'payslip_rejected': 'payslip',
    'payroll_accepted': 'payslip',
    'salary_paid': 'salary',
    'bale_payment': 'bale',
    'extra_pay_added': 'extra',
    'cash_advance_approved': 'bale',
    'cash_advance_rejected': 'bale',
    'payday_reminder': 'reminders',
    'ca_overdue_reminder': 'reminders',
    'announcement': 'announcements',
  };

  static const Map<String, String> categoryLabelsEn = {
    'payslip': 'Payslips',
    'salary': 'Salary payments',
    'bale': 'Cash advance',
    'extra': 'Extra pay',
    'reminders': 'Payday reminders',
    'announcements': 'Admin announcements',
  };

  static const Map<String, String> categoryLabelsFil = {
    'payslip': 'Mga Payslip',
    'salary': 'Pagbabayad ng Sahod',
    'bale': 'Paunang Sahod',
    'extra': 'Dagdag na Bayad',
    'reminders': 'Mga Paalala ng Payday',
    'announcements': 'Mga Anunsyo ng Admin',
  };

  static const List<String> allCategories = [
    'payslip',
    'salary',
    'bale',
    'extra',
    'reminders',
    'announcements',
  ];

  static Map<String, bool> _cached = {};
  static bool _loaded = false;

  static Future<void> _ensureLoaded() async {
    if (_loaded) return;
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_prefsKey);
    if (raw != null && raw.isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is Map) {
          _cached = decoded.map(
            (k, v) => MapEntry(k.toString(), v == true),
          );
        }
      } catch (_) {
        _cached = {};
      }
    }
    _loaded = true;
  }

  static bool isEnabled(String type) {
    final category = _typeToCategory[type];
    if (category == null) return true;
    return _cached[category] ?? true;
  }

  static bool isCategoryEnabled(String category) {
    return _cached[category] ?? true;
  }

  static Future<void> setCategoryEnabled(String category, bool enabled) async {
    await _ensureLoaded();
    _cached[category] = enabled;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefsKey, jsonEncode(_cached));
  }

  static Future<Map<String, bool>> snapshot() async {
    await _ensureLoaded();
    return Map<String, bool>.from(_cached);
  }
}
