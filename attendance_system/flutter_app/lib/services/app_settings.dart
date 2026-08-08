import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum AppTextScale { small, normal, large }

class AppSettings extends ChangeNotifier {
  static const String prefKey = 'app_text_scale_v1';

  AppTextScale _textScale = AppTextScale.normal;

  AppTextScale get textScale => _textScale;

  double get textScaleFactor => switch (_textScale) {
        AppTextScale.small => 0.9,
        AppTextScale.normal => 1.0,
        AppTextScale.large => 1.2,
      };

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final name = prefs.getString(prefKey);
    _textScale = AppTextScale.values.firstWhere(
      (value) => value.name == name,
      orElse: () => AppTextScale.normal,
    );
    notifyListeners();
  }

  Future<void> setTextScale(AppTextScale value) async {
    _textScale = value;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(prefKey, value.name);
  }
}
