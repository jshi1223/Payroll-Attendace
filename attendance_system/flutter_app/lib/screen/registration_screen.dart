import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

import '../services/api_client.dart';
import '../services/app_locale.dart';
import '../services/device_identity.dart';
import '../utils/api_errors.dart';
import '../widgets/brand_logo.dart';
import '../widgets/result_dialog.dart';
import 'face_photo_crop_screen.dart';
import 'registration_status_screen.dart';

part 'registration_widgets.dart';

class RegistrationScreen extends StatefulWidget {
  const RegistrationScreen({super.key});

  @override
  State<RegistrationScreen> createState() => _RegistrationScreenState();
}

class _RegistrationScreenState extends State<RegistrationScreen> {
  final _formKey = GlobalKey<FormState>();
  final ImagePicker _imagePicker = ImagePicker();
  final _firstNameCtrl = TextEditingController();
  final _lastNameCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _sssCtrl = TextEditingController();
  final _philhealthCtrl = TextEditingController();
  final _pagibigCtrl = TextEditingController();
  final _tinCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _confirmPasswordCtrl = TextEditingController();
  bool _passwordVisible = false;
  bool _confirmPasswordVisible = false;
  String _facePhotoPath = '';
  bool _facePhotoError = false;

  static final RegExp _emailPattern = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');
  static final RegExp _sssPattern = RegExp(r'^\d{2}-\d{7}-\d$');
  static final RegExp _philhealthPattern = RegExp(r'^\d{2}-\d{9}-\d$');
  static final RegExp _pagibigPattern = RegExp(r'^\d{4}-\d{4}-\d{4}$');
  static final RegExp _tinPattern = RegExp(r'^\d{3}-\d{3}-\d{3}-\d{3}$');

  int _pageStep = 0;
  bool _isCheckingAvailability = false;
  String _statusMsg = '';
  String _submissionStatus =
      'Please wait while we submit your registration.';
  int _submissionAttempt = 0;
  static const int _maxSubmissionAttempts = 3;

  @override
  void dispose() {
    _firstNameCtrl.dispose();
    _lastNameCtrl.dispose();
    _emailCtrl.dispose();
    _phoneCtrl.dispose();
    _sssCtrl.dispose();
    _philhealthCtrl.dispose();
    _pagibigCtrl.dispose();
    _tinCtrl.dispose();
    _passwordCtrl.dispose();
    _confirmPasswordCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_pageStep == 2) return _buildSubmitting();
    return _buildInfoForm();
  }

  Future<void> _pickFacePhoto(ImageSource source) async {
    final picked = await _imagePicker.pickImage(
      source: source,
      maxWidth: 1200,
      maxHeight: 1200,
      imageQuality: 85,
    );
    if (picked == null) return;
    if (!mounted) return;
    final croppedPath = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => FacePhotoCropScreen(imagePath: picked.path),
      ),
    );
    if (croppedPath == null) return;
    if (!mounted) return;
    setState(() {
      _facePhotoPath = croppedPath;
      _facePhotoError = false;
    });
  }

  Future<void> _submitForm() async {
    if (_isCheckingAvailability) return;

    if (!(_formKey.currentState?.validate() ?? false)) {
      return;
    }

    if (_facePhotoPath.isEmpty) {
      setState(() => _facePhotoError = true);
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
          'sss_number': _sssCtrl.text.trim(),
          'philhealth_number': _philhealthCtrl.text.trim(),
          'pagibig_number': _pagibigCtrl.text.trim(),
          'tin_number': _tinCtrl.text.trim(),
        },
      );
      final data = ApiClient.jsonObject(res.body) ?? const {};
      final available = data['available'] == true;
      final govIdTaken = (data['gov_id_taken'] as String?)?.trim();

      if (!available) {
        setState(() {
          _statusMsg =
              (govIdTaken != null && govIdTaken.isNotEmpty)
              ? govIdTaken
              : 'These details are already in use.';
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

        final deviceId = await DeviceIdentity.getId();
        final response = await ApiClient.sendMultipart(
          '/register',
          fields: {
            'first_name': _firstNameCtrl.text.trim(),
            'last_name': _lastNameCtrl.text.trim(),
            'email': _emailCtrl.text.trim(),
            'phone': _normalizedPhoneNumber(),
            'password': _passwordCtrl.text,
            'sss_number': _sssCtrl.text.trim(),
            'philhealth_number': _philhealthCtrl.text.trim(),
            'pagibig_number': _pagibigCtrl.text.trim(),
            'tin_number': _tinCtrl.text.trim(),
            if (deviceId.isNotEmpty) 'device_id': deviceId,
          },
          filePaths: {'photo': _facePhotoPath},
          timeout: const Duration(seconds: 30),
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
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(
        builder: (_) => RegistrationStatusScreen(
          email: _emailCtrl.text.trim(),
          phone: _normalizedPhoneNumber(),
        ),
      ),
    );
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
      _pageStep = 0;
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
    final locale = context.appLocale;
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
                  Text(
                    locale.t(
                      'Employee Registration',
                      'Pagrerehistro ng Empleyado',
                    ),
                    style: const TextStyle(
                      color: BrandColors.text,
                      fontSize: 20,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    locale.t(
                      'Fill in your details to submit your registration for approval.',
                      'Punan ang iyong detalye upang isumite ang iyong rehistrasyon para sa pag-apruba.',
                    ),
                    textAlign: TextAlign.center,
                    style: const TextStyle(
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
                    _FacePhotoField(
                      photoPath: _facePhotoPath,
                      error: _facePhotoError,
                      onTakePhoto: () => _pickFacePhoto(ImageSource.camera),
                      onChoosePhoto: () => _pickFacePhoto(ImageSource.gallery),
                    ),
                    const SizedBox(height: 16),
                    _AppField(
                      ctrl: _firstNameCtrl,
                      label: locale.t('First Name', 'Unang Pangalan'),
                      hint: locale.t('Enter your first name', 'Ilagay ang iyong unang pangalan'),
                      icon: Icons.person_rounded,
                      required: true,
                      textCapitalization: TextCapitalization.words,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.givenName],
                      validator: (value) {
                        if ((value ?? '').trim().isEmpty) {
                          return locale.t('First name is required.', 'Kinakailangan ang unang pangalan.');
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),
                    _AppField(
                      ctrl: _lastNameCtrl,
                      label: locale.t('Last Name', 'Apelyido'),
                      hint: locale.t('Enter your last name', 'Ilagay ang iyong apelyido'),
                      icon: Icons.person_outline_rounded,
                      required: true,
                      textCapitalization: TextCapitalization.words,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.familyName],
                      validator: (value) {
                        if ((value ?? '').trim().isEmpty) {
                          return locale.t('Last name is required.', 'Kinakailangan ang apelyido.');
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),
                    _ResponsiveFormPair(
                      first: _AppField(
                      ctrl: _emailCtrl,
                      label: locale.t('Email', 'Email'),
                      hint: locale.t('Enter a valid email', 'Maglagay ng wastong email'),
                      icon: Icons.email_rounded,
                      required: true,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.email],
                      validator: (value) {
                        final text = (value ?? '').trim();
                        if (text.isEmpty) {
                          return locale.t('Email is required.', 'Kinakailangan ang email.');
                        }
                        if (!_emailPattern.hasMatch(text)) {
                          return locale.t('Enter a valid email address.', 'Maglagay ng wastong email address.');
                        }
                        return null;
                      },
                      ),
                      second: _AppField(
                      ctrl: _phoneCtrl,
                      label: locale.t('Phone Number', 'Numero ng Telepono'),
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
                        if (digits.isEmpty) {
                          return locale.t('Phone number is required.', 'Kinakailangan ang numero ng telepono.');
                        }
                        if (digits.length != 10 && digits.length != 11) {
                          return locale.t('Enter a valid PH mobile number.', 'Maglagay ng wastong PH mobile number.');
                        }
                        return null;
                      },
                      ),
                    ),
                    const SizedBox(height: 8),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        locale.t('Government IDs', 'Mga Government ID'),
                        style: const TextStyle(
                          color: BrandColors.text,
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    _ResponsiveGovIdGrid(
                      first: _AppField(
                      ctrl: _sssCtrl,
                      label: locale.t('SSS Number', 'Numero ng SSS'),
                      hint: 'e.g. 12-3456789-0',
                      icon: Icons.badge_rounded,
                      required: true,
                      textInputAction: TextInputAction.next,
                      inputFormatters: const [
                        _GovIdInputFormatter([2, 7, 1]),
                      ],
                      validator: (value) {
                        final text = (value ?? '').trim();
                        if (text.isEmpty) {
                          return locale.t('SSS Number is required.', 'Kinakailangan ang Numero ng SSS.');
                        }
                        if (!_sssPattern.hasMatch(text)) {
                          return 'Format: 12-3456789-0';
                        }
                        return null;
                      },
                      ),
                      second: _AppField(
                      ctrl: _philhealthCtrl,
                      label: locale.t('PhilHealth Number', 'Numero ng PhilHealth'),
                      hint: 'e.g. 12-345678901-2',
                      icon: Icons.health_and_safety_rounded,
                      required: true,
                      textInputAction: TextInputAction.next,
                      inputFormatters: const [
                        _GovIdInputFormatter([2, 9, 1]),
                      ],
                      validator: (value) {
                        final text = (value ?? '').trim();
                        if (text.isEmpty) {
                          return locale.t('PhilHealth Number is required.', 'Kinakailangan ang Numero ng PhilHealth.');
                        }
                        if (!_philhealthPattern.hasMatch(text)) {
                          return 'Format: 12-345678901-2';
                        }
                        return null;
                      },
                      ),
                      third: _AppField(
                      ctrl: _pagibigCtrl,
                      label: locale.t('Pag-IBIG Number', 'Numero ng Pag-IBIG'),
                      hint: 'e.g. 1234-5678-9012',
                      icon: Icons.home_work_rounded,
                      required: true,
                      textInputAction: TextInputAction.next,
                      inputFormatters: const [
                        _GovIdInputFormatter([4, 4, 4]),
                      ],
                      validator: (value) {
                        final text = (value ?? '').trim();
                        if (text.isEmpty) {
                          return locale.t('Pag-IBIG Number is required.', 'Kinakailangan ang Numero ng Pag-IBIG.');
                        }
                        if (!_pagibigPattern.hasMatch(text)) {
                          return 'Format: 1234-5678-9012';
                        }
                        return null;
                      },
                      ),
                      fourth: _AppField(
                      ctrl: _tinCtrl,
                      label: locale.t('TIN Number', 'Numero ng TIN'),
                      hint: 'e.g. 123-456-789-012',
                      icon: Icons.receipt_long_rounded,
                      required: true,
                      textInputAction: TextInputAction.next,
                      inputFormatters: const [
                        _GovIdInputFormatter([3, 3, 3, 3]),
                      ],
                      validator: (value) {
                        final text = (value ?? '').trim();
                        if (text.isEmpty) {
                          return locale.t('TIN Number is required.', 'Kinakailangan ang Numero ng TIN.');
                        }
                        if (!_tinPattern.hasMatch(text)) {
                          return 'Format: 123-456-789-012';
                        }
                        return null;
                      },
                      ),
                    ),
                    const SizedBox(height: 14),
                    _AppField(
                      ctrl: _passwordCtrl,
                      label: locale.t('Password', 'Password'),
                      hint: locale.t('At least 8 characters', 'Hindi bababa sa 8 na karakter'),
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
                        if (text.isEmpty) {
                          return locale.t('Password is required.', 'Kinakailangan ang password.');
                        }
                        if (text.length < 8) {
                          return locale.t('Password must be at least 8 characters.', 'Ang password ay dapat hindi bababa sa 8 na karakter.');
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),
                    _AppField(
                      ctrl: _confirmPasswordCtrl,
                      label: locale.t('Confirm Password', 'Kumpirmahin ang Password'),
                      hint: locale.t('Re-enter your password', 'Ulitin ang iyong password'),
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
                          return locale.t('Please confirm your password.', 'Paki-kumpirma ang iyong password.');
                        }
                        if (value != _passwordCtrl.text) {
                          return locale.t('Passwords do not match.', 'Hindi magkatugma ang mga password.');
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
                onPressed: _isCheckingAvailability ? null : _submitForm,
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
                    : Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(
                            locale.t('Submit Registration', 'Isumite ang Rehistrasyon'),
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(width: 8),
                          const Icon(Icons.send_rounded, size: 20),
                        ],
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }


  Widget _buildSubmitting() {
    final locale = context.appLocale;
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
                Text(
                  locale.t('Submitting Registration...', 'Sinisumite ang Rehistrasyon...'),
                  style: const TextStyle(
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
