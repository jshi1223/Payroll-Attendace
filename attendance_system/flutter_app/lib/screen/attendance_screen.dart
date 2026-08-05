import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:local_auth/local_auth.dart';
import '../constants.dart';
import 'package:http/http.dart' as http;
import '../services/api_client.dart';
import '../widgets/brand_logo.dart';
import '../widgets/result_dialog.dart';

class AttendanceScreen extends StatefulWidget {
  final String initialType;
  final String employeeToken;

  const AttendanceScreen({
    super.key,
    required this.initialType,
    required this.employeeToken,
  });

  @override
  State<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends State<AttendanceScreen>
    with TickerProviderStateMixin {
  final LocalAuthentication _localAuth = LocalAuthentication();
  bool _isLoading = false;
  bool _hasBiometrics = false;

  @override
  void initState() {
    super.initState();
    _checkBiometrics();
  }

  Future<void> _checkBiometrics() async {
    bool available = false;
    try {
      available = await _localAuth.canCheckBiometrics;
      final isSupported = await _localAuth.isDeviceSupported();
      available = available && isSupported;
    } catch (_) {
      available = false;
    }
    if (mounted) setState(() => _hasBiometrics = available);
  }

  Future<void> _markPresent() async {
    HapticFeedback.mediumImpact();
    if (_isLoading) return;

    bool authenticated = false;
    try {
      authenticated = await _localAuth.authenticate(
        localizedReason: 'Confirm you are marking your presence for today.',
        options: const AuthenticationOptions(
          biometricOnly: true,
          stickyAuth: true,
        ),
      );
    } catch (_) {
      authenticated = false;
    }

    if (!mounted) return;
    if (!authenticated) {
      _showResultDialog(
        success: false,
        type: 'present',
        errorMessage: 'Fingerprint authentication failed or cancelled.',
      );
      return;
    }

    HapticFeedback.heavyImpact();
    setState(() => _isLoading = true);
    try {
      final response = await http
          .post(
            Uri.parse('${AppConstants.baseUrl}/present'),
            headers: {
              'Authorization': 'Bearer ${widget.employeeToken}',
              'Content-Type': 'application/json',
            },
            body: '{}',
          )
          .timeout(
            const Duration(seconds: 15),
            onTimeout: () => throw Exception('Request timed out.'),
          );

      final data = json.decode(response.body);
      final detail = data is Map<String, dynamic>
          ? data['detail']?.toString() ?? ''
          : '';
      final serverMessage = detail.isNotEmpty
          ? detail
          : (data is Map<String, dynamic>
                ? data['message']?.toString() ?? ''
                : '');

      if (response.statusCode == 200) {
        _showResultDialog(
          success: true,
          name: data['name'],
          employeeId: data['employee_id'],
          type: 'present',
          timestamp: data['timestamp'],
        );
      } else if (response.statusCode == 401 ||
          response.statusCode == 403) {
        _showResultDialog(
          success: false,
          type: 'present',
          errorMessage: ApiClient.authMessage,
        );
      } else {
        _showResultDialog(
          success: false,
          type: 'present',
          errorMessage: _formatAttendanceError(
            serverMessage.isNotEmpty ? serverMessage : 'Unknown error',
          ),
        );
      }
    } catch (e) {
      if (mounted) setState(() => _isLoading = false);
      _showResultDialog(
        success: false,
        type: 'present',
        errorMessage: _formatAttendanceError(
          ApiClient.friendlyNetworkError(e),
        ),
      );
    }
  }

  String _formatAttendanceError(String raw) {
    final msg = raw.toLowerCase();
    if (msg.contains('already marked') ||
        msg.contains('already timed in') ||
        msg.contains('already clocked in')) {
      return 'You are already marked present today.';
    }
    if (msg.contains('not linked to payroll')) {
      return 'Your account is not linked to payroll yet. Please ask the administrator to approve you.';
    }
    if (msg.contains('duplicate') || msg.contains('already registered')) {
      return 'This attendance has already been recorded.';
    }
    return raw;
  }

  void _showResultDialog({
    required bool success,
    String? name,
    String? employeeId,
    String? type,
    String? timestamp,
    String? errorMessage,
  }) {
    final displayName = _formatDisplayName(name ?? '');
    final resultTime = _formatTime(timestamp ?? '');
    final warning =
        !success &&
        errorMessage != null &&
        (errorMessage.toLowerCase().contains('already marked') ||
            errorMessage.toLowerCase().contains('already timed') ||
            errorMessage.toLowerCase().contains('already recorded') ||
            errorMessage.toLowerCase().contains('duplicate'));
    final mainColor = success
        ? BrandColors.cyan
        : warning
        ? const Color(0xFFF59E0B)
        : const Color(0xFF364152);
    final titleText = success
        ? 'Marked Present, $displayName!'
        : warning
        ? 'Attendance Reminder'
        : 'Mark Present Failed';
    final messageText = success
        ? 'Your presence has been recorded for today.'
        : errorMessage ?? 'Something went wrong.';
    ResultDialog.show(
      context,
      title: titleText,
      message: messageText,
      accentColor: mainColor,
      icon: success
          ? Icons.check_circle_rounded
          : warning
          ? Icons.info_rounded
          : Icons.error_rounded,
      iconForeground: Colors.white,
      buttonText: success || warning ? 'Back to Dashboard' : 'Try Again',
      details: success
          ? [
              ResultDialogDetail(
                icon: Icons.person_rounded,
                label: 'Name',
                value: displayName,
              ),
              ResultDialogDetail(
                icon: Icons.badge_rounded,
                label: 'ID',
                value: employeeId ?? '',
              ),
              ResultDialogDetail(
                icon: Icons.access_time_rounded,
                label: 'Marked At',
                value: resultTime,
              ),
            ]
          : const [],
      onConfirm: () {
        if (success || warning) {
          Navigator.of(context).pop();
        } else {
          if (mounted) setState(() => _isLoading = false);
        }
      },
    );
  }

  String _formatTime(String ts) {
    try {
      final dt = DateTime.parse(ts).toLocal();
      final h = dt.hour > 12
          ? dt.hour - 12
          : dt.hour == 0
          ? 12
          : dt.hour;
      final m = dt.minute.toString().padLeft(2, '0');
      final s = dt.second.toString().padLeft(2, '0');
      return '$h:$m:$s ${dt.hour >= 12 ? 'PM' : 'AM'}';
    } catch (_) {
      return ts;
    }
  }

  String _formatDisplayName(String raw) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return 'Employee';
    return trimmed
        .split(RegExp(r'\s+'))
        .where((part) => part.isNotEmpty)
        .map((part) => part[0].toUpperCase() + part.substring(1).toLowerCase())
        .join(' ');
  }

  double _responsivePadding(double width) {
    if (width >= 900) return 44;
    if (width >= 600) return 32;
    return 20;
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    return Scaffold(
      backgroundColor: BrandColors.bg,
      appBar: AppBar(
        backgroundColor: BrandColors.surface,
        elevation: 0,
        toolbarHeight: 72,
        leading: IconButton(
          icon: const Icon(
            Icons.arrow_back_ios_new_rounded,
            color: BrandColors.text,
            size: 20,
          ),
          onPressed: () => Navigator.pop(context),
        ),
        title: const BrandMark(
          compact: true,
          titleColor: BrandColors.text,
          subtitleColor: BrandColors.textMuted,
        ),
        centerTitle: false,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: BrandColors.border),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(
            _responsivePadding(size.width),
            20,
            _responsivePadding(size.width),
            24,
          ),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Container(
                padding: const EdgeInsets.all(22),
                decoration: BoxDecoration(
                  color: BrandColors.surface.withValues(alpha: 0.92),
                  borderRadius: BorderRadius.circular(32),
                  border: Border.all(
                    color: BrandColors.border.withValues(alpha: 0.92),
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.08),
                      blurRadius: 28,
                      offset: const Offset(0, 16),
                    ),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: 8),
                    Center(
                      child: Container(
                        width: 96,
                        height: 96,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: const Color(0xFF00B8A9)
                              .withValues(alpha: 0.12),
                          border: Border.all(
                            color: const Color(0xFF00B8A9)
                                .withValues(alpha: 0.35),
                          ),
                        ),
                        child: const Icon(
                          Icons.fingerprint_rounded,
                          color: Color(0xFF00B8A9),
                          size: 52,
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                    const Text(
                      'Mark Present',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: BrandColors.text,
                        fontSize: 22,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _hasBiometrics
                          ? 'Confirm with your fingerprint to record\nyour presence for today.'
                          : 'Use your fingerprint to record your\npresence for today.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: BrandColors.textMuted,
                        fontSize: 13,
                        height: 1.4,
                      ),
                    ),
                    const SizedBox(height: 24),
                    Material(
                      color: Colors.transparent,
                      child: InkWell(
                        onTap: _isLoading ? null : _markPresent,
                        borderRadius: BorderRadius.circular(22),
                        child: Ink(
                          padding: const EdgeInsets.all(20),
                          decoration: BoxDecoration(
                            gradient: const LinearGradient(
                              colors: [
                                Color(0xFF073B36),
                                Color(0xFF041E1B),
                              ],
                            ),
                            borderRadius: BorderRadius.circular(22),
                            border: Border.all(
                              color: const Color(0xFF00B8A9)
                                  .withValues(alpha: 0.4),
                            ),
                            boxShadow: [
                              BoxShadow(
                                color: const Color(0xFF00B8A9)
                                    .withValues(alpha: 0.14),
                                blurRadius: 22,
                                offset: const Offset(0, 10),
                              ),
                            ],
                          ),
                          child: Row(
                            children: [
                              Container(
                                width: 56,
                                height: 56,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  color: const Color(0xFF00B8A9)
                                      .withValues(alpha: 0.15),
                                  border: Border.all(
                                    color: const Color(0xFF00B8A9)
                                        .withValues(alpha: 0.4),
                                  ),
                                ),
                                child: _isLoading
                                    ? const Padding(
                                        padding: EdgeInsets.all(16),
                                        child: CircularProgressIndicator(
                                          color: Color(0xFF00B8A9),
                                          strokeWidth: 2.5,
                                        ),
                                      )
                                    : const Icon(
                                        Icons.fingerprint_rounded,
                                        color: Color(0xFF00B8A9),
                                        size: 28,
                                      ),
                              ),
                              const SizedBox(width: 16),
                              const Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      'MARK PRESENT',
                                      style: TextStyle(
                                        color: Color(0xFF00B8A9),
                                        fontSize: 20,
                                        fontWeight: FontWeight.bold,
                                        letterSpacing: 1,
                                      ),
                                    ),
                                    SizedBox(height: 4),
                                    Text(
                                      'Tap to scan your fingerprint',
                                      style: TextStyle(
                                        color: Color(0xFF7FD9D1),
                                        fontSize: 13,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: const Color(0xFF00B8A9).withValues(alpha: 0.06),
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(
                          color: const Color(0xFF00B8A9)
                              .withValues(alpha: 0.15),
                        ),
                      ),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.lock_rounded,
                            color: Color(0xFF00B8A9),
                            size: 18,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              _hasBiometrics
                                  ? 'Your fingerprint stays on this device. It is never uploaded.'
                                  : 'No fingerprint is available on this device. You can still proceed.',
                              style: TextStyle(
                                color: BrandColors.textMuted,
                                fontSize: 12,
                                height: 1.4,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
