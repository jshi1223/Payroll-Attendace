import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:local_auth/local_auth.dart';
import 'package:provider/provider.dart';

import '../constants.dart';
import '../services/api_client.dart';
import '../services/app_locale.dart';
import '../services/app_lock_service.dart';
import '../services/device_identity.dart';
import '../services/offline_queue.dart';
import '../services/push_notification_service.dart';
import '../services/session_store.dart';
import '../utils/api_errors.dart';
import '../widgets/brand_logo.dart';
import '../widgets/empty_state.dart';
import 'face_photo_crop_screen.dart';
import 'employee_notifications_screen.dart';

enum EmployeeSection {
  dashboard,
  attendanceLogs,
  payroll,
  profile,
}

class EmployeeLoginScreen extends StatefulWidget {
  const EmployeeLoginScreen({super.key});

  @override
  State<EmployeeLoginScreen> createState() => _EmployeeLoginScreenState();
}

class _EmployeeLoginScreenState extends State<EmployeeLoginScreen>
    with WidgetsBindingObserver {
  final _loginFormKey = GlobalKey<FormState>();
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();

  final LocalAuthentication _localAuth = LocalAuthentication();
  final ImagePicker _imagePicker = ImagePicker();

  bool _isLoading = false;
  bool _isLogsLoading = false;
  bool _isSignedIn = false;
  bool _isPasswordHidden = true;
  bool _isPhotoUploading = false;
  bool _isVerifyingBiometrics = false;
  bool _isAttendancePromptOpen = false;
  bool _isMarkingPresent = false;
  bool _isMarkingTimeout = false;
  EmployeeSession? _pendingSession;
  bool _hasSavedSession = false;
  bool _hasBiometrics = false;
  bool _isRestoringSession = false;
  bool _needsAppUnlock = false;
  bool _isSyncingQueue = false;
  bool _isPayrollPeriodLoading = false;
  bool _isPickingPhoto = false;
  bool _passwordUnlockMode = false;
  bool _isUnlockingWithPassword = false;
  final _unlockPasswordCtrl = TextEditingController();
  int _queuedCount = 0;
  String _dashboardStatFilter = 'month';

  String _statusMsg = '';
  String _logsMsg = '';
  String _token = '';
  String _name = '';
  String _employeeId = '';
  String _email = '';
  String _phone = '';
  String _governmentId = '';
  String _sssNumber = '';
  String _philhealthNumber = '';
  String _pagibigNumber = '';
  String _tinNumber = '';
  String _status = '';
  String _photoUrl = '';
  EmployeeSection _selectedSection = EmployeeSection.dashboard;
  DateTime _calendarMonth = DateTime(DateTime.now().year, DateTime.now().month);
  DateTime _selectedCalendarDate = DateTime.now();
  DateTime _lastDashboardRefreshAt = DateTime.now();
  Timer? _dashboardClockTimer;
  Timer? _pushRefreshDebounce;
  String? _lastPushType;

  List<dynamic> _groupedLogs = const [];
  Map<String, dynamic> _dailyFinancials = const {};
  List<dynamic> _caRequests = const [];
  bool _caRequestsLoading = false;
  bool _caRequestSubmitting = false;
  int? _caCancelRequestId;
  List<Map<String, dynamic>> _breakdownPeriods = const [];
  int _paidPeriodIndex = 0;
  String _periodTypeLabel = '';
  List<Map<String, dynamic>> _payslipPeriods = const [];
  List<dynamic> _payslipRequests = const [];
  bool _isPayslipLoading = false;
  bool _isPayslipSubmitting = false;
  int _notifCount = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _checkBiometrics();
    PushNotificationService.onDataRefresh = _handlePushRefresh;
    PushNotificationService.deepLinkNotifier.addListener(_handleDeepLink);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _refreshQueuedCount();
      _restoreSession();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    PushNotificationService.onDataRefresh = null;
    PushNotificationService.deepLinkNotifier.removeListener(_handleDeepLink);
    _dashboardClockTimer?.cancel();
    _pushRefreshDebounce?.cancel();
    _emailCtrl.dispose();
    _passwordCtrl.dispose();
    _unlockPasswordCtrl.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (_isSignedIn && _token.isNotEmpty) {
        final lock = context.read<AppLockService>();
        if (lock.enabled && lock.locked) {
          if (mounted) setState(() => _needsAppUnlock = true);
        } else {
          if (mounted && _needsAppUnlock) setState(() => _needsAppUnlock = false);
          _loadLogs();
        }
      }
      _syncOfflineQueue(silent: true);
    } else if (state == AppLifecycleState.paused) {
      if (_isSignedIn && _token.isNotEmpty) {
        final lock = context.read<AppLockService>();
        // Do not lock while a system flow is on screen: the attendance
        // fingerprint prompt, a biometrics verification prompt, or the
        // camera / photo picker all trigger a pause/resume cycle that must
        // not lock the app behind them.
        if (lock.enabled &&
            !_isAttendancePromptOpen &&
            !_isVerifyingBiometrics &&
            !_isPickingPhoto) {
          lock.lock();
          if (mounted) setState(() => _needsAppUnlock = true);
        }
      }
    }
  }

  void _handlePushRefresh(String type) {
    if (!mounted || !_isSignedIn || _token.isEmpty) return;
    // Coalesce bursts of pushes (e.g. several payroll edits in a row) into a
    // single refresh so the backend is not hammered.
    _lastPushType = type;
    _pushRefreshDebounce?.cancel();
    _pushRefreshDebounce = Timer(const Duration(milliseconds: 400), () {
      if (mounted && _isSignedIn && _token.isNotEmpty) {
        if (_lastPushType == 'payroll_updated' ||
            _lastPushType == 'cash_advance_approved' ||
            _lastPushType == 'cash_advance_rejected' ||
            _lastPushType == 'payslip_approved' ||
            _lastPushType == 'payslip_rejected' ||
            _lastPushType == 'payroll_accepted' ||
            _lastPushType == 'payslip_ready' ||
            _lastPushType == 'payslip_unlocked' ||
            _lastPushType == 'salary_paid' ||
            _lastPushType == 'bale_payment' ||
            _lastPushType == 'extra_pay_added') {
          _loadPayrollPeriods();
          _loadPayslipRequests();
        }
        _loadNotifications();
        _loadCashAdvanceRequests();
        _loadLogs();
      }
    });
  }

  void _handleDeepLink() {
    final target = PushNotificationService.deepLinkNotifier.value;
    final period = PushNotificationService.deepLinkPeriodNotifier.value;
    if (!mounted || !_isSignedIn) return;
    if (target == 'attendance') {
      setState(() => _selectedSection = EmployeeSection.attendanceLogs);
    } else if (target == 'payroll') {
      _openPayrollSection(period: period);
      PushNotificationService.clearDeepLinkPeriod();
    } else if (target == 'notifications') {
      _openNotifications();
    }
  }

  void _startDashboardRefreshTimer() {
    // No auto-refresh: dashboard and payroll data only load on demand
    // (login, pull-to-refresh, or the refresh button) so payroll numbers
    // never change underneath the employee.
    _dashboardClockTimer?.cancel();
    if (!_isSignedIn || _token.isEmpty) return;
    _dashboardClockTimer = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted && _isSignedIn) setState(() {});
    });
  }

  void _togglePasswordVisibility() {
    setState(() => _isPasswordHidden = !_isPasswordHidden);
  }

  Future<void> _checkBiometrics() async {
    bool enrolled = false;
    try {
      if (!await _localAuth.isDeviceSupported()) {
        enrolled = false;
      } else {
        final enrolledList = await _localAuth.getAvailableBiometrics();
        enrolled = enrolledList.isNotEmpty;
      }
    } catch (_) {
      enrolled = false;
    }
    if (mounted) setState(() => _hasBiometrics = enrolled);
  }

  Future<void> _restoreSession() async {
    if (_isRestoringSession || _isSignedIn) return;
    _isRestoringSession = true;
    try {
      final session = await SessionStore.load();
      if (session == null || !mounted) return;
      // Validate the saved token with the server so an expired or revoked
      // session is cleared up-front instead of failing after a successful
      // fingerprint scan. Offline devices keep the session optimistically.
      final invalidReason = await _validateSavedSession(session);
      if (!mounted) return;
      if (invalidReason != null) {
        await SessionStore.clear();
        if (!mounted) return;
        final signedInElsewhere = invalidReason == 'device';
        setState(() {
          _pendingSession = null;
          _hasSavedSession = false;
          _statusMsg = context.tr(
            signedInElsewhere
                ? 'You signed in on another device. Please sign in again.'
                : 'Your saved session has expired. Please sign in with your password.',
            signedInElsewhere
                ? 'Nag-sign in ka sa ibang device. Mangyaring mag-sign in muli.'
                : 'Nag-expire na ang iyong naka-save na session. Mangyaring mag-sign in gamit ang iyong password.',
          );
        });
        return;
      }
      // Do NOT auto-login. Remember the saved session only so the login
      // screen can offer "Login with Fingerprint" as a quick option.
      setState(() {
        _pendingSession = session;
        _hasSavedSession = true;
      });
    } finally {
      _isRestoringSession = false;
    }
  }

  /// Returns null when the saved token can still be used. Otherwise returns a
  /// short reason code ('device' when another device signed in, 'expired'
  /// otherwise) explaining why the saved session is no longer valid. Any
  /// non-auth response — endpoint not deployed yet (404), server error (5xx),
  /// or being offline — keeps the session so the "Login with Fingerprint"
  /// option never disappears unexpectedly.
  Future<String?> _validateSavedSession(EmployeeSession session) async {
    try {
      final res = await ApiClient.get(
        '/employee/session',
        headers: {'Authorization': 'Bearer ${session.token}'},
        timeout: const Duration(seconds: 8),
      );
      if (!ApiClient.isAuthExpiredStatus(res.statusCode)) return null;
      return res.body.toLowerCase().contains('another device')
          ? 'device'
          : 'expired';
    } catch (_) {
      // Offline — keep the session optimistically.
      return null;
    }
  }

  Future<void> _loginWithBiometrics() async {
    final session = _pendingSession;
    if (session == null || _isLoading || _isVerifyingBiometrics || !_hasBiometrics) {
      return;
    }
    setState(() => _isVerifyingBiometrics = true);
    bool verified = false;
    try {
      verified = await _localAuth.authenticate(
        localizedReason: 'Verify your fingerprint to sign in.',
        options: const AuthenticationOptions(
          biometricOnly: true,
          stickyAuth: false,
        ),
      );
    } catch (_) {
      verified = false;
    }
    if (!mounted) return;
    setState(() => _isVerifyingBiometrics = false);
    if (!verified) {
      _showProfileSnack(
        context.tr(
          'Fingerprint verification failed or cancelled.',
          'Hindi nakumpirma ang fingerprint o nakansela.',
        ),
        error: true,
      );
      return;
    }
    // Re-validate the saved session with the server before applying it. This
    // prevents the "login with fingerprint then instantly logged out" case
    // when the saved token expired or the account was archived.
    final invalidReason = await _validateSavedSession(session);
    if (!mounted) return;
    if (invalidReason != null) {
      await SessionStore.clear();
      if (!mounted) return;
      final signedInElsewhere = invalidReason == 'device';
      setState(() {
        _pendingSession = null;
        _hasSavedSession = false;
      });
      _showProfileSnack(
        context.tr(
          signedInElsewhere
              ? 'You signed in on another device. Please sign in again.'
              : 'Your saved session has expired. Please sign in with your password.',
          signedInElsewhere
              ? 'Nag-sign in ka sa ibang device. Mangyaring mag-sign in muli.'
              : 'Nag-expire na ang iyong naka-save na session. Mangyaring mag-sign in gamit ang iyong password.',
        ),
        error: true,
      );
      return;
    }
    _applySession(session);
    context.read<AppLockService>().markUnlocked();
    unawaited(_registerPushNotifications());
    await _loadLogs();
    _startDashboardRefreshTimer();
    await _syncOfflineQueue(silent: true);
  }

  void _applySession(EmployeeSession session) {
    setState(() {
      _isSignedIn = true;
      _needsAppUnlock = false;
      _token = session.token;
      _name = session.name;
      _employeeId = session.employeeId;
      _email = session.email;
      _phone = session.phone;
      _governmentId = session.governmentId;
      _sssNumber = session.sssNumber;
      _philhealthNumber = session.philhealthNumber;
      _pagibigNumber = session.pagibigNumber;
      _tinNumber = session.tinNumber;
      _status = session.status;
      _photoUrl = session.photoUrl;
      // Remember the session so "Login with Fingerprint" is available again
      // after logging out — not just on a fresh app start.
      _pendingSession = session;
      _hasSavedSession = true;
    });
  }

  Future<void> _unlockApp() async {
    if (_isVerifyingBiometrics) return;
    setState(() => _isVerifyingBiometrics = true);
    final ok = await context.read<AppLockService>().unlock();
    if (!mounted) return;
    setState(() {
      _isVerifyingBiometrics = false;
      if (ok) _needsAppUnlock = false;
    });
    if (ok) {
      unawaited(_registerPushNotifications());
      await _loadLogs();
      _startDashboardRefreshTimer();
    } else {
      _showProfileSnack('Fingerprint required to open the app.', error: true);
    }
  }

  /// Password fallback for the App Locked gate. Lets the employee unlock the
  /// app with their password when the fingerprint is unavailable or fails.
  Future<void> _unlockWithPassword() async {
    if (_isUnlockingWithPassword) return;
    final password = _unlockPasswordCtrl.text;
    if (password.isEmpty) {
      _showProfileSnack('Enter your password to unlock.', error: true);
      return;
    }
    if (_email.isEmpty) {
      // No email on file — fall back to logout so the login screen is shown.
      await _logout();
      return;
    }
    setState(() => _isUnlockingWithPassword = true);
    try {
      final res = await ApiClient.postForm(
        '/employee/login',
        body: {'email': _email, 'password': password},
      );
      if (!mounted) return;
      final body = json.decode(res.body);
      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        final freshToken = body['token']?.toString() ?? '';
        context.read<AppLockService>().markUnlocked();
        if (!mounted) return;
        setState(() {
          if (freshToken.isNotEmpty) _token = freshToken;
          _isUnlockingWithPassword = false;
          _needsAppUnlock = false;
          _passwordUnlockMode = false;
          _unlockPasswordCtrl.clear();
        });
        await _saveSession();
        unawaited(_registerPushNotifications());
        await _loadLogs();
        _startDashboardRefreshTimer();
      } else {
        if (!mounted) return;
        setState(() => _isUnlockingWithPassword = false);
        _showProfileSnack(
          body is Map<String, dynamic>
              ? serverMessageFromBody(res.body, fallback: 'Incorrect password.')
              : 'Incorrect password.',
          error: true,
        );
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _isUnlockingWithPassword = false);
      _showProfileSnack(ApiClient.friendlyNetworkError(error), error: true);
    }
  }

  Future<void> _saveSession() async {
    await SessionStore.save(
      EmployeeSession(
        token: _token,
        name: _name,
        employeeId: _employeeId,
        email: _email,
        phone: _phone,
        governmentId: _governmentId,
        sssNumber: _sssNumber,
        philhealthNumber: _philhealthNumber,
        pagibigNumber: _pagibigNumber,
        tinNumber: _tinNumber,
        status: _status,
        photoUrl: _photoUrl,
      ),
    );
  }

  Future<void> _refreshQueuedCount() async {
    final count = await OfflineAttendanceQueue.length();
    if (mounted) setState(() => _queuedCount = count);
  }

  Future<void> _syncOfflineQueue({bool silent = false}) async {
    if (_token.isEmpty || _isSyncingQueue) return;
    _isSyncingQueue = true;
    try {
      final result = await OfflineSyncService.syncAll();
      if (!mounted) return;
      final remaining = await OfflineAttendanceQueue.length();
      setState(() => _queuedCount = remaining);
      if (result.synced > 0) {
        await _loadLogs();
        if (!silent) {
          _showProfileSnack(
            'Synced ${result.synced} offline ${result.synced == 1 ? 'record' : 'records'}.',
            error: false,
          );
        }
      }
    } finally {
      _isSyncingQueue = false;
    }
  }

  Future<void> _handleDashboardRefresh() async {
    await _syncOfflineQueue(silent: true);
    await _loadLogs();
    await _refreshQueuedCount();
  }

  Future<void> _handleLogsRefresh() async {
    await _loadLogs();
    await _refreshQueuedCount();
  }

  Future<void> _openPayrollSection({String? period}) async {
    setState(() => _selectedSection = EmployeeSection.payroll);
    _loadPayslipRequests();
    await _loadPayrollPeriods();
    if (!mounted || period == null || period.isEmpty) return;
    final index = _breakdownPeriods.indexWhere((p) {
      return (p['period_key']?.toString() ?? '') == period ||
          (p['start_date']?.toString() ?? '') == period;
    });
    if (index >= 0) {
      setState(() => _paidPeriodIndex = index);
    }
  }

  Future<void> _loadNotifications() async {
    if (_token.isEmpty || !mounted) return;
    try {
      final res = await ApiClient.get(
        '/employee/notifications',
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (!mounted || res.statusCode != 200) return;
      final body = ApiClient.jsonObject(res.body);
      final unread = body?['unread'];
      if (mounted) {
        setState(() => _notifCount = unread is int ? unread : 0);
      }
    } catch (_) {
      // silent: the bell simply keeps its last known count
    }
  }

  void _openNotifications() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => EmployeeNotificationsScreen(
          token: _token,
          onOpenPayroll: (period) => _openPayrollSection(period: period),
          onChanged: _loadNotifications,
        ),
      ),
    );
  }

  Future<void> _loadPayrollPeriods() async {
    if (_token.isEmpty) return;
    setState(() => _isPayrollPeriodLoading = true);
    try {
      final res = await ApiClient.get(
        '/employee/payroll/periods',
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (!mounted) return;
      final body = ApiClient.jsonObject(res.body);
      if (ApiClient.isAuthExpiredStatus(res.statusCode)) {
        final detail = body?['detail']?.toString().toLowerCase() ?? '';
        _expireSession(
          detail.contains('archiv')
              ? 'Your account was archived by the administrator.'
              : ApiClient.authMessage,
          res.body,
        );
        return;
      }
      setState(() {
        final all = <Map<String, dynamic>>[];
        if (res.statusCode == 200 && body != null) {
          final list = body['periods'];
          if (list is List) {
            for (final entry in list) {
              if (entry is Map) all.add(Map<String, dynamic>.from(entry));
            }
          }
          _periodTypeLabel = body['period_type']?.toString() ?? '';
        } else {
          _periodTypeLabel = '';
        }
        _breakdownPeriods = all
            .where((p) {
              final s = p['payment_status']?.toString() ?? '';
              return s == 'paid' || s == 'generated';
            })
            .toList();
        if (_paidPeriodIndex >= _breakdownPeriods.length) {
          _paidPeriodIndex = _breakdownPeriods.isEmpty ? 0 : _breakdownPeriods.length - 1;
        }
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _breakdownPeriods = const [];
          _periodTypeLabel = '';
        });
      }
    } finally {
      if (mounted) setState(() => _isPayrollPeriodLoading = false);
    }
  }

  Future<void> _loadPayslipRequests() async {
    if (_token.isEmpty) return;
    if (mounted) setState(() => _isPayslipLoading = true);
    try {
      final periodsRes = await ApiClient.get(
        '/employee/payslip/periods',
        headers: {'Authorization': 'Bearer $_token'},
      );
      final requestsRes = await ApiClient.get(
        '/employee/payslip/requests',
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (!mounted) return;
      final periodsBody = ApiClient.jsonObject(periodsRes.body);
      final requestsBody = ApiClient.jsonObject(requestsRes.body);
      if (ApiClient.isAuthExpiredStatus(periodsRes.statusCode) ||
          ApiClient.isAuthExpiredStatus(requestsRes.statusCode)) {
        final expiredBody = ApiClient.isAuthExpiredStatus(periodsRes.statusCode)
            ? periodsRes.body
            : requestsRes.body;
        _expireSession(ApiClient.authMessage, expiredBody);
        return;
      }
      setState(() {
        final available = <Map<String, dynamic>>[];
        if (periodsRes.statusCode == 200 && periodsBody != null) {
          final list = periodsBody['periods'];
          if (list is List) {
            for (final entry in list) {
              if (entry is Map) available.add(Map<String, dynamic>.from(entry));
            }
          }
        }
        _payslipPeriods = available;
        _payslipRequests = (requestsRes.statusCode == 200 && requestsBody != null)
            ? (requestsBody['rows'] as List?) ?? const []
            : const [];
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _payslipPeriods = const [];
          _payslipRequests = const [];
        });
      }
    } finally {
      if (mounted) setState(() => _isPayslipLoading = false);
    }
  }

  void _showRequestPayslipDialog() {
    if (_payslipPeriods.isEmpty) return;
    Map<String, dynamic> selected = _payslipPeriods.first;
    showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) {
          final selectedLabel =
              '${selected['start_date']} → ${selected['end_date']}  ·  ${context.tr(selected['period_type'] == 'weekly' ? 'Weekly' : 'Semi-monthly', selected['period_type'] == 'weekly' ? 'Lingguhan' : 'Kalahating-buwan')}  ·  ${_fmtMoney(selected['net_pay'])}';
          return AlertDialog(
            backgroundColor: BrandColors.surface,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            title: Row(
              children: [
                const Icon(Icons.receipt_long_rounded, color: BrandColors.cyan),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    context.tr('Request Payslip', 'Humingi ng Payslip'),
                    style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16),
                  ),
                ),
              ],
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  context.tr(
                    'Choose the paid period for your payslip. It will be emailed to you after admin approval.',
                    'Piliin ang bayad na panahon para sa iyong payslip. Ie-email ito sa iyo pagkatapos ng pag-apruba ng admin.',
                  ),
                  style: const TextStyle(color: BrandColors.textMuted, fontSize: 12, height: 1.4),
                ),
                const SizedBox(height: 14),
                Text(
                  context.tr('Period', 'Panahon'),
                  style: const TextStyle(
                    color: BrandColors.textMuted,
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 6),
                DropdownButtonFormField<Map<String, dynamic>>(
                  initialValue: selected,
                  isExpanded: true,
                  decoration: InputDecoration(
                    filled: true,
                    fillColor: const Color(0xFFF8FAFC),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  ),
                  items: _payslipPeriods
                      .map((p) => DropdownMenuItem<Map<String, dynamic>>(
                            value: p,
                            child: Text(
                              '${p['start_date']} → ${p['end_date']}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
                            ),
                          ))
                      .toList(),
                  onChanged: (value) {
                    if (value != null) setDialogState(() => selected = value);
                  },
                ),
                const SizedBox(height: 12),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF0FDF4),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: const Color(0xFF34A853).withValues(alpha: 0.3)),
                  ),
                  child: Text(
                    selectedLabel,
                    style: const TextStyle(
                      color: Color(0xFF147A3A),
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(),
                child: Text(context.tr('Cancel', 'Kanselahin')),
              ),
              FilledButton(
                onPressed: _isPayslipSubmitting
                    ? null
                    : () {
                        Navigator.of(dialogContext).pop();
                        _submitPayslipRequest(selected);
                      },
                child: Text(context.tr('Submit Request', 'Isumite ang Kahilingan')),
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _submitPayslipRequest(Map<String, dynamic> period) async {
    if (_isPayslipSubmitting) return;
    setState(() => _isPayslipSubmitting = true);
    try {
      final res = await ApiClient.postJson(
        '/employee/payslip/request',
        body: {
          'period_start': period['start_date'],
          'period_end': period['end_date'],
        },
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (!mounted) return;
      final body = ApiClient.jsonObject(res.body);
      if (ApiClient.isAuthExpiredStatus(res.statusCode)) {
        _expireSession(ApiClient.authMessage, res.body);
        return;
      }
      if (res.statusCode == 200 || res.statusCode == 201) {
        _showProfileSnack(
          context.tr(
            'Payslip request submitted. Wait for the admin to approve and email it.',
            'Na-submit ang iyong kahilingan. Hintayin ang pag-apruba at email ng admin.',
          ),
          error: false,
        );
        await _loadPayslipRequests();
      } else {
        String? detail;
        if (body is Map<String, dynamic>) {
          detail = body['detail']?.toString();
        }
        _showProfileSnack(
          detail ??
              context.tr('Unable to submit payslip request.', 'Hindi ma-submit ang kahilingan.'),
          error: true,
        );
      }
    } catch (_) {
      if (mounted) {
        _showProfileSnack(
          context.tr('Network error. Please try again.', 'Network error. Subukan muli.'),
          error: true,
        );
      }
    } finally {
      if (mounted) setState(() => _isPayslipSubmitting = false);
    }
  }

  String _isoDate(DateTime dt) {
    return '${dt.year.toString().padLeft(4, '0')}-'
        '${dt.month.toString().padLeft(2, '0')}-'
        '${dt.day.toString().padLeft(2, '0')}';
  }

  Future<void> _loadCashAdvanceRequests() async {
    if (_token.isEmpty) return;
    if (mounted) setState(() => _caRequestsLoading = true);
    try {
      final res = await ApiClient.get(
        '/employee/cash-advance-requests',
        headers: {'Authorization': 'Bearer $_token'},
      );
      if (!mounted) return;
      final body = ApiClient.jsonObject(res.body);
      if (res.statusCode == 200 && body != null) {
        setState(() => _caRequests = (body['requests'] as List?) ?? const []);
      }
    } catch (_) {
      // Leave the previous list intact on transient errors.
    } finally {
      if (mounted) setState(() => _caRequestsLoading = false);
    }
  }

  Future<void> _submitCashAdvanceRequest(double amount, String reason, {String? pickupDate}) async {
    if (_token.isEmpty) return;
    setState(() => _caRequestSubmitting = true);
    try {
      final res = await ApiClient.postJson(
        '/employee/cash-advance-request',
        body: {
          'amount': amount,
          'reason': reason,
          'pickup_date': ?pickupDate,
        },
        headers: {'Authorization': 'Bearer $_token'},
      );
      final body = ApiClient.jsonObject(res.body);
      if (ApiClient.isAuthExpiredStatus(res.statusCode)) {
        final detail = body?['detail']?.toString().toLowerCase() ?? '';
        _expireSession(
          detail.contains('archiv')
              ? 'Your account was archived by the administrator.'
              : ApiClient.authMessage,
          res.body,
        );
        return;
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(context.tr(
              'Cash advance request submitted.',
              'Naipadala na ang kahilingan ng paunang sahod.',
            )),
          ));
        }
        await _loadCashAdvanceRequests();
      } else {
        final detail = body?['detail']?.toString() ??
            body?['error']?.toString();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(detail ??
                context.tr('Failed to submit request.', 'Hindi naipadala ang kahilingan.')),
          ));
        }
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(context.tr('Failed to submit request.', 'Hindi naipadala ang kahilingan.')),
        ));
      }
    } finally {
      if (mounted) setState(() => _caRequestSubmitting = false);
    }
  }

  Future<void> _showCashAdvanceRequestDialog() async {
    final amountCtrl = TextEditingController();
    final reasonCtrl = TextEditingController();
    final formKey = GlobalKey<FormState>();
    DateTime? pickupDate;
    await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: Text(
            context.tr('Request Cash Advance', 'Humingi ng Paunang Sahod'),
            style: const TextStyle(fontWeight: FontWeight.w900),
          ),
          content: Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextFormField(
                  controller: amountCtrl,
                  autofocus: true,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: InputDecoration(
                    labelText: context.tr('Amount (₱)', 'Halaga (₱)'),
                    border: const OutlineInputBorder(),
                  ),
                  validator: (v) {
                    final val = double.tryParse((v ?? '').trim());
                    if (val == null || val <= 0) {
                      return context.tr('Enter a valid amount.', 'Maglagay ng wastong halaga.');
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 14),
                OutlinedButton.icon(
                  onPressed: () async {
                    final now = DateTime.now();
                    final picked = await showDatePicker(
                      context: dialogContext,
                      initialDate: pickupDate ?? now,
                      firstDate: now,
                      lastDate: now.add(const Duration(days: 365)),
                    );
                    if (picked != null) {
                      setDialogState(() => pickupDate = picked);
                    }
                  },
                  icon: const Icon(Icons.event_rounded, size: 18),
                  label: Text(
                    pickupDate == null
                        ? context.tr('Select pickup date (when to receive)', 'Pumili ng petsa ng pagkuha (kailan matatanggap)')
                        : '${context.tr('Pickup date', 'Petsa ng pagkuha')}: ${_isoDate(pickupDate!)}',
                  ),
                ),
                if (pickupDate == null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      context.tr('Required — choose when you will receive the cash advance.', 'Kinakailangan — pumili kung kailan mo makukuha ang paunang sahod.'),
                      style: const TextStyle(fontSize: 11, color: Color(0xFFC62828)),
                    ),
                  ),
                const SizedBox(height: 8),
                TextFormField(
                  controller: reasonCtrl,
                  maxLength: 500,
                  decoration: InputDecoration(
                    labelText: context.tr('Reason (optional)', 'Dahilan (opsyonal)'),
                    border: const OutlineInputBorder(),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: Text(context.tr('Cancel', 'Kanselahin')),
            ),
            ElevatedButton(
              onPressed: () {
                if (!(formKey.currentState?.validate() ?? false)) return;
                if (pickupDate == null) {
                  ScaffoldMessenger.of(dialogContext).showSnackBar(SnackBar(
                    content: Text(context.tr(
                      'Please choose a pickup date for your cash advance.',
                      'Mangyaring pumili ng petsa ng pagkuha para sa iyong paunang sahod.',
                    )),
                  ));
                  return;
                }
                final amount = double.parse(amountCtrl.text.trim());
                Navigator.of(dialogContext).pop(true);
                _submitCashAdvanceRequest(
                  amount,
                  reasonCtrl.text.trim(),
                  pickupDate: _isoDate(pickupDate!),
                );
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: BrandColors.cyan,
                foregroundColor: Colors.white,
              ),
              child: Text(context.tr('Submit', 'Ipasa')),
            ),
          ],
        ),
      ),
    );
  }

  Widget _caStatusPill(String status) {
    if (status == 'approved') return _pill('APPROVED', const Color(0xFFE8F5E9), const Color(0xFF147A3A));
    if (status == 'rejected') return _pill('REJECTED', const Color(0xFFFFEBEE), const Color(0xFFC62828));
    return _pill('PENDING', const Color(0xFFFFF3E0), const Color(0xFFB45309));
  }

  String _formatRequestDate(String? raw) {
    if (raw == null || raw.length < 10) return '-';
    final date = DateTime.tryParse(raw.substring(0, 10));
    if (date == null) return raw.substring(0, 10);
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return '${months[date.month - 1]} ${date.day}, ${date.year}';
  }

  Future<void> _cancelCashAdvanceRequest(Map<String, dynamic> row) async {
    if (_token.isEmpty || _caCancelRequestId != null) return;
    final requestId = row['id'];
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(
          context.tr('Cancel request?', 'Kanselahin ang kahilingan?'),
          style: const TextStyle(fontWeight: FontWeight.w900),
        ),
        content: Text(context.tr(
          'This will remove your pending cash advance request of ${_fmtMoney(row['amount'])}.',
          'Tatanggalin nito ang iyong kahilingan ng paunang sahod na ${_fmtMoney(row['amount'])}.',
        )),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(context.tr('Keep', 'Panatilihin')),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFFC62828),
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(context.tr('Cancel Request', 'Kanselahin ang Kahilingan')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _caCancelRequestId = requestId);
    try {
      final res = await ApiClient.postJson(
        '/employee/cash-advance-request/$requestId/cancel',
        headers: {'Authorization': 'Bearer $_token'},
      );
      final body = ApiClient.jsonObject(res.body);
      if (ApiClient.isAuthExpiredStatus(res.statusCode)) {
        final detail = body?['detail']?.toString().toLowerCase() ?? '';
        _expireSession(
          detail.contains('archiv')
              ? 'Your account was archived by the administrator.'
              : ApiClient.authMessage,
          res.body,
        );
        return;
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(context.tr('Request cancelled.', 'Nakansela na ang kahilingan.')),
          ));
        }
        await _loadCashAdvanceRequests();
      } else {
        final detail = body?['detail']?.toString() ?? body?['error']?.toString();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(detail ??
                context.tr('Failed to cancel request.', 'Hindi nakansela ang kahilingan.')),
          ));
        }
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(context.tr('Failed to cancel request.', 'Hindi nakansela ang kahilingan.')),
        ));
      }
    } finally {
      if (mounted) setState(() => _caCancelRequestId = null);
    }
  }


  Future<void> _pickAndUploadPhoto() async {
    if (_isPhotoUploading || _token.isEmpty) return;

    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt_rounded),
              title: Text(context.tr('Take a selfie', 'Mag-selfie gamit ang camera')),
              onTap: () => Navigator.of(sheetContext).pop(ImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_rounded),
              title: Text(context.tr('Choose from gallery', 'Pumili mula sa gallery')),
              onTap: () => Navigator.of(sheetContext).pop(ImageSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (source == null || !mounted) return;

    // The camera / photo picker is a separate system activity: it triggers a
    // pause/resume cycle. Keep the app lock from firing behind it. The flag
    // is always reset (try/finally) so a picker error cannot leave the app
    // permanently unlocked.
    if (mounted) setState(() => _isPickingPhoto = true);
    XFile? picked;
    try {
      picked = await _imagePicker.pickImage(
        source: source,
        maxWidth: 1200,
        maxHeight: 1200,
        imageQuality: 85,
      );
    } finally {
      if (mounted) setState(() => _isPickingPhoto = false);
    }
    if (picked == null || !mounted) return;
    final pickedFile = picked;

    final croppedPath = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => FacePhotoCropScreen(imagePath: pickedFile.path),
      ),
    );
    if (croppedPath == null || !mounted) return;

    setState(() => _isPhotoUploading = true);
    try {
      final res = await ApiClient.sendMultipart(
        '/employee/photo',
        headers: {'Authorization': 'Bearer $_token'},
        fields: const {},
        filePaths: {'photo': croppedPath},
        timeout: const Duration(seconds: 30),
      );

      if (!mounted) return;
      if (ApiClient.isAuthExpiredStatus(res.statusCode)) {
        _expireSession(ApiClient.authMessage, res.body);
        return;
      }

      final data = ApiClient.jsonObject(res.body);
      if (res.statusCode == 200) {
        final photoUrl = data?['photo_url']?.toString() ?? '';
        setState(() {
          _photoUrl = photoUrl;
          _statusMsg = '';
        });
        unawaited(_saveSession());
        _showProfileSnack(
          'Profile photo updated.',
          error: false,
        );
      } else {
        _showProfileSnack(
          ApiClient.messageFromBody(res.body, fallback: 'Unable to upload photo.'),
          error: true,
        );
      }
    } catch (error) {
      if (mounted) {
        _showProfileSnack(
          ApiClient.friendlyNetworkError(error),
          error: true,
        );
      }
    } finally {
      if (mounted) setState(() => _isPhotoUploading = false);
    }
  }

  void _showProfileSnack(String message, {required bool error}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          backgroundColor: error ? const Color(0xFFB3261E) : const Color(0xFF147A3A),
          behavior: SnackBarBehavior.floating,
        ),
      );
  }

  void _expireSession(
      [String message = ApiClient.authMessage, String responseBody = '']) {
    _dashboardClockTimer?.cancel();
    if (!mounted) return;
    // Kapag ang server ay nag-revoke ng session dahil nag-sign in ang
    // employee sa ibang device, ipakita ang eksaktong dahilan imbes na
    // ang generic na 'session expired' na mensahe.
    if (responseBody.toLowerCase().contains('another device')) {
      message = context.tr(
        'You signed in on another device. Please sign in again.',
        'Nag-sign in ka sa ibang device. Mangyaring mag-sign in muli.',
      );
    }
    setState(() {
      _isSignedIn = false;
      _token = '';
      _name = '';
      _employeeId = '';
      _email = '';
      _phone = '';
      _governmentId = '';
      _sssNumber = '';
      _philhealthNumber = '';
      _pagibigNumber = '';
      _tinNumber = '';
      _status = '';
      _photoUrl = '';
      _groupedLogs = const [];
      _dailyFinancials = const {};
      _lastDashboardRefreshAt = DateTime.now();
      _selectedSection = EmployeeSection.dashboard;
      _statusMsg = message;
      _logsMsg = '';
      _pendingSession = null;
      _hasSavedSession = false;
    });
    unawaited(PushNotificationService.clearEmployee());
    unawaited(SessionStore.clear());
  }

  Future<void> _login() async {
    if (!(_loginFormKey.currentState?.validate() ?? false)) {
      return;
    }

    final identifier = _emailCtrl.text.trim();
    final password = _passwordCtrl.text;
    final appLock = context.read<AppLockService>();

    setState(() {
      _isLoading = true;
      _statusMsg = '';
    });

    try {
      final deviceId = await DeviceIdentity.getId();
      final res = await ApiClient.postForm(
        '/employee/login',
        body: {
          'email': identifier,
          'password': password,
          if (deviceId.isNotEmpty) 'device_id': deviceId,
        },
      );
      final body = json.decode(res.body);

      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        _applySession(EmployeeSession(
          token: body['token']?.toString() ?? '',
          name: body['name']?.toString() ?? '',
          employeeId: body['employee_id']?.toString() ?? '',
          email: body['email']?.toString() ?? '',
          phone: body['phone']?.toString() ?? '',
          governmentId: body['government_id']?.toString() ?? '',
          sssNumber: body['sss_number']?.toString() ?? '',
          philhealthNumber: body['philhealth_number']?.toString() ?? '',
          pagibigNumber: body['pagibig_number']?.toString() ?? '',
          tinNumber: body['tin_number']?.toString() ?? '',
          status: body['status']?.toString() ?? '',
          photoUrl: body['photo_url']?.toString() ?? '',
        ));
        appLock.markUnlocked();
        unawaited(_saveSession());
        unawaited(_registerPushNotifications());
        await _loadLogs();
        _startDashboardRefreshTimer();
        await _syncOfflineQueue(silent: true);
        return;
      }

      setState(() {
        _statusMsg = body is Map<String, dynamic>
            ? serverMessageFromBody(res.body, fallback: 'Login failed.')
            : 'Login failed.';
      });
    } catch (error) {
      setState(() => _statusMsg = ApiClient.friendlyNetworkError(error));
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _registerPushNotifications() async {
    await PushNotificationService.registerForEmployee(_token);
    _loadNotifications();
  }

  Future<void> _loadLogs() async {
    if (_token.isEmpty) return;

    setState(() {
      _isLogsLoading = true;
      _logsMsg = '';
    });

    try {
      final res = await ApiClient.get(
        '/employee/logs',
        headers: {'Authorization': 'Bearer $_token'},
      );
      final body = json.decode(res.body);

      if (ApiClient.isAuthExpiredStatus(res.statusCode)) {
        final detail = body is Map<String, dynamic>
            ? body['detail']?.toString().toLowerCase() ?? ''
            : '';
        _expireSession(
          detail.contains('archiv')
              ? 'Your account was archived by the administrator.'
              : ApiClient.authMessage,
          res.body,
        );
        return;
      }

      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        setState(() {
          _groupedLogs = (body['grouped'] as List?) ?? const [];
          _dailyFinancials = body['daily'] is Map
              ? Map<String, dynamic>.from(body['daily'] as Map)
              : const {};
          _logsMsg = '';
          _lastDashboardRefreshAt = DateTime.now();
          final emp = body['employee'];
          if (emp is Map<String, dynamic>) {
            _name = emp['name']?.toString() ?? _name;
            _employeeId = emp['employee_id']?.toString() ?? _employeeId;
            _email = emp['email']?.toString() ?? _email;
            _phone = emp['phone']?.toString() ?? _phone;
            _governmentId = emp['government_id']?.toString() ?? _governmentId;
            _sssNumber = emp['sss_number']?.toString() ?? _sssNumber;
            _philhealthNumber = emp['philhealth_number']?.toString() ?? _philhealthNumber;
            _pagibigNumber = emp['pagibig_number']?.toString() ?? _pagibigNumber;
            _tinNumber = emp['tin_number']?.toString() ?? _tinNumber;
            _status = emp['status']?.toString() ?? _status;
            _photoUrl = emp['photo_url']?.toString() ?? _photoUrl;
          }
        });
        return;
      }

      setState(() {
        _logsMsg = body is Map<String, dynamic>
            ? body['detail']?.toString() ?? 'Unable to load logs.'
            : 'Unable to load logs.';
      });
    } catch (error) {
      setState(() => _logsMsg = ApiClient.friendlyNetworkError(error));
    } finally {
      if (mounted) setState(() => _isLogsLoading = false);
    }
    unawaited(_loadCashAdvanceRequests());
  }

  Future<void> _showForgotPasswordForm() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => _ForgotPasswordPage(
          initialEmail: _emailCtrl.text.trim(),
        ),
      ),
    );
  }

  Future<void> _logout() async {
    final shouldLogout = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) {
        return AlertDialog(
          icon: const Icon(
            Icons.logout_rounded,
            color: Color(0xFFB31D18),
            size: 34,
          ),
          title: Text(context.tr('Confirm Logout', 'Kumpirmahin ang Logout')),
          content: Text(
            context.tr(
              'Are you sure you want to log out?',
              'Sigurado ka bang gusto mong mag-logout?',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: Text(context.tr('Cancel', 'Kanselahin')),
            ),
            ElevatedButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFFB31D18),
                foregroundColor: Colors.white,
              ),
              child: Text(context.tr('Logout', 'Mag-logout')),
            ),
          ],
        );
      },
    );

    if (shouldLogout != true || !mounted) return;

    // Preserve the saved session so "Login with Fingerprint" stays available
    // on the login screen after logging out.  The stored token stays valid and
    // is only cleared when it actually expires or the account is archived.
    // Build from the current state (not _pendingSession) so any refreshed or
    // edited profile data is kept, never a stale copy.
    final savedSession = EmployeeSession(
      token: _token,
      name: _name,
      employeeId: _employeeId,
      email: _email,
      phone: _phone,
      governmentId: _governmentId,
      sssNumber: _sssNumber,
      philhealthNumber: _philhealthNumber,
      pagibigNumber: _pagibigNumber,
      tinNumber: _tinNumber,
      status: _status,
      photoUrl: _photoUrl,
    );

    setState(() {
      _isSignedIn = false;
      _selectedSection = EmployeeSection.dashboard;
      _token = '';
      _name = '';
      _employeeId = '';
      _email = '';
      _phone = '';
      _governmentId = '';
      _sssNumber = '';
      _philhealthNumber = '';
      _pagibigNumber = '';
      _tinNumber = '';
      _status = '';
      _groupedLogs = const [];
      _dailyFinancials = const {};
      _logsMsg = '';
      _statusMsg = '';
      _pendingSession = savedSession;
      _hasSavedSession = true;
      _emailCtrl.clear();
      _passwordCtrl.clear();
    });
    _dashboardClockTimer?.cancel();
    context.read<AppLockService>().markUnlocked();
    unawaited(PushNotificationService.clearEmployee());
    await SessionStore.save(savedSession);
  }

  void _changeCalendarMonth(int offset) {
    setState(() {
      _calendarMonth = DateTime(
        _calendarMonth.year,
        _calendarMonth.month + offset,
        1,
      );
      if (_selectedCalendarDate.year != _calendarMonth.year ||
          _selectedCalendarDate.month != _calendarMonth.month) {
        _selectedCalendarDate = DateTime(
          _calendarMonth.year,
          _calendarMonth.month,
          1,
        );
      }
    });
  }

  bool _isSameDay(DateTime a, DateTime b) {
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }

  String _monthLabel(DateTime date) {
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    return '${months[date.month - 1]} ${date.year}';
  }

  Set<String> _attendanceDaysForMonth(DateTime month) {
    return _sortedGroupedLogs()
        .where((row) {
          final day = _dateFromWorkDate(row['work_date']);
          return _isPresentDay(row) &&
              day.year == month.year &&
              day.month == month.month;
        })
        .map((row) {
          final day = _dateFromWorkDate(row['work_date']);
          return '${day.year}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}';
        })
        .toSet();
  }

  List<DateTime?> _calendarDays(DateTime month) {
    final firstDay = DateTime(month.year, month.month, 1);
    final daysInMonth = DateTime(month.year, month.month + 1, 0).day;
    final leading = (firstDay.weekday + 6) % 7;
    final days = <DateTime?>[
      for (var i = 0; i < leading; i++) null,
      for (var day = 1; day <= daysInMonth; day++)
        DateTime(month.year, month.month, day),
    ];
    while (days.length % 7 != 0) {
      days.add(null);
    }
    return days;
  }

  List<Map<String, dynamic>> _selectedCalendarLogs() {
    final selected = _selectedCalendarDate;
    return _sortedGroupedLogs()
        .where((row) {
          final workDate = _dateFromWorkDate(row['work_date']);
          return workDate.year == selected.year &&
              workDate.month == selected.month &&
              workDate.day == selected.day;
        })
        .toList();
  }

  Widget _employeeDrawer(BuildContext context) {
    return Drawer(
      backgroundColor: BrandColors.bg,
      child: SafeArea(
        child: Column(
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(18, 20, 18, 18),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    const Color(0xFF0F172A),
                    BrandColors.cyan.withValues(alpha: 0.95),
                  ],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                border: const Border(
                  bottom: BorderSide(color: BrandColors.border),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const BrandLogo(
                    size: 50,
                    radius: 16,
                    withFrame: false,
                    padding: EdgeInsets.zero,
                  ),
                  const SizedBox(height: 14),
                  Text(
                    _name.isNotEmpty ? _name : 'Employee',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 18,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    _employeeId.isNotEmpty ? _employeeId : 'Attendance',
                    style: const TextStyle(
                      color: Colors.white70,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Navigation',
                    style: TextStyle(
                      color: Colors.white70,
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.4,
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(12, 14, 12, 12),
                children: [
                  ListTile(
                    selected: _selectedSection == EmployeeSection.dashboard,
                    selectedTileColor: const Color(0xFFE9F7FB),
                    leading: const Icon(Icons.dashboard_rounded, color: BrandColors.cyan),
                    title: Text(
                      context.tr('Dashboard', 'Dashboard'),
                      style: const TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    subtitle: Text(context.tr('Main actions', 'Mga pangunahing aksyon'), style: const TextStyle(color: BrandColors.textMuted, fontSize: 12)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    onTap: () {
                      HapticFeedback.selectionClick();
                      setState(() => _selectedSection = EmployeeSection.dashboard);
                      Navigator.of(context).pop();
                    },
                  ),
                  ListTile(
                    selected: _selectedSection == EmployeeSection.attendanceLogs,
                    selectedTileColor: const Color(0xFFE9F7FB),
                    leading: const Icon(Icons.badge_rounded, color: BrandColors.cyan),
                    title: Text(
                      context.tr('Attendance', 'Attendance'),
                      style: const TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    subtitle: Text(context.tr('Open logs', 'Buksan ang mga logs'), style: const TextStyle(color: BrandColors.textMuted, fontSize: 12)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    onTap: () {
                      HapticFeedback.selectionClick();
                      setState(() => _selectedSection = EmployeeSection.attendanceLogs);
                      Navigator.of(context).pop();
                    },
                  ),
                  ListTile(
                    selected: _selectedSection == EmployeeSection.payroll,
                    selectedTileColor: const Color(0xFFE9F7FB),
                    leading: const Icon(Icons.payments_rounded, color: BrandColors.cyan),
                    title: Text(
                      context.tr('Payroll', 'Payroll'),
                      style: const TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    subtitle: Text(context.tr('Pay and balance', 'Sahod at balanse'), style: const TextStyle(color: BrandColors.textMuted, fontSize: 12)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    onTap: () {
                      HapticFeedback.selectionClick();
                      _openPayrollSection();
                      Navigator.of(context).pop();
                    },
                  ),
                  ListTile(
                    selected: _selectedSection == EmployeeSection.profile,
                    selectedTileColor: const Color(0xFFE9F7FB),
                    leading: const Icon(Icons.person_rounded, color: BrandColors.cyan),
                    title: Text(
                      context.tr('Profile', 'Profile'),
                      style: const TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    subtitle: Text(context.tr('Account details', 'Detalye ng account'), style: const TextStyle(color: BrandColors.textMuted, fontSize: 12)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    onTap: () {
                      HapticFeedback.selectionClick();
                      setState(() => _selectedSection = EmployeeSection.profile);
                      Navigator.of(context).pop();
                    },
                  ),
                  const SizedBox(height: 10),
                  const Divider(height: 1, color: BrandColors.border),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              child: Consumer<AppLocale>(
                builder: (context, locale, _) {
                  return ListTile(
                    dense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                    leading: Icon(
                      locale.isFilipino
                          ? Icons.language_rounded
                          : Icons.translate_rounded,
                      color: BrandColors.cyan,
                    ),
                    title: Text(
                      locale.isFilipino ? 'Wika (Language)' : 'Language',
                      style: const TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w700,
                        fontSize: 13,
                      ),
                    ),
                    subtitle: Text(
                      locale.languageLabel,
                      style: const TextStyle(
                        color: BrandColors.textMuted,
                        fontSize: 11,
                      ),
                    ),
                    trailing: const Icon(
                      Icons.swap_horiz_rounded,
                      color: BrandColors.textMuted,
                      size: 20,
                    ),
                    onTap: locale.toggle,
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 14),
              child: SizedBox(
                width: double.infinity,
                height: 50,
                child: OutlinedButton(
                  onPressed: _logout,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: BrandColors.text,
                    side: const BorderSide(color: BrandColors.border),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  ),
                  child: Text(context.tr('Logout', 'Mag-logout')),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  DateTime? _parseFlexibleDateTime(dynamic value) {
    if (value is DateTime) return value;
    final raw = value?.toString().trim() ?? '';
    if (raw.isEmpty) return null;
    final normalized = raw.contains('T')
        ? raw
        : raw.contains(' ')
            ? raw.replaceFirst(' ', 'T')
            : '${raw}T00:00:00';
    return DateTime.tryParse(normalized) ?? DateTime.tryParse(raw);
  }

  String _fmtDate(dynamic value) {
    final dt = _parseFlexibleDateTime(value);
    if (dt == null) return value?.toString() ?? '-';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${months[dt.month - 1]} ${dt.day}, ${dt.year}';
  }


  DateTime _dateFromWorkDate(dynamic value) {
    final dt = _parseFlexibleDateTime(value);
    return dt ?? DateTime.fromMillisecondsSinceEpoch(0);
  }

  List<Map<String, dynamic>> _sortedGroupedLogs() {
    final list = _groupedLogs
        .map((entry) => Map<String, dynamic>.from(entry as Map))
        .toList();
    list.sort((a, b) => _dateFromWorkDate(b['work_date']).compareTo(_dateFromWorkDate(a['work_date'])));
    return list;
  }

  String _fmtMoney(dynamic value) {
    final amount = double.tryParse(value?.toString() ?? '') ?? 0;
    return 'PHP ${amount.toStringAsFixed(2)}';
  }

  String _fmtPeso(double value) {
    final negative = value < 0;
    final abs = value.abs();
    final parts = abs.toStringAsFixed(2).split('.');
    final intPart = parts[0].replaceAllMapped(
      RegExp(r'(\d)(?=(\d{3})+$)'),
      (m) => '${m[1]},',
    );
    return '${negative ? '-' : ''}\u20B1$intPart.${parts[1]}';
  }

  bool _isPresentDay(Map<String, dynamic> row) {
    return row['time_in'] != null;
  }

  Iterable<Map<String, dynamic>> _dashboardFilteredRows(String filter) {
    final now = DateTime.now();
    Iterable<Map<String, dynamic>> rows = _sortedGroupedLogs();
    switch (filter) {
      case '7d':
        final since = now.subtract(const Duration(days: 7));
        rows = rows.where((row) {
          final timeIn = _dateFromWorkDate(row['time_in']?.toString() ?? row['work_date']?.toString() ?? '');
          return _isPresentDay(row) && !timeIn.isBefore(DateTime(since.year, since.month, since.day));
        });
        break;
      case 'all':
        rows = rows.where(_isPresentDay);
        break;
      case 'month':
      default:
        rows = rows.where((row) {
          final timeIn = _dateFromWorkDate(row['time_in']?.toString() ?? row['work_date']?.toString() ?? '');
          return _isPresentDay(row) && timeIn.year == now.year && timeIn.month == now.month;
        });
        break;
    }
    return rows;
  }

  int _dashboardPresentDaysCount(String filter) {
    final days = <String>{};
    for (final row in _dashboardFilteredRows(filter)) {
      final day = _dateFromWorkDate(row['work_date']);
      days.add('${day.year}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}');
    }
    return days.length;
  }

  int _dashboardRecordCount(String filter) {
    return _dashboardFilteredRows(filter).length;
  }

  String _dashboardHoursWorked(String filter) {
    var totalSeconds = 0;
    for (final row in _dashboardFilteredRows(filter)) {
      final duration = row['duration']?.toString();
      if (duration == null || duration.isEmpty) continue;
      final parts = duration.split(':');
      if (parts.length != 3) continue;
      final hours = int.tryParse(parts[0]) ?? 0;
      final minutes = int.tryParse(parts[1]) ?? 0;
      final seconds = int.tryParse(parts[2]) ?? 0;
      totalSeconds += hours * 3600 + minutes * 60 + seconds;
    }
    if (totalSeconds <= 0) return context.tr('0h', '0 oras');
    final h = totalSeconds ~/ 3600;
    final m = (totalSeconds % 3600) ~/ 60;
    if (h == 0) return '${m}m';
    return m == 0 ? '${h}h' : '${h}h ${m}m';
  }

  String _dashboardClockLabel(DateTime now) {
    final hour12 = now.hour % 12 == 0 ? 12 : now.hour % 12;
    final minute = now.minute.toString().padLeft(2, '0');
    final suffix = now.hour < 12 ? 'AM' : 'PM';
    return '$hour12:$minute $suffix';
  }

  String _dashboardDateLabel(DateTime now) {
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return '${weekdays[now.weekday - 1]}, ${months[now.month - 1]} ${now.day}, ${now.year}';
  }

  Map<String, dynamic>? _todayLog() {
    final today = DateTime.now();
    for (final row in _sortedGroupedLogs()) {
      final workDate = _dateFromWorkDate(row['work_date']);
      if (_isSameDay(workDate, today)) return row;
    }
    return null;
  }

  bool _hasTimedOutToday(Map<String, dynamic>? todayLog) {
    return todayLog != null && todayLog['time_out'] != null;
  }

  String _todayStatusTitle(Map<String, dynamic>? todayLog) {
    if (todayLog == null) {
      return context.tr('Ready to time in', 'Handa nang mag-time in');
    }
    if (_hasTimedOutToday(todayLog)) {
      return context.tr('Shift completed for today', 'Tapos na ang shift mo ngayong araw');
    }
    return context.tr('You are on shift', 'Naka-shift ka na');
  }

  String _todayStatusCaption(Map<String, dynamic>? todayLog) {
    if (todayLog == null) {
      if (_hasBiometrics) {
        return context.tr(
          'Confirm your fingerprint, then time in for today. If the scan fails, you can still continue without it.',
          'Kumpirmahin ang iyong fingerprint, pagkatapos ay mag-time in para ngayong araw. Kung pumalpak ang scan, maaari ka pa ring magpatuloy nang wala ito.',
        );
      }
      return context.tr(
        'Time in once for today to record your attendance.',
        'Mag-time in nang isang beses para ngayong araw upang maitala ang iyong attendance.',
      );
    }
    if (_hasTimedOutToday(todayLog)) {
      return context.tr(
        'Your time in and time out are recorded for today.',
        'Naitala na ang iyong time in at time out ngayong araw.',
      );
    }
    return context.tr(
      'You have timed in. Remember to time out when your shift ends.',
      'Naka-time in ka na. Huwag kalimutang mag-time out kapag tapos na ang shift mo.',
    );
  }

  Color _todayStatusColor(Map<String, dynamic>? todayLog) {
    if (todayLog == null) return BrandColors.cyan;
    if (_hasTimedOutToday(todayLog)) return const Color(0xFF147A3A);
    return const Color(0xFFC46A18);
  }

  String _todayActionLabel(Map<String, dynamic>? todayLog) {
    if (_isVerifyingBiometrics) {
      return context.tr(
        'Confirming fingerprint...',
        'Kinukumpirma ang fingerprint...',
      );
    }
    if (_isMarkingPresent || _isMarkingTimeout) {
      return context.tr('Saving...', 'Sine-save...');
    }
    if (todayLog == null) {
      return context.tr('Time In', 'Mag-time In');
    }
    if (_hasTimedOutToday(todayLog)) {
      return context.tr('Completed', 'Tapos Na');
    }
    return context.tr('Time Out', 'Mag-time Out');
  }

  VoidCallback? _todayAction(Map<String, dynamic>? todayLog) {
    if (_isMarkingPresent || _isMarkingTimeout || _isVerifyingBiometrics) return null;
    if (todayLog == null) return _markPresent;
    if (_hasTimedOutToday(todayLog)) return null;
    return _markTimeout;
  }

  Future<void> _markPresent() async {
    if (_token.isEmpty || _isMarkingPresent || _isVerifyingBiometrics || _todayLog() != null) {
      return;
    }
    final confirmed = await _confirmBiometricsForAttendance();
    if (!confirmed || !mounted) return;

    setState(() => _isMarkingPresent = true);
    try {
      final response = await ApiClient.postJson(
        '/present',
        headers: {'Authorization': 'Bearer $_token'},
        body: const <String, dynamic>{},
      );
      if (!mounted) return;
      if (ApiClient.isAuthExpiredStatus(response.statusCode)) {
        _expireSession(ApiClient.authMessage, response.body);
        return;
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        await _loadLogs();
        _showProfileSnack('Time in recorded successfully.', error: false);
        return;
      }
      _showProfileSnack(
        friendlyAttendanceError(ApiClient.messageFromBody(
          response.body,
          fallback: 'Unable to mark present.',
        )),
        error: true,
      );
    } catch (error) {
      if (isRetryableNetworkError(error)) {
        await OfflineAttendanceQueue.enqueue(
          type: 'present',
          timestamp: DateTime.now(),
          employeeToken: _token,
        );
        await _refreshQueuedCount();
        if (mounted) {
          _showProfileSnack('Saved offline. It will sync when connected.', error: false);
        }
      } else if (mounted) {
        _showProfileSnack(ApiClient.friendlyNetworkError(error), error: true);
      }
    } finally {
      if (mounted) setState(() => _isMarkingPresent = false);
    }
  }

  Future<void> _markTimeout() async {
    final todayLog = _todayLog();
    if (_token.isEmpty ||
        _isMarkingTimeout ||
        _isVerifyingBiometrics ||
        todayLog == null ||
        todayLog['time_out'] != null) {
      return;
    }
    // Anti-cheat pre-check: time-out must be at least MIN_WORK_MINUTES after
    // time-in. The server enforces the same rule (MIN_WORK_MINUTES in .env);
    // this gives instant feedback without a round trip. A negative value
    // (phone clock slightly behind the server) is left to the server, which
    // is the authoritative gate for the minimum-work rule.
    final timeIn = _parseFlexibleDateTime(todayLog['time_in']);
    if (timeIn != null) {
      const minWorkMinutes = 30;
      final workedMinutes = DateTime.now().difference(timeIn).inMinutes;
      if (workedMinutes >= 0 && workedMinutes < minWorkMinutes) {
        _showProfileSnack(
          'You need to work at least $minWorkMinutes minutes before timing out.',
          error: true,
        );
        return;
      }
    }
    final confirmed = await _confirmBiometricsForAttendance();
    if (!confirmed || !mounted) return;

    setState(() => _isMarkingTimeout = true);
    try {
      final response = await ApiClient.postJson(
        '/timeout',
        headers: {'Authorization': 'Bearer $_token'},
        body: const <String, dynamic>{},
      );
      if (!mounted) return;
      if (ApiClient.isAuthExpiredStatus(response.statusCode)) {
        _expireSession(ApiClient.authMessage, response.body);
        return;
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        await _loadLogs();
        _showProfileSnack('Time out recorded successfully.', error: false);
        return;
      }
      _showProfileSnack(
        friendlyAttendanceError(ApiClient.messageFromBody(
          response.body,
          fallback: 'Unable to time out.',
        )),
        error: true,
      );
    } catch (error) {
      if (isRetryableNetworkError(error)) {
        await OfflineAttendanceQueue.enqueue(
          type: 'time_out',
          timestamp: DateTime.now(),
          employeeToken: _token,
        );
        await _refreshQueuedCount();
        if (mounted) {
          _showProfileSnack('Saved offline. It will sync when connected.', error: false);
        }
      } else if (mounted) {
        _showProfileSnack(ApiClient.friendlyNetworkError(error), error: true);
      }
    } finally {
      if (mounted) setState(() => _isMarkingTimeout = false);
    }
  }

  Future<bool> _confirmBiometricsForAttendance() async {
    // Require fingerprint confirmation before recording attendance whenever
    // the device has a fingerprint enrolled. Devices without a fingerprint
    // still proceed (fallback) so employees are never locked out. When a
    // scan fails or is cancelled, the employee may choose to continue
    // anyway so they are never blocked from recording attendance.
    if (!_hasBiometrics) return true;
    var verified = false;
    var allowWithoutFingerprint = false;
    while (!verified && !allowWithoutFingerprint) {
      setState(() {
        _isVerifyingBiometrics = true;
        _isAttendancePromptOpen = true;
      });
      try {
        verified = await _localAuth.authenticate(
          localizedReason:
              'Confirm your fingerprint to record your attendance.',
          options: const AuthenticationOptions(
            biometricOnly: true,
            // Do not reuse a prior unlock: every attendance mark needs a
            // fresh fingerprint confirmation.
            stickyAuth: false,
          ),
        );
      } catch (_) {
        verified = false;
      }
      if (!mounted) return false;
      setState(() {
        _isVerifyingBiometrics = false;
        _isAttendancePromptOpen = false;
      });
      if (verified) break;

      // Scan failed or was cancelled — offer alternatives instead of
      // blocking the employee from recording attendance.
      const cancelChoice = 0;
      const tryAgainChoice = 1;
      const markAnywayChoice = 2;
      final choice = await showDialog<int>(
        context: context,
        barrierDismissible: false,
        builder: (dialogContext) {
          return AlertDialog(
            icon: const Icon(
              Icons.fingerprint_rounded,
              color: Color(0xFFB31D18),
              size: 34,
            ),
            title: Text(
              context.tr(
                'Fingerprint not verified',
                'Hindi nakumpirma ang fingerprint',
              ),
            ),
            content: Text(
              context.tr(
                'You can try the fingerprint again, or continue without it.',
                'Maaari mong subukan muli ang fingerprint, o magpatuloy nang wala ito.',
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(cancelChoice),
                child: Text(context.tr('Cancel', 'Kanselahin')),
              ),
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(tryAgainChoice),
                child: Text(context.tr('Try Again', 'Subukan Muli')),
              ),
              ElevatedButton(
                onPressed: () => Navigator.of(dialogContext).pop(markAnywayChoice),
                style: ElevatedButton.styleFrom(
                  backgroundColor: BrandColors.cyan,
                  foregroundColor: Colors.white,
                ),
                child: Text(
                  context.tr('Continue Anyway', 'Magpatuloy Pa Rin'),
                ),
              ),
            ],
          );
        },
      );
      if (!mounted) return false;
      if (choice == tryAgainChoice) {
        continue; // Try Again — loop back to the fingerprint prompt
      }
      if (choice == markAnywayChoice) {
        allowWithoutFingerprint = true; // Continue Anyway
        break;
      }
      return false; // Cancelled — do not record attendance
    }
    return true;
  }

  String _dashboardUpdatedLabel() {
    final elapsed = DateTime.now().difference(_lastDashboardRefreshAt);
    if (elapsed.inSeconds < 45) return context.tr('Updated just now', 'Kakasilang na-update');
    if (elapsed.inMinutes < 60) {
      return context.tr('Updated ${elapsed.inMinutes}m ago', 'Na-update ${elapsed.inMinutes}m ang nakalipas');
    }
    return context.tr('Updated ${elapsed.inHours}h ago', 'Na-update ${elapsed.inHours}h ang nakalipas');
  }

  double _toMoneyValue(dynamic value) {
    return double.tryParse(value?.toString() ?? '') ?? 0;
  }

  Widget _filterChip(String value, String label) {
    final selected = _dashboardStatFilter == value;
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) {
        setState(() => _dashboardStatFilter = value);
      },
      labelStyle: TextStyle(
        color: selected ? Colors.white : BrandColors.textMuted,
        fontWeight: FontWeight.w700,
        fontSize: 11,
      ),
      selectedColor: BrandColors.cyan,
      backgroundColor: const Color(0xFFF8FAFC),
      side: BorderSide(color: selected ? BrandColors.cyan : BrandColors.border),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
      visualDensity: VisualDensity.compact,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      labelPadding: const EdgeInsets.symmetric(horizontal: 8),
    );
  }

  Widget _monthNavButton({
    required IconData icon,
    required VoidCallback onPressed,
  }) {
    return Material(
      color: const Color(0xFFF8FAFC),
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          width: 44,
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: BrandColors.border),
          ),
          child: Icon(
            icon,
            color: BrandColors.textMuted,
            size: 22,
          ),
        ),
      ),
    );
  }

  int _attendanceCountForDay(DateTime day) {
    return _sortedGroupedLogs().where((row) {
      final workDate = _dateFromWorkDate(row['work_date']);
      return _isPresentDay(row) && _isSameDay(workDate, day);
    }).length;
  }

  Widget _sectionHeader(String title, IconData icon) {
    return Row(
      children: [
        Icon(icon, color: BrandColors.cyan, size: 20),
        const SizedBox(width: 8),
        Text(
          title,
          style: const TextStyle(
            color: BrandColors.text,
            fontSize: 15,
            fontWeight: FontWeight.w900,
          ),
        ),
      ],
    );
  }

  Widget _miniStat(String label, String value, IconData icon, Color accent) {
    return Container(
      constraints: const BoxConstraints(minHeight: 92),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: accent.withValues(alpha: 0.16)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: accent, size: 21),
          const SizedBox(height: 10),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: accent,
              fontSize: 16,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: BrandColors.textMuted,
              fontSize: 11,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }

  Widget _compactAttendanceRow(Map<String, dynamic> row) {
    final present = row['time_in'] != null;
    final label = present ? 'Present' : 'Pending';
    final color = present ? const Color(0xFF147A3A) : const Color(0xFFC46A18);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: BrandColors.border),
      ),
      child: Row(
        children: [
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _fmtDate(row['work_date']),
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 13,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ],
            ),
          ),
          _pill(
            label.toUpperCase(),
            present ? const Color(0xFFEAF8EF) : const Color(0xFFFFF4E8),
            color,
          ),
        ],
      ),
    );
  }


  Widget _timeChip({
    required IconData icon,
    required String label,
    required String value,
  }) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: BrandColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 12, color: BrandColors.cyan),
                const SizedBox(width: 4),
                Text(
                  label,
                  style: const TextStyle(
                    color: BrandColors.textMuted,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 3),
            Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: BrandColors.text,
                fontSize: 12,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _timeOfDay(dynamic value) {
    if (value == null || value.toString().isEmpty) return '-';
    final dt = _parseFlexibleDateTime(value);
    if (dt == null) return '-';
    final hour12 = dt.hour % 12 == 0 ? 12 : dt.hour % 12;
    final minute = dt.minute.toString().padLeft(2, '0');
    final suffix = dt.hour < 12 ? 'AM' : 'PM';
    return '$hour12:$minute $suffix';
  }

  String _formatDurationShort(String hms) {
    final parts = hms.split(':');
    if (parts.length != 3) return hms;
    final hours = int.tryParse(parts[0]) ?? 0;
    final minutes = int.tryParse(parts[1]) ?? 0;
    if (hours == 0) return '${minutes}m';
    return minutes == 0 ? '${hours}h' : '${hours}h ${minutes}m';
  }

  @override
  Widget build(BuildContext context) {
    if (_isSignedIn) {
      return Consumer<AppLocale>(
        builder: (context, locale, _) {
          return PopScope(
            canPop: false,
            onPopInvokedWithResult: (didPop, _) {
              if (!didPop) {
                _logout();
              }
            },
            child: Scaffold(
              backgroundColor: BrandColors.bg,
              drawer: _needsAppUnlock ? null : _employeeDrawer(context),
              appBar: AppBar(
                backgroundColor: BrandColors.surface,
                elevation: 0,
                toolbarHeight: 72,
                title: const BrandMark(
                  compact: true,
                  titleColor: BrandColors.text,
                  subtitleColor: BrandColors.textMuted,
                ),
                actions: [
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: Stack(
                      clipBehavior: Clip.none,
                      children: [
                        IconButton(
                          tooltip: 'Notifications',
                          onPressed: _openNotifications,
                          icon: const Icon(
                            Icons.notifications_rounded,
                            color: BrandColors.text,
                            size: 26,
                          ),
                        ),
                        if (_notifCount > 0)
                          Positioned(
                            right: 2,
                            top: 6,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 5,
                                vertical: 1,
                              ),
                              constraints: const BoxConstraints(minWidth: 18),
                              decoration: BoxDecoration(
                                color: BrandColors.cyan,
                                borderRadius: BorderRadius.circular(10),
                                border: Border.all(
                                  color: BrandColors.surface,
                                  width: 1.5,
                                ),
                              ),
                              child: Text(
                                _notifCount > 99 ? '99+' : '$_notifCount',
                                textAlign: TextAlign.center,
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 10,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
                bottom: PreferredSize(
                  preferredSize: const Size.fromHeight(1),
                  child: Container(height: 1, color: BrandColors.border),
                ),
              ),
              body: _needsAppUnlock
                  ? _buildAppUnlockGate()
                  : AnimatedSwitcher(
                      duration: const Duration(milliseconds: 260),
                      switchInCurve: Curves.easeOutCubic,
                      switchOutCurve: Curves.easeInCubic,
                      transitionBuilder: (child, animation) {
                        return FadeTransition(
                          opacity: animation,
                          child: SlideTransition(
                            position: Tween<Offset>(
                              begin: const Offset(0.02, 0.03),
                              end: Offset.zero,
                            ).animate(animation),
                            child: child,
                          ),
                        );
                      },
                      child: _selectedSection == EmployeeSection.dashboard
                          ? KeyedSubtree(
                              key: const ValueKey('dashboard'),
                              child: _buildEmployeeDashboard(),
                            )
                          : _selectedSection == EmployeeSection.attendanceLogs
                              ? KeyedSubtree(
                                  key: const ValueKey('attendanceLogs'),
                                  child: _buildEmployeeLogs(),
                                )
                              : _selectedSection == EmployeeSection.payroll
                                      ? KeyedSubtree(
                                          key: const ValueKey('payroll'),
                                          child: _buildPayrollPage(),
                                        )
                                      : KeyedSubtree(
                                          key: const ValueKey('profile'),
                                          child: _buildEmployeeProfile(),
                                        ),
                    ),
            ),
          );
        },
      );
    }

    return Scaffold(
      backgroundColor: BrandColors.bg,
      appBar: AppBar(
        backgroundColor: BrandColors.surface,
        elevation: 0,
        toolbarHeight: 72,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, color: BrandColors.text, size: 20),
          onPressed: () => Navigator.pop(context),
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
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: _card(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const BrandLogo(size: 84, radius: 18, withFrame: false, padding: EdgeInsets.zero),
                  const SizedBox(height: 16),
                  Text(
                    context.tr('Employee Login', 'Pag-login ng Empleyado'),
                    style: const TextStyle(color: BrandColors.text, fontSize: 22, fontWeight: FontWeight.w900),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    context.tr(
                      'Sign in to see only your own attendance logs.',
                      'Mag-login para makita ang sarili mong attendance logs.',
                    ),
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: BrandColors.textMuted, fontSize: 13, height: 1.4),
                  ),
                  const SizedBox(height: 20),
                  Form(
                    key: _loginFormKey,
                    autovalidateMode: AutovalidateMode.onUserInteraction,
                    child: Column(
                      children: [
                        _field(
                          controller: _emailCtrl,
                          label: context.tr('Email or Phone', 'Email o Numero ng Telepono'),
                          icon: Icons.alternate_email_rounded,
                          keyboardType: TextInputType.text,
                          validator: (value) {
                            final text = value?.trim() ?? '';
                            if (text.isEmpty) {
                              return context.tr(
                                'Email or phone is required.',
                                'Kinakailangan ang email o numero ng telepono.',
                              );
                            }
                            final digits = text.replaceAll(RegExp(r'\D'), '');
                            final isEmail = text.contains('@') && text.contains('.');
                            final isPhone = digits.length == 11 ||
                                (digits.length == 12 && digits.startsWith('63'));
                            if (!isEmail && !isPhone) {
                              return context.tr(
                                'Enter a valid email or 11-digit phone number.',
                                'Maglagay ng wastong email o 11-digit na numero ng telepono.',
                              );
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 14),
                        _field(
                          controller: _passwordCtrl,
                          label: context.tr('Password', 'Password'),
                          icon: Icons.lock_rounded,
                          obscureText: _isPasswordHidden,
                          suffixIcon: IconButton(
                            onPressed: _togglePasswordVisibility,
                            icon: Icon(
                              _isPasswordHidden
                                  ? Icons.visibility_rounded
                                  : Icons.visibility_off_rounded,
                              color: BrandColors.textMuted,
                            ),
                            tooltip: _isPasswordHidden
                                ? context.tr('Show password', 'Ipakita ang password')
                                : context.tr('Hide password', 'Itago ang password'),
                          ),
                          validator: (value) {
                            if ((value ?? '').isEmpty) {
                              return context.tr('Password is required.', 'Kinakailangan ang password.');
                            }
                            return null;
                          },
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                  if (_statusMsg.isNotEmpty) ...[
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFFEFEF),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: const Color(0xFFE2B0B0)),
                      ),
                      child: Text(
                        _statusMsg,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Color(0xFF8E1F1F), fontSize: 13, height: 1.35, fontWeight: FontWeight.w600),
                      ),
                    ),
                    const SizedBox(height: 14),
                  ],
                  SizedBox(
                    width: double.infinity,
                    height: 54,
                    child: ElevatedButton(
                      onPressed: _isLoading ? null : _login,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: BrandColors.cyan,
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      ),
                      child: _isLoading
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white),
                            )
                          : Text(
                              context.tr('Sign In', 'Mag-sign In'),
                              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                            ),
                    ),
                  ),
                  if (_hasSavedSession && _hasBiometrics) ...[
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        const Expanded(child: Divider()),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: Text(
                            context.tr('or', 'o'),
                            style: const TextStyle(
                              color: BrandColors.textMuted,
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        const Expanded(child: Divider()),
                      ],
                    ),
                    const SizedBox(height: 14),
                    SizedBox(
                      width: double.infinity,
                      height: 52,
                      child: OutlinedButton.icon(
                        onPressed: _isLoading || _isVerifyingBiometrics
                            ? null
                            : _loginWithBiometrics,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: BrandColors.cyan,
                          side: const BorderSide(color: BrandColors.cyan),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14),
                          ),
                        ),
                        icon: _isVerifyingBiometrics
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: BrandColors.cyan,
                                ),
                              )
                            : const Icon(Icons.fingerprint_rounded),
                        label: Text(
                          _isVerifyingBiometrics
                              ? context.tr(
                                  'Verifying fingerprint...',
                                  'Kinukumpirma ang fingerprint...',
                                )
                              : context.tr(
                                  'Login with Fingerprint',
                                  'Mag-login gamit ang Fingerprint',
                                ),
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 10),
                  TextButton(
                    onPressed: _showForgotPasswordForm,
                    child: Text(
                      context.tr('Forgot Password?', 'Nakalimutan ang Password?'),
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

  Widget _buildAppUnlockGate() {
    return SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                _passwordUnlockMode ? Icons.lock_rounded : Icons.fingerprint_rounded,
                size: 72,
                color: BrandColors.cyan,
              ),
              const SizedBox(height: 16),
              Text(
                context.tr('App Locked', 'Naka-lock ang App'),
                style: const TextStyle(
                  color: BrandColors.text,
                  fontSize: 20,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                _passwordUnlockMode
                    ? context.tr(
                        'Enter your password to unlock the app.',
                        'Ilagay ang iyong password para i-unlock ang app.',
                      )
                    : context.tr(
                        'Use your fingerprint to unlock the app.',
                        'Gamitin ang iyong fingerprint para i-unlock ang app.',
                      ),
                textAlign: TextAlign.center,
                style: const TextStyle(color: BrandColors.textMuted, fontSize: 13),
              ),
              const SizedBox(height: 24),
              if (_passwordUnlockMode) ...[
                TextField(
                  controller: _unlockPasswordCtrl,
                  obscureText: true,
                  autofocus: true,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => _unlockWithPassword(),
                  style: const TextStyle(color: BrandColors.text, fontSize: 15),
                  decoration: InputDecoration(
                    labelText: context.tr('Password', 'Password'),
                    prefixIcon: const Icon(Icons.lock_rounded, color: BrandColors.textMuted),
                    filled: true,
                    fillColor: BrandColors.bg,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: const BorderSide(color: BrandColors.border),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: const BorderSide(color: BrandColors.border),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: const BorderSide(color: BrandColors.cyan, width: 1.6),
                    ),
                  ),
                ),
                const SizedBox(height: 14),
                SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: ElevatedButton.icon(
                    onPressed: _isUnlockingWithPassword ? null : _unlockWithPassword,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: BrandColors.cyan,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14),
                      ),
                    ),
                    icon: _isUnlockingWithPassword
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.lock_open_rounded),
                    label: Text(
                      _isUnlockingWithPassword
                          ? context.tr('Unlocking...', 'Ina-unlock...')
                          : context.tr('Unlock with Password', 'I-unlock gamit ang Password'),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                TextButton(
                  onPressed: () {
                    _unlockPasswordCtrl.clear();
                    setState(() => _passwordUnlockMode = false);
                  },
                  child: Text(context.tr('Use fingerprint instead', 'Gamitin ang fingerprint sa halip')),
                ),
              ] else ...[
                SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: ElevatedButton.icon(
                    onPressed: _isVerifyingBiometrics ? null : _unlockApp,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: BrandColors.cyan,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14),
                      ),
                    ),
                    icon: _isVerifyingBiometrics
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.fingerprint_rounded),
                    label: Text(
                      _isVerifyingBiometrics
                          ? context.tr('Unlocking...', 'Ina-unlock...')
                          : context.tr('Unlock with Fingerprint', 'I-unlock gamit ang Fingerprint'),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                TextButton(
                  onPressed: () {
                    setState(() => _passwordUnlockMode = true);
                    _unlockPasswordCtrl.clear();
                  },
                  child: Text(context.tr('Use password instead', 'Gamitin ang password sa halip')),
                ),
              ],
              TextButton(
                onPressed: _logout,
                child: Text(context.tr('Log out instead', 'Mag-logout na lang')),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildEmployeeDashboard() {
    final todayLog = _todayLog();
    final statusColor = _todayStatusColor(todayLog);
    final recentLogs = _sortedGroupedLogs().take(3).toList();
    final now = DateTime.now();

    return SafeArea(
      child: RefreshIndicator(
        onRefresh: _handleDashboardRefresh,
        color: BrandColors.cyan,
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
            _card(
              child: Row(
                children: [
                  Container(
                    width: 54,
                    height: 54,
                    decoration: BoxDecoration(
                      color: const Color(0xFFE9F7FB),
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: const Icon(Icons.schedule_rounded, color: BrandColors.cyan, size: 28),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _dashboardClockLabel(now),
                          style: const TextStyle(
                            color: BrandColors.text,
                            fontSize: 26,
                            fontWeight: FontWeight.w900,
                            height: 1.0,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          _dashboardDateLabel(now),
                          style: const TextStyle(
                            color: BrandColors.textMuted,
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (_status.isNotEmpty)
                    _pill(_status.toUpperCase(), const Color(0xFFEAF8EF), const Color(0xFF147A3A)),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 54,
                        height: 54,
                        clipBehavior: Clip.antiAlias,
                        decoration: BoxDecoration(
                          color: statusColor.withValues(alpha: 0.13),
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: statusColor.withValues(alpha: 0.35),
                            width: 2,
                          ),
                        ),
                        child: _photoUrl.isNotEmpty
                            ? Image.network(
                                '${AppConstants.baseUrl}$_photoUrl',
                                fit: BoxFit.cover,
                                loadingBuilder: (context, child, progress) {
                                  if (progress == null) return child;
                                  return Center(
                                    child: SizedBox(
                                      width: 18,
                                      height: 18,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: statusColor,
                                      ),
                                    ),
                                  );
                                },
                                errorBuilder: (context, error, stack) {
                                  return Icon(
                                    Icons.person_rounded,
                                    color: statusColor,
                                    size: 30,
                                  );
                                },
                              )
                            : Icon(
                                Icons.person_rounded,
                                color: statusColor,
                                size: 30,
                              ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    _name.isNotEmpty ? _name : 'Employee',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      color: BrandColors.text,
                                      fontSize: 21,
                                      fontWeight: FontWeight.w900,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 3),
                            Text(
                              _employeeId.isNotEmpty ? _employeeId : (_email.isNotEmpty ? _email : 'Approved account'),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: BrandColors.textMuted,
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (_status.isNotEmpty)
                        _pill(_status.toUpperCase(), const Color(0xFFEAF8EF), const Color(0xFF147A3A)),
                    ],
                  ),
                  const SizedBox(height: 18),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: statusColor.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(color: statusColor.withValues(alpha: 0.18)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            Icon(Icons.today_rounded, color: statusColor, size: 24),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    _todayStatusTitle(todayLog),
                                    style: const TextStyle(
                                      color: BrandColors.text,
                                      fontSize: 16,
                                      fontWeight: FontWeight.w900,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    _todayStatusCaption(todayLog),
                                    style: const TextStyle(
                                      color: BrandColors.textMuted,
                                      fontSize: 12,
                                      height: 1.3,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                        if (todayLog != null) ...[  
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              _timeChip(
                                icon: Icons.login_rounded,
                                label: context.tr('In', 'Pasok'),
                                value: _timeOfDay(todayLog['time_in']),
                              ),
                              const SizedBox(width: 8),
                              _timeChip(
                                icon: Icons.logout_rounded,
                                label: context.tr('Out', 'Uwi'),
                                value: _timeOfDay(todayLog['time_out']),
                              ),
                              const SizedBox(width: 8),
                              _timeChip(
                                icon: Icons.timelapse_rounded,
                                label: context.tr('Duration', 'Tagal'),
                                value: (todayLog['duration']?.toString() ?? '').isNotEmpty
                                    ? _formatDurationShort(todayLog['duration'].toString())
                                    : '-',
                              ),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: _todayAction(todayLog),
                          icon: Icon(
                            todayLog == null
                                ? Icons.login_rounded
                                : _hasTimedOutToday(todayLog)
                                    ? Icons.check_circle_rounded
                                    : Icons.logout_rounded,
                            size: 18,
                          ),
                          label: Text(_todayActionLabel(todayLog)),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: statusColor,
                            foregroundColor: Colors.white,
                            minimumSize: const Size.fromHeight(52),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: () => _openPayrollSection(),
                          icon: const Icon(Icons.payments_rounded, size: 18),
                          label: Text(context.tr('Payroll', 'Payroll')),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF364152),
                            foregroundColor: Colors.white,
                            minimumSize: const Size.fromHeight(52),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(child: _sectionHeader(context.tr('Overview', 'Buod'), Icons.dashboard_rounded)),
                      Text(
                        _dashboardUpdatedLabel(),
                        style: const TextStyle(
                          color: BrandColors.textMuted,
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: _miniStat(
                          context.tr('Present', 'Presente'),
                          '${_dashboardPresentDaysCount(_dashboardStatFilter)}',
                          Icons.event_available_rounded,
                          BrandColors.cyan,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _miniStat(
                          context.tr('Records', 'Mga Record'),
                          '${_dashboardRecordCount(_dashboardStatFilter)}',
                          Icons.task_alt_rounded,
                          const Color(0xFF147A3A),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _miniStat(
                          context.tr('Hours', 'Oras'),
                          _dashboardHoursWorked(_dashboardStatFilter),
                          Icons.schedule_rounded,
                          const Color(0xFFC46A18),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _filterChip('month', context.tr('This Month', 'Ngayong Buwan')),
                      _filterChip('7d', context.tr('Last 7 Days', 'Huling 7 Araw')),
                      _filterChip('all', context.tr('All Time', 'Lahat')),
                    ],
                  ),
                ],
              ),
            ),
            if (_queuedCount > 0) ...[
              const SizedBox(height: 14),
              _card(
                child: Row(
                  children: [
                    const Icon(
                      Icons.cloud_queue_rounded,
                      color: Color(0xFFB45309),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        _isSyncingQueue
                            ? context.tr('Syncing offline records...', 'Sini-sync ang offline records...')
                            : _queuedCount == 1
                                ? context.tr('1 offline record waiting to sync.', '1 offline record ang naghihintay i-sync.')
                                : context.tr('$_queuedCount offline records waiting to sync.',
                                    '$_queuedCount offline records ang naghihintay i-sync.'),
                        style: const TextStyle(
                          color: BrandColors.text,
                          fontWeight: FontWeight.w800,
                          fontSize: 13,
                        ),
                      ),
                    ),
                    if (!_isSyncingQueue)
                      TextButton(
                        onPressed: () => _syncOfflineQueue(),
                        child: Text(context.tr('Sync', 'I-sync')),
                      )
                    else
                      const Padding(
                        padding: EdgeInsets.all(12),
                        child: SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 14),
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _sectionHeader(context.tr('Recent Attendance', 'Kamakailang Attendance'), Icons.history_rounded),
                  const SizedBox(height: 10),
                  if (recentLogs.isEmpty)
                    EmptyState(
                      icon: Icons.history_rounded,
                      title: context.tr('No attendance logs yet.', 'Wala pang attendance logs.'),
                      subtitle: context.tr(
                        'Your recent attendance records will show up here.',
                        'Dito lalabas ang iyong mga kamakailang attendance records.',
                      ),
                    )
                  else
                    ...recentLogs.map((row) => _compactAttendanceRow(row)),
                ],
              ),
            ),
          ],
        ),
        ),
      ),
    );
  }

  Widget _calendarCard() {
    final today = DateTime.now();
    final visibleDays = _calendarDays(_calendarMonth);
    final monthAttendanceDays = _attendanceDaysForMonth(_calendarMonth);
    final monthAttendanceCount = monthAttendanceDays.length;
    final selectedLogs = _selectedCalendarLogs();
    final selectedLog = selectedLogs.isNotEmpty ? selectedLogs.first : null;
    final hasRecord = selectedLog != null;
    const weekdays = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

    return _card(
      child: LayoutBuilder(
        builder: (context, constraints) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Container(
                    width: 46,
                    height: 46,
                    decoration: BoxDecoration(
                      color: const Color(0xFFE9F7FB),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Icon(Icons.calendar_month_rounded, color: BrandColors.cyan, size: 24),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          context.tr('Calendar', 'Kalendaryo'),
                          style: const TextStyle(
                            color: BrandColors.text,
                            fontSize: 18,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          context.tr(
                            'Quick date view for your attendance logs.',
                            'Mabilis na pagtingin sa petsa ng iyong mga attendance logs.',
                          ),
                          style: const TextStyle(
                            color: BrandColors.textMuted,
                            fontSize: 12,
                            height: 1.35,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _monthNavButton(
                    icon: Icons.chevron_left_rounded,
                    onPressed: () { HapticFeedback.selectionClick(); _changeCalendarMonth(-1); },
                  ),
                  Expanded(
                    child: Column(
                      children: [
                        Text(
                          _monthLabel(_calendarMonth),
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            color: BrandColors.text,
                            fontSize: 15,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          context.tr('Tap arrows to switch months', 'Pindutin ang mga arrow para lumipat ng buwan'),
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: BrandColors.textMuted.withValues(alpha: 0.85),
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                  _monthNavButton(
                    icon: Icons.chevron_right_rounded,
                    onPressed: () { HapticFeedback.selectionClick(); _changeCalendarMonth(1); },
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  color: const Color(0xFFF8FAFC),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: BrandColors.border),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        color: const Color(0xFFEAF8EF),
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: const Icon(
                        Icons.event_available_rounded,
                        color: Color(0xFF147A3A),
                        size: 22,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            context.tr('Days Present', 'Mga Araw na Presente'),
                            style: const TextStyle(
                              color: BrandColors.textMuted,
                              fontSize: 11,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.6,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            context.tr(
                              '$monthAttendanceCount day${monthAttendanceCount == 1 ? '' : 's'}',
                              monthAttendanceCount == 1
                                  ? '$monthAttendanceCount araw'
                                  : '$monthAttendanceCount araw',
                            ),
                            style: const TextStyle(
                              color: BrandColors.text,
                              fontSize: 20,
                              fontWeight: FontWeight.w900,
                              height: 1.0,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEAF8EF),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: const Color(0xFF34A853).withValues(alpha: 0.22)),
                      ),
                      child: Text(
                        _monthLabel(_calendarMonth),
                        style: const TextStyle(
                          color: Color(0xFF147A3A),
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: weekdays
                    .map(
                      (day) => Expanded(
                        child: Center(
                          child: Text(
                            day,
                            style: const TextStyle(
                              color: BrandColors.textMuted,
                              fontSize: 11,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.8,
                            ),
                          ),
                        ),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 10),
              GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: visibleDays.length,
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 7,
                  mainAxisSpacing: 8,
                  crossAxisSpacing: 8,
                  childAspectRatio: 1,
                ),
                itemBuilder: (context, index) {
                  final day = visibleDays[index];
                  if (day == null) {
                    return const SizedBox.shrink();
                  }

                  final isToday = _isSameDay(day, today);
                  final isSelected = _isSameDay(day, _selectedCalendarDate);
                  final attendanceCount = _attendanceCountForDay(day);
                  final hasAttendance = attendanceCount > 0;
                  return InkWell(
                    onTap: () {
                      HapticFeedback.selectionClick();
                      setState(() => _selectedCalendarDate = day);
                    },
                    borderRadius: BorderRadius.circular(12),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 180),
                      decoration: BoxDecoration(
                        color: isSelected
                            ? BrandColors.cyan
                            : hasAttendance
                                ? const Color(0xFFEAF8EF)
                                : isToday
                                    ? const Color(0xFFE9F7FB)
                                    : const Color(0xFFF8FAFC),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: isSelected
                              ? BrandColors.cyan
                              : hasAttendance
                                  ? const Color(0xFF34A853).withValues(alpha: 0.45)
                                  : isToday
                                      ? BrandColors.cyan.withValues(alpha: 0.35)
                                      : BrandColors.border,
                        ),
                        boxShadow: isSelected
                            ? [
                                BoxShadow(
                                  color: BrandColors.cyan.withValues(alpha: 0.18),
                                  blurRadius: 14,
                                  offset: const Offset(0, 6),
                                ),
                              ]
                            : null,
                      ),
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          Center(
                            child: Text(
                              '${day.day}',
                              style: TextStyle(
                                color: isSelected
                                    ? Colors.white
                                    : hasAttendance
                                        ? const Color(0xFF147A3A)
                                        : isToday
                                            ? BrandColors.cyan
                                            : BrandColors.text,
                                fontSize: 13,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                          if (hasAttendance && !isSelected)
                            Positioned(
                              top: 3,
                              right: 3,
                              child: Container(
                                width: 16,
                                height: 16,
                                decoration: BoxDecoration(
                                  color: const Color(0xFF34A853),
                                  shape: BoxShape.circle,
                                  boxShadow: [
                                    BoxShadow(
                                      color: const Color(0xFF34A853).withValues(alpha: 0.16),
                                      blurRadius: 6,
                                      offset: const Offset(0, 2),
                                    ),
                                  ],
                                ),
                                alignment: Alignment.center,
                                child: Text(
                                  attendanceCount > 9 ? '9+' : '$attendanceCount',
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 8,
                                    fontWeight: FontWeight.w900,
                                    height: 1,
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  );
                },
              ),
              const SizedBox(height: 12),
              Text(
                context.tr(
                  'Selected: ${dayName(_selectedCalendarDate)}',
                  'Napili: ${dayName(_selectedCalendarDate)}',
                ),
                style: const TextStyle(
                  color: BrandColors.textMuted,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: const Color(0xFFF8FAFC),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: BrandColors.border),
                ),
                child: hasRecord
                    ? Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              _calendarStat(
                                label: context.tr('Time In', 'Pasok'),
                                value: _timeOfDay(selectedLog['time_in']),
                                accent: const Color(0xFF147A3A),
                              ),
                              const SizedBox(width: 8),
                              _calendarStat(
                                label: context.tr('Time Out', 'Uwi'),
                                value: _timeOfDay(selectedLog['time_out']),
                                accent: const Color(0xFFC46A18),
                              ),
                            ],
                          ),
                          if ((selectedLog['duration']?.toString() ?? '').isNotEmpty) ...[
                            const SizedBox(height: 8),
                            _calendarStat(
                              label: context.tr('Duration', 'Tagal'),
                              value: _formatDurationShort(selectedLog['duration'].toString()),
                              accent: const Color(0xFF7C5CDB),
                              fullWidth: true,
                            ),
                          ],
                        ],
                      )
                    : EmptyState(
                        icon: Icons.event_busy_rounded,
                        title: context.tr(
                          'No attendance record for the selected date.',
                          'Walang attendance record para sa napiling petsa.',
                        ),
                      ),
              ),
              ..._dayFinancialsSection(),
            ],
          );
        },
      ),
    );
  }

  List<Widget> _dayFinancialsSection() {
    final fin = _selectedDayFinancials();
    if (fin == null || !_dayHasFinancials(fin)) return const [];
    return [
      const SizedBox(height: 12),
      _dayFinancialsCard(fin),
    ];
  }

  String _dateKey(DateTime d) {
    final mm = d.month.toString().padLeft(2, '0');
    final dd = d.day.toString().padLeft(2, '0');
    return '${d.year}-$mm-$dd';
  }

  Map<String, dynamic>? _selectedDayFinancials() {
    final raw = _dailyFinancials[_dateKey(_selectedCalendarDate)];
    if (raw is Map) return Map<String, dynamic>.from(raw);
    return null;
  }

  bool _dayHasFinancials(Map<String, dynamic> fin) {
    return _toMoneyValue(fin['salary']) > 0 ||
        _toMoneyValue(fin['extra']) > 0 ||
        _toMoneyValue(fin['cash_advance']) > 0;
  }

  Widget _dayFinancialsCard(Map<String, dynamic> fin) {
    final cashAdvance = _toMoneyValue(fin['cash_advance']);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFFFBF0),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE9DFC0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.account_balance_wallet_rounded,
                  size: 15, color: Color(0xFF8A6D1F)),
              const SizedBox(width: 6),
              Text(
                context.tr('Day Earnings', 'Kita ng Araw'),
                style: const TextStyle(
                  color: Color(0xFF8A6D1F),
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.6,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              _calendarStat(
                label: context.tr('Salary', 'Sahod'),
                value: _fmtMoney(fin['salary']),
                accent: const Color(0xFF147A3A),
              ),
              const SizedBox(width: 8),
              _calendarStat(
                label: context.tr('Extra Pay', 'Dagdag Sahod'),
                value: _fmtMoney(fin['extra']),
                accent: const Color(0xFF7C5CDB),
              ),
            ],
          ),
          if (cashAdvance > 0) ...[
            const SizedBox(height: 8),
            _calendarStat(
              label: context.tr('Cash Advance', 'Cash Advance'),
              value: _fmtMoney(fin['cash_advance']),
              accent: const Color(0xFFC0392B),
              fullWidth: true,
            ),
          ],
        ],
      ),
    );
  }

  Widget _calendarStat({
    required String label,
    required String value,
    required Color accent,
    bool fullWidth = false,
  }) {
    final stat = Container(
      width: fullWidth ? double.infinity : null,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: accent.withValues(alpha: 0.18)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: TextStyle(
              color: accent,
              fontSize: 11,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.6,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            value.isEmpty ? '-' : value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: BrandColors.text,
              fontSize: 13,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
    return fullWidth ? stat : Expanded(child: stat);
  }

  String dayName(DateTime date) {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return '${months[date.month - 1]} ${date.day}, ${date.year}';
  }

  Widget _buildEmployeeLogs() {
    return SafeArea(
      child: RefreshIndicator(
        onRefresh: _handleLogsRefresh,
        color: BrandColors.cyan,
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _card(
                child: Row(
                  children: [
                    Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                        color: const Color(0xFFE9F7FB),
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: const Icon(Icons.badge_rounded, color: BrandColors.cyan, size: 24),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            context.tr('Attendance Logs', 'Mga Attendance Logs'),
                            style: const TextStyle(
                              color: BrandColors.text,
                              fontSize: 18,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            context.tr(
                              'Your attendance records are listed here.',
                              'Narito ang listahan ng iyong mga attendance records.',
                            ),
                            style: const TextStyle(
                              color: BrandColors.textMuted,
                              fontSize: 12,
                              height: 1.35,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              _calendarCard(),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: ElevatedButton.icon(
                      onPressed: _isLogsLoading ? null : () { HapticFeedback.lightImpact(); _loadLogs(); },
                      icon: _isLogsLoading
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                            )
                          : const Icon(Icons.refresh_rounded, size: 18),
                      label: Text(context.tr('Refresh', 'I-refresh')),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: BrandColors.cyan,
                        foregroundColor: Colors.white,
                        minimumSize: const Size.fromHeight(48),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              if (_isLogsLoading && _groupedLogs.isEmpty)
                _card(
                  child: const Padding(
                    padding: EdgeInsets.symmetric(vertical: 8),
                    child: Center(
                      child: CircularProgressIndicator(strokeWidth: 2.4),
                    ),
                  ),
                ),
              if (_logsMsg.isNotEmpty) ...[
                _card(
                  child: Text(
                    _logsMsg,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: BrandColors.textMuted, fontSize: 13, height: 1.35),
                  ),
                ),
                const SizedBox(height: 12),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPayrollPage() {
    final hasPendingCaRequest = _caRequests.any((e) {
      final row = Map<String, dynamic>.from(e as Map);
      return (row['status']?.toString() ?? '') == 'pending';
    });
    final breakdownPeriods = _breakdownPeriods;
    final hasPaidPeriods = breakdownPeriods.isNotEmpty;
    final index = hasPaidPeriods
        ? _paidPeriodIndex.clamp(0, breakdownPeriods.length - 1)
        : 0;
    final currentPeriod = hasPaidPeriods ? breakdownPeriods[index] : null;
    final periodTypeLabel = _periodTypeLabel.isNotEmpty
        ? _periodTypeLabel
        : (currentPeriod?['period_type']?.toString() ?? '');
    final hasPendingPayslip = _payslipRequests.any((e) {
      final row = Map<String, dynamic>.from(e as Map);
      return (row['status']?.toString() ?? '') == 'pending';
    });
    return RefreshIndicator(
      onRefresh: _loadLogs,
      color: BrandColors.cyan,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
        children: [
          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  context.tr('Cash Advance Requests', 'Mga Kahilingan ng Paunang Sahod'),
                  style: const TextStyle(color: BrandColors.text, fontSize: 16, fontWeight: FontWeight.w900),
                ),
                const SizedBox(height: 6),
                Text(
                  context.tr(
                    'Request a salary advance for admin approval.',
                    'Humingi ng paunang sahod para i-approve ng admin.',
                  ),
                  style: const TextStyle(color: BrandColors.textMuted, fontSize: 12),
                ),
                const SizedBox(height: 12),
                if (_caRequestsLoading && _caRequests.isEmpty)
                  const Center(
                    child: Padding(
                      padding: EdgeInsets.all(12),
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                else if (_caRequests.isEmpty)
                  EmptyState(
                    icon: Icons.request_page_outlined,
                    title: context.tr('No requests yet.', 'Wala pang kahilingan.'),
                  )
                else
                  ..._caRequests.map((entry) {
                    final row = Map<String, dynamic>.from(entry as Map);
                    final status = row['status']?.toString() ?? 'pending';
                    final isCancelling = _caCancelRequestId != null &&
                        _caCancelRequestId.toString() == row['id'].toString();
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  _fmtMoney(row['amount']),
                                  style: const TextStyle(
                                    color: BrandColors.text,
                                    fontWeight: FontWeight.w800,
                                    fontSize: 13,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  _formatRequestDate(row['created_at']?.toString()),
                                  style: const TextStyle(
                                    color: BrandColors.textMuted,
                                    fontSize: 11,
                                  ),
                                ),
                                if ((row['pickup_date']?.toString() ?? '').isNotEmpty)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 2),
                                    child: Text(
                                      '${context.tr('Pickup', 'Pagkuha')}: ${_formatRequestDate(row['pickup_date']?.toString())}',
                                      style: const TextStyle(
                                        color: BrandColors.cyan,
                                        fontSize: 11,
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              _caStatusPill(status),
                              if (status == 'pending') ...[
                                const SizedBox(height: 4),
                                GestureDetector(
                                  onTap: isCancelling
                                      ? null
                                      : () => _cancelCashAdvanceRequest(row),
                                  child: Text(
                                    isCancelling
                                        ? context.tr('Cancelling…', 'Kinakansela…')
                                        : context.tr('Cancel', 'Kanselahin'),
                                    style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.w700,
                                      color: isCancelling
                                          ? BrandColors.textMuted
                                          : const Color(0xFFC62828),
                                    ),
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ],
                      ),
                    );
                  }),
                if (!hasPendingCaRequest) ...[
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      onPressed: _caRequestSubmitting ? null : _showCashAdvanceRequestDialog,
                      icon: const Icon(Icons.add, size: 18),
                      label: Text(context.tr('Request Cash Advance', 'Humingi ng Paunang Sahod')),
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 14),
          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        context.tr('Request Payslip', 'Humingi ng Payslip'),
                        style: const TextStyle(color: BrandColors.text, fontSize: 16, fontWeight: FontWeight.w900),
                      ),
                    ),
                    if (_isPayslipLoading)
                      const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  context.tr(
                    'Request your payslip as a PDF. The admin approves it and we email it to you.',
                    'Humingi ng iyong payslip bilang PDF. I-aaprove ng admin at iesend ito sa iyong email.',
                  ),
                  style: const TextStyle(color: BrandColors.textMuted, fontSize: 12),
                ),
                const SizedBox(height: 12),
                if (_payslipPeriods.isEmpty)
                  EmptyState(
                    icon: Icons.receipt_long_outlined,
                    title: context.tr('No paid periods yet.', 'Wala pang bayad na panahon.'),
                    subtitle: context.tr(
                      'Payslips become available once a period is generated and paid.',
                      'Magiging available ang payslip kapag na-generate at nabayaran na ang isang panahon.',
                    ),
                  )
                else if (hasPendingPayslip)
                  _infoRow(
                    context.tr('Pending request', 'Naghihintay na kahilingan'),
                    context.tr('Wait for the admin to approve and email it.', 'Hintayin ang pag-apruba at email ng admin.'),
                  )
                else ...[
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: _isPayslipSubmitting ? null : _showRequestPayslipDialog,
                      icon: const Icon(Icons.email_outlined, size: 18),
                      label: Text(context.tr('Request Payslip', 'Humingi ng Payslip')),
                    ),
                  ),
                ],
                if (_payslipRequests.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  ..._payslipRequests.map((entry) {
                    final row = Map<String, dynamic>.from(entry as Map);
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '${row['period_start'] ?? '-'} → ${row['period_end'] ?? '-'}',
                                  style: const TextStyle(
                                    color: BrandColors.text,
                                    fontWeight: FontWeight.w800,
                                    fontSize: 13,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  _formatRequestDate(row['requested_at']?.toString()),
                                  style: const TextStyle(
                                    color: BrandColors.textMuted,
                                    fontSize: 11,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          _caStatusPill(row['status']?.toString() ?? 'pending'),
                        ],
                      ),
                    );
                  }),
                ],
              ],
            ),
          ),
          const SizedBox(height: 14),
          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        context.tr('Period Breakdown', 'Detalye ng Bawat Panahon'),
                        style: const TextStyle(color: BrandColors.text, fontSize: 16, fontWeight: FontWeight.w900),
                      ),
                    ),
                    if (_isPayrollPeriodLoading)
                      const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                  ],
                ),
                const SizedBox(height: 12),
                if (!hasPaidPeriods)
                  EmptyState(
                    icon: Icons.pie_chart_outline,
                    title: context.tr('No paid periods yet.', 'Wala pang bayad na panahon.'),
                    subtitle: context.tr(
                      'Your payroll breakdown appears here once a period is generated and paid.',
                      'Dito lalabas ang iyong payroll kapag na-generate at nabayaran na ang isang panahon.',
                    ),
                  )
                else ...[
                  if (periodTypeLabel.isNotEmpty) ...[
                    _pill(periodTypeLabel.toUpperCase(), const Color(0xFFE0F2FE), const Color(0xFF0369A1)),
                    const SizedBox(height: 10),
                  ],
                  Row(
                    children: [
                      IconButton(
                        onPressed: index > 0
                            ? () => setState(() => _paidPeriodIndex--)
                            : null,
                        icon: const Icon(Icons.chevron_left_rounded),
                        color: index > 0 ? BrandColors.cyan : BrandColors.textMuted,
                      ),
                      Expanded(
                        child: Column(
                          children: [
                            Text(
                              '${context.tr('Period', 'Panahon')} ${index + 1} ${context.tr('of', 'ng')} ${breakdownPeriods.length}',
                              style: const TextStyle(
                                color: BrandColors.text,
                                fontWeight: FontWeight.w800,
                                fontSize: 13,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              '${currentPeriod!['start_date'] ?? '-'} → ${currentPeriod['end_date'] ?? '-'}',
                              style: const TextStyle(
                                color: BrandColors.textMuted,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ),
                      IconButton(
                        onPressed: index < breakdownPeriods.length - 1
                            ? () => setState(() => _paidPeriodIndex++)
                            : null,
                        icon: const Icon(Icons.chevron_right_rounded),
                        color: index < breakdownPeriods.length - 1 ? BrandColors.cyan : BrandColors.textMuted,
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  _periodBreakdownTile(currentPeriod),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),
          Center(
            child: Text(
              context.tr('Only paid or generated periods are shown.', 'Ang mga bayad o na-generate na panahon lang ang ipinapakita.'),
              style: const TextStyle(color: BrandColors.textMuted, fontSize: 11),
            ),
          ),
        ],
      ),
    );
  }

  Widget _periodBreakdownTile(Map<String, dynamic> row) {
    final status = (row['payment_status']?.toString() ?? 'unpaid').toUpperCase();
    final Color pillBg;
    final Color pillFg;
    if (status == 'PAID') {
      pillBg = const Color(0xFFE8F5E9);
      pillFg = const Color(0xFF147A3A);
    } else if (status == 'GENERATED') {
      pillBg = const Color(0xFFE3F2FD);
      pillFg = const Color(0xFF0B5FAD);
    } else if (status == 'PARTIAL') {
      pillBg = const Color(0xFFFFF3E0);
      pillFg = const Color(0xFFB45309);
    } else {
      pillBg = const Color(0xFFFFEBEE);
      pillFg = const Color(0xFFC62828);
    }
    final history = (row['payment_history'] as List?) ?? const [];
    final salary = _toMoneyValue(row['salary'] ?? row['amount']);
    final extra = _toMoneyValue(row['extra_payment']);
    final paid = _toMoneyValue(row['paid_amount']);
    final balance = _toMoneyValue(row['balance']);
    final cashAdvanceBalance = _toMoneyValue(row['remaining_bale_balance']);
    final totalEarnings = salary + extra;
    final netPay = totalEarnings;

    Widget sectionLabel(String label) => Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Row(
            children: [
              Container(
                width: 3,
                height: 12,
                decoration: BoxDecoration(
                  color: BrandColors.cyan,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(width: 6),
              Text(
                label,
                style: const TextStyle(
                  color: BrandColors.textMuted,
                  fontSize: 11,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 0.6,
                ),
              ),
            ],
          ),
        );

    Widget breakdownRow(String label, String value, {TextStyle? valueStyle}) => Row(
          children: [
            SizedBox(
              width: 94,
              child: Text(
                label,
                style: const TextStyle(
                  color: BrandColors.textMuted,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                value,
                textAlign: TextAlign.right,
                style: valueStyle ??
                    const TextStyle(
                      color: BrandColors.text,
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                    ),
              ),
            ),
          ],
        );

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: BrandColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${row['start_date'] ?? '-'} → ${row['end_date'] ?? '-'}',
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              _pill(status, pillBg, pillFg),
            ],
          ),
          const SizedBox(height: 12),
          sectionLabel(context.tr('Earnings', 'Mga Kita')),
          const SizedBox(height: 6),
          breakdownRow(context.tr('Days', 'Mga Araw'), '${row['days'] ?? 0}'),
          const SizedBox(height: 6),
          breakdownRow(context.tr('Salary', 'Sahod'), _fmtPeso(salary)),
          if (extra > 0) ...[
            const SizedBox(height: 6),
            breakdownRow(context.tr('Extra Pay', 'Dagdag na Sahod'), _fmtPeso(extra)),
          ],
          const Divider(height: 18),
          breakdownRow(
            context.tr('Total Earnings', 'Kabuuang Kita'),
            _fmtPeso(totalEarnings),
            valueStyle: const TextStyle(
              color: BrandColors.cyan,
              fontSize: 13,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 12),
          if (cashAdvanceBalance > 0) ...[
            sectionLabel(context.tr('Cash Advance', 'Paunang Sahod')),
            const SizedBox(height: 6),
            breakdownRow(
              context.tr('Outstanding Balance', 'Natitirang Balanse'),
              _fmtPeso(cashAdvanceBalance),
            ),
          ],
          const SizedBox(height: 12),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: BrandColors.surface,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: BrandColors.border),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  context.tr('Net Pay', 'Netong Sahod'),
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 13,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                Text(
                  _fmtPeso(netPay),
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          sectionLabel(context.tr('Payments', 'Mga Bayad')),
          const SizedBox(height: 6),
          breakdownRow(context.tr('Paid', 'Nabayaran'), _fmtPeso(paid)),
          if (history.isNotEmpty)
            for (final entry in history)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: breakdownRow(
                  _fmtPeso(_toMoneyValue((entry as Map)['amount_paid'])),
                  entry['created_at']?.toString() ?? '-',
                ),
              ),
          const SizedBox(height: 10),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: pillBg.withValues(alpha: 0.4),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: pillFg.withValues(alpha: 0.35)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  context.tr('Balance', 'Natitira'),
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 13,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                Text(
                  _fmtPeso(balance),
                  style: TextStyle(
                    color: pillFg,
                    fontSize: 16,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }


  Widget _buildEmployeeProfile() {
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _card(
              child: Column(
                children: [
                  GestureDetector(
                    onTap: _isPhotoUploading ? null : _pickAndUploadPhoto,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        Container(
                          width: 82,
                          height: 82,
                          clipBehavior: Clip.antiAlias,
                          decoration: BoxDecoration(
                            color: const Color(0xFF00E676),
                            shape: BoxShape.circle,
                            border: Border.all(
                              color: BrandColors.border,
                              width: 2,
                            ),
                          ),
                          child: _photoUrl.isNotEmpty
                              ? Image.network(
                                  '${AppConstants.baseUrl}$_photoUrl',
                                  fit: BoxFit.cover,
                                  loadingBuilder: (context, child, progress) {
                                    if (progress == null) return child;
                                    return const Center(
                                      child: SizedBox(
                                        width: 22,
                                        height: 22,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      ),
                                    );
                                  },
                                  errorBuilder: (context, error, stack) {
                                    return const Icon(
                                      Icons.person_rounded,
                                      color: Colors.white,
                                      size: 42,
                                    );
                                  },
                                )
                              : const Icon(
                                  Icons.person_rounded,
                                  color: Colors.white,
                                  size: 42,
                                ),
                        ),
                        Positioned(
                          right: 0,
                          bottom: 0,
                          child: Container(
                            width: 28,
                            height: 28,
                            decoration: BoxDecoration(
                              color: BrandColors.surface,
                              shape: BoxShape.circle,
                              border: Border.all(color: BrandColors.border),
                            ),
                            child: _isPhotoUploading
                                ? const Padding(
                                    padding: EdgeInsets.all(6),
                                    child: CircularProgressIndicator(strokeWidth: 2),
                                  )
                                : const Icon(
                                    Icons.camera_alt_rounded,
                                    color: BrandColors.text,
                                    size: 15,
                                  ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    _photoUrl.isNotEmpty
                        ? context.tr('Tap photo to change', 'Pindutin ang photo para palitan')
                        : context.tr('Tap to upload your photo', 'Pindutin para i-upload ang iyong photo'),
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: BrandColors.textMuted,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    _name.isNotEmpty ? _name : context.tr('Employee', 'Empleyado'),
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: BrandColors.text,
                      fontSize: 22,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _employeeId.isNotEmpty ? _employeeId : context.tr('No employee ID', 'Walang employee ID'),
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: BrandColors.textMuted,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 10),
                  if (_status.isNotEmpty)
                    _pill(_status.toUpperCase(), const Color(0xFFEAF8EF), const Color(0xFF147A3A)),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    context.tr('Account Info', 'Impormasyon ng Account'),
                    style: const TextStyle(
                      color: BrandColors.text,
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 12),
                  _infoRow(context.tr('Name', 'Pangalan'), _name.isNotEmpty ? _name : '-'),
                  const SizedBox(height: 10),
                  _infoRow(context.tr('Employee ID', 'Employee ID'), _employeeId.isNotEmpty ? _employeeId : '-'),
                  const SizedBox(height: 10),
                  _infoRow(context.tr('Email', 'Email'), _email.isNotEmpty ? _email : '-'),
                  const SizedBox(height: 10),
                  _infoRow(
                    context.tr('Phone', 'Telepono'),
                    _phone.isNotEmpty ? _phone : '-',
                  ),
                  const SizedBox(height: 10),
                  _infoRow(
                    context.tr('SSS', 'SSS'),
                    _sssNumber.isNotEmpty ? _sssNumber : '-',
                  ),
                  const SizedBox(height: 10),
                  _infoRow(
                    context.tr('PhilHealth', 'PhilHealth'),
                    _philhealthNumber.isNotEmpty ? _philhealthNumber : '-',
                  ),
                  const SizedBox(height: 10),
                  _infoRow(
                    context.tr('Pag-IBIG', 'Pag-IBIG'),
                    _pagibigNumber.isNotEmpty ? _pagibigNumber : '-',
                  ),
                  const SizedBox(height: 10),
                  _infoRow(
                    context.tr('TIN', 'TIN'),
                    _tinNumber.isNotEmpty ? _tinNumber : '-',
                  ),
                  const SizedBox(height: 10),
                  _infoRow(context.tr('Status', 'Status'), _status.isNotEmpty ? _status : '-'),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    context.tr('App Lock', 'App Lock'),
                    style: const TextStyle(
                      color: BrandColors.text,
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _hasBiometrics
                        ? context.tr(
                            'Require your fingerprint to open the app when you return or restart it.',
                            'Kailanganin ang iyong fingerprint para mabuksan ang app kapag bumalik o nag-restart ka.',
                          )
                        : context.tr(
                            'Fingerprint is not available on this device, so the app lock cannot be enabled.',
                            'Hindi available ang fingerprint sa device na ito, kaya hindi maaaring i-enable ang app lock.',
                          ),
                    style: const TextStyle(
                      color: BrandColors.textMuted,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      height: 1.4,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Consumer<AppLockService>(
                    builder: (context, lock, _) {
                      return SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(
                          context.tr(
                            'Require fingerprint to open',
                            'Kailanganin ang fingerprint para mabuksan',
                          ),
                          style: const TextStyle(
                            color: BrandColors.text,
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        value: lock.enabled,
                        activeTrackColor: BrandColors.cyan,
                        onChanged: !_hasBiometrics
                            ? null
                            : (value) => lock.setEnabled(value),
                      );
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _card(
              child: SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _logout,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: const Color(0xFFB31D18),
                    side: const BorderSide(color: Color(0xFFE2B0B0)),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                  icon: const Icon(Icons.logout_rounded, size: 18),
                  label: Text(
                    context.tr('Logout', 'Mag-logout'),
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _card({required Widget child, EdgeInsets margin = EdgeInsets.zero}) {
    return Container(
      margin: margin,
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: BrandColors.surface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: BrandColors.border),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.06),
            blurRadius: 24,
            offset: const Offset(0, 14),
          ),
        ],
      ),
      child: child,
    );
  }

  Widget _pill(String text, Color bg, Color fg) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: fg.withValues(alpha: 0.18)),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: fg,
          fontSize: 11,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  Widget _infoRow(String label, String value, {Widget? trailing}) {
    return Row(
      children: [
        SizedBox(
          width: 94,
          child: Text(
            label,
            style: const TextStyle(
              color: BrandColors.textMuted,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(
              color: BrandColors.text,
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        ?trailing,
      ],
    );
  }


  Widget _field({
    required TextEditingController controller,
    required String label,
    required IconData icon,
    bool obscureText = false,
    TextInputType keyboardType = TextInputType.text,
    Widget? suffixIcon,
    String? Function(String?)? validator,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(color: BrandColors.text, fontSize: 13, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 8),
        TextFormField(
          controller: controller,
          keyboardType: keyboardType,
          obscureText: obscureText,
          enableSuggestions: !obscureText,
          autocorrect: !obscureText,
          cursorColor: BrandColors.cyan,
          validator: validator,
          autovalidateMode: AutovalidateMode.onUserInteraction,
          decoration: InputDecoration(
            prefixIcon: Icon(icon, color: BrandColors.cyan),
            suffixIcon: suffixIcon,
            hintText: 'Enter $label',
            filled: true,
            fillColor: BrandColors.surface,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: BrandColors.border),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: BrandColors.border),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
            ),
          ),
        ),
      ],
    );
  }
}

class _ForgotPasswordPage extends StatefulWidget {
  final String initialEmail;

  const _ForgotPasswordPage({
    required this.initialEmail,
  });

  @override
  State<_ForgotPasswordPage> createState() => _ForgotPasswordPageState();
}

class _ForgotPasswordPageState extends State<_ForgotPasswordPage> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _emailCtrl;
  late final TextEditingController _newPasswordCtrl;
  late final TextEditingController _confirmPasswordCtrl;
  late final FocusNode _emailFocusNode;
  late final FocusNode _newPasswordFocusNode;
  late final FocusNode _confirmPasswordFocusNode;
  final List<TextEditingController> _codeCtrls =
      List.generate(6, (_) => TextEditingController());
  final List<FocusNode> _codeFocusNodes = List.generate(6, (_) => FocusNode());
  bool _isSending = false;
  bool _codeSent = false;
  bool _codeVerified = false;
  bool _newPasswordHidden = true;
  bool _confirmPasswordHidden = true;
  String _message = '';
  int _codeExpiryRemainingSeconds = 0;
  int _resendRemainingSeconds = 0;
  Timer? _resetTimer;
  static const int _codeExpiryTotalSeconds = 20 * 60;
  static const int _resendCooldownSeconds = 30;

  @override
  void initState() {
    super.initState();
    _emailCtrl = TextEditingController(text: widget.initialEmail);
    _newPasswordCtrl = TextEditingController();
    _confirmPasswordCtrl = TextEditingController();
    _emailFocusNode = FocusNode();
    _newPasswordFocusNode = FocusNode();
    _confirmPasswordFocusNode = FocusNode();
  }

  @override
  void dispose() {
    _resetTimer?.cancel();
    _emailCtrl.dispose();
    _newPasswordCtrl.dispose();
    _confirmPasswordCtrl.dispose();
    _emailFocusNode.dispose();
    _newPasswordFocusNode.dispose();
    _confirmPasswordFocusNode.dispose();
    for (final ctrl in _codeCtrls) {
      ctrl.dispose();
    }
    for (final node in _codeFocusNodes) {
      node.dispose();
    }
    super.dispose();
  }

  String get _otpCode => _codeCtrls.map((ctrl) => ctrl.text.trim()).join();

  String _formatCountdown(int totalSeconds) {
    final safe = totalSeconds < 0 ? 0 : totalSeconds;
    final minutes = safe ~/ 60;
    final seconds = safe % 60;
    return '${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}';
  }

  void _clearOtpFields() {
    for (final ctrl in _codeCtrls) {
      ctrl.clear();
    }
  }

  void _startResetTimers() {
    _resetTimer?.cancel();
    _codeExpiryRemainingSeconds = _codeExpiryTotalSeconds;
    _resendRemainingSeconds = _resendCooldownSeconds;
    _resetTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      final hasExpiry = _codeExpiryRemainingSeconds > 0;
      final hasResend = _resendRemainingSeconds > 0;
      if (!hasExpiry && !hasResend) {
        timer.cancel();
        return;
      }
      setState(() {
        if (_codeExpiryRemainingSeconds > 0) {
          _codeExpiryRemainingSeconds--;
        }
        if (_resendRemainingSeconds > 0) {
          _resendRemainingSeconds--;
        }
        if (_codeExpiryRemainingSeconds <= 0) {
          _codeVerified = false;
        }
      });
    });
  }

  void _stopResetTimers() {
    _resetTimer?.cancel();
    _resetTimer = null;
    _codeExpiryRemainingSeconds = 0;
    _resendRemainingSeconds = 0;
  }

  void _focusCodeField(int index) {
    if (index < 0 || index >= _codeFocusNodes.length) return;
    FocusScope.of(context).requestFocus(_codeFocusNodes[index]);
  }

  void _applyOtpValue(String value, int index) {
    final digits = value.replaceAll(RegExp(r'\D'), '');
    if (digits.isEmpty) {
      if (_codeVerified) setState(() => _codeVerified = false);
      return;
    }

    if (digits.length > 1) {
      for (var i = 0; i < _codeCtrls.length; i++) {
        final next = i < digits.length ? digits[i] : '';
        _codeCtrls[i].text = next;
      }
      if (_codeVerified) _codeVerified = false;
      setState(() {});
      final nextFocus = digits.length >= _codeCtrls.length
          ? _codeCtrls.length - 1
          : digits.length;
      _focusCodeField(nextFocus);
      if (digits.length >= _codeCtrls.length) {
        FocusScope.of(context).unfocus();
      }
      return;
    }

    if (_codeCtrls[index].text != digits) {
      _codeCtrls[index].text = digits;
      _codeCtrls[index].selection = TextSelection.collapsed(offset: digits.length);
    }
    if (_codeVerified) setState(() => _codeVerified = false);
    if (index < _codeCtrls.length - 1) {
      _focusCodeField(index + 1);
    } else {
      FocusScope.of(context).unfocus();
    }
  }

  Future<void> _sendResetCode() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() {
      _isSending = true;
      _message = '';
    });

    try {
      final res = await ApiClient.postForm(
        '/employee/forgot-password',
        body: {'email': _emailCtrl.text.trim()},
      );
      final body = json.decode(res.body);

      if (!mounted) return;

      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        setState(() {
          _codeSent = true;
          _codeVerified = false;
          _clearOtpFields();
          _newPasswordCtrl.clear();
          _confirmPasswordCtrl.clear();
          _message = body['message']?.toString() ?? 'Verification code sent to your email.';
        });
        if (mounted) {
          _startResetTimers();
          _focusCodeField(0);
        }
        return;
      }

      setState(() {
        _message = body is Map<String, dynamic>
            ? _friendlyResetMessage(
                serverMessageFromBody(
                  res.body,
                  fallback: 'Unable to send verification code.',
                ),
                fallback: 'Unable to send verification code.',
              )
            : 'Unable to send verification code.';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _message = ApiClient.friendlyNetworkError(error);
      });
    } finally {
      if (mounted) {
        setState(() => _isSending = false);
      }
    }
  }

  Future<void> _verifyResetCode() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    if (_otpCode.length != 6) {
      setState(() {
        _codeVerified = false;
        _message = 'Enter the full 6-digit code.';
      });
      return;
    }
    if (_codeExpiryRemainingSeconds <= 0) {
      setState(() {
        _codeVerified = false;
        _message = 'That code has expired. Please request a new one.';
      });
      return;
    }
    setState(() {
      _isSending = true;
      _message = '';
    });

    try {
      final res = await ApiClient.postForm(
        '/employee/verify-reset-code',
        body: {
          'email': _emailCtrl.text.trim(),
          'code': _otpCode,
        },
      );
      final body = json.decode(res.body);

      if (!mounted) return;

      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        setState(() {
          _codeVerified = true;
          _newPasswordCtrl.clear();
          _confirmPasswordCtrl.clear();
          _message = body['message']?.toString() ?? 'Code verified. You may now set a new password.';
        });
        if (mounted) {
          FocusScope.of(context).requestFocus(_newPasswordFocusNode);
        }
        return;
      }

      setState(() {
        _codeVerified = false;
        _message = body is Map<String, dynamic>
            ? _friendlyResetMessage(
                serverMessageFromBody(
                  res.body,
                  fallback: 'Unable to verify code.',
                ),
                fallback: 'Unable to verify code.',
              )
            : 'Unable to verify code.';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _codeVerified = false;
        _message = ApiClient.friendlyNetworkError(error);
      });
    } finally {
      if (mounted) {
        setState(() => _isSending = false);
      }
    }
  }

  void _resetToEmailStep() {
    _stopResetTimers();
    setState(() {
      _codeSent = false;
      _codeVerified = false;
      _newPasswordHidden = true;
      _confirmPasswordHidden = true;
      _message = '';
      _clearOtpFields();
      _newPasswordCtrl.clear();
      _confirmPasswordCtrl.clear();
    });
    FocusScope.of(context).requestFocus(_emailFocusNode);
  }

  String _friendlyResetMessage(String raw, {String fallback = 'Something went wrong.'}) {
    final msg = raw.toLowerCase();
    if (msg.contains('expired')) {
      return 'That code has expired. Please request a new one.';
    }
    if (msg.contains('invalid verification code') || msg.contains('verification code is not valid')) {
      return 'The code you entered is incorrect. Please try again.';
    }
    if (msg.contains('no verification code found')) {
      return 'No code is available yet. Please send a new code first.';
    }
    if (msg.contains('no account found')) {
      return 'We could not find an account for that email.';
    }
    if (msg.contains('email is required')) {
      return 'Email is required.';
    }
    if (msg.contains('verification code is required')) {
      return 'Verification code is required.';
    }
    if (msg.contains('password must be at least 8 characters')) {
      return 'Password must be at least 8 characters.';
    }
    return raw.isNotEmpty ? raw : fallback;
  }

  Future<void> _resendCode() async {
    if (_isSending || (_resendRemainingSeconds > 0 && _codeSent)) return;
    setState(() {
      _codeVerified = false;
      _newPasswordHidden = true;
      _confirmPasswordHidden = true;
      _message = '';
      _clearOtpFields();
    });
    await _sendResetCode();
  }

  Future<void> _submitNewPassword() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    if (!_codeVerified) {
      setState(() {
        _message = 'Please verify the code first.';
      });
      return;
    }
    if (_otpCode.length != 6) {
      setState(() {
        _codeVerified = false;
        _message = 'Enter the full 6-digit code.';
      });
      return;
    }
    if (_codeExpiryRemainingSeconds <= 0) {
      setState(() {
        _codeVerified = false;
        _message = 'That code has expired. Please request a new one.';
      });
      return;
    }
    if (_newPasswordCtrl.text.trim() != _confirmPasswordCtrl.text.trim()) {
      setState(() {
        _message = 'Passwords do not match.';
      });
      return;
    }

    setState(() {
      _isSending = true;
      _message = '';
    });

    try {
      final res = await ApiClient.postForm(
        '/employee/reset-password',
        body: {
          'email': _emailCtrl.text.trim(),
          'code': _otpCode,
          'new_password': _newPasswordCtrl.text,
        },
      );
      final body = json.decode(res.body);

      if (!mounted) return;

      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              body['message']?.toString() ?? 'Password updated successfully.',
            ),
            backgroundColor: const Color(0xFF1D2939),
          ),
        );
        Navigator.of(context).pop();
        return;
      }

      setState(() {
        _message = body is Map<String, dynamic>
            ? _friendlyResetMessage(
                serverMessageFromBody(
                  res.body,
                  fallback: 'Unable to update password.',
                ),
                fallback: 'Unable to update password.',
              )
            : 'Unable to update password.';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _message = ApiClient.friendlyNetworkError(error);
      });
    } finally {
      if (mounted) {
        setState(() => _isSending = false);
      }
    }
  }

  Widget _statusChip({
    required IconData icon,
    required String label,
    required Color bg,
    required Color fg,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: fg.withValues(alpha: 0.16)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: fg),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              color: fg,
              fontSize: 11,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }

  Widget _otpDigitField(int index) {
    return SizedBox(
      width: 44,
      child: TextFormField(
        controller: _codeCtrls[index],
        focusNode: _codeFocusNodes[index],
        enabled: !_isSending && _codeSent,
        textAlign: TextAlign.center,
        keyboardType: TextInputType.number,
        textInputAction: index == _codeCtrls.length - 1
            ? TextInputAction.done
            : TextInputAction.next,
        autofillHints: const [AutofillHints.oneTimeCode],
        maxLength: 6,
        inputFormatters: [
          FilteringTextInputFormatter.digitsOnly,
          LengthLimitingTextInputFormatter(6),
        ],
        onChanged: (value) {
          _applyOtpValue(value, index);
        },
        onTap: () {
          if (_codeVerified) {
            setState(() => _codeVerified = false);
          }
        },
        decoration: InputDecoration(
          counterText: '',
          filled: true,
          fillColor: const Color(0xFFF7FAFC),
          contentPadding: const EdgeInsets.symmetric(vertical: 14),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: BrandColors.border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: BrandColors.border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
          ),
        ),
        validator: (_) => null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: BrandColors.bg,
      appBar: AppBar(
        backgroundColor: BrandColors.surface,
        elevation: 0,
        toolbarHeight: 72,
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
          padding: const EdgeInsets.all(20),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Container(
                padding: const EdgeInsets.all(22),
                decoration: BoxDecoration(
                  color: BrandColors.surface,
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: BrandColors.border),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.12),
                      blurRadius: 24,
                      offset: const Offset(0, 14),
                    ),
                  ],
                ),
                child: Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Container(
                            width: 48,
                            height: 48,
                            decoration: BoxDecoration(
                              color: const Color(0xFFE9F7FB),
                              borderRadius: BorderRadius.circular(14),
                            ),
                            child: const Icon(Icons.lock_reset_rounded, color: BrandColors.cyan),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  context.tr('Forgot Password', 'Nakalimutan ang Password'),
                                  style: const TextStyle(
                                    color: BrandColors.text,
                                    fontSize: 18,
                                    fontWeight: FontWeight.w900,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  context.tr(
                                    'Use your registered email so we can route the reset request.',
                                    'Gamitin ang iyong rehistradong email para mapadala namin ang reset request.',
                                  ),
                                  style: const TextStyle(
                                    color: BrandColors.textMuted,
                                    fontSize: 12,
                                    height: 1.35,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 18),
                      TextFormField(
                        controller: _emailCtrl,
                        enabled: !_codeSent,
                        focusNode: _emailFocusNode,
                        keyboardType: TextInputType.emailAddress,
                        decoration: InputDecoration(
                          labelText: context.tr('Registered email', 'Rehistradong email'),
                          prefixIcon: const Icon(Icons.email_rounded, color: BrandColors.cyan),
                          filled: true,
                          fillColor: const Color(0xFFF7FAFC),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(14),
                            borderSide: const BorderSide(color: BrandColors.border),
                          ),
                          enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(14),
                            borderSide: const BorderSide(color: BrandColors.border),
                          ),
                          focusedBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(14),
                            borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
                          ),
                        ),
                        validator: (value) {
                          final text = value?.trim() ?? '';
                          if (text.isEmpty) return context.tr('Email is required.', 'Kinakailangan ang email.');
                          if (!text.contains('@')) return context.tr('Enter a valid email.', 'Maglagay ng wastong email.');
                          return null;
                        },
                      ),
                      if (_codeSent) ...[
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            Expanded(
                              child: TextButton(
                                onPressed: _isSending ? null : _resetToEmailStep,
                                child: Text(context.tr('Use a different email', 'Gumamit ng ibang email')),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: TextButton(
                                onPressed: (_isSending || _resendRemainingSeconds > 0)
                                    ? null
                                    : _resendCode,
                                child: Text(
                                  _resendRemainingSeconds > 0
                                      ? '${context.tr('Resend in', 'Ulitin sa')} ${_formatCountdown(_resendRemainingSeconds)}'
                                      : context.tr('Resend code', 'Ulitin ang code'),
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        LayoutBuilder(
                          builder: (context, constraints) {
                            final gap = constraints.maxWidth < 420 ? 6.0 : 8.0;
                            final fieldWidth =
                                ((constraints.maxWidth - (gap * 5)) / 6).clamp(40.0, 48.0);
                            final children = <Widget>[];
                            for (var index = 0; index < _codeCtrls.length; index++) {
                              if (index > 0) {
                                children.add(SizedBox(width: gap));
                              }
                              children.add(SizedBox(
                                width: fieldWidth,
                                child: _otpDigitField(index),
                              ));
                            }
                            return Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: children,
                            );
                          },
                        ),
                        const SizedBox(height: 10),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            _statusChip(
                              icon: Icons.schedule_rounded,
                              label: _codeExpiryRemainingSeconds > 0
                                  ? '${context.tr('Expires in', 'Mae-expire sa')} ${_formatCountdown(_codeExpiryRemainingSeconds)}'
                                  : context.tr('Code expired', 'Nag-expire ang code'),
                              bg: const Color(0xFFFDF2F2),
                              fg: const Color(0xFFB42318),
                            ),
                            _statusChip(
                              icon: Icons.refresh_rounded,
                              label: _resendRemainingSeconds > 0
                                  ? '${context.tr('Resend in', 'Ulitin sa')} ${_formatCountdown(_resendRemainingSeconds)}'
                                  : context.tr('Resend ready', 'Handa nang ulitin'),
                              bg: const Color(0xFFF8FAFC),
                              fg: BrandColors.textMuted,
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        if (_codeExpiryRemainingSeconds <= 0) ...[
                          Container(
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: const Color(0xFFFDF2F2),
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(color: const Color(0xFFFECACA)),
                            ),
                            child: Text(
                              context.tr(
                                'That code has expired. Request a new one to continue.',
                                'Nag-expire na ang code na iyon. Humingi ng bago para magpatuloy.',
                              ),
                              style: const TextStyle(
                                color: Color(0xFFB42318),
                                fontSize: 12,
                                height: 1.45,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ] else if (_codeVerified) ...[
                          const SizedBox(height: 12),
                          TextFormField(
                            controller: _newPasswordCtrl,
                            focusNode: _newPasswordFocusNode,
                            obscureText: _newPasswordHidden,
                            decoration: InputDecoration(
                              labelText: context.tr('New password', 'Bagong password'),
                              prefixIcon: const Icon(Icons.lock_rounded, color: BrandColors.cyan),
                              suffixIcon: IconButton(
                                onPressed: () {
                                  setState(() => _newPasswordHidden = !_newPasswordHidden);
                                },
                                icon: Icon(
                                  _newPasswordHidden ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                                  color: BrandColors.textMuted,
                                ),
                              ),
                              filled: true,
                              fillColor: const Color(0xFFF7FAFC),
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.border),
                              ),
                              enabledBorder: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.border),
                              ),
                              focusedBorder: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
                              ),
                            ),
                            validator: (value) {
                              final text = value?.trim() ?? '';
                              if (text.isEmpty) {
                                return context.tr('New password is required.', 'Kinakailangan ang bagong password.');
                              }
                              if (text.length < 8) {
                                return context.tr('Password must be at least 8 characters.', 'Ang password ay dapat hindi bababa sa 8 na karakter.');
                              }
                              return null;
                            },
                          ),
                          const SizedBox(height: 12),
                          TextFormField(
                            controller: _confirmPasswordCtrl,
                            focusNode: _confirmPasswordFocusNode,
                            obscureText: _confirmPasswordHidden,
                            decoration: InputDecoration(
                              labelText: context.tr('Confirm password', 'Kumpirmahin ang password'),
                              prefixIcon: const Icon(Icons.lock_outline_rounded, color: BrandColors.cyan),
                              suffixIcon: IconButton(
                                onPressed: () {
                                  setState(() => _confirmPasswordHidden = !_confirmPasswordHidden);
                                },
                                icon: Icon(
                                  _confirmPasswordHidden ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                                  color: BrandColors.textMuted,
                                ),
                              ),
                              filled: true,
                              fillColor: const Color(0xFFF7FAFC),
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.border),
                              ),
                              enabledBorder: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.border),
                              ),
                              focusedBorder: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
                              ),
                            ),
                            validator: (value) {
                              final text = value?.trim() ?? '';
                              if (text.isEmpty) {
                                return context.tr('Please confirm your password.', 'Paki-kumpirma ang iyong password.');
                              }
                              if (text != _newPasswordCtrl.text) {
                                return context.tr('Passwords do not match.', 'Hindi magkatugma ang mga password.');
                              }
                              return null;
                            },
                          ),
                          const SizedBox(height: 14),
                          Container(
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF8FAFC),
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(color: BrandColors.border),
                            ),
                            child: Text(
                              context.tr(
                                'Code verified. You can now create your new password.',
                                'Na-verify ang code. Maaari ka nang gumawa ng iyong bagong password.',
                              ),
                              style: const TextStyle(
                                color: BrandColors.textMuted,
                                fontSize: 12,
                                height: 1.45,
                              ),
                            ),
                          ),
                        ] else ...[
                          Container(
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF8FAFC),
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(color: BrandColors.border),
                            ),
                            child: Text(
                              context.tr(
                                'Enter the 6-digit code sent to your email, then tap Verify Code.',
                                'Ipasok ang 6-digit na code na ipinadala sa iyong email, pagkatapos ay pindutin ang I-verify ang Code.',
                              ),
                              style: const TextStyle(
                                color: BrandColors.textMuted,
                                fontSize: 12,
                                height: 1.45,
                              ),
                            ),
                          ),
                        ],
                      ],
                      if (_message.isNotEmpty) ...[
                        const SizedBox(height: 12),
                        Text(
                          _message,
                          style: const TextStyle(
                            color: Color(0xFF8E1F1F),
                            fontSize: 12,
                            height: 1.35,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                      const SizedBox(height: 18),
                      Row(
                        children: [
                          Expanded(
                            child: TextButton(
                              onPressed: _isSending ? null : () => Navigator.pop(context),
                              child: Text(context.tr('Cancel', 'Kanselahin')),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: ElevatedButton(
                              onPressed: _isSending
                                  ? null
                                  : !_codeSent
                                      ? _sendResetCode
                                      : !_codeVerified
                                          ? _verifyResetCode
                                          : _submitNewPassword,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: BrandColors.cyan,
                                foregroundColor: Colors.white,
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(14),
                                ),
                              ),
                              child: _isSending
                                  ? const SizedBox(
                                      width: 18,
                                      height: 18,
                                  child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Colors.white,
                                      ),
                                    )
                                  : Text(
                                      !_codeSent
                                          ? context.tr('Send Code', 'Ipadala ang Code')
                                          : !_codeVerified
                                              ? context.tr('Verify Code', 'I-verify ang Code')
                                              : context.tr('Reset Password', 'I-reset ang Password'),
                                    ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
