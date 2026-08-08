package com.example.flutter_app

import android.content.Intent
import android.hardware.biometrics.BiometricManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterFragmentActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "kvsk.attendance/biometric_settings")
            .setMethodCallHandler { call, result ->
                if (call.method != "open") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                try {
                    startActivity(biometricSettingsIntent())
                    result.success(null)
                } catch (exc: Exception) {
                    result.error("open_failed", exc.message, null)
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "kvsk.attendance/app_update")
            .setMethodCallHandler { call, result ->
                if (call.method != "openUrl") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                val url = call.argument<String>("url") ?: ""
                if (url.isBlank()) {
                    result.error("missing_url", "Update URL is missing.", null)
                    return@setMethodCallHandler
                }
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    startActivity(intent)
                    result.success(null)
                } catch (exc: Exception) {
                    result.error("open_failed", exc.message, null)
                }
            }
    }

    private fun biometricSettingsIntent(): Intent {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val biometricManager = getSystemService(BiometricManager::class.java)
            val authResult = biometricManager
                ?.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
            if (authResult == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) {
                return Intent(Settings.ACTION_BIOMETRIC_ENROLL)
            }
        }
        return Intent(Settings.ACTION_SECURITY_SETTINGS)
    }
}
