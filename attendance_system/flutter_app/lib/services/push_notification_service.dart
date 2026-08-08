import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import 'api_client.dart';

class PushNotificationStatus {
  final bool configured;
  final bool initialized;
  final bool permissionRequested;
  final bool tokenGenerated;
  final bool uploaded;
  final String message;
  final String tokenPreview;

  const PushNotificationStatus({
    required this.configured,
    required this.initialized,
    required this.permissionRequested,
    required this.tokenGenerated,
    required this.uploaded,
    required this.message,
    required this.tokenPreview,
  });

  const PushNotificationStatus.initial()
      : configured = false,
        initialized = false,
        permissionRequested = false,
        tokenGenerated = false,
        uploaded = false,
        message = 'Not checked yet.',
        tokenPreview = '';

  PushNotificationStatus copyWith({
    bool? configured,
    bool? initialized,
    bool? permissionRequested,
    bool? tokenGenerated,
    bool? uploaded,
    String? message,
    String? tokenPreview,
  }) {
    return PushNotificationStatus(
      configured: configured ?? this.configured,
      initialized: initialized ?? this.initialized,
      permissionRequested: permissionRequested ?? this.permissionRequested,
      tokenGenerated: tokenGenerated ?? this.tokenGenerated,
      uploaded: uploaded ?? this.uploaded,
      message: message ?? this.message,
      tokenPreview: tokenPreview ?? this.tokenPreview,
    );
  }
}

@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await PushNotificationService.ensureInitialized();
}

class PushNotificationService {
  static bool _initializing = false;
  static bool _initialized = false;
  static String _employeeToken = '';
  static PushNotificationStatus _status = const PushNotificationStatus.initial();

  /// Emits a navigation request when a push notification deep-link is tapped,
  /// e.g. the payload requests opening the attendance screen.
  static final ValueNotifier<String?> deepLinkNotifier = ValueNotifier<String?>(null);

  /// Carries the payroll period (week start) to highlight when a push asks to
  /// open the payroll section. Cleared after it is consumed.
  static final ValueNotifier<String?> deepLinkPeriodNotifier = ValueNotifier<String?>(null);

  static void clearDeepLinkPeriod() {
    deepLinkPeriodNotifier.value = null;
  }

  /// Invoked when a push arrives with fresh data while the app is in the
  /// foreground, so the dashboard can refresh without the old 20s polling.
  /// The [type] is the push payload type (e.g. present, payroll_updated).
  static void Function(String type)? onDataRefresh;

  static bool _listening = false;

  static const String _firebaseApiKey = String.fromEnvironment(
    'FIREBASE_API_KEY',
    defaultValue: 'AIzaSyBd2lBlpsVeo-uodqHIHsGIGyQnN-HPHHc',
  );
  static const String _firebaseAppId = String.fromEnvironment(
    'FIREBASE_APP_ID',
    defaultValue: '1:1081441548888:android:24a2b7cb75b978aaefa82d',
  );
  static const String _firebaseMessagingSenderId = String.fromEnvironment(
    'FIREBASE_MESSAGING_SENDER_ID',
    defaultValue: '1081441548888',
  );
  static const String _firebaseProjectId = String.fromEnvironment(
    'FIREBASE_PROJECT_ID',
    defaultValue: 'attendance-7c06d',
  );
  static const String _firebaseStorageBucket = String.fromEnvironment(
    'FIREBASE_STORAGE_BUCKET',
    defaultValue: 'attendance-7c06d.firebasestorage.app',
  );

  static PushNotificationStatus get status => _status;

  static bool get isConfigured =>
      _firebaseApiKey.isNotEmpty &&
      _firebaseAppId.isNotEmpty &&
      _firebaseMessagingSenderId.isNotEmpty &&
      _firebaseProjectId.isNotEmpty;

  static Future<void> ensureInitialized() async {
    _status = _status.copyWith(configured: isConfigured);
    if (kIsWeb) {
      _status = _status.copyWith(message: 'Push notifications are not available on web.');
      return;
    }
    if (!isConfigured) {
      _status = _status.copyWith(
        initialized: false,
        message: 'Firebase dart-defines are missing in this app build.',
      );
      return;
    }
    if (_initialized || _initializing) return;
    _initializing = true;
    try {
      await Firebase.initializeApp(
        options: const FirebaseOptions(
          apiKey: _firebaseApiKey,
          appId: _firebaseAppId,
          messagingSenderId: _firebaseMessagingSenderId,
          projectId: _firebaseProjectId,
          storageBucket: _firebaseStorageBucket,
        ),
      );
      FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
      FirebaseMessaging.instance.onTokenRefresh.listen((token) {
        _sendTokenToBackend(token);
      });
      _setupListeners();
      unawaited(_handleInitialMessage());
      _initialized = true;
      _status = _status.copyWith(
        configured: true,
        initialized: true,
        message: 'Firebase initialized.',
      );
    } catch (error) {
      _initialized = false;
      _status = _status.copyWith(
        configured: true,
        initialized: false,
        message: 'Firebase init failed: $error',
      );
    } finally {
      _initializing = false;
    }
  }

  static Future<void> registerForEmployee(String employeeToken) async {
    _employeeToken = employeeToken;
    await ensureInitialized();
    if (_employeeToken.isEmpty) {
      _status = _status.copyWith(message: 'Employee session token is missing.');
      return;
    }
    if (!_initialized) return;

    try {
      await FirebaseMessaging.instance.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
      _status = _status.copyWith(permissionRequested: true);
      final token = await FirebaseMessaging.instance.getToken();
      if (token != null && token.isNotEmpty) {
        _status = _status.copyWith(
          tokenGenerated: true,
          tokenPreview: token.length > 18 ? '${token.substring(0, 18)}...' : token,
          message: 'FCM token generated. Uploading to backend...',
        );
        await _sendTokenToBackend(token);
      } else {
        _status = _status.copyWith(
          tokenGenerated: false,
          message: 'Firebase did not return a device token.',
        );
      }
    } catch (error) {
      _status = _status.copyWith(message: 'FCM token request failed: $error');
    }
  }

  static Future<void> _sendTokenToBackend(String token) async {
    if (_employeeToken.isEmpty || token.isEmpty) {
      _status = _status.copyWith(uploaded: false, message: 'Token upload skipped.');
      return;
    }
    try {
      final response = await ApiClient.postForm(
        '/employee/device-token',
        headers: {'Authorization': 'Bearer $_employeeToken'},
        body: {
          'device_token': token,
          'platform': Platform.isAndroid
              ? 'android'
              : Platform.isIOS
              ? 'ios'
              : 'unknown',
        },
        timeout: const Duration(seconds: 10),
      );
      final success = response.statusCode >= 200 && response.statusCode < 300;
      _status = _status.copyWith(
        uploaded: success,
        message: success
            ? 'Device registered for push notifications.'
            : 'Backend token upload failed: ${response.statusCode} ${response.body}',
      );
    } catch (error) {
      _status = _status.copyWith(
        uploaded: false,
        message: 'Backend token upload failed: $error',
      );
    }
  }

  static Future<void> clearEmployee() async {
    _employeeToken = '';
    _status = const PushNotificationStatus.initial();
  }

  static void _setupListeners() {
    if (_listening) return;
    _listening = true;
    FirebaseMessaging.onMessage.listen(_handleForegroundMessage);
    FirebaseMessaging.onMessageOpenedApp.listen(_handleOpen);
  }

  static Future<void> _handleInitialMessage() async {
    final message = await FirebaseMessaging.instance.getInitialMessage();
    if (message != null) {
      _handleOpen(message);
    }
  }

  static void _handleOpen(RemoteMessage message) {
    final screen = message.data['screen']?.toString() ?? '';
    if (screen == 'attendance') {
      deepLinkNotifier.value = 'attendance';
    } else if (screen == 'payroll') {
      deepLinkNotifier.value = 'payroll';
      final period = message.data['period']?.toString() ?? '';
      deepLinkPeriodNotifier.value = period.isEmpty ? null : period;
    } else if (screen == 'dashboard') {
      deepLinkNotifier.value = 'notifications';
    }
  }

  static void _handleForegroundMessage(RemoteMessage message) {
    final type = message.data['type']?.toString() ?? '';
    if (type == 'present' ||
        type == 'time_out' ||
        type == 'attendance_updated' ||
        type == 'payroll_updated' ||
        type == 'cash_advance_approved' ||
        type == 'cash_advance_rejected' ||
        type == 'profile_change_approved' ||
        type == 'profile_change_rejected' ||
        type == 'announcement' ||
        type == 'payslip_ready' ||
        type == 'payslip_unlocked' ||
        type == 'payslip_approved' ||
        type == 'payslip_rejected' ||
        type == 'payroll_accepted' ||
        type == 'salary_paid' ||
        type == 'bale_payment' ||
        type == 'extra_pay_added' ||
        type == 'payday_reminder' ||
        type == 'ca_overdue_reminder') {
      onDataRefresh?.call(type);
    }
  }
}
