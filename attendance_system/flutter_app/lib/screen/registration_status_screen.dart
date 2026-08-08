import 'dart:async';

import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../services/app_locale.dart';
import '../services/local_notification_service.dart';
import '../widgets/brand_logo.dart';
import 'employee_login_screen.dart';
import 'registration_screen.dart';

class RegistrationStatusScreen extends StatefulWidget {
  final String email;
  final String phone;

  const RegistrationStatusScreen({
    super.key,
    required this.email,
    required this.phone,
  });

  @override
  State<RegistrationStatusScreen> createState() =>
      _RegistrationStatusScreenState();
}

class _RegistrationStatusScreenState extends State<RegistrationStatusScreen> {
  static const Duration _pollInterval = Duration(seconds: 10);

  Timer? _timer;
  String _status = 'pending';
  String _statusMsg = '';
  String _adminNotes = '';
  String _employeeId = '';
  String? _previousStatus;

  @override
  void initState() {
    super.initState();
    unawaited(LocalNotificationService.initialize());
    _checkStatus();
    _timer = Timer.periodic(_pollInterval, (_) => _checkStatus());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _checkStatus() async {
    try {
      final res = await ApiClient.get(
        '/register/status?email=${Uri.encodeQueryComponent(widget.email)}'
        '&phone=${Uri.encodeQueryComponent(widget.phone)}',
        timeout: const Duration(seconds: 8),
      );
      if (res.statusCode == 404) {
        _setStatus('removed', '');
        _notifyOnChange('removed', '');
        _previousStatus = 'removed';
        _timer?.cancel();
        return;
      }
      final data = ApiClient.jsonObject(res.body);
      if (data == null) {
        _setStatus('error', 'Cannot read the server response right now.');
        return;
      }

      final newStatus =
          (data['status'] ?? 'pending').toString().toLowerCase();
      final notes =
          (data['admin_notes'] as String?)?.trim() ?? '';
      final employeeId =
          (data['employee_id'] as String?)?.trim() ?? '';

      if (mounted) {
        setState(() {
          _status = newStatus;
          _adminNotes = notes;
          _employeeId = employeeId;
          _statusMsg = '';
        });
      }

      _notifyOnChange(newStatus, notes);
      _previousStatus = newStatus;
    } catch (_) {
      if (mounted && _previousStatus == null) {
        setState(() {
          _statusMsg = 'Cannot reach the server. We will keep trying...';
        });
      }
    }
  }

  void _notifyOnChange(String newStatus, String notes) {
    if (_previousStatus == null || _previousStatus == newStatus) return;
    final locale = context.appLocale;

    switch (newStatus) {
      case 'approved':
        unawaited(
          LocalNotificationService.show(
            id: 1001,
            title: locale.t('Registration Approved', 'Naaprubahan ang Rehistrasyon'),
            body: locale.t(
              'Your account has been approved. You can now sign in.',
              'Naaprubahan na ang iyong account. Pwede ka nang mag-login.',
            ),
          ),
        );
      case 'rejected':
        unawaited(
          LocalNotificationService.show(
            id: 1002,
            title: locale.t('Registration Rejected', 'Hindi Naaprubahan ang Rehistrasyon'),
            body: notes.isNotEmpty
                ? locale.t(
                    'Your registration was not approved. $notes',
                    'Hindi naaprubahan ang iyong rehistrasyon. $notes',
                  )
                : locale.t(
                    'Your registration was not approved. Contact the admin for details.',
                    'Hindi naaprubahan ang iyong rehistrasyon. Makipag-ugnayan sa admin para sa detalye.',
                  ),
          ),
        );
      case 'removed':
        unawaited(
          LocalNotificationService.show(
            id: 1003,
            title: locale.t('Registration Not Approved', 'Hindi Naaprubahan ang Rehistrasyon'),
            body: locale.t(
              'Your registration was removed. You can register again.',
              'Tinanggal ang iyong rehistrasyon. Pwede kang mag-register muli.',
            ),
          ),
        );
    }
  }

  void _setStatus(String status, String message) {
    if (!mounted) return;
    setState(() {
      _status = status;
      _statusMsg = message;
    });
  }

  void _goToLogin() {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const EmployeeLoginScreen()),
      (route) => false,
    );
  }

  void _backToLogin() {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const EmployeeLoginScreen()),
      (route) => false,
    );
  }

  void _goToRegister() {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const RegistrationScreen()),
      (route) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final locale = context.appLocale;
    final isApproved = _status == 'approved';
    final isRejected = _status == 'rejected' || _status == 'removed';
    final isRemoved = _status == 'removed';
    final accent = isApproved
        ? const Color(0xFF159947)
        : isRejected
        ? const Color(0xFFB31D18)
        : BrandColors.cyan;

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
          onPressed: _backToLogin,
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
          padding: const EdgeInsets.all(20),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 8),
                  Container(
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
                            'Registration Submitted',
                            'Naisumite ang Rehistrasyon',
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
                            'Your account is now waiting for admin approval.',
                            'Ang iyong account ay naghihintay na sa pag-apruba ng admin.',
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
                  Container(
                    padding: const EdgeInsets.all(22),
                    decoration: BoxDecoration(
                      color: BrandColors.surface.withValues(alpha: 0.96),
                      borderRadius: BorderRadius.circular(24),
                      border: Border.all(
                        color: accent.withValues(alpha: 0.4),
                      ),
                    ),
                    child: Column(
                      children: [
                        if (isApproved)
                          _StatusIcon(
                            icon: Icons.check_circle_rounded,
                            color: accent,
                          )
                        else if (isRejected)
                          _StatusIcon(
                            icon: Icons.cancel_rounded,
                            color: accent,
                          )
                        else
                          const _PulsingProgress(),
                        const SizedBox(height: 18),
                        Text(
                          _titleForStatus(locale),
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            color: BrandColors.text,
                            fontSize: 18,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          _messageForStatus(locale),
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            color: BrandColors.textMuted,
                            fontSize: 13,
                            height: 1.5,
                          ),
                        ),
                        if (isApproved && _employeeId.isNotEmpty) ...[
                          const SizedBox(height: 16),
                          _InfoRow(
                            label: locale.t('Employee ID', 'Employee ID'),
                            value: _employeeId,
                            accent: accent,
                          ),
                        ],
                        if (isRejected && _adminNotes.isNotEmpty) ...[
                          const SizedBox(height: 16),
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: accent.withValues(alpha: 0.06),
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(
                                color: accent.withValues(alpha: 0.18),
                              ),
                            ),
                            child: Text(
                              _adminNotes,
                              style: const TextStyle(
                                color: BrandColors.textMuted,
                                fontSize: 13,
                                height: 1.4,
                              ),
                            ),
                          ),
                        ],
                        const SizedBox(height: 22),
                        SizedBox(
                          width: double.infinity,
                          height: 54,
                          child: ElevatedButton.icon(
                            onPressed: isApproved
                                ? _goToLogin
                                : isRemoved
                                ? _goToRegister
                                : _backToLogin,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: accent,
                              foregroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(14),
                              ),
                            ),
                            icon: Icon(
                              isApproved
                                  ? Icons.login_rounded
                                  : isRemoved
                                  ? Icons.app_registration_rounded
                                  : Icons.arrow_back_rounded,
                              size: 20,
                            ),
                            label: Text(
                              isApproved
                                  ? locale.t('Go to Login', 'Pumunta sa Login')
                                  : isRemoved
                                  ? locale.t('Register Again', 'Mag-register Muli')
                                  : locale.t('Back to Login', 'Bumalik sa Login'),
                              style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                        ),
                        if (!isApproved && !isRejected) ...[
                          const SizedBox(height: 12),
                          Text(
                            locale.t(
                              'This screen refreshes automatically.\nYou will be notified once the admin decides.',
                              'Awtomatikong nagre-refresh ang screen na ito.\nMaaabutan ka kapag nagdesisyon na ang admin.',
                            ),
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              color: BrandColors.textMuted,
                              fontSize: 11.5,
                              height: 1.4,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  String _titleForStatus(AppLocale locale) {
    if (_status == 'approved') return locale.t('Approved!', 'Naaprubahan!');
    if (_status == 'rejected' || _status == 'removed') {
      return locale.t('Not Approved', 'Hindi Naaprubahan');
    }
    if (_status == 'error') {
      return locale.t('Status Unavailable', 'Hindi Available ang Status');
    }
    return locale.t('Waiting for Admin Approval', 'Naghihintay ng Pag-apruba ng Admin');
  }

  String _messageForStatus(AppLocale locale) {
    if (_status == 'approved') {
      return locale.t(
        'Congratulations! Your account has been approved.\nTap "Go to Login" to sign in.',
        'Binabati kita! Naaprubahan na ang iyong account.\nPindutin ang "Pumunta sa Login" para mag-login.',
      );
    }
    if (_status == 'rejected') {
      return locale.t(
        'Your registration was reviewed but was not approved.\nPlease contact the admin for the next step.',
        'Sinuri ang iyong rehistrasyon ngunit hindi ito naaprubahan.\nMakipag-ugnayan sa admin para sa susunod na hakbang.',
      );
    }
    if (_status == 'removed') {
      return locale.t(
        'Your registration was removed.\nYou can now register again with the same email and number.',
        'Tinanggal ang iyong rehistrasyon.\nPwede kang mag-register muli gamit ang parehong email at numero.',
      );
    }
    if (_status == 'error') return _statusMsg;
    if (_statusMsg.isNotEmpty) return _statusMsg;
    return locale.t(
      'Please wait while the admin reviews your registration.\nThis usually takes a little while.',
      'Mangyaring maghintay habang sinusuri ng admin ang iyong rehistrasyon.\nKaraniwang tumatagal lamang ito ng ilang sandali.',
    );
  }
}

class _StatusIcon extends StatelessWidget {
  final IconData icon;
  final Color color;

  const _StatusIcon({required this.icon, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 96,
      height: 96,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color.withValues(alpha: 0.12),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Icon(icon, color: color, size: 56),
    );
  }
}

class _PulsingProgress extends StatefulWidget {
  const _PulsingProgress();

  @override
  State<_PulsingProgress> createState() => _PulsingProgressState();
}

class _PulsingProgressState extends State<_PulsingProgress>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 96,
      height: 96,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) {
          return Stack(
            alignment: Alignment.center,
            children: [
              Transform.scale(
                scale: 0.8 + _controller.value * 0.25,
                child: Container(
                  width: 96,
                  height: 96,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: BrandColors.cyan.withValues(
                        alpha: (1 - _controller.value) * 0.25,
                      ),
                      width: 2,
                    ),
                  ),
                ),
              ),
              Container(
                width: 76,
                height: 76,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: BrandColors.cyan.withValues(alpha: 0.12),
                  border: Border.all(
                    color: BrandColors.cyan.withValues(alpha: 0.35),
                  ),
                ),
                child: Icon(
                  Icons.hourglass_top_rounded,
                  color: BrandColors.cyan,
                  size: 40,
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final String label;
  final String value;
  final Color accent;

  const _InfoRow({
    required this.label,
    required this.value,
    required this.accent,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: accent.withValues(alpha: 0.18)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: const TextStyle(
              color: BrandColors.textMuted,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: 12),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: const TextStyle(
                color: BrandColors.text,
                fontSize: 14,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
