import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:local_auth/local_auth.dart';

import '../services/api_client.dart';
import '../utils/api_errors.dart';
import 'employee_login_screen.dart';
import '../widgets/brand_logo.dart';
import '../widgets/result_dialog.dart';

part 'registration_widgets.dart';

class RegistrationScreen extends StatefulWidget {
  const RegistrationScreen({super.key});

  @override
  State<RegistrationScreen> createState() => _RegistrationScreenState();
}

class _RegistrationScreenState extends State<RegistrationScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _govIdCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _confirmPasswordCtrl = TextEditingController();
  bool _passwordVisible = false;
  bool _confirmPasswordVisible = false;

  final LocalAuthentication _localAuth = LocalAuthentication();
  bool _hasBiometrics = false;

  static final RegExp _emailPattern = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');

  int _pageStep = 0;
  bool _isCheckingAvailability = false;
  bool _biometricsVerified = false;
  String _statusMsg = '';
  String _submissionStatus =
      'Please wait while we submit your registration.';
  int _submissionAttempt = 0;
  static const int _maxSubmissionAttempts = 3;

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

  @override
  void dispose() {
    _nameCtrl.dispose();
    _emailCtrl.dispose();
    _phoneCtrl.dispose();
    _govIdCtrl.dispose();
    _passwordCtrl.dispose();
    _confirmPasswordCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_pageStep == 2) return _buildSubmitting();
    if (_pageStep == 1) return _buildBiometricsScreen();
    return _buildInfoForm();
  }

  Future<void> _goToBiometrics() async {
    if (_isCheckingAvailability) return;

    if (!(_formKey.currentState?.validate() ?? false)) {
      return;
    }

    setState(() {
      _isCheckingAvailability = true;
      _statusMsg = '';
    });

    try {
      final res = await ApiClient.postForm(
        '/register/check-availability',
        body: {
          'email': _emailCtrl.text.trim(),
          'phone': _normalizedPhoneNumber(),
        },
      );
      final data = ApiClient.jsonObject(res.body) ?? const {};
      final available = data['available'] == true;

      if (!available) {
        setState(() {
          _statusMsg = 'These details are already in use.';
        });
        return;
      }
    } catch (_) {
      setState(() {
        _statusMsg = 'Cannot verify account details right now.';
      });
      return;
    } finally {
      if (mounted) {
        setState(() => _isCheckingAvailability = false);
      }
    }

    if (!mounted) return;
    FocusScope.of(context).unfocus();
    HapticFeedback.mediumImpact();
    setState(() {
      _pageStep = 1;
      _statusMsg = '';
      _biometricsVerified = false;
    });
  }

  Future<void> _verifyBiometrics() async {
    if (_biometricsVerified) return;

    bool authenticated = false;
    try {
      authenticated = await _localAuth.authenticate(
        localizedReason:
            'Verify your fingerprint to finish setting up your account.',
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
      setState(() {
        _statusMsg =
            'Fingerprint verification failed or cancelled. Please try again.';
      });
      return;
    }

    HapticFeedback.heavyImpact();
    setState(() {
      _biometricsVerified = true;
      _statusMsg = '';
    });
    _submitRegistration();
  }

  Future<void> _submitRegistration() async {
    setState(() => _pageStep = 2);
    _submissionAttempt = 0;
    if (mounted) {
      setState(() {
        _submissionStatus =
            'Please wait while we submit your registration.';
      });
    }

    while (mounted && _submissionAttempt < _maxSubmissionAttempts) {
      _submissionAttempt++;
      final isFinalAttempt = _submissionAttempt == _maxSubmissionAttempts;

      try {
        if (mounted) {
          setState(() {
            _submissionStatus = _submissionAttempt == 1
                ? 'Submitting your registration...'
                : 'Retrying submission ($_submissionAttempt/$_maxSubmissionAttempts)...';
          });
        }

        final response = await ApiClient.postForm(
          '/register',
          body: {
            'name': _nameCtrl.text.trim(),
            'email': _emailCtrl.text.trim(),
            'phone': _normalizedPhoneNumber(),
            'password': _passwordCtrl.text,
            'government_id': _govIdCtrl.text.trim(),
          },
        );

        if (response.statusCode == 200) {
          if (mounted) _showSuccessDialog();
          return;
        }

        final msg = friendlyRegistrationError(
          serverMessageFromBody(response.body, fallback: response.body),
        );

        final shouldRetry =
            response.statusCode >= 500 || response.statusCode == 429;
        if (shouldRetry && !isFinalAttempt) {
          await Future.delayed(
            Duration(milliseconds: 650 * _submissionAttempt),
          );
          continue;
        }

        await _showSubmissionErrorDialog(msg);
        return;
      } catch (e) {
        final raw = e.toString();
        final shouldRetry = isRetryableNetworkError(e);

        if (shouldRetry && !isFinalAttempt) {
          await Future.delayed(
            Duration(milliseconds: 650 * _submissionAttempt),
          );
          continue;
        }

        String msg = raw;
        if (msg.contains('timed out')) {
          msg = 'Request timed out. Check the connection.';
        }
        if (msg.contains('SocketException')) msg = 'Cannot connect to server.';
        msg = friendlyRegistrationError(msg);
        await _showSubmissionErrorDialog(msg);
        return;
      }
    }
  }

  String _normalizedPhoneNumber() {
    final raw = _phoneCtrl.text.trim();
    if (raw.isEmpty) return '+63';
    if (raw.startsWith('0') && raw.length == 11) {
      return '+63${raw.substring(1)}';
    }
    return '+63$raw';
  }

  void _showSuccessDialog() {
    ResultDialog.show(
      context,
      title: 'Registration Submitted',
      message:
          'Your account has been submitted for approval.\nPlease wait for admin confirmation, then sign in.',
      accentColor: BrandColors.cyan,
      icon: Icons.check_rounded,
      buttonText: 'Done',
      onConfirm: () {},
    ).then((_) {
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const EmployeeLoginScreen()),
      );
    });
  }

  Future<void> _showSubmissionErrorDialog(String message) async {
    final cleanMessage = _cleanNoticeMessage(message);
    if (!mounted) return;

    await ResultDialog.show(
      context,
      title: _noticeTitleForMessage(cleanMessage),
      message: cleanMessage,
      accentColor: _noticeColorForMessage(cleanMessage),
      icon: _noticeIconForMessage(cleanMessage),
      buttonText: 'Try Again',
      onConfirm: () {},
    );

    if (!mounted) return;
    setState(() {
      _pageStep = 1;
      _biometricsVerified = false;
      _statusMsg = 'Error: $cleanMessage';
    });
  }

  String _cleanNoticeMessage(String message) {
    final cleaned = message
        .replaceFirst(RegExp(r'^\s*Error:\s*', caseSensitive: false), '')
        .trim();
    return cleaned.isEmpty ? 'Please try again.' : cleaned;
  }

  String _noticeTitleForMessage(String message) {
    final msg = message.toLowerCase();
    if (msg.contains('already registered') ||
        msg.contains('registration details already in use') ||
        msg.contains('already in use')) {
      return 'Registration blocked';
    }
    if (msg.contains('cannot verify account details')) return 'Check details';
    if (msg.contains('connection') || msg.contains('timed out')) {
      return 'Connection issue';
    }
    return 'Registration notice';
  }

  IconData _noticeIconForMessage(String message) {
    final msg = message.toLowerCase();
    if (msg.contains('already registered') ||
        msg.contains('registration details already in use') ||
        msg.contains('already in use')) {
      return Icons.warning_rounded;
    }
    if (msg.contains('connection') || msg.contains('timed out')) {
      return Icons.wifi_off_rounded;
    }
    return Icons.info_rounded;
  }

  Color _noticeColorForMessage(String message) {
    final msg = message.toLowerCase();
    if (msg.contains('already registered') ||
        msg.contains('registration details already in use') ||
        msg.contains('already in use')) {
      return const Color(0xFFB31D18);
    }
    if (msg.contains('connection') || msg.contains('timed out')) {
      return const Color(0xFF334155);
    }
    return const Color(0xFFB31D18);
  }

  Widget _buildInfoForm() {
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
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 8),
            const _StepBar(currentStep: 0),
            const SizedBox(height: 20),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(
                color: BrandColors.surface,
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: BrandColors.border),
              ),
              child: Column(
                children: [
                  const BrandLogo(
                    size: 84,
                    radius: 18,
                    withFrame: false,
                    padding: EdgeInsets.zero,
                  ),
                  const SizedBox(height: 14),
                  const Text(
                    'Employee Registration',
                    style: TextStyle(
                      color: BrandColors.text,
                      fontSize: 20,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Fill in your details, then verify your fingerprint.',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: BrandColors.textMuted,
                      fontSize: 13,
                      height: 1.4,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Form(
              key: _formKey,
              autovalidateMode: AutovalidateMode.onUserInteraction,
              child: AutofillGroup(
                child: Column(
                  children: [
                    _AppField(
                      ctrl: _nameCtrl,
                      label: 'Full Name',
                      hint: 'Enter your full name',
                      icon: Icons.person_rounded,
                      required: true,
                      textCapitalization: TextCapitalization.words,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.name],
                      validator: (value) {
                        if ((value ?? '').trim().isEmpty) {
                          return 'Full name is required.';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),
                    _AppField(
                      ctrl: _emailCtrl,
                      label: 'Email',
                      hint: 'Enter a valid email',
                      icon: Icons.email_rounded,
                      required: true,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.email],
                      validator: (value) {
                        final text = (value ?? '').trim();
                        if (text.isEmpty) return 'Email is required.';
                        if (!_emailPattern.hasMatch(text)) {
                          return 'Enter a valid email address.';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),
                    _AppField(
                      ctrl: _phoneCtrl,
                      label: 'Phone Number',
                      hint: '9123456789',
                      icon: Icons.phone_rounded,
                      required: true,
                      keyboardType: TextInputType.phone,
                      textInputAction: TextInputAction.next,
                      prefixWidget: Container(
                        margin: const EdgeInsets.only(right: 10),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 7,
                        ),
                        decoration: BoxDecoration(
                          color: const Color(0xFFE9F7FB),
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: const Color(0xFFD0E6EE)),
                        ),
                        child: const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.public_rounded,
                              size: 14,
                              color: BrandColors.cyan,
                            ),
                            SizedBox(width: 6),
                            Text(
                              'PH +63',
                              style: TextStyle(
                                color: BrandColors.text,
                                fontSize: 12.5,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ],
                        ),
                      ),
                      inputFormatters: [
                        FilteringTextInputFormatter.digitsOnly,
                        LengthLimitingTextInputFormatter(11),
                      ],
                      autofillHints: const [AutofillHints.telephoneNumber],
                      validator: (value) {
                        final digits = (value ?? '').replaceAll(
                          RegExp(r'\D'),
                          '',
                        );
                        if (digits.isEmpty) return 'Phone number is required.';
                        if (digits.length != 10 && digits.length != 11) {
                          return 'Enter a valid PH mobile number.';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),
                    _AppField(
                      ctrl: _govIdCtrl,
                      label: 'Government ID',
                      hint: 'e.g. SSS / UMID / Driver\u2019s License no.',
                      icon: Icons.badge_rounded,
                      required: true,
                      textInputAction: TextInputAction.next,
                      validator: (value) {
                        if ((value ?? '').trim().isEmpty) {
                          return 'Government ID is required.';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),
                    _AppField(
                      ctrl: _passwordCtrl,
                      label: 'Password',
                      hint: 'At least 8 characters',
                      icon: Icons.lock_rounded,
                      required: true,
                      keyboardType: TextInputType.visiblePassword,
                      textInputAction: TextInputAction.next,
                      obscureText: !_passwordVisible,
                      autofillHints: const [AutofillHints.newPassword],
                      suffixWidget: IconButton(
                        onPressed: () => setState(
                          () => _passwordVisible = !_passwordVisible,
                        ),
                        icon: Icon(
                          _passwordVisible
                              ? Icons.visibility_off_rounded
                              : Icons.visibility_rounded,
                          color: BrandColors.textMuted,
                        ),
                        splashRadius: 18,
                      ),
                      validator: (value) {
                        final text = value ?? '';
                        if (text.isEmpty) return 'Password is required.';
                        if (text.length < 8) {
                          return 'Password must be at least 8 characters.';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),
                    _AppField(
                      ctrl: _confirmPasswordCtrl,
                      label: 'Confirm Password',
                      hint: 'Re-enter your password',
                      icon: Icons.lock_outline_rounded,
                      required: true,
                      keyboardType: TextInputType.visiblePassword,
                      textInputAction: TextInputAction.done,
                      obscureText: !_confirmPasswordVisible,
                      autofillHints: const [AutofillHints.newPassword],
                      suffixWidget: IconButton(
                        onPressed: () => setState(
                          () => _confirmPasswordVisible =
                              !_confirmPasswordVisible,
                        ),
                        icon: Icon(
                          _confirmPasswordVisible
                              ? Icons.visibility_off_rounded
                              : Icons.visibility_rounded,
                          color: BrandColors.textMuted,
                        ),
                        splashRadius: 18,
                      ),
                      validator: (value) {
                        if ((value ?? '').isEmpty) {
                          return 'Please confirm your password.';
                        }
                        if (value != _passwordCtrl.text) {
                          return 'Passwords do not match.';
                        }
                        return null;
                      },
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 18),
            if (_statusMsg.isNotEmpty) ...[
              _NoticeBox(
                title: _noticeTitleForMessage(_statusMsg),
                message: _statusMsg,
                icon: _noticeIconForMessage(_statusMsg),
                accentColor: _noticeColorForMessage(_statusMsg),
              ),
              const SizedBox(height: 14),
            ],
            SizedBox(
              width: double.infinity,
              height: 54,
              child: ElevatedButton(
                onPressed: _isCheckingAvailability ? null : _goToBiometrics,
                style: ElevatedButton.styleFrom(
                  backgroundColor: BrandColors.cyan,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                ),
                child: _isCheckingAvailability
                    ? const SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(
                          strokeWidth: 2.2,
                          color: Colors.white,
                        ),
                      )
                    : const Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(
                            'Next',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          SizedBox(width: 8),
                          Icon(Icons.arrow_forward_rounded, size: 20),
                        ],
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBiometricsScreen() {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        unawaited(_backToForm());
      },
      child: Scaffold(
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
            onPressed: () async {
              await _backToForm();
            },
          ),
          title: const BrandMark(
            compact: true,
            titleColor: BrandColors.text,
            subtitleColor: BrandColors.textMuted,
          ),
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(1),
            child: Container(height: 1, color: BrandColors.border),
          ),
        ),
        body: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 480),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const _StepBar(currentStep: 1),
                    const SizedBox(height: 22),
                    Container(
                      padding: const EdgeInsets.all(22),
                      decoration: BoxDecoration(
                        color: BrandColors.surface.withValues(alpha: 0.96),
                        borderRadius: BorderRadius.circular(32),
                        border: Border.all(
                          color: BrandColors.border.withValues(alpha: 0.95),
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
                        children: [
                          const SizedBox(height: 8),
                          Container(
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
                            child: _biometricsVerified
                                ? const Icon(
                                    Icons.check_rounded,
                                    color: Color(0xFF00B8A9),
                                    size: 52,
                                  )
                                : const Icon(
                                    Icons.fingerprint_rounded,
                                    color: Color(0xFF00B8A9),
                                    size: 52,
                                  ),
                          ),
                          const SizedBox(height: 20),
                          const Text(
                            'Verify Fingerprint',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              color: BrandColors.text,
                              fontSize: 22,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            _biometricsVerified
                                ? 'Fingerprint verified.\nSubmitting your registration...'
                                : _hasBiometrics
                                    ? 'Confirm with your fingerprint to\nfinish setting up your account.'
                                    : 'No fingerprint is available on this device.\nYou can still continue without one.',
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
                              onTap: _biometricsVerified ? null : _verifyBiometrics,
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
                                      child: _biometricsVerified
                                          ? const Icon(
                                              Icons.check_rounded,
                                              color: Color(0xFF00B8A9),
                                              size: 28,
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
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            'VERIFY FINGERPRINT',
                                            style: TextStyle(
                                              color: Color(0xFF00B8A9),
                                              fontSize: 16,
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
                              color: const Color(0xFF00B8A9)
                                  .withValues(alpha: 0.06),
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
                                        : 'No fingerprint is available on this device. You can still continue.',
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
                    const SizedBox(height: 18),
                    if (_statusMsg.isNotEmpty) ...[
                      _NoticeBox(
                        title: _noticeTitleForMessage(_statusMsg),
                        message: _statusMsg,
                        icon: _noticeIconForMessage(_statusMsg),
                        accentColor: _noticeColorForMessage(_statusMsg),
                      ),
                      const SizedBox(height: 14),
                    ],
                    if (!_hasBiometrics)
                      SizedBox(
                        width: double.infinity,
                        height: 54,
                        child: ElevatedButton.icon(
                          onPressed: _biometricsVerified
                              ? null
                              : () {
                                  HapticFeedback.mediumImpact();
                                  setState(() {
                                    _biometricsVerified = true;
                                    _statusMsg = '';
                                  });
                                  _submitRegistration();
                                },
                          icon: const Icon(Icons.skip_next_rounded, size: 20),
                          label: const Text('Continue without fingerprint'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF364152),
                            foregroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(14),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _backToForm() async {
    setState(() {
      _pageStep = 0;
      _statusMsg = '';
      _biometricsVerified = false;
      _submissionStatus =
          'Please wait while we submit your registration.';
      _submissionAttempt = 0;
    });
  }

  Widget _buildSubmitting() {
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: BrandColors.bg,
        body: Center(
          child: Container(
            margin: const EdgeInsets.all(24),
            padding: const EdgeInsets.all(28),
            decoration: BoxDecoration(
              color: BrandColors.surface,
              borderRadius: BorderRadius.circular(24),
              border: Border.all(color: BrandColors.border),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox(
                  width: 74,
                  height: 74,
                  child: CircularProgressIndicator(
                    color: BrandColors.cyan,
                    strokeWidth: 3,
                  ),
                ),
                const SizedBox(height: 22),
                const Text(
                  'Submitting Registration...',
                  style: TextStyle(
                    color: BrandColors.text,
                    fontSize: 17,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  _submissionStatus,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: BrandColors.textMuted,
                    fontSize: 13,
                    height: 1.4,
                  ),
                ),
                if (_submissionAttempt > 1) ...[
                  const SizedBox(height: 10),
                  Text(
                    'Attempt $_submissionAttempt of $_maxSubmissionAttempts',
                    style: const TextStyle(
                      color: BrandColors.textMuted,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
