import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class EmployeeSession {
  final String token;
  final String name;
  final String employeeId;
  final String email;
  final String phone;
  final String governmentId;
  final String sssNumber;
  final String philhealthNumber;
  final String pagibigNumber;
  final String tinNumber;
  final String status;
  final String photoUrl;

  const EmployeeSession({
    required this.token,
    this.name = '',
    this.employeeId = '',
    this.email = '',
    this.phone = '',
    this.governmentId = '',
    this.sssNumber = '',
    this.philhealthNumber = '',
    this.pagibigNumber = '',
    this.tinNumber = '',
    this.status = '',
    this.photoUrl = '',
  });

  bool get isValid => token.isNotEmpty;

  Map<String, dynamic> toJson() => {
        'token': token,
        'name': name,
        'employee_id': employeeId,
        'email': email,
        'phone': phone,
        'government_id': governmentId,
        'sss_number': sssNumber,
        'philhealth_number': philhealthNumber,
        'pagibig_number': pagibigNumber,
        'tin_number': tinNumber,
        'status': status,
        'photo_url': photoUrl,
      };

  factory EmployeeSession.fromJson(Map<String, dynamic> json) {
    return EmployeeSession(
      token: json['token']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      employeeId: json['employee_id']?.toString() ?? '',
      email: json['email']?.toString() ?? '',
      phone: json['phone']?.toString() ?? '',
      governmentId: json['government_id']?.toString() ?? '',
      sssNumber: json['sss_number']?.toString() ?? '',
      philhealthNumber: json['philhealth_number']?.toString() ?? '',
      pagibigNumber: json['pagibig_number']?.toString() ?? '',
      tinNumber: json['tin_number']?.toString() ?? '',
      status: json['status']?.toString() ?? '',
      photoUrl: json['photo_url']?.toString() ?? '',
    );
  }

  EmployeeSession copyWith({
    String? name,
    String? email,
    String? phone,
    String? governmentId,
    String? sssNumber,
    String? philhealthNumber,
    String? pagibigNumber,
    String? tinNumber,
    String? status,
    String? photoUrl,
  }) {
    return EmployeeSession(
      token: token,
      name: name ?? this.name,
      employeeId: employeeId,
      email: email ?? this.email,
      phone: phone ?? this.phone,
      governmentId: governmentId ?? this.governmentId,
      sssNumber: sssNumber ?? this.sssNumber,
      philhealthNumber: philhealthNumber ?? this.philhealthNumber,
      pagibigNumber: pagibigNumber ?? this.pagibigNumber,
      tinNumber: tinNumber ?? this.tinNumber,
      status: status ?? this.status,
      photoUrl: photoUrl ?? this.photoUrl,
    );
  }
}

/// Persists the employee session so the app can restore the login after the
/// app is closed. Tokens are stored in the OS secure keystore.
class SessionStore {
  static const FlutterSecureStorage _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const String _sessionKey = 'employee_session_v1';

  static Future<void> save(EmployeeSession session) async {
    await _storage.write(key: _sessionKey, value: jsonEncode(session.toJson()));
  }

  static Future<EmployeeSession?> load() async {
    try {
      final raw = await _storage.read(key: _sessionKey);
      if (raw == null || raw.isEmpty) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final session = EmployeeSession.fromJson(decoded);
      return session.isValid ? session : null;
    } catch (_) {
      return null;
    }
  }

  static Future<void> clear() async {
    await _storage.delete(key: _sessionKey);
  }
}
