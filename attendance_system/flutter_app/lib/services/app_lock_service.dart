import 'package:flutter/material.dart';
import 'package:local_auth/local_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Optional app-lock using the device biometric (fingerprint). When enabled,
/// the app requires a fingerprint to open after it was backgrounded or
/// relaunched while a session is still signed in.
class AppLockService extends ChangeNotifier {
  static const String prefKey = 'app_lock_enabled_v1';

  final LocalAuthentication _localAuth = LocalAuthentication();

  bool _enabled = false;
  bool _locked = false;
  bool _authenticating = false;

  bool get enabled => _enabled;
  bool get locked => _locked;
  bool get authenticating => _authenticating;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    _enabled = prefs.getBool(prefKey) ?? false;
    _locked = _enabled;
    notifyListeners();
  }

  Future<void> setEnabled(bool value) async {
    _enabled = value;
    if (!value) {
      _locked = false;
    }
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(prefKey, value);
  }

  Future<bool> hasBiometrics() async {
    try {
      if (!await _localAuth.isDeviceSupported()) return false;
      final available = await _localAuth.getAvailableBiometrics();
      return available.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  Future<bool> unlock() async {
    if (!_locked) return true;
    if (_authenticating) return false;
    _authenticating = true;
    notifyListeners();
    var ok = false;
    try {
      ok = await _localAuth.authenticate(
        localizedReason:
            'Unlock the app to continue using your attendance account.',
        options: const AuthenticationOptions(
          biometricOnly: true,
          stickyAuth: true,
        ),
      );
    } catch (_) {
      ok = false;
    }
    _authenticating = false;
    if (ok) {
      _locked = false;
    }
    notifyListeners();
    return ok;
  }

  void lock() {
    if (!_enabled || _locked) return;
    _locked = true;
    notifyListeners();
  }

  /// Marks the app as unlocked without prompting. Used after a successful
  /// biometric login so the lock does not re-appear on the next resume.
  void markUnlocked() {
    if (!_locked) return;
    _locked = false;
    notifyListeners();
  }
}
