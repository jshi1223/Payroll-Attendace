import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Lightweight English / Filipino localization for the attendance app.
class AppLocale extends ChangeNotifier {
  static const String prefKey = 'app_locale_v1';
  static const String en = 'en';
  static const String tl = 'tl';

  static const String _enLabel = 'English';
  static const String _tlLabel = 'Filipino';

  String _language = en;

  String get language => _language;
  bool get isFilipino => _language == tl;
  String get languageLabel => isFilipino ? _tlLabel : _enLabel;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    _language = prefs.getString(prefKey) ?? en;
    notifyListeners();
  }

  Future<void> setLanguage(String code) async {
    if (code != en && code != tl) return;
    _language = code;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(prefKey, code);
  }

  Future<void> toggle() async {
    await setLanguage(isFilipino ? en : tl);
  }

  String t(String english, [String? filipino]) {
    return isFilipino ? (filipino ?? english) : english;
  }
}

extension AppLocaleContext on BuildContext {
  AppLocale get appLocale => Provider.of<AppLocale>(this, listen: false);

  String tr(String english, [String? filipino]) =>
      Provider.of<AppLocale>(this, listen: false).t(english, filipino);
}
